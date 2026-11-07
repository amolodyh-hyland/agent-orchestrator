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
			decision := resolveFixtureDelegationPolicy(context.Background(), r, opts, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
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

func TestManagedDelegationNoRuleLocalDefault(t *testing.T) {
	for _, tc := range []struct {
		name, source, origin, runtime, cache, want string
	}{
		{"enrolled local", "no rule", "http://localhost:8380", "local", "", "policy_absent"},
		{"remote origin", "no rule", "https://multica.example", "local", "", "policy_unavailable"},
		{"remote runtime", "no rule", "http://localhost:8380", "remote", "", "policy_unavailable"},
		{"unknown runtime", "no rule", "http://localhost:8380", "unknown", "", "policy_unavailable"},
		{"managed deny", "deny", "http://localhost:8380", "local", "", "policy_denied"},
		{"managed profile excluded", "profile excluded", "http://localhost:8380", "local", "", "policy_denied"},
		{"managed allow", "allow", "http://localhost:8380", "local", "", "policy_allowed"},
		{"broken source", "broken", "http://localhost:8380", "local", "", "policy_unavailable"},
		{"dynamic source", "dynamic", "http://localhost:8380", "local", "", "policy_unavailable"},
		{"unreadable source", "unreadable", "http://localhost:8380", "local", "", "policy_unavailable"},
		{"invalid rule", "invalid rule", "http://localhost:8380", "local", "", "policy_unavailable"},
		{"marker only", "marker", "http://localhost:8380", "local", "", "policy_absent"},
		{"not enrolled", "none", "https://multica.example", "remote", "", "policy_absent"},
		{"cache denies", "no rule", "http://localhost:8380", "local", "deny", "policy_denied"},
		{"cache excludes profile", "no rule", "http://localhost:8380", "local", "profile excluded", "policy_denied"},
		{"cache allow keeps absent", "no rule", "http://localhost:8380", "local", "allow", "policy_absent"},
		{"cache cannot allow remote", "no rule", "https://multica.example", "local", "allow", "policy_unavailable"},
		{"broken cache", "no rule", "http://localhost:8380", "local", "broken", "policy_unavailable"},
		{"dynamic cache", "no rule", "http://localhost:8380", "local", "dynamic", "policy_unavailable"},
		{"cache cannot override deny", "deny", "http://localhost:8380", "local", "allow", "policy_denied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
			opts.ConfigDir, _ = filepath.EvalSymlinks(opts.ConfigDir)
			opts.ManagedSettingsDir, _ = filepath.EvalSymlinks(opts.ManagedSettingsDir)
			req, policy := delegationPolicyFixture()
			req.ServerOrigin, req.RuntimeClass = tc.origin, tc.runtime
			policy.ServerOrigins = []string{tc.origin}
			encode := func(kind string) string {
				switch kind {
				case "no rule", "unreadable":
					return `{"model":"sonnet"}`
				case "broken":
					return `{`
				case "dynamic":
					return `{"policyHelper":"must-not-run"}`
				case "invalid rule":
					return `{"aoMulticaDelegation":null}`
				}
				p := policy
				if kind == "deny" {
					p.Effect = "deny"
				}
				if kind == "profile excluded" {
					p.ProfileIDs = []string{"other-profile"}
				}
				data, err := json.Marshal(map[string]any{"aoMulticaDelegation": p})
				if err != nil {
					t.Fatal(err)
				}
				return string(data)
			}
			managed := filepath.Join(opts.ManagedSettingsDir, "managed-settings.json")
			if tc.source == "marker" {
				writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "ao-managed-enrollment"), "enrolled")
			} else if tc.source != "none" {
				writeClaudeSettingsFixture(t, managed, encode(tc.source))
			}
			if tc.cache != "" {
				writeClaudeSettingsFixture(t, filepath.Join(opts.ConfigDir, "remote-settings.json"), encode(tc.cache))
			}
			fs := fixturePolicyFiles(opts.ConfigDir, opts.ManagedSettingsDir)
			if tc.source == "unreadable" {
				open := fs.open
				fs.open = func(path string) (*os.File, error) {
					if path == managed {
						return nil, os.ErrPermission
					}
					return open(path)
				}
			}
			got := resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time { return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC) }, fs)
			if got.Code != tc.want {
				t.Fatalf("got %s, want %s", got.Code, tc.want)
			}
		})
	}
}

func TestManagedDelegationNoRuleOriginValidation(t *testing.T) {
	for _, tc := range []struct {
		origin string
		local  bool
	}{
		{"http://localhost", true}, {"https://localhost:8380", true},
		{"http://127.0.0.1:0", true}, {"https://127.0.0.1:65535", true},
		{"http://[::1]", true}, {"https://[::1]:8380", true},
		{"http://localhost:", false}, {"http://localhost:65536", false},
		{"http://localhost:port", false}, {"http://localhost:-1", false},
		{"http://localhost/", false}, {"http://localhost/path", false},
		{"http://localhost/%2e", false}, {"http://localhost?", false},
		{"http://localhost?x=1", false}, {"http://localhost#", false},
		{"http://localhost#fragment", false}, {"http://user@localhost", false},
		{"http://user:password@localhost", false}, {"ftp://localhost", false},
		{"//localhost", false}, {"http:localhost", false},
		{"http://localhost.evil.example", false}, {"http://localhost.", false},
		{"http://127.0.0.1.nip.io", false}, {"http://127.0.0.2", false},
		{"http://127.1", false}, {"http://2130706433", false},
		{"http://[::ffff:127.0.0.1]", false}, {"http://[::1%25lo0]", false},
		{"http://::1", false}, {"http://[localhost]", false},
		{" http://localhost", false}, {"http://localhost\n", false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
			writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "managed-settings.json"), `{}`)
			req, _ := delegationPolicyFixture()
			req.ServerOrigin = tc.origin
			want := "policy_unavailable"
			if tc.local {
				want = "policy_absent"
			}
			got := resolveFixtureDelegationPolicy(context.Background(), req, opts, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
			if got.Code != want {
				t.Fatalf("got %s, want %s", got.Code, want)
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
		if got := resolveFixtureDelegationPolicy(context.Background(), r, opts, now); got.Code != want {
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
	if got := resolveFixtureDelegationPolicy(ctx, r, opts, now); got.Code != "policy_unavailable" {
		t.Fatal(got)
	}
}

func resolveFixtureDelegationPolicy(ctx context.Context, req DelegationPolicyRequest, opts ResolveOptions, now time.Time) DelegationPolicyDecision {
	opts.ConfigDir, _ = filepath.EvalSymlinks(opts.ConfigDir)
	opts.ManagedSettingsDir, _ = filepath.EvalSymlinks(opts.ManagedSettingsDir)
	fs := fixturePolicyFiles(opts.ConfigDir, opts.ManagedSettingsDir)
	return resolveManagedDelegationPolicy(ctx, req, opts, func() time.Time { return now }, fs)
}

// Fixture roots simulate protected deployment paths; shared temp ancestors are
// synthetic so these tests need neither root privileges nor real managed data.
func fixturePolicyFiles(roots ...string) delegationPolicyFiles {
	fs := nativeDelegationPolicyFiles()
	fs.owner = func(string, os.FileInfo) bool { return true }
	fs.emptyOwner = fs.owner
	fs.lstat = func(path string) (os.FileInfo, error) {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			return info, err
		}
		for _, root := range roots {
			relative, err := filepath.Rel(root, path)
			if err == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
				return info, nil
			}
		}
		return protectedFixtureDirectory{info}, nil
	}
	return fs
}

type protectedFixtureDirectory struct{ os.FileInfo }

func (info protectedFixtureDirectory) Mode() os.FileMode { return info.FileInfo.Mode() &^ 0o022 }

func TestManagedResultScopeRequiresExplicitReadAndImport(t *testing.T) {
	for _, action := range []string{"result_read", "result_import"} {
		t.Run(action, func(t *testing.T) {
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
			req, p := delegationPolicyFixture()
			req.Action = action
			req.DataScopes = []string{"task_result"}
			check := func(want string) {
				t.Helper()
				raw, _ := json.Marshal(map[string]any{"aoMulticaDelegation": p})
				writeClaudeSettingsFixture(t, filepath.Join(opts.ManagedSettingsDir, "managed-settings.json"), string(raw))
				got := resolveFixtureDelegationPolicy(context.Background(), req, opts, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
				if got.Code != want {
					t.Fatalf("got %s want %s", got.Code, want)
				}
			}
			check("policy_denied")
			p.Actions = []string{action}
			check("policy_denied")
			p.DataScopes = []string{"task_result"}
			check("policy_allowed")
			p.Version = 2
			check("policy_unavailable")
		})
	}
}
