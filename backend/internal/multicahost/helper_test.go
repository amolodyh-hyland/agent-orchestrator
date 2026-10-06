package multicahost

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

func TestRunHelperIfRequestedNotHandled(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "no extra args", args: []string{"ao"}},
		{name: "other arg", args: []string{"ao", "version"}},
		{name: "extra arg", args: []string{"ao", daemonhost.PreparationHelperArg, "extra"}},
		{name: "near miss", args: []string{"ao", daemonhost.PreparationHelperArg + "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdin := strings.NewReader("input")
			var stdout, stderr bytes.Buffer
			called := false
			originalRunner := runPreparationHelper
			runPreparationHelper = func(io.Reader, io.Writer, *slog.Logger) error {
				called = true
				return nil
			}
			t.Cleanup(func() { runPreparationHelper = originalRunner })

			handled, code := RunHelperIfRequested(tt.args, stdin, &stdout, &stderr)
			if handled || code != 0 {
				t.Fatalf("RunHelperIfRequested() = (%v, %d), want (false, 0)", handled, code)
			}
			if called || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("non-helper args touched streams or ran helper: called=%v stdout=%q stderr=%q", called, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunHelperIfRequestedSuccess(t *testing.T) {
	stdin := strings.NewReader("input")
	var stdout, stderr bytes.Buffer
	called := false
	originalRunner := runPreparationHelper
	runPreparationHelper = func(gotIn io.Reader, gotOut io.Writer, logger *slog.Logger) error {
		called = true
		if gotIn != stdin || gotOut != &stdout {
			t.Errorf("runner received streams (%v, %v), want (%v, %v)", gotIn, gotOut, stdin, &stdout)
		}
		if logger == nil {
			t.Error("runner received nil logger")
		} else {
			logger.Info("helper log")
		}
		return nil
	}
	t.Cleanup(func() { runPreparationHelper = originalRunner })

	handled, code := RunHelperIfRequested([]string{"ao", daemonhost.PreparationHelperArg}, stdin, &stdout, &stderr)
	if !handled || code != 0 {
		t.Fatalf("RunHelperIfRequested() = (%v, %d), want (true, 0)", handled, code)
	}
	if !called {
		t.Fatal("runner was not called")
	}
	if !strings.Contains(stderr.String(), "helper log") {
		t.Fatalf("stderr = %q, want it to contain helper log", stderr.String())
	}
}

func TestRunHelperIfRequestedFailure(t *testing.T) {
	stdin := strings.NewReader("input")
	var stdout, stderr bytes.Buffer
	wantErr := errors.New("helper failed")
	originalRunner := runPreparationHelper
	runPreparationHelper = func(io.Reader, io.Writer, *slog.Logger) error { return wantErr }
	t.Cleanup(func() { runPreparationHelper = originalRunner })

	handled, code := RunHelperIfRequested([]string{"ao", daemonhost.PreparationHelperArg}, stdin, &stdout, &stderr)
	if !handled || code != 1 {
		t.Fatalf("RunHelperIfRequested() = (%v, %d), want (true, 1)", handled, code)
	}
	if !strings.Contains(stderr.String(), wantErr.Error()) {
		t.Fatalf("stderr = %q, want it to contain %q", stderr.String(), wantErr)
	}
}
