//go:build !windows

package runrepo

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
)

const directoryHelper = "--ao-observe-owned-repo"

// A minimal self-exec trampoline performs fchdir in the child only. macOS does
// not support chdir through /dev/fd directory paths. Never change daemon cwd.
func init() {
	if len(os.Args) < 4 || os.Args[1] != directoryHelper {
		return
	}
	gitPath, err := exec.LookPath("git")
	prefix := inspectionOptions()
	args := os.Args[3:]
	if err != nil || !filepath.IsAbs(gitPath) || gitPath != os.Args[2] || len(args) <= len(prefix) || !slices.Equal(args[:len(prefix)], prefix) || !safeInspectionArgs(args[len(prefix):]) {
		os.Exit(125)
	}
	file := os.NewFile(3, "owned-directory")
	if file == nil || file.Chdir() != nil {
		os.Exit(125)
	}
	_ = file.Close()
	if err := syscall.Exec(gitPath, append([]string{gitPath}, args...), inspectionEnv()); err != nil { //nolint:gosec // Exact options and read-only builtin arguments were allowlisted above; executable resolved before fchdir.
		os.Exit(125)
	}
}

func pinCommand(cmd *exec.Cmd, root *os.Root, _ string) (func(), error) {
	file, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	self, err := os.Executable()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	args := []string{self, directoryHelper, cmd.Path}
	for i := 1; i < len(cmd.Args); i++ {
		if cmd.Args[i] == "-C" {
			i++
			continue
		}
		args = append(args, cmd.Args[i])
	}
	cmd.Path = self
	cmd.Args = args
	cmd.ExtraFiles = []*os.File{file}
	return func() { _ = file.Close() }, nil
}
