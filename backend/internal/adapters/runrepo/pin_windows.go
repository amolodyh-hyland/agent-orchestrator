package runrepo

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Hold every ancestor without FILE_SHARE_DELETE until Git exits. Windows then
// refuses rename/replacement of any path component used by the child process.
func pinCommand(_ *exec.Cmd, root *os.Root, path string) (func(), error) {
	handles := []windows.Handle{}
	release := func() {
		for i := len(handles) - 1; i >= 0; i-- {
			_ = windows.CloseHandle(handles[i])
		}
	}
	volume := filepath.VolumeName(path)
	current := volume + string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, current), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		name, err := windows.UTF16PtrFromString(current)
		if err != nil {
			release()
			return nil, err
		}
		handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			release()
			return nil, err
		}
		handles = append(handles, handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			release()
			return nil, errors.New("unsafe owned directory")
		}
	}
	currentInfo, err := os.Stat(path)
	pinnedInfo, pinnedErr := root.Stat(".")
	if err != nil || pinnedErr != nil || !os.SameFile(currentInfo, pinnedInfo) {
		release()
		return nil, errors.New("owned root changed before inspection")
	}
	return release, nil
}
