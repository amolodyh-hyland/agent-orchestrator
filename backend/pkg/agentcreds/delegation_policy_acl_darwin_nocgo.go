//go:build darwin && !cgo

package agentcreds

import (
	"os"
	"syscall"
)

func protectedPolicyACL(string) bool { return false }

// Only empty locations may use this fallback; present sources still require ACLs.
func protectedEmptyPolicyOwner(_ string, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0
}
