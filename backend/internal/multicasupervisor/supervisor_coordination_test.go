package multicasupervisor

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSupervisorDefersStartUntilDrainingChildExits(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	first := newControlledProcess(1, false)
	startControlledChild(t, supervisor, factory, first)

	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	receiveSignal(t, first.stdin.closed)
	startReply := queueSupervisorRequest(t, supervisor, requestStart)
	assertNoReply(t, startReply)
	assertNoFactoryCall(t, factory)

	first.finish(ProcessExit{Code: 0})
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	secondCall := receiveFactoryCall(t, factory)
	second := newControlledProcess(2, true)
	secondCall.release(second, nil)
	if err := receiveReply(t, startReply); err != nil {
		t.Fatalf("deferred Start error = %v", err)
	}
	receiveSignal(t, second.waitStarted)
	if got := factory.count.Load(); got != 2 {
		t.Fatalf("factory calls = %d, want exactly 2", got)
	}
	if status := supervisor.Status(); status.State != StateRunning || status.Desired != DesiredRunning {
		t.Fatalf("status after deferred Start = %+v, want running", status)
	}
}

func TestSupervisorStartDuringSpawnPendingRunsAfterStop(t *testing.T) {
	// Chosen outcome: the Start runs after the stop completes.
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	firstCall := receiveFactoryCall(t, factory)
	initialStart := queueSupervisorRequest(t, supervisor, requestStart)
	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	awaitSupervisorStatus(t, supervisor, func(status Status) bool { return status.Desired == DesiredStopped })
	deferredStart := queueSupervisorRequest(t, supervisor, requestStart)
	assertNoReply(t, deferredStart)
	assertNoFactoryCall(t, factory)

	first := newControlledProcess(10, true)
	firstCall.release(first, nil)
	if err := receiveReply(t, initialStart); !errors.Is(err, ErrStopped) {
		t.Fatalf("in-flight Start error = %v, want ErrStopped", err)
	}
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	secondCall := receiveFactoryCall(t, factory)
	second := newControlledProcess(11, true)
	secondCall.release(second, nil)
	if err := receiveReply(t, deferredStart); err != nil {
		t.Fatalf("Start after stop error = %v", err)
	}
	receiveSignal(t, second.waitStarted)
	if got := factory.count.Load(); got != 2 {
		t.Fatalf("factory calls = %d, want 2", got)
	}
}

func TestSupervisorStopCancelsPendingRestart(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	first := newControlledProcess(20, false)
	startControlledChild(t, supervisor, factory, first)

	restartReply := queueSupervisorRequest(t, supervisor, requestRestart)
	receiveSignal(t, first.stdin.closed)
	deferredStart := queueSupervisorRequest(t, supervisor, requestStart)
	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	if err := receiveReply(t, restartReply); !errors.Is(err, ErrStopped) || !containsText(err, "cancelled by a later stop") {
		t.Fatalf("Restart error = %v, want later-stop cancellation", err)
	}
	if err := receiveReply(t, deferredStart); !errors.Is(err, ErrStopped) || !containsText(err, "cancelled by a later stop") {
		t.Fatalf("deferred Start error = %v, want later-stop cancellation", err)
	}
	assertNoFactoryCall(t, factory)
	first.finish(ProcessExit{Code: 0})
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	assertNoFactoryCall(t, factory)
	if status := supervisor.Status(); status.State != StateStopped || status.Desired != DesiredStopped {
		t.Fatalf("status after cancelled Restart = %+v, want stopped", status)
	}
}

func TestSupervisorShutdownAnswersRepliesDuringDrainingStart(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	first := newControlledProcess(30, false)
	startControlledChild(t, supervisor, factory, first)
	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	receiveSignal(t, first.stdin.closed)
	deferredStart := queueSupervisorRequest(t, supervisor, requestStart)
	shutdownReply := queueSupervisorRequest(t, supervisor, requestShutdown)

	awaitSupervisorDone(t, supervisor)
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	if err := receiveReply(t, deferredStart); !errors.Is(err, ErrStopped) {
		t.Fatalf("deferred Start error = %v, want ErrStopped", err)
	}
	if err := receiveReply(t, shutdownReply); err != nil {
		t.Fatalf("Shutdown error = %v", err)
	}
	assertNoFactoryCall(t, factory)
}

func TestSupervisorShutdownAnswersRepliesDuringSpawnPending(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	firstCall := receiveFactoryCall(t, factory)
	initialStart := queueSupervisorRequest(t, supervisor, requestStart)
	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	awaitSupervisorStatus(t, supervisor, func(status Status) bool { return status.Desired == DesiredStopped })
	deferredStart := queueSupervisorRequest(t, supervisor, requestStart)
	shutdownReply := queueSupervisorRequest(t, supervisor, requestShutdown)

	firstCall.release(newControlledProcess(40, true), nil)
	awaitSupervisorDone(t, supervisor)
	if err := receiveReply(t, initialStart); !errors.Is(err, ErrStopped) {
		t.Fatalf("in-flight Start error = %v, want ErrStopped", err)
	}
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	if err := receiveReply(t, deferredStart); !errors.Is(err, ErrStopped) {
		t.Fatalf("deferred Start error = %v, want ErrStopped", err)
	}
	if err := receiveReply(t, shutdownReply); err != nil {
		t.Fatalf("Shutdown error = %v", err)
	}
}

func TestSupervisorShutdownAnswersRepliesAfterRestartCanceledByStop(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	first := newControlledProcess(50, false)
	startControlledChild(t, supervisor, factory, first)
	restartReply := queueSupervisorRequest(t, supervisor, requestRestart)
	receiveSignal(t, first.stdin.closed)
	stopReply := queueSupervisorRequest(t, supervisor, requestStop)
	shutdownReply := queueSupervisorRequest(t, supervisor, requestShutdown)

	awaitSupervisorDone(t, supervisor)
	if err := receiveReply(t, restartReply); !errors.Is(err, ErrStopped) {
		t.Fatalf("Restart error = %v, want ErrStopped", err)
	}
	if err := receiveReply(t, stopReply); err != nil {
		t.Fatalf("Stop error = %v", err)
	}
	if err := receiveReply(t, shutdownReply); err != nil {
		t.Fatalf("Shutdown error = %v", err)
	}
	assertNoFactoryCall(t, factory)
}

func TestSupervisorStopTwiceDuringOneDrain(t *testing.T) {
	factory := newControlledFactory()
	supervisor := newCoordinationSupervisor(t, factory)
	first := newControlledProcess(60, false)
	startControlledChild(t, supervisor, factory, first)
	firstStop := queueSupervisorRequest(t, supervisor, requestStop)
	receiveSignal(t, first.stdin.closed)
	secondStop := queueSupervisorRequest(t, supervisor, requestStop)
	first.finish(ProcessExit{Code: 0})
	if err := receiveReply(t, firstStop); err != nil {
		t.Fatalf("first Stop error = %v", err)
	}
	if err := receiveReply(t, secondStop); err != nil {
		t.Fatalf("second Stop error = %v", err)
	}
	if got := factory.count.Load(); got != 1 {
		t.Fatalf("factory calls = %d, want 1", got)
	}
}

func TestSupervisorIgnoresStaleProcessExitForReplacedChild(t *testing.T) {
	supervisor := New(Config{Enabled: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	oldChild := &childRun{done: make(chan struct{})}
	currentChild := &childRun{done: make(chan struct{})}
	state := ownerState{
		status: Status{State: StateRunning, Desired: DesiredRunning, PID: 72},
		child:  currentChild,
	}

	supervisor.handleExit(&state, processExit{child: oldChild, result: ProcessExit{Code: 1}})
	if state.child != currentChild || state.status.State != StateRunning || state.status.PID != 72 || state.status.LastExit != nil {
		t.Fatalf("stale process exit changed replacement child state: %+v", state)
	}
}

type controlledFactory struct {
	calls chan *controlledFactoryCall
	count atomic.Int32
	mu    sync.Mutex
	all   []*controlledFactoryCall
}

type controlledFactoryCall struct {
	result chan controlledFactoryResult
	once   sync.Once
}

type controlledFactoryResult struct {
	process Process
	err     error
}

func newControlledFactory() *controlledFactory {
	return &controlledFactory{calls: make(chan *controlledFactoryCall, 8)}
}

func (f *controlledFactory) factory(_ context.Context, _ ProcessSpec, _ func(string, string)) (Process, error) {
	call := &controlledFactoryCall{result: make(chan controlledFactoryResult, 1)}
	f.count.Add(1)
	f.mu.Lock()
	f.all = append(f.all, call)
	f.mu.Unlock()
	f.calls <- call
	result := <-call.result
	return result.process, result.err
}

func (c *controlledFactoryCall) release(process Process, err error) {
	c.once.Do(func() { c.result <- controlledFactoryResult{process: process, err: err} })
}

func (f *controlledFactory) releaseAll() {
	f.mu.Lock()
	calls := append([]*controlledFactoryCall(nil), f.all...)
	f.mu.Unlock()
	for _, call := range calls {
		call.release(nil, errors.New("controlled factory released during cleanup"))
	}
}

type controlledProcess struct {
	id          int
	exitCh      chan ProcessExit
	exitOnce    sync.Once
	waitOnce    sync.Once
	waitStarted chan struct{}
	stdin       *controlledStdin
	kills       atomic.Int32
}

func newControlledProcess(id int, exitOnStdin bool) *controlledProcess {
	process := &controlledProcess{id: id, exitCh: make(chan ProcessExit, 1), waitStarted: make(chan struct{})}
	process.stdin = &controlledStdin{closed: make(chan struct{}), onClose: func() {
		if exitOnStdin {
			process.finish(ProcessExit{Code: 0})
		}
	}}
	return process
}

func (p *controlledProcess) PID() int { return p.id }

func (p *controlledProcess) Stdin() io.WriteCloser { return p.stdin }

func (p *controlledProcess) Wait() ProcessExit {
	p.waitOnce.Do(func() { close(p.waitStarted) })
	return <-p.exitCh
}

func (p *controlledProcess) Kill() error {
	p.kills.Add(1)
	p.finish(ProcessExit{Code: -1, Signal: "killed"})
	return nil
}

func (p *controlledProcess) finish(result ProcessExit) {
	p.exitOnce.Do(func() { p.exitCh <- result })
}

type controlledStdin struct {
	closed  chan struct{}
	once    sync.Once
	onClose func()
}

func (s *controlledStdin) Write(data []byte) (int, error) { return len(data), nil }

func (s *controlledStdin) Close() error {
	s.once.Do(func() {
		close(s.closed)
		if s.onClose != nil {
			s.onClose()
		}
	})
	return nil
}

func startControlledChild(t *testing.T, supervisor *Supervisor, factory *controlledFactory, process *controlledProcess) {
	t.Helper()
	call := receiveFactoryCall(t, factory)
	startReply := queueSupervisorRequest(t, supervisor, requestStart)
	call.release(process, nil)
	if err := receiveReply(t, startReply); err != nil {
		t.Fatalf("initial Start error = %v", err)
	}
	receiveSignal(t, process.waitStarted)
}

func newCoordinationSupervisor(t *testing.T, factory *controlledFactory) *Supervisor {
	t.Helper()
	supervisor := New(Config{
		Enabled: true, HealthPort: 0, HealthTimeout: 20 * time.Millisecond,
		StopTimeout: 5 * time.Second, ShutdownTimeout: 5 * time.Second,
		ProcessFactory: factory.factory,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	supervisor.Run(context.Background())
	t.Cleanup(func() {
		factory.releaseAll()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = supervisor.Shutdown(ctx)
	})
	return supervisor
}

func queueSupervisorRequest(t *testing.T, supervisor *Supervisor, kind requestKind) <-chan error {
	t.Helper()
	reply := make(chan error, 1)
	supervisor.requests <- request{kind: kind, ctx: context.Background(), resp: reply}
	deadline := time.Now().Add(2 * time.Second)
	for len(supervisor.requests) != 0 && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	if len(supervisor.requests) != 0 {
		t.Fatal("supervisor did not receive queued request")
	}
	return reply
}

func receiveFactoryCall(t *testing.T, factory *controlledFactory) *controlledFactoryCall {
	t.Helper()
	select {
	case call := <-factory.calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for process factory")
		return nil
	}
}

func assertNoFactoryCall(t *testing.T, factory *controlledFactory) {
	t.Helper()
	select {
	case <-factory.calls:
		t.Fatal("unexpected process factory call")
	default:
	}
}

func receiveSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for channel signal")
	}
}

func receiveReply(t *testing.T, reply <-chan error) error {
	t.Helper()
	select {
	case err := <-reply:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for supervisor reply")
		return nil
	}
}

func assertNoReply(t *testing.T, reply <-chan error) {
	t.Helper()
	select {
	case err := <-reply:
		t.Fatalf("request replied before stop completed: %v", err)
	default:
	}
}

func awaitSupervisorStatus(t *testing.T, supervisor *Supervisor, condition func(Status) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition(supervisor.Status()) {
			return
		}
		runtime.Gosched()
	}
	t.Fatal("supervisor status condition not reached")
}

func awaitSupervisorDone(t *testing.T, supervisor *Supervisor) {
	t.Helper()
	select {
	case <-supervisor.done:
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor owner did not exit")
	}
}

func containsText(err error, text string) bool {
	return err != nil && strings.Contains(err.Error(), text)
}
