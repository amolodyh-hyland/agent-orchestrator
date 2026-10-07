package multicahost

import (
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

var runPreparationHelper = daemonhost.RunPreparationHelper

// RunHelperIfRequested runs the hidden execution-environment helper when args select it and reports whether it did.
func RunHelperIfRequested(args []string, stdin io.Reader, stdout, stderr io.Writer) (handled bool, exitCode int) {
	return runHelperIfRequested(args, stdin, stdout, stderr, os.Getenv)
}

func runHelperIfRequested(args []string, stdin io.Reader, stdout, stderr io.Writer, getenv func(string) string) (handled bool, exitCode int) {
	if !Enabled(getenv) {
		return false, 0
	}
	if len(args) != 2 || args[1] != daemonhost.PreparationHelperArg {
		return false, 0
	}

	logger := slog.New(slog.NewTextHandler(stderr, nil))
	if err := runPreparationHelper(stdin, stdout, logger); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return true, 1
	}
	return true, 0
}
