package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentcreds"
)

func TestNativeManagedCredentialStatusDoesNotExtractSecrets(t *testing.T) {
	for _, tc := range []struct {
		name, method, provider string
		env                    map[string]string
	}{
		{"enterprise account", "claude.ai", "firstParty", nil},
		{"keychain account", "claude.ai", "firstParty", nil},
		{"credentials file account", "claude.ai", "firstParty", nil},
		{"managed Console key", "api_key", "firstParty", nil},
		{"Console OAuth profile", "anthropic_profile", "firstParty", nil},
		{"federation profile", "federation", "firstParty", nil},
		{"credential helper", "api_key_helper", "firstParty", nil},
		{"API key environment", "api_key", "firstParty", map[string]string{"ANTHROPIC_API_KEY": "fixture-only"}},
		{"auth token environment", "api_key", "firstParty", map[string]string{"ANTHROPIC_AUTH_TOKEN": "fixture-only"}},
		{"OAuth token environment", "oauth_token", "firstParty", map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "fixture-only"}},
		{"organisation gateway", "third_party", "gateway", map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1", "ANTHROPIC_API_KEY": "unused-fixture"}},
		{"Bedrock", "third_party", "bedrock", map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1"}},
		{"Vertex", "third_party", "vertex", map[string]string{"CLAUDE_CODE_USE_VERTEX": "1"}},
		{"Foundry", "third_party", "foundry", map[string]string{"CLAUDE_CODE_USE_FOUNDRY": "1"}},
		{"future CLI credential", "future_auth", "future_provider", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearClaudeCredentialEnv(t)
			t.Setenv("CLAUDE_CODE_USE_FOUNDRY", "")
			previousCommand, previousResolver := claudeAuthCommand, claudeResolveLocal
			t.Cleanup(func() { claudeAuthCommand, claudeResolveLocal = previousCommand, previousResolver })
			claudeResolveLocal = func(context.Context, agentcreds.Provider, agentcreds.ResolveOptions) (agentcreds.Credential, bool) {
				t.Fatal("native sign-in status must not read Keychain or credential files")
				return agentcreds.Credential{}, false
			}
			claudeAuthCommand = func(context.Context, string, string, map[string]string) (claudeCommandOutput, error) {
				raw, _ := json.Marshal(map[string]any{
					"loggedIn": true, "authMethod": tc.method, "apiProvider": tc.provider,
					"orgName": "Fixture Company", "subscriptionType": "enterprise",
					"secret": "must-not-escape", "accessToken": "must-not-escape",
				})
				return claudeCommandOutput{Stdout: raw, Stderr: []byte("must-not-escape")}, nil
			}
			for _, launch := range []bool{false, true} {
				status, report, steps, err := (&Plugin{resolvedBinary: "/fixture/claude"}).authStatusAndDiagnostics(context.Background(), "", tc.env, launch)
				if err != nil || status != ports.AgentAuthStatusConfigured || report.account().Organization != "Fixture Company" {
					t.Fatalf("status=%q, report=%+v, err=%v", status, report.account(), err)
				}
				if len(steps) != 2 || steps[0].Code != "cli_signed_in" || steps[1].Code != "cli_managed_credential" {
					t.Fatalf("diagnostics=%+v", steps)
				}
				public, _ := json.Marshal([]any{report.account(), steps})
				if strings.Contains(string(public), "must-not-escape") {
					t.Fatal("secret or raw CLI output escaped into public evidence")
				}
			}
		})
	}
}

func TestNativeStatusRecognizesDirectCredentialForms(t *testing.T) {
	for _, tc := range []struct{ variable, method string }{
		{"ANTHROPIC_API_KEY", "api_key"},
		{"ANTHROPIC_AUTH_TOKEN", "api_key"},
		{"CLAUDE_CODE_OAUTH_TOKEN", "oauth_token"},
	} {
		t.Run(tc.variable, func(t *testing.T) {
			clearClaudeCredentialEnv(t)
			t.Setenv(tc.variable, "fixture-only")
			loggedIn := true
			report := claudeAuthReport{LoggedIn: &loggedIn, AuthMethod: tc.method}
			if !report.managesCredential((agentcreds.ResolveOptions{}).WithClaudeSettings(context.Background())) {
				t.Fatal("native status must cover environment credentials too")
			}
			InvalidateAuthCache()
			t.Cleanup(InvalidateAuthCache)
			server := withStubValidator(t, func(w http.ResponseWriter, req *http.Request) {
				if tc.variable == "ANTHROPIC_API_KEY" {
					if req.Header.Get("x-api-key") != "fixture-only" {
						t.Error("API key must use x-api-key")
					}
				} else if req.Header.Get("authorization") != "Bearer fixture-only" {
					t.Error("token must use Bearer auth")
				}
				if tc.method == "oauth_token" && req.Header.Get("anthropic-beta") == "" {
					t.Error("OAuth model listing requires its beta header")
				}
				_, _ = w.Write([]byte(`{"data":[{"id":"claude-opus-5-5"}]}`))
			})
			t.Setenv("ANTHROPIC_BASE_URL", server.URL)
			previous := claudeModelAuthReport
			t.Cleanup(func() { claudeModelAuthReport = previous })
			claudeModelAuthReport = func(context.Context, string, string, map[string]string) (claudeAuthReport, bool) { return report, true }
			models, err := ProviderModels(context.Background(), "/fixture/claude", "", nil)
			if err != nil || len(models) != 1 || models[0].ID != "claude-opus-5-5" {
				t.Fatalf("direct credential model list=%+v, err=%v", models, err)
			}
		})
	}
}

func TestCLIManagedModelListingKeepsAccountSignInWhenLegacyStoreFails(t *testing.T) {
	loggedIn := true
	resolved := claudeProviderContext{
		providerOK: true, provider: agentcreds.ProviderFirstParty, cliManaged: true, cliOK: true,
		report: claudeAuthReport{LoggedIn: &loggedIn, AuthMethod: "claude.ai"},
	}
	_, err := providerModelsFor(context.Background(), resolved)
	if err == nil || !strings.Contains(err.Error(), "reports signed in") || errors.Is(err, ports.ErrAgentModelDiscoveryCredentialRejected) {
		t.Fatalf("missing legacy credential error=%v", err)
	}
}

func TestNativeSignedOutDoesNotAcceptAStaleEnvironmentCredential(t *testing.T) {
	for _, method := range []string{"", "none", "api_key"} {
		t.Run("method="+method, func(t *testing.T) {
			clearClaudeCredentialEnv(t)
			t.Setenv("ANTHROPIC_API_KEY", "stale-fixture")
			previousCommand, previousResolver := claudeAuthCommand, claudeResolveLocal
			t.Cleanup(func() { claudeAuthCommand, claudeResolveLocal = previousCommand, previousResolver })
			claudeAuthCommand = func(context.Context, string, string, map[string]string) (claudeCommandOutput, error) {
				payload := map[string]any{"loggedIn": false, "apiProvider": "firstParty"}
				if method != "" {
					payload["authMethod"] = method
				}
				raw, _ := json.Marshal(payload)
				return claudeCommandOutput{Stdout: raw}, errors.New("signed out")
			}
			claudeResolveLocal = func(context.Context, agentcreds.Provider, agentcreds.ResolveOptions) (agentcreds.Credential, bool) {
				t.Fatal("native sign-out must not validate unrelated credential sources")
				return agentcreds.Credential{}, false
			}
			status, _, steps, err := (&Plugin{resolvedBinary: "/fixture/claude"}).authStatusAndDiagnostics(context.Background(), "", nil, false)
			if err != nil || status != ports.AgentAuthStatusUnauthorized || len(steps) != 1 || steps[0].Code != "cli_signed_out" {
				t.Fatalf("status=%s, steps=%+v, err=%v", status, steps, err)
			}
			previousReport := claudeModelAuthReport
			t.Cleanup(func() { claudeModelAuthReport = previousReport })
			claudeModelAuthReport = func(ctx context.Context, binary, dir string, env map[string]string) (claudeAuthReport, bool) {
				return (&Plugin{}).claudeCLIAuthReport(ctx, binary, dir, env)
			}
			models, err := ProviderModels(context.Background(), "/fixture/claude", "", nil)
			if len(models) != 0 || !errors.Is(err, ports.ErrAgentModelDiscoveryCredentialRejected) {
				t.Fatalf("signed-out account models=%+v, err=%v", models, err)
			}
		})
	}
}

func TestCLIManagedCatalogFingerprintIncludesAccountWithoutSecrets(t *testing.T) {
	clearClaudeCredentialEnv(t)
	previous := claudeModelAuthReport
	t.Cleanup(func() { claudeModelAuthReport = previous })
	loggedIn := true
	report := claudeAuthReport{LoggedIn: &loggedIn, AuthMethod: "api_key_helper", Email: "one@example.test", OrgID: "one"}
	claudeModelAuthReport = func(context.Context, string, string, map[string]string) (claudeAuthReport, bool) { return report, true }
	fingerprint := func() string { return ProviderCatalogFingerprint(context.Background(), "/fixture/claude", "", nil) }
	first := fingerprint()
	if first != fingerprint() || strings.Contains(first, report.Email) || strings.Contains(first, report.OrgID) {
		t.Fatal("fingerprint must be stable and contain only hashed account identity")
	}
	report.Email = "two@example.test"
	if fingerprint() == first {
		t.Fatal("account change must invalidate the catalog")
	}
	second := fingerprint()
	report.OrgID = "two"
	if fingerprint() == second {
		t.Fatal("organisation change must invalidate the catalog")
	}
	third := fingerprint()
	loggedIn = false
	if fingerprint() == third {
		t.Fatal("sign-out must invalidate the catalog")
	}
}

func TestOAuthTokenIdentityIsNotAnAccountLogin(t *testing.T) {
	loggedIn := true
	if got := (claudeAuthReport{LoggedIn: &loggedIn, AuthMethod: "oauth_token"}).account().Method; got != domain.AgentAccountMethodToken {
		t.Fatalf("method=%s", got)
	}
}

func TestNativeAccountModelsUseAvailableLegacyCredentialButNeverRejectNativeLogin(t *testing.T) {
	clearClaudeCredentialEnv(t)
	InvalidateAuthCache()
	t.Cleanup(InvalidateAuthCache)
	previousReport, previousResolver := claudeModelAuthReport, claudeResolveLocal
	t.Cleanup(func() { claudeModelAuthReport, claudeResolveLocal = previousReport, previousResolver })
	loggedIn := true
	method := "claude.ai"
	claudeModelAuthReport = func(context.Context, string, string, map[string]string) (claudeAuthReport, bool) {
		return claudeAuthReport{LoggedIn: &loggedIn, AuthMethod: method, APIProvider: "firstParty"}, true
	}
	statusCode := http.StatusOK
	requests := 0
	server := withStubValidator(t, func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(statusCode)
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}]}`))
	})
	claudeResolveLocal = func(context.Context, agentcreds.Provider, agentcreds.ResolveOptions) (agentcreds.Credential, bool) {
		if method == "api_key_helper" {
			t.Fatal("helper-backed catalog must not read unrelated legacy secrets")
		}
		return agentcreds.Credential{Kind: agentcreds.KindOAuthToken, Secret: "fixture-only", Source: "keychain", BaseURL: server.URL}, true
	}
	models, err := ProviderModels(context.Background(), "/fixture/claude", "", nil)
	if err != nil || len(models) != 1 || models[0].ID != "claude-opus-5-5" {
		t.Fatalf("account model list=%+v, err=%v", models, err)
	}
	InvalidateAuthCache()
	statusCode = http.StatusUnauthorized
	_, err = ProviderModels(context.Background(), "/fixture/claude", "", nil)
	if err == nil || errors.Is(err, ports.ErrAgentModelDiscoveryCredentialRejected) || !strings.Contains(err.Error(), "reports signed in") {
		t.Fatalf("legacy rejection must not contradict native sign-in: %v", err)
	}
	method = "api_key_helper"
	_, err = ProviderModels(context.Background(), "/fixture/claude", "", nil)
	if err == nil || !strings.Contains(err.Error(), "reports signed in") || requests != 2 {
		t.Fatalf("helper discovery err=%v, provider requests=%d", err, requests)
	}
}
