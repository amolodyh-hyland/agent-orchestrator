package agentcreds

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func delegationPolicyFixture() (DelegationPolicyRequest, managedDelegationPolicy) {
	return DelegationPolicyRequest{ServerOrigin: "https://multica.example", WorkspaceID: "workspace", ProfileID: "profile", RuntimeID: "runtime", RuntimeClass: "local", DataScopes: []string{"task_brief"}, Action: "delegate"}, managedDelegationPolicy{
		Version: 1, Revision: "private-policy-revision", ValidUntil: "2026-11-01T00:00:00Z", Effect: "allow",
		ServerOrigins: []string{"https://multica.example"}, WorkspaceIDs: []string{"workspace"}, ProfileIDs: []string{"profile"},
		RuntimeClasses: []string{"local"}, DataScopes: []string{"task_brief"}, Actions: []string{"delegate"},
	}
}

func TestManagedDelegationPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*DelegationPolicyRequest, *managedDelegationPolicy)
		code   string
	}{
		{"allow", func(*DelegationPolicyRequest, *managedDelegationPolicy) {}, "policy_allowed"},
		{"deny", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.Effect = "deny" }, "policy_denied"},
		{"origin", func(r *DelegationPolicyRequest, _ *managedDelegationPolicy) { r.ServerOrigin = "https://other.example" }, "policy_denied"},
		{"workspace", func(r *DelegationPolicyRequest, _ *managedDelegationPolicy) { r.WorkspaceID = "other" }, "policy_denied"},
		{"profile", func(r *DelegationPolicyRequest, _ *managedDelegationPolicy) { r.ProfileID = "other" }, "policy_denied"},
		{"remote restricted", func(r *DelegationPolicyRequest, _ *managedDelegationPolicy) { r.RuntimeClass = "remote" }, "policy_denied"},
		{"remote allowed explicitly", func(r *DelegationPolicyRequest, p *managedDelegationPolicy) {
			r.RuntimeClass = "remote"
			p.RuntimeClasses = []string{"remote"}
		}, "policy_allowed"},
		{"runtime unknown", func(r *DelegationPolicyRequest, _ *managedDelegationPolicy) { r.RuntimeClass = "unknown" }, "policy_runtime_unknown"},
		{"scope", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.DataScopes = []string{} }, "policy_denied"},
		{"action", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.Actions = []string{} }, "policy_denied"},
		{"unknown effect", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.Effect = "maybe" }, "policy_unavailable"},
		{"missing allowlist", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.ProfileIDs = nil }, "policy_unavailable"},
		{"stale", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.ValidUntil = "2026-10-21T00:00:00Z" }, "policy_unavailable"},
		{"invalid expiry", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.ValidUntil = "never" }, "policy_unavailable"},
		{"unknown version", func(_ *DelegationPolicyRequest, p *managedDelegationPolicy) { p.Version = 2 }, "policy_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
			r, p := delegationPolicyFixture()
			tc.change(&r, &p)
			data, err := json.Marshal(map[string]any{"aoMulticaDelegation": p})
			if err != nil {
				t.Fatal(err)
			}
			writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "managed-settings.json"), string(data))
			decision := ResolveManagedDelegationPolicy(context.Background(), r, opts, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
			if decision.Code != tc.code {
				t.Fatalf("got %s, want %s", decision.Code, tc.code)
			}
			projection, _ := json.Marshal(decision)
			if string(projection) != `{"code":"`+tc.code+`"}` {
				t.Fatalf("unsafe projection: %s", projection)
			}
		})
	}
}

func TestManagedDelegationSourcesAndLocalPrecedence(t *testing.T) {
	opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
	r, p := delegationPolicyFixture()
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	check := func(want string) {
		t.Helper()
		if got := ResolveManagedDelegationPolicy(context.Background(), r, opts, now); got.Code != want {
			t.Fatalf("got %s, want %s", got.Code, want)
		}
	}
	encode := func(p managedDelegationPolicy) string {
		data, _ := json.Marshal(map[string]any{"aoMulticaDelegation": p})
		return string(data)
	}
	check("policy_absent")
	writeClaudeSettingsFixture(t, filepath.Join(opts.ConfigDir, "settings.json"), encode(p))
	check("policy_absent")
	managed := filepath.Join(opts.ManagedSettingsDir, "managed-settings.json")
	p.Effect = "deny"
	writeClaudeSettingsFixture(t, managed, encode(p))
	check("policy_denied")
	p.Effect = "allow"
	writeClaudeSettingsFixture(t, filepath.Join(opts.ConfigDir, "remote-settings.json"), encode(p))
	writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "managed-settings.d", "10-allow.json"), encode(p))
	check("policy_denied")
	writeClaudeSettingsFixture(t, managed, encode(p))
	check("policy_allowed")
	denied := p
	denied.Effect = "deny"
	writeClaudeSettingsFixture(t, managed, strings.TrimSuffix(encode(denied), "}")+","+strings.TrimPrefix(encode(p), "{"))
	check("policy_denied")
	writeClaudeSettingsFixture(t, managed, strings.TrimSuffix(encode(p), "}")+`,"policyHelper":"must-not-run"}`)
	writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "managed-settings.d", "20-clear-helper.json"), `{"policyHelper":null}`)
	check("policy_unavailable")
	if err := os.Remove(filepath.Join(opts.ManagedSettingsDir, "managed-settings.d", "20-clear-helper.json")); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{" ", `{`, `{"aoMulticaDelegation":null}`, `{"aoMulticaDelegation":{"optional":true}}`, strings.Replace(encode(p), `"version":1`, `"unknown":"private-content","version":1`, 1), `{"aoMulticaDelegation":{},"policyHelper":"must-not-run"}`, strings.Replace(encode(p), `"effect":"allow"`, `"effect":"deny","effect":"allow"`, 1), strings.Replace(encode(p), `"effect":"allow"`, `"Effect":"allow"`, 1)} {
		writeClaudeSettingsFixture(t, managed, raw)
		check("policy_unavailable")
	}
	if err := os.Remove(managed); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(managed, 0o700); err != nil {
		t.Fatal(err)
	}
	check("policy_unavailable")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := ResolveManagedDelegationPolicy(ctx, r, opts, now); got.Code != "policy_unavailable" {
		t.Fatal(got)
	}
}
