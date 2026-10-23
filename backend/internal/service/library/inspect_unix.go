//go:build darwin || linux

package library

import (
	"fmt"
	"os"
	"syscall"
)

func targetIdentity(info os.FileInfo) (string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fail("inspection_unsupported_platform")
	}
	return fmt.Sprintf("%v:%v", stat.Dev, stat.Ino), nil
}

func openLibraryFile(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
}

func checkLibraryRegularFile(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fail("inspection_unsupported_platform")
	}
	if !info.Mode().IsRegular() {
		return fail("special_file")
	}
	if stat.Nlink != 1 {
		return fail("hardlink_denied")
	}
	return nil
}
