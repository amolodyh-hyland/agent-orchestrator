package multicahost

import (
	"fmt"
	"io"
	"log/slog"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

var runPreparationHelper = daemonhost.RunPreparationHelper

func RunHelperIfRequested(args []string, stdin io.Reader, stdout, stderr io.Writer) (handled bool, exitCode int) {
	if len(args) != 2 || args[1] != daemonhost.PreparationHelperArg {
		return false, 0
	}

	logger := slog.New(slog.NewTextHandler(stderr, nil))
	if err := runPreparationHelper(stdin, stdout, logger); err != nil {
		fmt.Fprintln(stderr, err)
		return true, 1
	}
	return true, 0
}
