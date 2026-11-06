//go:build !windows

package startupstatus

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func currentProcessStart() string {
	command := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(os.Getpid()))
	command.Env = append(os.Environ(), "LC_ALL=C")
	start, _ := command.Output()
	return strings.TrimSpace(string(start))
}
