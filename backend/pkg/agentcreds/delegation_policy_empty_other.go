//go:build !darwin

package agentcreds

import "os"

func protectedEmptyPolicyOwner(path string, info os.FileInfo) bool {
	return protectedPolicyOwner(path, info)
}
