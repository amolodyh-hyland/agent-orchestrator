package multicasupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// Errors returned by the supervisor's control methods.
var (
	ErrDisabled   = errors.New("Multica hosting is disabled")          //nolint:staticcheck // Multica is a proper noun
	ErrExternal   = errors.New("Multica daemon is externally managed") //nolint:staticcheck // Multica is a proper noun
	ErrNotRunning = errors.New("Multica supervisor is not running")    //nolint:staticcheck // Multica is a proper noun
	ErrStopped    = errors.New("Multica start was cancelled by stop")  //nolint:staticcheck // Multica is a proper noun
)

const (
	maxLogTail       = 40
	loggerQueueSize  = 512
	ownerQueueSize   = 512
	defaultStopBound = 40 * time.Second
	defaultExitBound = 20 * time.Second
)

// Supervisor owns the hosted Multica daemon child: it starts, restarts, stops and reports on it.
type Supervisor struct {
	cfg      Config
	logger   *slog.Logger
	requests chan request
	events   chan any
	refresh  chan struct{}
	logQueue chan logEvent
	done     chan struct{}
	started  atomic.Bool
	snapshot atomic.Pointer[Status]
}

var _ Service = (*Supervisor)(nil)

type requestKind uint8

const (
	requestStart requestKind = iota
	requestStop
	requestRestart
	requestShutdown
)

type request struct {
	kind requestKind
	ctx  context.Context
	resp chan error
}

type logEvent struct {
	stream string
	line   string
}

type startCheck struct {
	generation uint64
	health     *Health
}

type startResult struct {
	generation uint64
	process    Process
	err        error
}

type processExit struct {
	child  *childRun
	result ProcessExit
}

type stopResult struct {
	child  *childRun
	result ProcessExit
	err    error
}

type healthResult struct{ health *Health }

type childRun struct {
	process    Process
	done       chan struct{}
	result     ProcessExit
	startedAt  time.Time
	stopping   bool
	stopCancel context.CancelFunc
}

type pendingReply struct {
	ch  chan error
	err error
}

type ownerState struct {
	status          Status
	generation      uint64
	operation       string
	operationCancel context.CancelFunc
	child           *childRun
	spawnInFlight   bool
	startReplies    []chan error
	outbox          []pendingReply
	stopReplies     []chan error
	deferredStart   []chan error
	restartReply    chan error
	stopErr         error
	closing         bool
	healthInFlight  bool
	lastHealthFetch time.Time
	fastCrashes     int
	retryTimer      Timer
	retryC          <-chan time.Time
}

// New builds a supervisor from cfg; Run must be called to start it.
func New(cfg Config, logger *slog.Logger) *Supervisor {
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Clock == nil {
		cfg.Clock = realClock{}
	}
	if cfg.Command == nil {
		cfg.Command = aoprocess.Command
	}
	if cfg.ProcessFactory == nil {
		cfg.ProcessFactory = startExecProcess
	}
	if cfg.HealthTimeout <= 0 {
		cfg.HealthTimeout = time.Second
	}
	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = defaultStopBound
	}
	if cfg.ShutdownTimeout <= 0 {
		cfg.ShutdownTimeout = defaultExitBound
	}
	if cfg.BackoffBase <= 0 {
		cfg.BackoffBase = time.Second
	}
	if cfg.BackoffMax <= 0 {
		cfg.BackoffMax = time.Minute
	}
	if cfg.StableRunDuration <= 0 {
		cfg.StableRunDuration = 2 * time.Minute
	}
	if cfg.MaxFastCrashes <= 0 {
		cfg.MaxFastCrashes = 8
	}
	state := StateStopped
	if !cfg.Enabled {
		state = StateDisabled
	}
	s := &Supervisor{
		cfg:      cfg,
		logger:   logger,
		requests: make(chan request, 32),
		events:   make(chan any, ownerQueueSize),
		refresh:  make(chan struct{}, 1),
		logQueue: make(chan logEvent, loggerQueueSize),
		done:     make(chan struct{}),
	}
	initial := Status{
		Enabled: cfg.Enabled, State: state, Desired: DesiredStopped,
		Profile: cfg.Profile, HealthPort: cfg.HealthPort,
	}
	s.snapshot.Store(&initial)
	return s
}

// Run runs the supervisor until ctx is cancelled.
func (s *Supervisor) Run(ctx context.Context) {
	if !s.started.CompareAndSwap(false, true) {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if s.cfg.Enabled {
		// Report the start that the owner goroutine is about to begin, so a
		// status read right after Run is not the pre-start "stopped".
		starting := cloneStatus(s.snapshot.Load())
		starting.State, starting.Desired = StateStarting, DesiredRunning
		s.snapshot.Store(&starting)
	}
	go s.runLogger()
	go s.runOwner(ctx) //nolint:gosec // the owner goroutine is bound to ctx; the logger only drains a queue
}

// Status returns a snapshot of the supervised daemon's state.
func (s *Supervisor) Status() Status {
	status := cloneStatus(s.snapshot.Load())
	if status.Enabled && (status.State == StateRunning || status.State == StateExternal || status.State == StateStopped) {
		if s.cfg.Clock.Now().Sub(status.HealthFetchedAt) > 2*time.Second {
			select {
			case s.refresh <- struct{}{}:
			default:
			}
		}
	}
	return status
}

// Start asks the supervisor to run the daemon and waits for the outcome.
func (s *Supervisor) Start(ctx context.Context) error {
	return s.send(ctx, requestStart)
}

// Stop asks the supervisor to stop the daemon and keep it stopped.
func (s *Supervisor) Stop(ctx context.Context) error {
	return s.send(ctx, requestStop)
}

// Restart stops the daemon if it is running and starts it again.
func (s *Supervisor) Restart(ctx context.Context) error {
	return s.send(ctx, requestRestart)
}

// Shutdown stops the daemon and the supervisor, bounded by ctx.
func (s *Supervisor) Shutdown(ctx context.Context) error {
	if !s.started.Load() {
		return nil
	}
	return s.send(ctx, requestShutdown)
}

func (s *Supervisor) send(ctx context.Context, kind requestKind) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !s.cfg.Enabled && kind != requestShutdown {
		return ErrDisabled
	}
	if !s.started.Load() {
		return ErrNotRunning
	}
	req := request{kind: kind, ctx: ctx, resp: make(chan error, 1)}
	select {
	case s.requests <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return nil
	}
	select {
	case err := <-req.resp:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		select {
		case err := <-req.resp:
			return err
		default:
			return nil
		}
	}
}

func (s *Supervisor) runLogger() {
	for line := range s.logQueue {
		s.logger.Info(line.line, "component", "multica-host", "stream", line.stream)
	}
}

func (s *Supervisor) runOwner(ctx context.Context) {
	defer close(s.done)
	state := ownerState{
		status: cloneStatus(s.snapshot.Load()),
	}
	if s.cfg.Enabled {
		state.status.Desired = DesiredRunning
		s.beginStart(&state)
		s.publish(&state)
	} else {
		state.status.State = StateDisabled
		s.publish(&state)
	}
	parentDone := ctx.Done()
	for {
		select {
		case <-parentDone:
			parentDone = nil
			s.beginShutdown(context.Background(), &state, nil)
		case req := <-s.requests:
			s.handleRequest(&state, req)
		case event := <-s.events:
			s.handleEvent(&state, event)
		case <-s.refresh:
			s.refreshHealth(&state)
		case <-state.retryC:
			state.retryC = nil
			state.retryTimer = nil
			state.status.NextRetryAt = time.Time{}
			if state.status.Desired == DesiredRunning && !state.closing {
				state.status.State = StateStarting
				state.status.Restarts++
				s.beginStart(&state)
			}
		}
		if state.closing && state.child == nil && !state.spawnInFlight && state.operation != "" {
			state.operationCancel = nil
			state.operation = ""
		}
		if state.closing && state.child == nil && !state.spawnInFlight && state.operation == "" {
			s.finishClosing(&state)
			return
		}
		s.publish(&state)
		s.flushReplies(&state)
	}
}

func (s *Supervisor) handleRequest(state *ownerState, req request) {
	switch req.kind {
	case requestStart:
		s.start(state, req.resp)
	case requestStop:
		if state.status.State == StateExternal {
			// AO runs nothing here: answering "stopped" would claim to have
			// stopped a daemon that keeps running.
			s.answer(state, req.resp, ErrExternal)
			return
		}
		s.cancelPendingStarts(state)
		s.stop(req.ctx, state, req.resp)
	case requestRestart:
		s.restart(req.ctx, state, req.resp)
	case requestShutdown:
		s.beginShutdown(req.ctx, state, req.resp)
	}
}

func (s *Supervisor) start(state *ownerState, reply chan error) {
	if !s.cfg.Enabled {
		reply <- ErrDisabled
		return
	}
	if state.closing {
		state.deferredStart = append(state.deferredStart, reply)
		return
	}
	if s.stopPending(state) {
		state.deferredStart = append(state.deferredStart, reply)
		return
	}
	if state.status.State == StateRunning && (state.child == nil || !state.child.stopping) {
		reply <- nil
		return
	}
	if state.status.State == StateStarting {
		state.startReplies = append(state.startReplies, reply)
		return
	}
	state.status.Desired = DesiredRunning
	state.status.Restarts = 0
	state.fastCrashes = 0
	state.status.LastError = ""
	s.clearRetry(state)
	state.startReplies = append(state.startReplies, reply)
	s.beginStart(state)
}

func (s *Supervisor) restart(ctx context.Context, state *ownerState, reply chan error) {
	if !s.cfg.Enabled {
		reply <- ErrDisabled
		return
	}
	if state.closing {
		reply <- ErrStopped
		return
	}
	if state.status.State == StateExternal {
		reply <- ErrExternal
		return
	}
	if state.restartReply != nil {
		reply <- errors.New("Multica restart already in progress") //nolint:staticcheck // Multica is a proper noun
		return
	}
	state.status.Restarts = 0
	state.fastCrashes = 0
	state.status.LastError = ""
	state.restartReply = reply
	if s.stopPending(state) {
		return
	}
	s.stop(ctx, state, nil)
}

func (s *Supervisor) stopPending(state *ownerState) bool {
	return state.closing || state.child != nil && state.child.stopping ||
		state.spawnInFlight && state.status.Desired == DesiredStopped || len(state.stopReplies) > 0
}

func (s *Supervisor) cancelPendingStarts(state *ownerState) {
	err := fmt.Errorf("%w (cancelled by a later stop)", ErrStopped)
	state.deferredStart = s.resolveReplies(state, state.deferredStart, err)
	if state.restartReply != nil {
		s.answer(state, state.restartReply, err)
		state.restartReply = nil
	}
}

func (s *Supervisor) stop(ctx context.Context, state *ownerState, reply chan error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !s.cfg.Enabled {
		if reply != nil {
			s.answer(state, reply, nil)
		}
		return
	}
	state.status.Desired = DesiredStopped
	s.clearRetry(state)
	if state.operation == "spawn" && state.operationCancel != nil {
		state.operationCancel()
	}
	if state.operation == "probe" {
		state.generation++
		if state.operationCancel != nil {
			state.operationCancel()
		}
		state.operation = ""
		state.operationCancel = nil
		state.startReplies = s.resolveReplies(state, state.startReplies, ErrStopped)
	}
	if reply != nil {
		state.stopReplies = append(state.stopReplies, reply)
	}
	if state.status.State == StateExternal || state.child == nil && !state.spawnInFlight {
		state.status.State = StateStopped
		state.status.PID = 0
		s.completeStop(state)
		return
	}
	state.status.State = StateStopped
	state.status.PID = 0
	if state.child == nil {
		return
	}
	if state.child.stopping {
		if state.closing && state.child.stopCancel != nil {
			state.child.stopCancel()
		}
		return
	}
	state.child.stopping = true
	child := state.child
	bound := s.cfg.StopTimeout
	if state.closing {
		bound = s.cfg.ShutdownTimeout
	}
	stopCtx, stopCancel := context.WithCancel(ctx)
	child.stopCancel = stopCancel
	go func() {
		result, err := s.stopProcess(stopCtx, child, bound)
		stopCancel()
		s.events <- stopResult{child: child, result: result, err: err}
	}()
}

func (s *Supervisor) completeStop(state *ownerState) {
	state.status.State = StateStopped
	state.status.Desired = DesiredStopped
	state.status.PID = 0
	for _, reply := range state.stopReplies {
		s.answer(state, reply, state.stopErr)
	}
	state.stopReplies = nil
	state.stopErr = nil
	s.publish(state)
	s.flushReplies(state)

	if state.closing {
		state.deferredStart = s.resolveReplies(state, state.deferredStart, ErrStopped)
		if state.restartReply != nil {
			s.answer(state, state.restartReply, ErrStopped)
			state.restartReply = nil
		}
		s.flushReplies(state)
		return
	}
	if len(state.deferredStart) == 0 && state.restartReply == nil {
		return
	}
	state.status.Desired = DesiredRunning
	state.status.State = StateStarting
	state.status.Restarts = 0
	state.fastCrashes = 0
	state.status.LastError = ""
	s.clearRetry(state)
	state.startReplies = append(state.startReplies, state.deferredStart...)
	state.deferredStart = nil
	if state.restartReply != nil {
		state.startReplies = append(state.startReplies, state.restartReply)
		state.restartReply = nil
	}
	s.beginStart(state)
}

func (s *Supervisor) beginShutdown(ctx context.Context, state *ownerState, reply chan error) {
	if reply != nil && state.closing {
		state.stopReplies = append(state.stopReplies, reply)
		return
	}
	state.closing = true
	state.status.Desired = DesiredStopped
	s.clearRetry(state)
	if state.operation == "spawn" && state.operationCancel != nil {
		state.operationCancel()
	}
	if state.operation == "probe" {
		state.generation++
		if state.operationCancel != nil {
			state.operationCancel()
		}
		state.operation = ""
		state.operationCancel = nil
		state.startReplies = s.resolveReplies(state, state.startReplies, ErrStopped)
	}
	if reply != nil {
		state.stopReplies = append(state.stopReplies, reply)
	}
	if state.status.State == StateExternal || state.child == nil && !state.spawnInFlight {
		state.status.State = StateStopped
		state.status.PID = 0
		s.completeStop(state)
		return
	}
	if state.child != nil && state.child.stopping && state.child.stopCancel != nil {
		state.child.stopCancel()
	}
	s.stop(ctx, state, nil)
}

func (s *Supervisor) finishClosing(state *ownerState) {
	s.completeStop(state)
	s.publish(state)
	s.flushReplies(state)
	for _, reply := range state.startReplies {
		reply <- ErrStopped
	}
	state.startReplies = nil
	close(s.logQueue)
}

func (s *Supervisor) beginStart(state *ownerState) {
	if !s.cfg.Enabled || state.status.Desired != DesiredRunning || state.closing {
		return
	}
	if state.operation != "" || state.spawnInFlight {
		return
	}
	state.generation++
	generation := state.generation
	ctx, cancel := context.WithCancel(context.Background())
	state.operationCancel = cancel
	state.operation = "probe"
	state.status.State = StateStarting
	state.status.PID = 0
	state.status.NextRetryAt = time.Time{}
	go func() {
		health, _ := s.fetchHealth(ctx)
		s.events <- startCheck{generation: generation, health: health}
	}()
}

func (s *Supervisor) handleEvent(state *ownerState, event any) {
	switch value := event.(type) {
	case startCheck:
		if value.generation != state.generation || state.operation != "probe" {
			return
		}
		state.operation = ""
		state.operationCancel = nil
		if state.status.Desired != DesiredRunning || state.closing {
			state.status.State = StateStopped
			state.startReplies = s.resolveReplies(state, state.startReplies, ErrStopped)
			return
		}
		if validHealth(value.health) {
			state.status.State = StateExternal
			state.status.Health = cloneHealth(value.health)
			state.status.HealthFetchedAt = s.cfg.Clock.Now()
			state.lastHealthFetch = state.status.HealthFetchedAt
			state.startReplies = s.resolveReplies(state, state.startReplies, ErrExternal)
			return
		}
		s.spawn(state)
	case startResult:
		if value.generation != state.generation {
			if value.process != nil {
				go s.discardProcess(value.process)
			}
			return
		}
		state.operation = ""
		state.operationCancel = nil
		state.spawnInFlight = false
		if value.process == nil {
			s.handleStartFailure(state, value.err)
			return
		}
		child := &childRun{process: value.process, done: make(chan struct{}), startedAt: s.cfg.Clock.Now()}
		state.child = child
		state.status.State = StateRunning
		state.status.PID = value.process.PID()
		state.status.StartedAt = child.startedAt
		state.status.NextRetryAt = time.Time{}
		state.status.LastError = ""
		if state.status.Desired == DesiredStopped || state.closing {
			state.startReplies = s.resolveReplies(state, state.startReplies, ErrStopped)
		} else {
			state.startReplies = s.resolveReplies(state, state.startReplies, nil)
		}
		go func() {
			child.result = child.process.Wait()
			close(child.done)
			s.events <- processExit{child: child, result: child.result}
		}()
		if state.status.Desired == DesiredStopped || state.closing {
			s.stop(context.Background(), state, nil)
		}
	case processExit:
		s.handleExit(state, value)
	case stopResult:
		s.handleStopResult(state, value)
	case logEvent:
		s.recordLog(state, value)
	case healthResult:
		s.handleHealth(state, value)
	}
}

func (s *Supervisor) handleHealth(state *ownerState, result healthResult) {
	now := s.cfg.Clock.Now()
	state.healthInFlight = false
	state.lastHealthFetch = now
	state.status.HealthFetchedAt = now
	switch state.status.State {
	case StateRunning:
		if result.health != nil {
			state.status.Health = cloneHealth(result.health)
		}
	case StateExternal:
		if validHealth(result.health) {
			state.status.Health = cloneHealth(result.health)
			return
		}
		// The daemon AO was staying away from is gone. AO does not take the
		// profile over by itself; an explicit Start does.
		state.status.State = StateStopped
		state.status.Desired = DesiredStopped
		state.status.Health = nil
		state.status.LastError = "the externally managed Multica daemon is no longer running"
	case StateStopped:
		if s.idle(state) && validHealth(result.health) {
			state.status.State = StateExternal
			state.status.Health = cloneHealth(result.health)
		}
	}
}

// idle reports whether AO has no child, no spawn and no start probe pending.
func (s *Supervisor) idle(state *ownerState) bool {
	return state.child == nil && !state.spawnInFlight && state.operation == ""
}

func (s *Supervisor) spawn(state *ownerState) {
	if state.status.Desired != DesiredRunning || state.closing {
		return
	}
	state.generation++
	generation := state.generation
	ctx, cancel := context.WithCancel(context.Background())
	state.operationCancel = cancel
	state.operation = "spawn"
	state.spawnInFlight = true
	spec := ProcessSpec{
		Executable:  s.cfg.Executable,
		Args:        []string{multicahost.HostCommand, "--watch-stdin"},
		Environment: s.childEnvironment(),
		Command:     s.cfg.Command,
	}
	go func() {
		process, err := s.cfg.ProcessFactory(ctx, spec, func(stream, line string) {
			select {
			case s.events <- logEvent{stream: stream, line: line}:
			default:
			}
		})
		s.events <- startResult{generation: generation, process: process, err: err}
	}()
}

func (s *Supervisor) handleStartFailure(state *ownerState, err error) {
	state.status.PID = 0
	if err == nil {
		err = errors.New("Multica host process did not start") //nolint:staticcheck // Multica is a proper noun
	}
	if state.status.Desired != DesiredRunning || state.closing {
		state.status.State = StateStopped
		state.status.LastError = err.Error()
		state.startReplies = s.resolveReplies(state, state.startReplies, ErrStopped)
		state.stopErr = nil
		s.completeStop(state)
		return
	}
	state.status.LastError = err.Error()
	state.startReplies = s.resolveReplies(state, state.startReplies, err)
	s.scheduleCrash(state, err, false)
}

func (s *Supervisor) handleExit(state *ownerState, event processExit) {
	child := state.child
	if child == nil || child != event.child {
		return
	}
	state.status.PID = 0
	state.status.StartedAt = child.startedAt
	result := event.result
	stoppedBySupervisor := child.stopping || state.status.Desired == DesiredStopped || state.closing
	status := &ExitStatus{Code: result.Code, Signal: result.Signal, At: s.cfg.Clock.Now(), Graceful: result.Code == multicahost.ExitOK && result.Signal == ""}
	state.status.LastExit = status
	if stoppedBySupervisor {
		state.status.State = StateStopped
		state.status.Desired = DesiredStopped
		if result.Err != nil {
			state.status.LastError = result.Err.Error()
		}
		state.child = nil
		state.stopErr = nil
		s.completeStop(state)
		return
	}
	state.child = nil
	if result.Code == multicahost.ExitOK {
		state.status.Desired = DesiredStopped
		state.status.State = StateStopped
		state.status.LastError = ""
		return
	}
	if result.Code == multicahost.ExitConfig {
		state.status.State = StateFailed
		state.status.LastError = s.exitReason(result, true)
		status.Crash = false
		return
	}
	status.Crash = true
	s.scheduleCrash(state, errors.New(s.exitReason(result, false)), s.cfg.Clock.Now().Sub(child.startedAt) >= s.cfg.StableRunDuration)
}

func (s *Supervisor) scheduleCrash(state *ownerState, err error, stable bool) {
	if stable {
		state.fastCrashes = 0
	} else {
		state.fastCrashes++
	}
	state.status.LastError = err.Error()
	if state.status.Desired != DesiredRunning || state.closing {
		state.status.State = StateStopped
		return
	}
	if state.fastCrashes >= s.cfg.MaxFastCrashes {
		state.status.State = StateFailed
		state.status.NextRetryAt = time.Time{}
		return
	}
	delay := s.cfg.BackoffBase
	for i := 1; i < state.fastCrashes; i++ {
		if delay >= s.cfg.BackoffMax/2 {
			delay = s.cfg.BackoffMax
			break
		}
		delay *= 2
	}
	if delay > s.cfg.BackoffMax {
		delay = s.cfg.BackoffMax
	}
	state.status.State = StateBackoff
	s.clearRetry(state)
	state.status.NextRetryAt = s.cfg.Clock.Now().Add(delay)
	state.retryTimer = s.cfg.Clock.NewTimer(delay)
	state.retryC = state.retryTimer.C()
}

func (s *Supervisor) handleStopResult(state *ownerState, event stopResult) {
	if state.child == nil || state.child != event.child {
		return
	}
	if state.closing && errors.Is(event.err, context.Canceled) {
		event.err = nil
	}
	result := event.result
	if state.child.doneClosed() {
		result = state.child.result
	}
	state.status.LastExit = &ExitStatus{Code: result.Code, Signal: result.Signal, At: s.cfg.Clock.Now(), Graceful: result.Code == multicahost.ExitOK && result.Signal == ""}
	state.child = nil
	state.status.State = StateStopped
	state.status.Desired = DesiredStopped
	state.status.PID = 0
	if event.err != nil {
		state.status.LastError = event.err.Error()
	}
	state.stopErr = event.err
	s.completeStop(state)
}

func (c *childRun) doneClosed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (s *Supervisor) refreshHealth(state *ownerState) {
	if !s.cfg.Enabled || state.healthInFlight || !s.watchesHealth(state) {
		return
	}
	if s.cfg.Clock.Now().Sub(state.lastHealthFetch) <= 2*time.Second {
		return
	}
	state.healthInFlight = true
	go func() {
		health, _ := s.fetchHealth(context.Background())
		s.events <- healthResult{health: health}
	}()
}

// watchesHealth reports whether the profile's health port is worth polling: the
// running child, an external daemon AO stays away from, or a stopped profile in
// which an external daemon could appear.
func (s *Supervisor) watchesHealth(state *ownerState) bool {
	switch state.status.State {
	case StateRunning, StateExternal:
		return true
	case StateStopped:
		return s.idle(state)
	}
	return false
}

func (s *Supervisor) fetchHealth(parent context.Context) (*Health, error) {
	ctx, cancel := context.WithTimeout(parent, s.cfg.HealthTimeout)
	defer cancel()
	requestURL := "http://127.0.0.1:" + strconv.Itoa(s.cfg.HealthPort) + "/health"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, http.NoBody)
	if err != nil {
		return nil, err
	}
	response, err := (&http.Client{Timeout: s.cfg.HealthTimeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("health endpoint returned %s", response.Status)
	}
	var raw struct {
		Status     string   `json:"status"`
		PID        int      `json:"pid"`
		DaemonID   string   `json:"daemon_id"`
		Profile    string   `json:"profile"`
		DeviceName string   `json:"device_name"`
		ServerURL  string   `json:"server_url"`
		Agents     []string `json:"agents"`
		Workspaces []struct {
			ID       string   `json:"id"`
			Runtimes []string `json:"runtimes"`
		} `json:"workspaces"`
	}
	if err := json.NewDecoder(response.Body).Decode(&raw); err != nil {
		return nil, err
	}
	health := &Health{
		Status: raw.Status, PID: raw.PID, DaemonID: raw.DaemonID, Profile: raw.Profile,
		DeviceName: raw.DeviceName, ServerURL: raw.ServerURL,
		Agents: append([]string(nil), raw.Agents...), WorkspaceCount: len(raw.Workspaces),
	}
	runtimes := make(map[string]struct{})
	for _, workspace := range raw.Workspaces {
		for _, id := range workspace.Runtimes {
			if id != "" {
				runtimes[id] = struct{}{}
			}
		}
	}
	for id := range runtimes {
		health.RuntimeIDs = append(health.RuntimeIDs, id)
	}
	sort.Strings(health.RuntimeIDs)
	return health, nil
}

func validHealth(health *Health) bool {
	return health != nil && (health.Status == "running" || health.Status == "starting") && health.PID > 0 && strings.TrimSpace(health.DaemonID) != ""
}

func (s *Supervisor) stopProcess(ctx context.Context, child *childRun, bound time.Duration) (ProcessExit, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if stdin := child.process.Stdin(); stdin != nil {
		_ = stdin.Close()
	}
	timer := s.cfg.Clock.NewTimer(bound)
	defer timer.Stop()
	select {
	case <-child.done:
		return child.result, nil
	case <-ctx.Done():
		_ = child.process.Kill()
		return s.waitAfterKill(child), ctx.Err()
	case <-timer.C():
		_ = child.process.Kill()
		return s.waitAfterKill(child), nil
	}
}

func (s *Supervisor) waitAfterKill(child *childRun) ProcessExit {
	timer := s.cfg.Clock.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-child.done:
		return child.result
	case <-timer.C():
		return ProcessExit{Code: -1, Err: errors.New("Multica host did not exit after kill")} //nolint:staticcheck // Multica is a proper noun
	}
}

func (s *Supervisor) discardProcess(process Process) {
	if stdin := process.Stdin(); stdin != nil {
		_ = stdin.Close()
	}
	_ = process.Kill()
	_ = process.Wait()
}

func (s *Supervisor) childEnvironment() []string {
	values := make(map[string]string)
	for _, entry := range BuildEnvironment(s.cfg.Environment) {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	values[multicahost.FlagEnv] = "1"
	values[multicahost.ProfileEnv] = s.cfg.Profile
	values[multicahost.HealthPortEnv] = strconv.Itoa(s.cfg.HealthPort)
	values[multicahost.CLIPathEnv] = s.cfg.CLIPath
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, key+"="+values[key])
	}
	return env
}

func (s *Supervisor) recordLog(state *ownerState, event logEvent) {
	line := fmt.Sprintf("%s: %s", event.stream, event.line)
	state.status.LogLines = append(state.status.LogLines, line)
	if len(state.status.LogLines) > maxLogTail {
		state.status.LogLines = append([]string(nil), state.status.LogLines[len(state.status.LogLines)-maxLogTail:]...)
	}
	select {
	case s.logQueue <- event:
	default:
	}
}

func (s *Supervisor) exitReason(result ProcessExit, configuration bool) string {
	reason := fmt.Sprintf("Multica host exited with code %d", result.Code)
	if result.Signal != "" {
		reason = "Multica host terminated by " + result.Signal
	}
	if result.Err != nil && result.Code < 0 {
		reason = result.Err.Error()
	}
	if configuration {
		stderr := make([]string, 0, 8)
		for _, line := range stateLogLines(s.snapshot.Load()) {
			if strings.HasPrefix(line, "stderr: ") {
				stderr = append(stderr, strings.TrimPrefix(line, "stderr: "))
			}
		}
		if len(stderr) > 8 {
			stderr = stderr[len(stderr)-8:]
		}
		if len(stderr) > 0 {
			reason += ": " + strings.Join(stderr, " | ")
		}
	}
	return reason
}

func stateLogLines(status *Status) []string {
	if status == nil {
		return nil
	}
	return status.LogLines
}

func (s *Supervisor) clearRetry(state *ownerState) {
	if state.retryTimer != nil {
		state.retryTimer.Stop()
	}
	state.retryTimer = nil
	state.retryC = nil
	state.status.NextRetryAt = time.Time{}
}

func (s *Supervisor) publish(state *ownerState) {
	status := cloneStatus(&state.status)
	s.snapshot.Store(&status)
}

func cloneStatus(status *Status) Status {
	if status == nil {
		return Status{}
	}
	cp := *status
	cp.LogLines = append([]string(nil), status.LogLines...)
	if status.LastExit != nil {
		exit := *status.LastExit
		cp.LastExit = &exit
	}
	cp.Health = cloneHealth(status.Health)
	return cp
}

func cloneHealth(health *Health) *Health {
	if health == nil {
		return nil
	}
	cp := *health
	cp.Agents = append([]string(nil), health.Agents...)
	cp.RuntimeIDs = append([]string(nil), health.RuntimeIDs...)
	return &cp
}

// answer queues a reply that is sent only after the owner has published the
// state the request produced, so the caller never reads a snapshot from before
// its own request took effect.
func (s *Supervisor) answer(state *ownerState, ch chan error, err error) {
	if ch != nil {
		state.outbox = append(state.outbox, pendingReply{ch: ch, err: err})
	}
}

func (s *Supervisor) flushReplies(state *ownerState) {
	for _, pending := range state.outbox {
		pending.ch <- pending.err
	}
	state.outbox = nil
}

//nolint:unparam // callers assign the result to clear the answered list
func (s *Supervisor) resolveReplies(state *ownerState, replies []chan error, err error) []chan error {
	for _, reply := range replies {
		s.answer(state, reply, err)
	}
	return nil
}
