package agentcreds

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDelegationEnrollmentSurvivesCacheTampering(t *testing.T) {
	opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
	req, policy := delegationPolicyFixture()
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	cached := filepath.Join(opts.ConfigDir, "remote-settings.json")
	protected := filepath.Join(opts.ManagedSettingsDir, "managed-settings.json")
	marker := filepath.Join(opts.ManagedSettingsDir, "ao-managed-enrollment")
	encode := func(effect string) string {
		p := policy
		p.Effect = effect
		raw, _ := json.Marshal(map[string]any{"aoMulticaDelegation": p})
		return string(raw)
	}
	check := func(want string) {
		t.Helper()
		if got := resolveFixtureDelegationPolicy(context.Background(), req, opts, now); got.Code != want {
			t.Fatalf("got %s, want %s", got.Code, want)
		}
	}
	check("policy_absent")
	writeClaudeSettingsFixture(t, cached, encode("allow"))
	check("policy_absent")
	writeClaudeSettingsFixture(t, marker, "enrolled")
	check("policy_unavailable")
	for _, raw := range []string{"", "{}", encode("allow")} {
		writeClaudeSettingsFixture(t, cached, raw)
		check("policy_unavailable")
	}
	if err := os.Remove(cached); err != nil {
		t.Fatal(err)
	}
	check("policy_unavailable")
	writeClaudeSettingsFixture(t, protected, encode("deny"))
	check("policy_denied")
	writeClaudeSettingsFixture(t, cached, encode("allow"))
	check("policy_denied")
	writeClaudeSettingsFixture(t, protected, encode("allow"))
	req.RuntimeClass = "unknown"
	check("policy_runtime_unknown")
	if err := os.Remove(cached); err != nil {
		t.Fatal(err)
	}
	check("policy_runtime_unknown")
	writeClaudeSettingsFixture(t, cached, "")
	check("policy_runtime_unknown")
	req.RuntimeClass = "local"
	writeClaudeSettingsFixture(t, cached, encode("deny"))
	check("policy_denied")
	if err := os.Remove(cached); err != nil {
		t.Fatal(err)
	}
	check("policy_allowed")
	if err := os.Remove(protected); err != nil {
		t.Fatal(err)
	}
	check("policy_unavailable")
}

func TestDelegationProtectedSourceRejectsWritablePathsAndSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission and symlink fixtures")
	}
	for _, kind := range []string{"writable file", "symlink file", "symlink parent", "writable parent", "non-regular"} {
		t.Run(kind, func(t *testing.T) {
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: t.TempDir(), GOOS: "linux", Env: envFrom(nil)}
			req, p := delegationPolicyFixture()
			raw, _ := json.Marshal(map[string]any{"aoMulticaDelegation": p})
			target := filepath.Join(opts.ManagedSettingsDir, "managed-settings.json")
			switch kind {
			case "writable file":
				writeClaudeSettingsFixture(t, target, string(raw))
				if err := os.Chmod(target, 0o666); err != nil {
					t.Fatal(err)
				}
			case "symlink file":
				actual := filepath.Join(opts.ConfigDir, "other.json")
				writeClaudeSettingsFixture(t, actual, string(raw))
				if err := os.Symlink(actual, target); err != nil {
					t.Fatal(err)
				}
			case "symlink parent":
				actual := filepath.Join(opts.ConfigDir, "subdir")
				if err := os.Mkdir(actual, 0o700); err != nil {
					t.Fatal(err)
				}
				writeClaudeSettingsFixture(t, filepath.Join(actual, "managed-settings.json"), string(raw))
				if err := os.Symlink(actual, filepath.Join(opts.ManagedSettingsDir, "linked")); err != nil {
					t.Fatal(err)
				}
				opts.ManagedSettingsDir = filepath.Join(opts.ManagedSettingsDir, "linked")
			case "writable parent":
				writeClaudeSettingsFixture(t, target, string(raw))
				if err := os.Chmod(opts.ManagedSettingsDir, 0o777); err != nil {
					t.Fatal(err)
				}
			case "non-regular":
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			// Preserve source symlinks; resolve only the OS's temp-root alias.
			base, _ := filepath.EvalSymlinks(filepath.Dir(opts.ConfigDir))
			opts.ConfigDir = filepath.Join(base, filepath.Base(opts.ConfigDir))
			base, _ = filepath.EvalSymlinks(filepath.Dir(opts.ManagedSettingsDir))
			opts.ManagedSettingsDir = filepath.Join(base, filepath.Base(opts.ManagedSettingsDir))
			fs := fixturePolicyFiles(opts.ConfigDir, opts.ManagedSettingsDir)
			got := resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time { return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC) }, fs)
			if got.Code != "policy_unavailable" {
				t.Fatalf("unsafe source accepted: %s", got.Code)
			}
		})
	}
}

func TestDelegationNativeEnrollmentAndProtectedPreferences(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("macOS path and ownership fixtures")
	}
	for _, kind := range []string{"personal", "protected allow", "managed without policy", "MDM marker without policy", "other managed plist", "expired while loading", "unreadable preferences"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "snapshot.plist")
			req, p := delegationPolicyFixture()
			data, _ := json.Marshal(map[string]any{"aoMulticaDelegation": p})
			if kind == "managed without policy" {
				data = []byte(`{"model":"sonnet"}`)
			}
			writeClaudeSettingsFixture(t, file, string(data))
			info, err := os.Lstat(file)
			if err != nil {
				t.Fatal(err)
			}
			directory, err := os.Lstat(dir)
			if err != nil {
				t.Fatal(err)
			}
			entry, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			machine := "/Library/Managed Preferences/com.anthropic.claudecode.plist"
			mdm := "/private/var/db/ConfigurationProfiles/Settings/.cloudConfigProfileInstalled"
			fs := nativeDelegationPolicyFiles()
			fs.owner = func(string, os.FileInfo) bool { return true }
			fs.open = func(string) (*os.File, error) { return os.Open(file) }
			fs.lstat = func(path string) (os.FileInfo, error) {
				if path == machine && (kind == "protected allow" || kind == "managed without policy" || kind == "expired while loading" || kind == "unreadable preferences") {
					return info, nil
				}
				if path == mdm && kind == "MDM marker without policy" {
					return info, nil
				}
				if path == "/Library/Managed Preferences/other.plist" && kind == "other managed plist" {
					return info, nil
				}
				if strings.HasSuffix(path, ".plist") || strings.HasSuffix(path, ".json") || strings.Contains(path, ".cloudConfig") || strings.HasSuffix(path, "ao-managed-enrollment") || strings.HasSuffix(path, "managed-settings.d") {
					return nil, os.ErrNotExist
				}
				return directory, nil
			}
			fs.readDir = func(path string) ([]os.DirEntry, error) {
				if path == "/Library/Managed Preferences" && kind == "other managed plist" {
					return []os.DirEntry{policyDirectoryEntry{DirEntry: entry[0], name: "other.plist"}}, nil
				}
				return nil, nil
			}
			now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
			opts := ResolveOptions{ConfigDir: dir, GOOS: "darwin", Env: envFrom(nil), Runner: func(context.Context, string, ...string) ([]byte, error) {
				if kind == "unreadable preferences" {
					return nil, errors.New("private-policy-error")
				}
				if kind == "expired while loading" {
					now = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
				}
				return data, nil
			}}
			writeClaudeSettingsFixture(t, filepath.Join(dir, "remote-settings.json"), string(data))
			got := resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time { return now }, fs)
			want := "policy_unavailable"
			if kind == "personal" {
				want = "policy_absent"
			}
			if kind == "protected allow" {
				want = "policy_allowed"
			}
			if got.Code != want {
				t.Fatalf("got %s, want %s", got.Code, want)
			}
		})
	}
}

type policyDirectoryEntry struct {
	os.DirEntry
	name string
}

func (e policyDirectoryEntry) Name() string { return e.name }

func TestDelegationDarwinPresenceBeforeACLChecks(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	preferences := "/Library/Managed Preferences"
	userPreferences := filepath.Join(preferences, current.Username)
	for _, source := range []string{
		"personal", "empty preferences", "unreadable source", "unreadable preferences",
		"/Library/Application Support/ClaudeCode/managed-settings.json",
		"/Library/Application Support/ClaudeCode/ao-managed-enrollment",
		"/Library/Application Support/ClaudeCode/managed-settings.d",
		"/private/var/db/ConfigurationProfiles/Settings/.cloudConfigHasActivationRecord",
		"/private/var/db/ConfigurationProfiles/Settings/.cloudConfigProfileInstalled",
		filepath.Join(preferences, "com.anthropic.claudecode.plist"),
		filepath.Join(userPreferences, "com.anthropic.claudecode.plist"),
		filepath.Join(preferences, "other.plist"), filepath.Join(userPreferences, "other.plist"),
	} {
		t.Run(source, func(t *testing.T) {
			directory := t.TempDir()
			file := filepath.Join(directory, "snapshot")
			writeClaudeSettingsFixture(t, file, "{}")
			info, err := os.Lstat(file)
			if err != nil {
				t.Fatal(err)
			}
			dirInfo, err := os.Lstat(directory)
			if err != nil {
				t.Fatal(err)
			}
			checks := 0
			fs := nativeDelegationPolicyFiles()
			fs.owner = func(string, os.FileInfo) bool { checks++; return false }
			fs.open = func(string) (*os.File, error) {
				t.Fatal("opened without ACL verification")
				return nil, os.ErrPermission
			}
			fs.lstat = func(path string) (os.FileInfo, error) {
				if source == "unreadable source" && strings.HasSuffix(path, "managed-settings.json") {
					return nil, os.ErrPermission
				}
				if path == source {
					if strings.HasSuffix(path, "managed-settings.d") {
						return dirInfo, nil
					}
					return info, nil
				}
				if source != "personal" && (path == preferences || path == userPreferences) {
					return dirInfo, nil
				}
				return nil, os.ErrNotExist
			}
			fs.readDir = func(path string) ([]os.DirEntry, error) {
				if source == "unreadable preferences" {
					return nil, os.ErrPermission
				}
				if strings.HasSuffix(source, "other.plist") && filepath.Dir(source) == path {
					return []os.DirEntry{policyDirectoryEntry{name: "other.plist"}}, nil
				}
				return nil, nil
			}
			req, _ := delegationPolicyFixture()
			got := resolveManagedDelegationPolicy(context.Background(), req, ResolveOptions{ConfigDir: directory, GOOS: "darwin", Env: envFrom(nil)}, time.Now, fs)
			want := "policy_unavailable"
			if source == "personal" || source == "empty preferences" {
				want = "policy_absent"
				if checks != 0 {
					t.Fatal("personal use required an ACL reader")
				}
			}
			if got.Code != want {
				t.Fatalf("code=%s, want %s", got.Code, want)
			}
		})
	}
}
