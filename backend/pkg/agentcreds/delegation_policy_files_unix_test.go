//go:build !windows

package agentcreds

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

type policyFileOwnerFixture struct {
	os.FileInfo
	uid uint32
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
