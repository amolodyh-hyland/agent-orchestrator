package multicasupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

var (
	ErrDisabled   = errors.New("Multica hosting is disabled")
	ErrExternal   = errors.New("Multica daemon is externally managed")
	ErrNotRunning = errors.New("Multica supervisor is not running")
	ErrStopped    = errors.New("Multica start was cancelled by stop")
)

const (
	maxLogTail       = 40
	loggerQueueSize  = 512
	ownerQueueSize   = 512
	defaultStopBound = 40 * time.Second
	defaultExitBound = 20 * time.Second
)

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
	generation uint64
	result     ProcessExit
}

type stopResult struct {
	generation uint64
	result     ProcessExit
	err        error
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
	restartReply    chan error
	closing         bool
	healthInFlight  bool
	lastHealthFetch time.Time
	fastCrashes     int
	retryTimer      Timer
	retryC          <-chan time.Time
}

func New(cfg Config, logger *slog.Logger) *Supervisor {
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Clock == nil {
		cfg.Clock = realClock{}
	}
	if cfg.Command == nil {
		cfg.Command = exec.Command
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
	go s.runOwner(ctx)
}

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

func (s *Supervisor) Start(ctx context.Context) error {
	return s.send(ctx, requestStart)
}

func (s *Supervisor) Stop(ctx context.Context) error {
	return s.send(ctx, requestStop)
}

func (s *Supervisor) Restart(ctx context.Context) error {
	return s.send(ctx, requestRestart)
}

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
			s.beginShutdown(&state, nil, context.Background())
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
		s.stop(state, req.resp, req.ctx, false)
	case requestRestart:
		s.restart(state, req.resp, req.ctx)
	case requestShutdown:
		s.beginShutdown(state, req.resp, req.ctx)
	}
}

func (s *Supervisor) start(state *ownerState, reply chan error) {
	if !s.cfg.Enabled {
		reply <- ErrDisabled
		return
	}
	if state.closing {
		reply <- ErrStopped
		return
	}
	if state.status.State == StateRunning {
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

func (s *Supervisor) restart(state *ownerState, reply chan error, ctx context.Context) {
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
		reply <- errors.New("Multica restart already in progress")
		return
	}
	state.status.Restarts = 0
	state.fastCrashes = 0
	state.status.LastError = ""
	state.restartReply = reply
	s.stop(state, nil, ctx, true)
}

func (s *Supervisor) stop(state *ownerState, reply chan error, ctx context.Context, forRestart bool) {
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
	if state.status.State == StateExternal || state.child == nil && !state.spawnInFlight {
		state.status.State = StateStopped
		state.status.PID = 0
		if !forRestart {
			if reply != nil {
				s.answer(state, reply, nil)
			}
		} else {
			s.startAfterStop(state)
		}
		return
	}
	if reply != nil {
		state.stopReplies = append(state.stopReplies, reply)
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
	childGeneration := state.generation
	bound := s.cfg.StopTimeout
	if state.closing {
		bound = s.cfg.ShutdownTimeout
	}
	stopCtx, stopCancel := context.WithCancel(ctx)
	child.stopCancel = stopCancel
	go func() {
		result, err := s.stopProcess(stopCtx, child, bound)
		stopCancel()
		s.events <- stopResult{generation: childGeneration, result: result, err: err}
	}()
}

func (s *Supervisor) startAfterStop(state *ownerState) {
	state.status.Desired = DesiredRunning
	state.status.State = StateStarting
	state.status.Restarts = 0
	state.fastCrashes = 0
	state.startReplies = append(state.startReplies, state.restartReply)
	state.restartReply = nil
	s.beginStart(state)
}

func (s *Supervisor) beginShutdown(state *ownerState, reply chan error, ctx context.Context) {
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
		return
	}
	if state.child != nil && state.child.stopping && state.child.stopCancel != nil {
		state.child.stopCancel()
	}
	s.stop(state, nil, ctx, false)
}

func (s *Supervisor) finishClosing(state *ownerState) {
	s.publish(state)
	s.flushReplies(state)
	for _, reply := range state.stopReplies {
		reply <- nil
	}
	state.stopReplies = nil
	for _, reply := range state.startReplies {
		reply <- ErrStopped
	}
	state.startReplies = nil
	if state.restartReply != nil {
		state.restartReply <- ErrStopped
		state.restartReply = nil
	}
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
		state.startReplies = s.resolveReplies(state, state.startReplies, nil)
		generation := state.generation
		go func() {
			child.result = child.process.Wait()
			close(child.done)
			s.events <- processExit{generation: generation, result: child.result}
		}()
		if state.status.Desired == DesiredStopped || state.closing {
			s.stop(state, nil, context.Background(), false)
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
		err = errors.New("Multica host process did not start")
	}
	state.status.LastError = err.Error()
	state.startReplies = s.resolveReplies(state, state.startReplies, err)
	if state.status.Desired != DesiredRunning || state.closing {
		state.status.State = StateStopped
		for _, reply := range state.stopReplies {
			s.answer(state, reply, nil)
		}
		state.stopReplies = nil
		if state.restartReply != nil && !state.closing {
			s.startAfterStop(state)
		}
		return
	}
	s.scheduleCrash(state, err, false)
}

func (s *Supervisor) handleExit(state *ownerState, event processExit) {
	child := state.child
	if child == nil || event.generation != state.generation {
		return
	}
	state.status.PID = 0
	state.status.StartedAt = child.startedAt
	result := event.result
	stoppedBySupervisor := child.stopping || state.status.Desired == DesiredStopped || state.closing
	status := &ExitStatus{Code: result.Code, Signal: result.Signal, At: s.cfg.Clock.Now(), Graceful: stoppedBySupervisor || result.Code == multicahost.ExitOK}
	state.status.LastExit = status
	if stoppedBySupervisor {
		state.status.State = StateStopped
		state.status.Desired = DesiredStopped
		if result.Err != nil {
			state.status.LastError = result.Err.Error()
		}
		if !child.stopping {
			state.child = nil
		}
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
	if state.child == nil || event.generation != state.generation {
		return
	}
	if state.closing && errors.Is(event.err, context.Canceled) {
		event.err = nil
	}
	result := event.result
	if state.child.doneClosed() {
		result = state.child.result
	}
	state.status.LastExit = &ExitStatus{Code: result.Code, Signal: result.Signal, At: s.cfg.Clock.Now(), Graceful: true}
	state.child = nil
	state.status.State = StateStopped
	state.status.Desired = DesiredStopped
	state.status.PID = 0
	if event.err != nil {
		state.status.LastError = event.err.Error()
	}
	for _, reply := range state.stopReplies {
		s.answer(state, reply, event.err)
	}
	state.stopReplies = nil
	if state.restartReply != nil && !state.closing {
		s.startAfterStop(state)
	}
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := (&http.Client{Timeout: s.cfg.HealthTimeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
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
	s.requestChildShutdown(ctx, child)
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

// requestChildShutdown POSTs /shutdown to the health port, but only when the
// daemon answering there is this child: after the child died or while another
// daemon holds the port, the request would stop someone else's daemon.
func (s *Supervisor) requestChildShutdown(ctx context.Context, child *childRun) {
	bound := min(s.cfg.HealthTimeout, time.Second)
	shutdownCtx, cancel := context.WithTimeout(ctx, 2*bound)
	defer cancel()
	health, err := s.fetchHealth(shutdownCtx)
	if err != nil || health == nil || health.PID != child.process.PID() {
		return
	}
	requestURL := (&url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(s.cfg.HealthPort), Path: "/shutdown"}).String()
	req, err := http.NewRequestWithContext(shutdownCtx, http.MethodPost, requestURL, nil)
	if err != nil {
		return
	}
	response, err := (&http.Client{Timeout: bound}).Do(req)
	if err == nil {
		_ = response.Body.Close()
	}
}

func (s *Supervisor) waitAfterKill(child *childRun) ProcessExit {
	timer := s.cfg.Clock.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-child.done:
		return child.result
	case <-timer.C():
		return ProcessExit{Code: -1, Err: errors.New("Multica host did not exit after kill")}
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
	copy := *status
	copy.LogLines = append([]string(nil), status.LogLines...)
	if status.LastExit != nil {
		exit := *status.LastExit
		copy.LastExit = &exit
	}
	copy.Health = cloneHealth(status.Health)
	return copy
}

func cloneHealth(health *Health) *Health {
	if health == nil {
		return nil
	}
	copy := *health
	copy.Agents = append([]string(nil), health.Agents...)
	copy.RuntimeIDs = append([]string(nil), health.RuntimeIDs...)
	return &copy
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

func (s *Supervisor) resolveReplies(state *ownerState, replies []chan error, err error) []chan error {
	for _, reply := range replies {
		s.answer(state, reply, err)
	}
	return nil
}
