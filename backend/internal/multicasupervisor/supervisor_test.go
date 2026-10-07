package multicasupervisor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

func TestBuildEnvironmentAllowlist(t *testing.T) {
	env := BuildEnvironment([]string{
		"HOME=/home/test", "PATH=/bin", "TMPDIR=/tmp", "USER=test", "LOGNAME=test",
		"SHELL=/bin/zsh", "LANG=en_US.UTF-8", "LC_ALL=C", "TERM=xterm", "TZ=UTC",
		"AO_MULTICA_DAEMON=1", "AO_MULTICA_PROFILE=dev", "AO_MULTICA_HEALTH_PORT=1234",
		"AO_MULTICA_CLI=/bin/multica", "CODEX_HOME=/home/test/.codex", "MULTICA_TOKEN=secret",
		"ANTHROPIC_API_KEY=secret", "AO_TEST_SECRET=secret",
	})
	joined := strings.Join(env, "\n")
	for _, value := range []string{"HOME=/home/test", "LC_ALL=C", "CODEX_HOME=/home/test/.codex", "AO_MULTICA_PROFILE=dev"} {
		if !strings.Contains(joined, value) {
			t.Fatalf("allowlisted environment missing %q in %q", value, joined)
		}
	}
	for _, secret := range []string{"MULTICA_TOKEN", "ANTHROPIC_API_KEY", "AO_TEST_SECRET"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("secret variable %q leaked to child: %q", secret, joined)
		}
	}
}

func TestLineWriterCapsLinesAndFlushesFinalLine(t *testing.T) {
	var got []string
	writer := &lineWriter{stream: "stdout", emit: func(stream, line string) {
		got = append(got, stream+":"+line)
	}}
	long := bytes.Repeat([]byte("x"), maxChildLogLine+10)
	if n, err := writer.Write(append(long, '\n')); err != nil || n != len(long)+1 {
		t.Fatalf("Write() = (%d, %v)", n, err)
	}
	_, _ = writer.Write([]byte("final line"))
	writer.Flush()
	if len(got) < 2 {
		t.Fatalf("unexpected captured lines: %q", got)
	}
	if len(got) != 2 || len(got[0]) > maxChildLogLine+32 || !strings.HasSuffix(got[0], "[line truncated]") || got[1] != "stdout:final line" {
		t.Fatalf("unexpected captured lines: first length %d, lines %q", len(got[0]), got)
	}
}

func TestSpawnSpecUsesContractCommandAndFilteredEnvironment(t *testing.T) {
	var spec ProcessSpec
	factory := func(_ context.Context, childSpec ProcessSpec, _ func(string, string)) (Process, error) {
		spec = childSpec
		return newFakeProcess(5, true), nil
	}
	supervisor := newTestSupervisorWithConfig(t, Config{
		Enabled: true, Profile: "dev", HealthPort: 0, Executable: "/tmp/ao", CLIPath: "/tmp/multica",
		Environment:    BuildEnvironment([]string{"HOME=/tmp/home", "AO_TEST_SECRET=secret", "MULTICA_SERVER_URL=http://localhost:8080", "MULTICA_WORKSPACES_ROOT=/tmp/ws", "MULTICA_TOKEN=secret", "LC_ALL=C"}),
		ProcessFactory: factory,
	})
	awaitState(t, supervisor, StateRunning)
	if spec.Executable != "/tmp/ao" || len(spec.Args) != 2 || spec.Args[0] != multicahost.HostCommand || spec.Args[1] != "--watch-stdin" {
		t.Fatalf("child process spec = %+v", spec)
	}
	environment := strings.Join(spec.Environment, "\n")
	for _, expected := range []string{"HOME=/tmp/home", "LC_ALL=C", "MULTICA_SERVER_URL=http://localhost:8080", "MULTICA_WORKSPACES_ROOT=/tmp/ws", multicahost.FlagEnv + "=1", multicahost.ProfileEnv + "=dev", multicahost.HealthPortEnv + "=0", multicahost.CLIPathEnv + "=/tmp/multica"} {
		if !strings.Contains(environment, expected) {
			t.Errorf("child environment missing %q: %s", expected, environment)
		}
	}
	if strings.Contains(environment, "MULTICA_TOKEN") {
		t.Fatalf("child environment included a credential-looking MULTICA_ variable: %s", environment)
	}
	if strings.Contains(environment, "AO_TEST_SECRET") {
		t.Fatalf("child environment included a non-allowlisted variable: %s", environment)
	}
}

func TestUnsolicitedExitPolicy(t *testing.T) {
	tests := []struct {
		name      string
		exit      ProcessExit
		wantState State
		wantErr   string
		wantGrace bool
		wantCrash bool
	}{
		{name: "ok stands down", exit: ProcessExit{Code: 0}, wantState: StateStopped, wantGrace: true},
		{name: "signal exit is not graceful", exit: ProcessExit{Code: -1, Signal: "SIGTERM"}, wantState: StateBackoff, wantErr: "SIGTERM", wantCrash: true},
		{name: "config fails permanently", exit: ProcessExit{Code: 78}, wantState: StateFailed, wantErr: "configuration refused", wantCrash: false},
		{name: "other exit backs off", exit: ProcessExit{Code: 1}, wantState: StateBackoff, wantErr: "code 1", wantCrash: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clock := newFakeClock()
			factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
				process := newFakeProcess(index+10, false)
				if test.exit.Code == 78 {
					process.logLines = []string{"configuration refused"}
				}
				process.exit(test.exit)
				return process
			}}
			supervisor := newTestSupervisor(t, clock, factory.factory)
			awaitState(t, supervisor, test.wantState)
			status := supervisor.Status()
			if status.LastExit == nil || status.LastExit.Code != test.exit.Code {
				t.Fatalf("last exit = %+v, want code %d", status.LastExit, test.exit.Code)
			}
			if status.LastExit.Graceful != test.wantGrace || status.LastExit.Crash != test.wantCrash {
				t.Fatalf("exit classification = %+v", status.LastExit)
			}
			if test.wantErr != "" && !strings.Contains(status.LastError, test.wantErr) {
				t.Fatalf("last error = %q, want it to contain %q", status.LastError, test.wantErr)
			}
			if test.wantState != StateBackoff && factory.count() != 1 {
				t.Fatalf("process starts = %d, want 1", factory.count())
			}
		})
	}
}

func TestCrashBackoffCapAndGiveUp(t *testing.T) {
	clock := newFakeClock()
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		process := newFakeProcess(index+20, false)
		process.exit(ProcessExit{Code: 1})
		return process
	}}
	supervisor := newTestSupervisor(t, clock, factory.factory)
	awaitState(t, supervisor, StateBackoff)
	wantDelays := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, time.Minute}
	for index, delay := range wantDelays {
		status := supervisor.Status()
		if remaining := status.NextRetryAt.Sub(clock.Now()); remaining != delay {
			t.Fatalf("crash %d backoff = %s, want %s", index+1, remaining, delay)
		}
		clock.Advance(delay)
		if index == len(wantDelays)-1 {
			// The eighth fast crash gives up instead of backing off again.
			awaitState(t, supervisor, StateFailed)
			break
		}
		await(t, func() bool {
			status := supervisor.Status()
			return status.State == StateBackoff && status.Restarts == index+1
		})
	}
	if factory.count() != 8 {
		t.Fatalf("process starts = %d, want 8 fast crashes", factory.count())
	}
	if supervisor.Status().NextRetryAt != (time.Time{}) {
		t.Fatalf("failed supervisor has retry time: %s", supervisor.Status().NextRetryAt)
	}
}

func TestStableRunResetsFastCrashCount(t *testing.T) {
	clock := newFakeClock()
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		process := newFakeProcess(index+30, false)
		if index > 0 {
			process.exit(ProcessExit{Code: 1})
		}
		return process
	}}
	supervisor := newTestSupervisor(t, clock, factory.factory)
	awaitState(t, supervisor, StateRunning)
	process := factory.process(0)
	clock.Advance(2 * time.Minute)
	process.exit(ProcessExit{Code: 1})
	awaitState(t, supervisor, StateBackoff)
	if got := supervisor.Status().NextRetryAt.Sub(clock.Now()); got != time.Second {
		t.Fatalf("stable child backoff = %s, want 1s", got)
	}
	clock.Advance(time.Second)
	await(t, func() bool { return factory.count() == 2 })
	awaitState(t, supervisor, StateBackoff)
	if got := supervisor.Status().NextRetryAt.Sub(clock.Now()); got != time.Second {
		t.Fatalf("post-reset fast crash backoff = %s, want 1s", got)
	}
}

func TestStopCancelsBackoffAndStartRunningIsNoop(t *testing.T) {
	clock := newFakeClock()
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		process := newFakeProcess(index+40, false)
		process.exit(ProcessExit{Code: 1})
		return process
	}}
	supervisor := newTestSupervisor(t, clock, factory.factory)
	awaitState(t, supervisor, StateBackoff)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, supervisor, StateBackoff)
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	clock.Advance(time.Hour)
	time.Sleep(time.Millisecond)
	if factory.count() != 2 {
		t.Fatalf("stop during backoff allowed %d starts, want 2", factory.count())
	}

	stableFactory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+50, true)
	}}
	stable := newTestSupervisor(t, newFakeClock(), stableFactory.factory)
	awaitState(t, stable, StateRunning)
	if err := stable.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stableFactory.count() != 1 {
		t.Fatalf("Start while running spawned %d children", stableFactory.count())
	}
}

func TestExternalDetectionAndExplicitTakeover(t *testing.T) {
	var allowExternal atomic.Bool
	var healthRequests atomic.Int32
	allowExternal.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			healthRequests.Add(1)
		}
		if !allowExternal.Load() {
			http.Error(w, "gone", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `{"status":"running","pid":42,"daemon_id":"other-host","profile":"default","agents":["codex"],"workspaces":[{"id":"ws-a","runtimes":["rt-a"]}]}`)
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+60, true)
	}}
	clock := newFakeClock()
	supervisor := newTestSupervisorWithConfig(t, Config{Enabled: true, HealthPort: port, Clock: clock, ProcessFactory: factory.factory, StopTimeout: 100 * time.Millisecond, HealthTimeout: 100 * time.Millisecond})
	awaitState(t, supervisor, StateExternal)
	status := supervisor.Status()
	if status.PID != 0 || status.Health == nil || status.Health.DaemonID != "other-host" || status.Health.WorkspaceCount != 1 || len(status.Health.RuntimeIDs) != 1 {
		t.Fatalf("external health was not captured: %+v", status)
	}
	for range 10 {
		_ = supervisor.Status()
	}
	if got := healthRequests.Load(); got != 1 {
		t.Fatalf("cached external status caused %d health requests, want 1", got)
	}
	if err := supervisor.Restart(context.Background()); !errors.Is(err, ErrExternal) {
		t.Fatalf("Restart external error = %v, want ErrExternal", err)
	}
	if err := supervisor.Stop(context.Background()); !errors.Is(err, ErrExternal) {
		t.Fatalf("Stop external error = %v, want ErrExternal", err)
	}
	if state := supervisor.Status().State; state != StateExternal {
		t.Fatalf("state after refused Stop = %s, want external", state)
	}
	if factory.count() != 0 {
		t.Fatal("external daemon was started over")
	}
	allowExternal.Store(false)
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, supervisor, StateRunning)
	if factory.count() != 1 {
		t.Fatalf("explicit takeover starts = %d, want 1", factory.count())
	}
}

func TestStopWhileStartingAndRestartFromFailedAndStopped(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	factory := func(ctx context.Context, _ ProcessSpec, _ func(string, string)) (Process, error) {
		once.Do(func() { close(entered) })
		select {
		case <-release:
		case <-ctx.Done():
		}
		return newFakeProcess(70, true), nil
	}
	supervisor := newTestSupervisor(t, newFakeClock(), factory)
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("child start was not entered")
	}
	stopDone := make(chan error, 1)
	go func() { stopDone <- supervisor.Stop(context.Background()) }()
	close(release)
	select {
	case err := <-stopDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stop did not finish after child startup")
	}
	awaitState(t, supervisor, StateStopped)
	if err := supervisor.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, supervisor, StateRunning)
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, supervisor, StateStopped)
}

func TestRestartFromFailedAndShutdownIdempotent(t *testing.T) {
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		process := newFakeProcess(index+80, true)
		if index == 0 {
			process.exit(ProcessExit{Code: 78})
		}
		return process
	}}
	supervisor := newTestSupervisor(t, newFakeClock(), factory.factory)
	awaitState(t, supervisor, StateFailed)
	if err := supervisor.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, supervisor, StateRunning)
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRestartFromRunningAndBackoff(t *testing.T) {
	runningFactory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+100, true)
	}}
	running := newTestSupervisor(t, newFakeClock(), runningFactory.factory)
	awaitState(t, running, StateRunning)
	if err := running.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, running, StateRunning)
	if runningFactory.count() != 2 {
		t.Fatalf("Restart while running started %d children", runningFactory.count())
	}

	clock := newFakeClock()
	backoffFactory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		process := newFakeProcess(index+110, true)
		if index == 0 {
			process.exit(ProcessExit{Code: 1})
		}
		return process
	}}
	backoff := newTestSupervisor(t, clock, backoffFactory.factory)
	awaitState(t, backoff, StateBackoff)
	if err := backoff.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	awaitState(t, backoff, StateRunning)
	if backoffFactory.count() != 2 || backoff.Status().Restarts != 0 {
		t.Fatalf("Restart from backoff did not reset and start immediately: status=%+v starts=%d", backoff.Status(), backoffFactory.count())
	}
}

func TestLoggerCannotBlockChildOutput(t *testing.T) {
	entered := make(chan struct{}, 1)
	releaseLogger := make(chan struct{})
	logger := slog.New(blockingHandler{entered: entered, release: releaseLogger})
	factory := func(_ context.Context, _ ProcessSpec, emit func(string, string)) (Process, error) {
		for i := 0; i < ownerQueueSize*4; i++ {
			emit("stdout", fmt.Sprintf("line %d", i))
		}
		return newFakeProcess(90, true), nil
	}
	supervisor := New(Config{Enabled: true, HealthPort: 0, ProcessFactory: factory, StopTimeout: 50 * time.Millisecond}, logger)
	supervisor.Run(context.Background())
	t.Cleanup(func() {
		_ = supervisor.Shutdown(context.Background())
	})
	awaitState(t, supervisor, StateRunning)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("logger handler was not exercised")
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := supervisor.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	close(releaseLogger)
	await(t, func() bool { return len(supervisor.Status().LogLines) > 0 })
}

func newTestSupervisor(t *testing.T, clock *fakeClock, factory ProcessFactory) *Supervisor {
	t.Helper()
	return newTestSupervisorWithConfig(t, Config{
		Enabled: true, HealthPort: 0, Clock: clock, ProcessFactory: factory,
		HealthTimeout: 30 * time.Millisecond, StopTimeout: 100 * time.Millisecond,
	})
}

func newTestSupervisorWithConfig(t *testing.T, cfg Config) *Supervisor {
	t.Helper()
	supervisor := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	supervisor.Run(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = supervisor.Shutdown(ctx)
	})
	return supervisor
}

func awaitState(t *testing.T, supervisor *Supervisor, state State) {
	t.Helper()
	await(t, func() bool { return supervisor.Status().State == state })
}

func await(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		runtime.Gosched()
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not reached before timeout")
}

type fakeFactory struct {
	mu     sync.Mutex
	items  []*fakeProcess
	create func(int, func(string, string)) *fakeProcess
}

func (f *fakeFactory) factory(_ context.Context, _ ProcessSpec, emit func(string, string)) (Process, error) {
	f.mu.Lock()
	index := len(f.items)
	f.mu.Unlock()
	process := f.create(index, emit)
	for _, line := range process.logLines {
		emit("stderr", line)
	}
	f.mu.Lock()
	f.items = append(f.items, process)
	f.mu.Unlock()
	return process, nil
}

func (f *fakeFactory) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.items)
}

func (f *fakeFactory) process(index int) *fakeProcess {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.items[index]
}

type fakeProcess struct {
	id       int
	exitCh   chan ProcessExit
	stdin    *fakeStdin
	mu       sync.Mutex
	exited   bool
	autoEOF  bool
	logLines []string
}

func newFakeProcess(id int, autoEOF bool) *fakeProcess {
	process := &fakeProcess{id: id, exitCh: make(chan ProcessExit, 1), autoEOF: autoEOF}
	process.stdin = &fakeStdin{close: func() {
		if autoEOF {
			process.exit(ProcessExit{Code: 0})
		}
	}}
	return process
}

func (p *fakeProcess) PID() int { return p.id }

func (p *fakeProcess) Stdin() io.WriteCloser { return p.stdin }

func (p *fakeProcess) Wait() ProcessExit { return <-p.exitCh }

func (p *fakeProcess) Kill() error {
	p.exit(ProcessExit{Code: -1, Signal: "killed"})
	return nil
}

func (p *fakeProcess) exit(result ProcessExit) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited {
		return
	}
	p.exited = true
	p.exitCh <- result
}

type fakeStdin struct {
	once  sync.Once
	close func()
}

func (s *fakeStdin) Write(data []byte) (int, error) { return len(data), nil }

func (s *fakeStdin) Close() error {
	s.once.Do(s.close)
	return nil
}

type blockingHandler struct {
	entered chan struct{}
	release <-chan struct{}
}

func (h blockingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h blockingHandler) Handle(context.Context, slog.Record) error {
	select {
	case h.entered <- struct{}{}:
	default:
	}
	<-h.release
	return nil
}

func (h blockingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }

func (h blockingHandler) WithGroup(string) slog.Handler { return h }

// healthStub answers /health as a daemon with the given pid while online is set.
type healthStub struct {
	server *httptest.Server
	online atomic.Bool
	pid    atomic.Int64
}

func newHealthStub(t *testing.T, pid int) *healthStub {
	t.Helper()
	stub := &healthStub{}
	stub.pid.Store(int64(pid))
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !stub.online.Load() {
			http.Error(w, "gone", http.StatusServiceUnavailable)
			return
		}
		_, _ = fmt.Fprintf(w, `{"status":"running","pid":%d,"daemon_id":"stub-daemon"}`, stub.pid.Load())
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *healthStub) port() int { return s.server.Listener.Addr().(*net.TCPAddr).Port }

// awaitAfterCacheExpiry advances the clock past the status health cache and
// polls Status (which asks the owner to refresh) until the condition holds.
func awaitAfterCacheExpiry(t *testing.T, supervisor *Supervisor, clock *fakeClock, condition func(Status) bool) {
	t.Helper()
	clock.Advance(3 * time.Second)
	await(t, func() bool { return condition(supervisor.Status()) })
}

func TestExternalDaemonGoneStandsDownAndExplicitStartReportsExternal(t *testing.T) {
	stub := newHealthStub(t, 42)
	stub.online.Store(true)
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+70, true)
	}}
	clock := newFakeClock()
	supervisor := newTestSupervisorWithConfig(t, Config{Enabled: true, HealthPort: stub.port(), Clock: clock, ProcessFactory: factory.factory, StopTimeout: 100 * time.Millisecond, HealthTimeout: 100 * time.Millisecond})
	awaitState(t, supervisor, StateExternal)
	if err := supervisor.Start(context.Background()); !errors.Is(err, ErrExternal) {
		t.Fatalf("Start while external = %v, want ErrExternal", err)
	}
	stub.online.Store(false)
	awaitAfterCacheExpiry(t, supervisor, clock, func(status Status) bool { return status.State == StateStopped })
	status := supervisor.Status()
	if status.Desired != DesiredStopped || status.Health != nil || status.LastError == "" {
		t.Fatalf("external daemon going away was not reported as a stand-down: %+v", status)
	}
	if factory.count() != 0 {
		t.Fatalf("AO took the profile over by itself: %d starts", factory.count())
	}
}

func TestStoppedProfileNoticesExternalDaemon(t *testing.T) {
	stub := newHealthStub(t, 42)
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+80, true)
	}}
	clock := newFakeClock()
	supervisor := newTestSupervisorWithConfig(t, Config{Enabled: true, HealthPort: stub.port(), Clock: clock, ProcessFactory: factory.factory, StopTimeout: 100 * time.Millisecond, HealthTimeout: 100 * time.Millisecond})
	awaitState(t, supervisor, StateRunning)
	if err := supervisor.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A standalone daemon (for example after 'multica daemon restart') now holds the port.
	stub.online.Store(true)
	awaitAfterCacheExpiry(t, supervisor, clock, func(status Status) bool { return status.State == StateExternal })
	if status := supervisor.Status(); status.Desired != DesiredStopped || status.Health == nil || status.Health.DaemonID != "stub-daemon" {
		t.Fatalf("external daemon in a stopped profile was not reported: %+v", status)
	}
	if factory.count() != 1 {
		t.Fatalf("starts = %d, want only the initial child", factory.count())
	}
}

func TestActionsReturnOnlyAfterTheirStateIsPublished(t *testing.T) {
	factory := &fakeFactory{create: func(index int, _ func(string, string)) *fakeProcess {
		return newFakeProcess(index+100, true)
	}}
	supervisor := newTestSupervisor(t, newFakeClock(), factory.factory)
	awaitState(t, supervisor, StateRunning)
	for round := 0; round < 25; round++ {
		if err := supervisor.Stop(context.Background()); err != nil {
			t.Fatal(err)
		}
		if status := supervisor.Status(); status.State != StateStopped || status.PID != 0 {
			t.Fatalf("round %d: status after Stop = %+v", round, status)
		}
		if err := supervisor.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if status := supervisor.Status(); status.State != StateRunning || status.PID == 0 {
			t.Fatalf("round %d: status after Start = %+v", round, status)
		}
		if err := supervisor.Restart(context.Background()); err != nil {
			t.Fatal(err)
		}
		if status := supervisor.Status(); status.State != StateRunning || status.PID == 0 {
			t.Fatalf("round %d: status after Restart = %+v", round, status)
		}
	}
}
