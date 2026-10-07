//go:build unix

package multicahost

import (
	"errors"
	"syscall"
)

func processIsAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
