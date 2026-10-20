package agentcreds

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeModelPolicyMatching(t *testing.T) {
	for _, tc := range []struct {
		name             string
		policy           ClaudeModelPolicy
		allowed, blocked []string
	}{
		{"unrestricted", ClaudeModelPolicy{}, []string{"sonnet", "opus", "custom"}, nil},
		{"explicit empty", ClaudeModelPolicy{Available: []string{}}, nil, []string{"sonnet", "opus", "claude-sonnet-4-5"}},
		{"family", ClaudeModelPolicy{Available: []string{"sonnet"}}, []string{"sonnet", "sonnet[1m]", "claude-sonnet-4-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5@20250929"}, []string{"opus", "haiku", "claude-opus-4-5", "custom-sonnet"}},
		{"version prefix", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}}, []string{"claude-sonnet-4-5-20250929", "claude-sonnet-4-5-1"}, []string{"sonnet", "claude-sonnet-4-50", "claude-sonnet-4-6"}},
		{"specific disables wildcard", ClaudeModelPolicy{Available: []string{"sonnet", "claude-sonnet-4-5"}}, []string{"claude-sonnet-4-5-20250929"}, []string{"sonnet", "claude-sonnet-4-6"}},
		{"exact", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}, Exact: true}, []string{"claude-sonnet-4-5", "claude-sonnet-4-5-20250929"}, []string{"claude-sonnet-4-5-1", "sonnet"}},
		{"snapshot", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5-20250929"}, Exact: true}, []string{"claude-sonnet-4-5-20250929"}, []string{"claude-sonnet-4-5-20250930", "claude-sonnet-4-5"}},
		{"provider prefix is significant for allowlist", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}}, []string{"claude-sonnet-4-5"}, []string{"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}},
		{"provider form allowlist", ClaudeModelPolicy{Available: []string{"us.anthropic.claude-sonnet-4-5"}}, []string{"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}, []string{"claude-sonnet-4-5"}},
		{"denied wins", ClaudeModelPolicy{Available: []string{"sonnet"}, Denied: []string{"claude-sonnet-4-5"}}, []string{"claude-sonnet-4-6"}, []string{"sonnet", "claude-sonnet-4-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"}},
		{"denied without allowlist", ClaudeModelPolicy{Denied: []string{"opus"}}, []string{"sonnet", "custom"}, []string{"opus", "opus[1m]", "claude-opus-5-5"}},
		{"pinned alias", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}, Aliases: map[string]string{"sonnet": "claude-sonnet-4-5"}}, []string{"sonnet"}, []string{"opus"}},
		{"cross-family pin cannot bypass allowlist", ClaudeModelPolicy{Available: []string{"sonnet"}, Aliases: map[string]string{"sonnet": "claude-opus-4-5"}}, nil, []string{"sonnet", "sonnet[1m]"}},
		{"cross-family pin cannot bypass deny", ClaudeModelPolicy{Denied: []string{"opus"}, Aliases: map[string]string{"sonnet": "claude-opus-4-5"}}, nil, []string{"sonnet", "sonnet[1m]"}},
		{"custom override", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}, Overrides: map[string]string{"claude-sonnet-4-5": "team-model"}}, []string{"team-model"}, []string{"other-model"}},
		{"pinned custom override", ClaudeModelPolicy{Available: []string{"claude-sonnet-4-5"}, Aliases: map[string]string{"sonnet": "team-model"}, Overrides: map[string]string{"claude-sonnet-4-5": "team-model"}}, []string{"sonnet", "team-model"}, []string{"opus"}},
		{"ambiguous override fails closed", ClaudeModelPolicy{Available: []string{"sonnet"}, Overrides: map[string]string{"claude-sonnet-4-5": "team-model", "claude-opus-4-5": "team-model"}}, nil, []string{"team-model"}},
		{"disable extended context", ClaudeModelPolicy{Disable1M: true}, []string{"sonnet", "opus"}, []string{"sonnet[1m]", "opus[1m]"}},
		{"unresolved policy", ClaudeModelPolicy{Unresolved: true}, nil, []string{"sonnet", "opus", "custom"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, id := range tc.allowed {
				if !tc.policy.Allows(id) {
					t.Errorf("allowed model %q was hidden", id)
				}
			}
			for _, id := range tc.blocked {
				if tc.policy.Allows(id) {
					t.Errorf("restricted model %q was offered", id)
				}
			}
		})
	}
}

func TestResolveClaudeModelPolicyPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name, user, project, local, managed, remote, dropIn string
		allowed, blocked                                    []string
	}{
		{name: "non-managed union", user: `{"availableModels":["opus"]}`, project: `{"availableModels":["sonnet"]}`, local: `{"availableModels":[]}`, allowed: []string{"opus", "sonnet"}, blocked: []string{"haiku"}},
		{name: "managed wins", user: `{"availableModels":["opus"]}`, project: `{"availableModels":["haiku"]}`, managed: `{"availableModels":["sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"opus", "haiku"}},
		{name: "managed empty", user: `{"availableModels":["opus"]}`, managed: `{"availableModels":[]}`, blocked: []string{"opus", "sonnet"}},
		{name: "managed invalid list fails closed", managed: `{"availableModels":"sonnet"}`, blocked: []string{"sonnet", "opus"}},
		{name: "invalid list entries stripped", managed: `{"availableModels":[42,"sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"opus"}},
		{name: "remote wins", managed: `{"availableModels":["opus"]}`, remote: `{"availableModels":["sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"opus"}},
		{name: "remote document masks lower managed list", managed: `{"availableModels":["sonnet"]}`, remote: `{"model":"sonnet"}`, allowed: []string{"opus", "sonnet"}},
		{name: "merge uses highest list", managed: `{"availableModels":["opus"]}`, remote: `{"managedSourcesBehavior":"merge","availableModels":["sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"opus"}},
		{name: "merge retains lower deny", managed: `{"deniedModels":["claude-sonnet-4-5"]}`, remote: `{"managedSourcesBehavior":"merge","availableModels":["sonnet"]}`, allowed: []string{"claude-sonnet-4-6"}, blocked: []string{"sonnet", "claude-sonnet-4-5"}},
		{name: "lower source cannot opt in merge", managed: `{"managedSourcesBehavior":"merge","deniedModels":["sonnet"]}`, remote: `{"availableModels":["sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"opus"}},
		{name: "merge exact is strictest", managed: `{"availableModelsMatch":"exact"}`, remote: `{"managedSourcesBehavior":"merge","availableModels":["claude-sonnet-4-5"],"availableModelsMatch":"prefix"}`, allowed: []string{"claude-sonnet-4-5"}, blocked: []string{"claude-sonnet-4-5-1"}},
		{name: "env merges across skipped source", managed: `{"env":{"ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-opus-4-5"}}`, remote: `{"availableModels":["sonnet"]}`, allowed: []string{"claude-sonnet-4-5"}, blocked: []string{"sonnet"}},
		{name: "drop-in env merges per key", managed: `{"availableModels":["sonnet"],"env":{"ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-opus-4-5"}}`, dropIn: `{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"claude-haiku-4-5"}}`, blocked: []string{"sonnet", "haiku"}},
		{name: "fable pin", user: `{"availableModels":["fable"],"env":{"ANTHROPIC_DEFAULT_FABLE_MODEL":"claude-opus-4-5"}}`, blocked: []string{"fable"}},
		{name: "drop-in union", managed: `{"availableModels":["sonnet"]}`, dropIn: `{"availableModels":["haiku"]}`, allowed: []string{"sonnet", "haiku"}, blocked: []string{"opus"}},
		{name: "ignore unmanaged deny and exact", user: `{"availableModels":["sonnet"],"deniedModels":["sonnet"],"availableModelsMatch":"exact"}`, allowed: []string{"sonnet", "claude-sonnet-4-6"}, blocked: []string{"opus"}},
		{name: "do not run policy helper", managed: `{"availableModels":["sonnet"],"policyHelper":"must-not-execute"}`, blocked: []string{"sonnet", "opus"}},
		{name: "malformed managed document", managed: `{"availableModels":`, blocked: []string{"sonnet", "opus"}},
		{name: "lower overrides cannot change managed allowlist", user: `{"modelOverrides":{"claude-sonnet-4-5":"team-model"}}`, managed: `{"availableModels":["sonnet"]}`, allowed: []string{"sonnet"}, blocked: []string{"team-model", "opus"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, project, managed := t.TempDir(), t.TempDir(), t.TempDir()
			for path, body := range map[string]string{
				filepath.Join(dir, "settings.json"): tc.user, filepath.Join(project, ".claude", "settings.json"): tc.project,
				filepath.Join(project, ".claude", "settings.local.json"): tc.local, filepath.Join(managed, "managed-settings.json"): tc.managed,
				filepath.Join(dir, "remote-settings.json"): tc.remote, filepath.Join(managed, "managed-settings.d", "10-models.json"): tc.dropIn,
			} {
				if body != "" {
					writeClaudeSettingsFixture(t, path, body)
				}
			}
			policy := ResolveClaudeModelPolicy(context.Background(), project, nil, ResolveOptions{ConfigDir: dir, ManagedSettingsDir: managed, GOOS: "linux", Env: envFrom(nil)})
			for _, id := range tc.allowed {
				if !policy.Allows(id) {
					t.Errorf("allowed model %q hidden", id)
				}
			}
			for _, id := range tc.blocked {
				if policy.Allows(id) {
					t.Errorf("restricted model %q offered", id)
				}
			}
		})
	}
}

func TestClaudePolicyCacheIdentity(t *testing.T) {
	dir, managed := t.TempDir(), t.TempDir()
	load := func() ClaudeModelPolicy {
		return ResolveClaudeModelPolicy(context.Background(), "", nil, ResolveOptions{ConfigDir: dir, ManagedSettingsDir: managed, GOOS: "linux", Env: envFrom(nil)})
	}
	first := load().Fingerprint()
	path := filepath.Join(managed, "managed-settings.json")
	writeClaudeSettingsFixture(t, path, `{"availableModels":["sonnet"]}`)
	second := load().Fingerprint()
	if first == second {
		t.Fatal("adding a managed allowlist did not invalidate identity")
	}
	writeClaudeSettingsFixture(t, path, `{"availableModels":[]}`)
	if load().Fingerprint() == second {
		t.Fatal("empty allowlist did not invalidate identity")
	}
}

func TestClaudeOSModelPolicyReaders(t *testing.T) {
	t.Run("macOS managed preferences", func(t *testing.T) {
		dir := t.TempDir()
		user, machine := filepath.Join(dir, "user.plist"), filepath.Join(dir, "machine.plist")
		for _, path := range []string{user, machine} {
			if err := os.WriteFile(path, []byte("fixture placeholder"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		runner := func(_ context.Context, name string, args ...string) ([]byte, error) {
			if name != "/usr/bin/plutil" || len(args) != 5 || args[4] != user && args[4] != machine {
				t.Fatal("unexpected OS policy command")
			}
			if args[4] == user {
				return []byte(`{"availableModels":["sonnet"]}`), nil
			}
			return []byte(`{"availableModels":["opus"],"deniedModels":["claude-sonnet-4-5"]}`), nil
		}
		doc := readClaudeMacPolicy(context.Background(), runner, []string{user, machine})
		if doc.broken || len(policyStringList(doc.values["availableModels"])) != 1 || policyStringList(doc.values["availableModels"])[0] != "sonnet" || len(policyStringList(doc.values["deniedModels"])) != 1 {
			t.Fatal("user-specific MDM preference lost priority or machine policy was omitted")
		}
	})
	t.Run("Windows machine policy", func(t *testing.T) {
		calls := 0
		doc := readClaudeOSPolicy(context.Background(), ResolveOptions{GOOS: "windows", Runner: func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls++
			if name != "reg" || args[1] != `HKLM\SOFTWARE\Policies\ClaudeCode` {
				t.Fatal("unexpected registry command")
			}
			return []byte(`Settings    REG_SZ    {"availableModels":["sonnet"]}`), nil
		}})
		if doc.broken || doc.userFallback || !doc.present() || calls != 1 {
			t.Fatal("machine registry policy not recognized")
		}
	})
	t.Run("Windows user policy fallback", func(t *testing.T) {
		calls := 0
		doc := readClaudeOSPolicy(context.Background(), ResolveOptions{GOOS: "windows", Runner: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			calls++
			if args[1] == `HKLM\SOFTWARE\Policies\ClaudeCode` {
				return nil, os.ErrNotExist
			}
			return []byte(`Settings    REG_EXPAND_SZ    {"availableModels":[]}`), nil
		}})
		if doc.broken || !doc.userFallback || !doc.present() || calls != 2 {
			t.Fatal("user registry policy fallback not recognized")
		}
	})
	t.Run("Windows empty machine document permits user fallback", func(t *testing.T) {
		calls := 0
		doc := readClaudeOSPolicy(context.Background(), ResolveOptions{GOOS: "windows", Runner: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			calls++
			if calls == 1 {
				return []byte(`Settings REG_SZ {}`), nil
			}
			return []byte(`Settings REG_SZ {"availableModels":["sonnet"]}`), nil
		}})
		if doc.broken || !doc.userFallback || calls != 2 {
			t.Fatal("empty machine settings incorrectly masked the user policy")
		}
	})
	t.Run("Windows dynamic expansion withholds models", func(t *testing.T) {
		doc := readClaudeOSPolicy(context.Background(), ResolveOptions{GOOS: "windows", Runner: func(_ context.Context, _ string, _ ...string) ([]byte, error) {
			return []byte(`Settings REG_EXPAND_SZ {"deniedModels":["%MODEL%"]}`), nil
		}})
		if !doc.broken {
			t.Fatal("unresolved expanded restriction could offer a blocked model")
		}
	})
}

func TestClaudeModelPolicyExplicitAliasEnvironmentWins(t *testing.T) {
	dir, managed := t.TempDir(), t.TempDir()
	writeClaudeSettingsFixture(t, filepath.Join(dir, "settings.json"), `{"availableModels":["sonnet"],"env":{"ANTHROPIC_DEFAULT_SONNET_MODEL":"claude-opus-4-5"}}`)
	for _, pin := range []string{"", "claude-sonnet-4-5"} {
		policy := ResolveClaudeModelPolicy(context.Background(), "", map[string]string{"ANTHROPIC_DEFAULT_SONNET_MODEL": pin}, ResolveOptions{ConfigDir: dir, ManagedSettingsDir: managed, GOOS: "linux", Env: envFrom(nil)})
		if !policy.Allows("sonnet") {
			t.Fatal("explicit alias environment did not shadow user file")
		}
	}
}
