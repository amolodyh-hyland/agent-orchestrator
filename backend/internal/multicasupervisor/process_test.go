package multicasupervisor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRealChildExitCodes(t *testing.T) {
	tests := []struct {
		code      string
		wantState State
	}{
		{code: "0", wantState: StateStopped},
		{code: "1", wantState: StateBackoff},
		{code: "78", wantState: StateFailed},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			supervisor := newRealSupervisor(t, "exit", test.code, 0, nil, 100*time.Millisecond)
			awaitState(t, supervisor, test.wantState)
			if test.code == "78" && !strings.Contains(supervisor.Status().LastError, "configuration refused") {
				t.Fatalf("configuration exit reason = %q", supervisor.Status().LastError)
			}
		})
	}
}

func TestAllowedEnvironmentKeyIsPlatformAware(t *testing.T) {
	for _, test := range []struct {
		key  string
		goos string
		want bool
	}{
		{key: "Path", goos: "windows", want: true},
		{key: "USERPROFILE", goos: "windows", want: true},
		{key: "Path", goos: "darwin", want: false},
		{key: "USERPROFILE", goos: "darwin", want: false},
		{key: "CODEX_HOME", goos: "darwin", want: true},
		{key: "ANTHROPIC_API_KEY", goos: "windows", want: false},
		{key: "AO_TEST_SECRET", goos: "darwin", want: false},
	} {
		if got := allowedEnvironmentKey(test.key, test.goos); got != test.want {
			t.Errorf("allowedEnvironmentKey(%q, %q) = %v, want %v", test.key, test.goos, got, test.want)
		}
	}
}

func TestRealChildStdinEOFExitsZero(t *testing.T) {
	supervisor := newRealSupervisor(t, "wait", "", 0, nil, 2*time.Second)
	awaitState(t, supervisor, StateRunning)
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := supervisor.Status()
	if status.State != StateStopped || status.LastExit == nil || status.LastExit.Code != 0 || status.LastExit.Signal != "" || !status.LastExit.Graceful {
		t.Fatalf("stdin EOF did not stop child gracefully: %+v", status)
	}
}

func TestRealChildThatIgnoresStdinIsKilled(t *testing.T) {
	bound := 50 * time.Millisecond
	supervisor := newRealSupervisor(t, "ignore", "", 0, nil, bound)
	awaitState(t, supervisor, StateRunning)
	start := time.Now()
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < bound || elapsed > time.Second {
		t.Fatalf("bounded stop took %s, want at least %s and under 1s", elapsed, bound)
	}
	status := supervisor.Status()
	if status.State != StateStopped || status.LastExit == nil || status.LastExit.Code != -1 || status.LastExit.Signal == "" || status.LastExit.Graceful {
		t.Fatalf("child was not killed after stop bound: %+v", status)
	}
}

func TestRealChildLogsAndEnvironment(t *testing.T) {
	handler := &recordingHandler{records: make(chan slog.Record, 8)}
	supervisor := newRealSupervisor(t, "logs-env", "", 0, slog.New(handler), 2*time.Second)
	awaitState(t, supervisor, StateRunning)
	var messages []string
	deadline := time.After(2 * time.Second)
	for len(messages) < 2 {
		select {
		case record := <-handler.records:
			messages = append(messages, record.Message)
			component := ""
			record.Attrs(func(attr slog.Attr) bool {
				if attr.Key == "component" {
					component = attr.Value.String()
				}
				return true
			})
			if component != "multica-host" {
				t.Fatalf("log component = %q", component)
			}
		case <-deadline:
			t.Fatal("child log lines did not reach the logger")
		}
	}
	joined := strings.Join(messages, "\n")
	for _, expected := range []string{"AO_TEST_SECRET=\"\"", "AO_MULTICA_DAEMON=\"1\"", "profile=\"test-profile\"", "health=\"0\""} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("child environment output missing %q: %s", expected, joined)
		}
	}
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := supervisor.Status()
	if status.LastExit == nil || status.LastExit.Code != 0 || !status.LastExit.Graceful {
		t.Fatalf("closing stdin did not stop the child with exit code 0: %+v", status.LastExit)
	}
}

func TestMulticaChildHelper(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == "multica-test-child" {
			index = i
			break
		}
	}
	if index < 0 || index+1 >= len(os.Args) {
		return
	}
	mode := os.Args[index+1]
	code := "0"
	if index+2 < len(os.Args) {
		code = os.Args[index+2]
	}
	switch mode {
	case "exit":
		if code == "78" {
			fmt.Fprintln(os.Stderr, "configuration refused")
		}
		exitCode, _ := strconv.Atoi(code)
		os.Exit(exitCode)
	case "wait":
		scanChildStdin()
	case "ignore":
		time.Sleep(15 * time.Second)
	case "logs-env":
		fmt.Printf("AO_TEST_SECRET=%q AO_MULTICA_DAEMON=%q profile=%q health=%q cli=%q\n",
			os.Getenv("AO_TEST_SECRET"), os.Getenv("AO_MULTICA_DAEMON"), os.Getenv("AO_MULTICA_PROFILE"),
			os.Getenv("AO_MULTICA_HEALTH_PORT"), os.Getenv("AO_MULTICA_CLI"))
		fmt.Fprintln(os.Stderr, "child stderr")
		scanChildStdin()
	}
}

func scanChildStdin() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fmt.Println("stdin:", scanner.Text())
	}
	fmt.Println("stdin eof")
}

func newRealSupervisor(t *testing.T, mode, code string, port int, logger *slog.Logger, stopBound time.Duration) *Supervisor {
	t.Helper()
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	command := func(executable string, _ ...string) *exec.Cmd {
		args := []string{"-test.run=^TestMulticaChildHelper$", "multica-test-child", mode, code}
		return exec.Command(executable, args...)
	}
	env := append(os.Environ(), "AO_TEST_SECRET=do-not-pass")
	supervisor := New(Config{
		Enabled: true, Profile: "test-profile", HealthPort: port, Executable: os.Args[0],
		CLIPath: "/test/multica", Environment: BuildEnvironment(env), Command: command,
		HealthTimeout: 100 * time.Millisecond, StopTimeout: stopBound, ShutdownTimeout: stopBound,
	}, logger)
	supervisor.Run(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = supervisor.Shutdown(ctx)
	})
	return supervisor
}

type recordingHandler struct {
	records chan slog.Record
	mu      sync.Mutex
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, record slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case h.records <- record.Clone():
	default:
	}
	return nil
}

func (h *recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }

func (h *recordingHandler) WithGroup(string) slog.Handler { return h }
