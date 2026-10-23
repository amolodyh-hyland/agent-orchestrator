package library

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func libraryFilesystemBoundary(f *os.File) (filesystemBoundary, error) {
	info, err := f.Stat()
	if err != nil {
		return filesystemBoundary{}, fail("source_changed")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return filesystemBoundary{}, fail("inspection_unsupported_platform")
	}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(int(f.Fd()), &fs); err != nil {
		return filesystemBoundary{}, fail("mount_identity_unavailable")
	}
	return filesystemBoundary{device: fmt.Sprint(stat.Dev), mount: fmt.Sprintf("%v:%s", fs.Fsid, unix.ByteSliceToString(fs.Mntonname[:]))}, nil
}
