//go:build darwin && !cgo

package agentcreds

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDelegationDarwinMissingACLReaderBlocks(t *testing.T) {
	file := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatal(err)
	}
	if protectedPolicyOwner(file, policyFileOwnerFixture{FileInfo: info, uid: 0}) {
		t.Fatal("root-owned file trusted without native ACL verification")
	}
}

func TestDelegationDarwinNoCGOEnrollment(t *testing.T) {
	for _, source := range []string{"personal", "managed-settings.json", "ao-managed-enrollment", "managed-settings.d"} {
		t.Run(source, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			req, policy := delegationPolicyFixture()
			if source == "managed-settings.d" {
				if err := os.Mkdir(filepath.Join(directory, source), 0o700); err != nil {
					t.Fatal(err)
				}
			} else if source != "personal" {
				data, err := json.Marshal(map[string]any{"aoMulticaDelegation": policy})
				if err != nil {
					t.Fatal(err)
				}
				writeClaudeSettingsFixture(t, filepath.Join(directory, source), string(data))
			}
			fs := fixturePolicyFiles(directory)
			checks := 0
			fs.owner = func(path string, info os.FileInfo) bool {
				checks++
				return protectedPolicyOwner(path, policyFileOwnerFixture{FileInfo: info, uid: 0})
			}
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: directory, GOOS: "darwin", Env: envFrom(nil)}
			got := resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time {
				return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
			}, fs)
			if source == "personal" {
				if got.Code != "policy_absent" || checks != 0 {
					t.Fatalf("personal use blocked: code=%s protection checks=%d", got.Code, checks)
				}
			} else if got.Code != "policy_unavailable" || checks == 0 {
				t.Fatalf("managed use bypassed missing ACL reader: code=%s protection checks=%d", got.Code, checks)
			}
		})
	}
}
