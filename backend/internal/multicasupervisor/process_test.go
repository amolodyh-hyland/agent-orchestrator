package multicasupervisor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

func TestRealChildShutdownAndStdinEOF(t *testing.T) {
	supervisor := newRealSupervisor(t, "wait", "", 0, nil, 100*time.Millisecond)
	awaitState(t, supervisor, StateRunning)
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	status := supervisor.Status()
	if status.State != StateStopped || status.LastExit == nil || !status.LastExit.Graceful {
		t.Fatalf("stdin EOF did not stop child gracefully: %+v", status)
	}
}

func TestRealChildThatIgnoresShutdownIsKilled(t *testing.T) {
	supervisor := newRealSupervisor(t, "ignore", "", 0, nil, 50*time.Millisecond)
	awaitState(t, supervisor, StateRunning)
	start := time.Now()
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("bounded stop took %s", elapsed)
	}
	status := supervisor.Status()
	if status.State != StateStopped || status.LastExit == nil || status.LastExit.Code != -1 || status.LastExit.Signal == "" {
		t.Fatalf("child was not killed after stop bound: %+v", status)
	}
}

func TestRealChildShutdownRequestAndLogsAndEnvironment(t *testing.T) {
	shutdownSeen := make(chan struct{}, 1)
	var childPID atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			// Answer as the child only once its pid is known: before that the
			// start probe must not mistake the stub for an external daemon.
			if pid := childPID.Load(); pid > 0 {
				_, _ = fmt.Fprintf(w, `{"status":"running","pid":%d,"daemon_id":"test"}`, pid)
				return
			}
			_, _ = io.WriteString(w, `{}`)
		case "/shutdown":
			select {
			case shutdownSeen <- struct{}{}:
			default:
			}
			_, _ = io.WriteString(w, `{"status":"shutting down"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	handler := &recordingHandler{records: make(chan slog.Record, 8)}
	supervisor := newRealSupervisor(t, "logs-env", "", port, slog.New(handler), time.Second)
	awaitState(t, supervisor, StateRunning)
	childPID.Store(int64(supervisor.Status().PID))
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
	for _, expected := range []string{"AO_TEST_SECRET=\"\"", "AO_MULTICA_DAEMON=\"1\"", "profile=\"test-profile\"", "health=\"" + fmt.Sprint(port) + "\""} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("child environment output missing %q: %s", expected, joined)
		}
	}
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-shutdownSeen:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not POST /shutdown before closing stdin")
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
