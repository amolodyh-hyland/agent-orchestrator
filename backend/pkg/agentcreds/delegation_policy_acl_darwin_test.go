//go:build darwin && cgo

package agentcreds

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDelegationDarwinACLProtection(t *testing.T) {
	worker, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	principal := "user:" + worker.Username
	if worker.Uid == "0" {
		principal = "user:daemon"
	}
	type aclCase struct {
		name     string
		entries  []string
		ancestor bool
		trusted  bool
	}
	tests := []aclCase{
		{name: "no ACL", trusted: true},
		{name: "root only", entries: []string{"user:root allow write,append,delete,writeattr,writeextattr,writesecurity,chown"}, trusted: true},
		{name: "system group", entries: []string{"group:wheel allow write"}, trusted: true},
		{name: "read only", entries: []string{principal + " allow read,readattr,readextattr,readsecurity"}, trusted: true},
		{name: "deny only", entries: []string{principal + " deny write"}, trusted: true},
		{name: "admin group", entries: []string{"group:admin allow write"}},
		{name: "deny cannot offset allow", entries: []string{principal + " deny write", principal + " allow write"}},
		{name: "ancestor delete child", entries: []string{principal + " allow delete_child"}, ancestor: true},
		{name: "inherited write", entries: []string{principal + " allow inherited,write"}},
		{name: "inherit only write", entries: []string{principal + " allow file_inherit,only_inherit,write"}, ancestor: true},
	}
	for _, permission := range []string{"write", "append", "delete", "writeattr", "writeextattr", "writesecurity", "chown"} {
		tests = append(tests, aclCase{name: "file " + permission, entries: []string{principal + " allow " + permission}})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(directory, "managed-settings.json")
			if err := os.Chmod(directory, 0o755); err != nil {
				t.Fatal(err)
			}
			req, policy := delegationPolicyFixture()
			data, err := json.Marshal(map[string]any{"aoMulticaDelegation": policy})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, data, 0o644); err != nil {
				t.Fatal(err)
			}
			target := file
			if test.ancestor {
				target = directory
			}
			for _, entry := range test.entries {
				if output, err := exec.Command("/bin/chmod", "+a", entry, target).CombinedOutput(); err != nil {
					t.Fatalf("fixture ACL: %v: %s", err, output)
				}
			}
			if got := protectedPolicyACL(target); got != test.trusted {
				t.Fatalf("native ACL trusted = %v, want %v", got, test.trusted)
			}
			fs := darwinACLFixtureFiles(directory)
			_, exists, err := fs.read(file)
			if test.trusted && (err != nil || !exists) {
				t.Fatalf("protected read rejected: exists=%v err=%v", exists, err)
			}
			if !test.trusted && err == nil {
				t.Fatal("unsafe ACL accepted by protected source reader")
			}
			opts := ResolveOptions{ConfigDir: t.TempDir(), ManagedSettingsDir: directory, GOOS: "darwin", Env: envFrom(nil)}
			decision := resolveManagedDelegationPolicy(context.Background(), req, opts, func() time.Time {
				return time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
			}, fs)
			want := "policy_unavailable"
			if test.trusted {
				want = "policy_allowed"
			}
			projection, err := json.Marshal(decision)
			if err != nil || string(projection) != `{"code":"`+want+`"}` {
				t.Fatalf("unsafe decision projection: %s, err=%v", projection, err)
			}
		})
	}
}

func TestDelegationDarwinUnreadableACLBlocks(t *testing.T) {
	for _, failure := range []string{"missing", "permission denied"} {
		t.Run(failure, func(t *testing.T) { testDelegationDarwinUnreadableACL(t, failure) })
	}
}

func testDelegationDarwinUnreadableACL(t *testing.T, failure string) {
	t.Helper()
	if failure == "permission denied" && os.Geteuid() == 0 {
		t.Skip("root bypasses fixture directory permissions")
	}
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, "policy.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatal(err)
	}
	if failure == "missing" {
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Cleanup(func() {
			if err := os.Chmod(directory, 0o700); err != nil {
				t.Error(err)
			}
		})
		if err := os.Chmod(directory, 0); err != nil {
			t.Fatal(err)
		}
	}
	if protectedPolicyACL(file) {
		t.Fatal("failed native ACL retrieval trusted")
	}
	fs := darwinACLFixtureFiles(directory)
	lstat := fs.lstat
	fs.lstat = func(path string) (os.FileInfo, error) {
		if path == file {
			return info, nil
		}
		return lstat(path)
	}
	fs.open = func(string) (*os.File, error) {
		t.Fatal("source opened after ACL retrieval failed")
		return nil, os.ErrPermission
	}
	if _, _, err := fs.read(file); err == nil {
		t.Fatal("unreadable ACL accepted by protected source reader")
	}
}

func darwinACLFixtureFiles(directory string) delegationPolicyFiles {
	fs := fixturePolicyFiles(directory)
	fs.owner = func(path string, info os.FileInfo) bool {
		if path == directory || strings.HasPrefix(path, directory+string(filepath.Separator)) {
			// Simulate root ownership only; ACLs come from real scratch files.
			return protectedPolicyOwner(path, policyFileOwnerFixture{FileInfo: info, uid: 0})
		}
		return true
	}
	return fs
}
