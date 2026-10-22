//go:build !windows

package agentcreds

import (
	"context"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func protectedPolicyOwner(path string, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0 && protectedPolicyACL(path)
}

func openProtectedPolicyFile(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func protectedPolicyMode(info os.FileInfo) bool { return info.Mode().Perm()&0o022 == 0 }

func protectedDelegationRegistry(context.Context) ([]claudePolicyDocument, bool) { return nil, false }
