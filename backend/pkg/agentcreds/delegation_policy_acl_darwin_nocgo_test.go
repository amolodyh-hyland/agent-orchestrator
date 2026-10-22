//go:build darwin && !cgo

package agentcreds

import (
	"os"
	"path/filepath"
	"testing"
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
