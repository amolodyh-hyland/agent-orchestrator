package library

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func libraryFilesystemBoundary(f *os.File) (filesystemBoundary, error) {
	var stat unix.Statx_t
	if err := unix.Statx(int(f.Fd()), "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &stat); err != nil || stat.Mask&unix.STATX_MNT_ID == 0 {
		return filesystemBoundary{}, fail("mount_identity_unavailable")
	}
	return filesystemBoundary{device: fmt.Sprintf("%d:%d", stat.Dev_major, stat.Dev_minor), mount: fmt.Sprint(stat.Mnt_id)}, nil
}
