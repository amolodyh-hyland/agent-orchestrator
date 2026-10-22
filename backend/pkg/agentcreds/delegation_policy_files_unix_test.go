//go:build !windows

package agentcreds

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

type policyFileOwnerFixture struct {
	os.FileInfo
	uid uint32
}

func TestDelegationRemovedPolicyRequiresProtectedEmptyLocations(t *testing.T) {
	for _, location := range []string{"protected", "writable directory", "writable ancestor", "user-owned directory", "missing directory", "symlink directory"} {
		t.Run(location, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(root, "managed")
			if err := os.Mkdir(directory, 0o755); err != nil {
				t.Fatal(err)
			}
			req, policy := delegationPolicyFixture()
			data, err := json.Marshal(map[string]any{"aoMulticaDelegation": policy})
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(directory, "managed-settings.json")
			if err := os.WriteFile(file, data, 0o644); err != nil {
				t.Fatal(err)
			}
			fs := fixturePolicyFiles(root)
			// Root ownership is simulated; directory permissions and deletion are real.
			fs.emptyOwner = func(path string, info os.FileInfo) bool {
				uid := uint32(0)
				if location == "user-owned directory" && path == directory {
					uid = 501
				}
				if path != root && path != directory {
					return true
				}
				return protectedEmptyPolicyOwner(path, policyFileOwnerFixture{FileInfo: info, uid: uid})
			}
			if location == "writable directory" || location == "missing directory" {
				if err := os.Chmod(directory, 0o777); err != nil {
					t.Fatal(err)
				}
			}
			if location == "writable ancestor" || location == "missing directory" {
				if err := os.Chmod(root, 0o777); err != nil {
					t.Fatal(err)
				}
			}
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: directory, GOOS: "darwin", Env: envFrom(nil)}
			check := func() DelegationPolicyDecision {
				return resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time {
					return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
				}, fs)
			}
			if got := check(); got.Code == "policy_absent" {
				t.Fatal("present managed policy counted as unmanaged")
			}
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
			if location == "missing directory" {
				if err := os.Remove(directory); err != nil {
					t.Fatal(err)
				}
			}
			if location == "symlink directory" {
				if err := os.Rename(directory, directory+"-actual"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(directory+"-actual", directory); err != nil {
					t.Fatal(err)
				}
			}
			want := "policy_location_unsafe"
			if location == "protected" {
				want = "policy_absent"
			}
			projection, err := json.Marshal(check())
			if err != nil || string(projection) != `{"code":"`+want+`"}` {
				t.Fatalf("deleting sole policy bypassed protection: %s, err=%v", projection, err)
			}
		})
	}
}

func (f policyFileOwnerFixture) Sys() any { return &syscall.Stat_t{Uid: f.uid} }

func TestDelegationProtectedFileRequiresRootOwner(t *testing.T) {
	file := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatal(err)
	}
	if protectedPolicyOwner(file, policyFileOwnerFixture{FileInfo: info, uid: 501}) {
		t.Fatal("user-owned source trusted")
	}
	if protectedPolicyOwner(file, policyFileOwnerFixture{FileInfo: info, uid: 0}) != protectedPolicyACL(file) {
		t.Fatal("root source did not require platform ACL verification")
	}
	fs := nativeDelegationPolicyFiles()
	fs.owner = func(string, os.FileInfo) bool { return false }
	file, _ = filepath.EvalSymlinks(file)
	if _, _, err := fs.read(file); err == nil {
		t.Fatal("untrusted ownership accepted")
	}
}

func TestDelegationProtectedReadRejectsPathReplacement(t *testing.T) {
	for _, window := range []string{"before open", "symlink before open", "after open"} {
		t.Run(window, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			file, other := filepath.Join(directory, "policy.json"), filepath.Join(directory, "replacement.json")
			for _, path := range []string{file, other} {
				if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			fs := fixturePolicyFiles(directory)
			fs.open = func(path string) (*os.File, error) {
				var opened *os.File
				if window == "after open" {
					var err error
					opened, err = openProtectedPolicyFile(path)
					if err != nil {
						return nil, err
					}
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if window == "symlink before open" {
					if err := os.Symlink(other, path); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Rename(other, path); err != nil {
					t.Fatal(err)
				}
				if opened != nil {
					return opened, nil
				}
				return openProtectedPolicyFile(path)
			}
			if _, _, err := fs.read(file); err == nil {
				t.Fatal("replaced path was trusted")
			}
		})
	}
}
