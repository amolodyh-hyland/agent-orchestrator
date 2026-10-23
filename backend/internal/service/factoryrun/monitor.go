package factoryrun

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// MonitorStore reads existing participant facts and persists observation snapshots.
type MonitorStore interface {
	Store
	ApprovedFactoryRunPage(context.Context, string, string, int64) ([]domain.FactoryRun, error)
	GetFactoryMonitorCursor(context.Context, string) (string, error)
	SaveFactoryMonitorCursor(context.Context, string, string) error
	GetRunMonitor(context.Context, string) (domain.RunMonitoring, bool, error)
	SaveRunMonitor(context.Context, domain.RunMonitoring) error
	FactoryMonitorParticipants(context.Context, string, domain.SessionID) ([]domain.SessionRecord, error)
	FactoryMonitorReports(context.Context, domain.SessionID, time.Time) ([]domain.ReportRecord, error)
	ReportChatReceipt(context.Context, string) (domain.ReportDeliveryReceipt, bool, error)
	FactoryMonitorPolicies(context.Context, domain.SessionID) ([]string, error)
}

// Monitor restores passive observation without an execution callback.
type Monitor struct {
	store MonitorStore
	mu    sync.Mutex
	runs  map[string]chan struct{}
	sweep chan struct{}
	now   func() time.Time
}

// NewMonitor constructs a monitor using durable run and report records.
func NewMonitor(store MonitorStore) *Monitor {
	return &Monitor{store: store, now: time.Now, runs: make(map[string]chan struct{}), sweep: make(chan struct{}, 1)}
}
func (m *Monitor) lock(ctx context.Context, id string) (func(), error) {
	m.mu.Lock()
	semaphore := m.runs[id]
	if semaphore == nil {
		semaphore = make(chan struct{}, 1)
		m.runs[id] = semaphore
	}
	m.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case semaphore <- struct{}{}:
		return func() { <-semaphore }, nil
	}
}

// Scan advances one durable batch; a timed-out run cannot starve later references.
func (m *Monitor) Scan(ctx context.Context, project string) ([]domain.RunMonitoring, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case m.sweep <- struct{}{}:
	}
	defer func() { <-m.sweep }()
	after, err := m.store.GetFactoryMonitorCursor(ctx, project)
	if err != nil {
		return nil, err
	}
	runs, err := m.store.ApprovedFactoryRunPage(ctx, project, after, 25)
	if err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		if err := m.store.SaveFactoryMonitorCursor(ctx, project, ""); err != nil {
			return nil, err
		}
		runs, err = m.store.ApprovedFactoryRunPage(ctx, project, "", 25)
		if err != nil {
			return nil, err
		}
	}
	out := make([]domain.RunMonitoring, 0, len(runs))
	var firstErr error
	for _, run := range runs {
		if err := m.store.SaveFactoryMonitorCursor(ctx, project, run.ID); err != nil {
			return out, err
		}
		release, err := m.lock(ctx, run.ID)
		if err != nil {
			return out, err
		}
		observation, err := m.observe(ctx, run)
		release()
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			if ctx.Err() != nil {
				return out, err
			}
			continue
		}
		out = append(out, observation)
	}
	return out, firstErr
}

// List reads available snapshots without waiting for a sweep or refreshing every run.
func (m *Monitor) List(ctx context.Context, project, after string, limit int64) ([]domain.RunMonitoring, string, error) {
	if limit < 1 || limit > 100 {
		return nil, "", invalid("Monitoring page size must be 1..100")
	}
	runs, err := m.store.ApprovedFactoryRunPage(ctx, project, after, limit+1)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if int64(len(runs)) > limit {
		runs = runs[:limit]
		next = runs[len(runs)-1].ID
	}
	out := make([]domain.RunMonitoring, 0, len(runs))
	for _, run := range runs {
		state, found, err := m.store.GetRunMonitor(ctx, run.ID)
		if err != nil {
			return nil, "", err
		}
		if !found {
			state = domain.RunMonitoring{RunID: run.ID, ProjectID: run.ProjectID, TaskID: run.TaskID, DelegationID: run.DelegationID, Stage: run.Stage, State: "in_progress", Ownership: "unknown", Freshness: "unobserved", Participants: []domain.RunParticipantSnapshot{}, Reports: []domain.RunReportObservation{}}
		}
		state.SessionID = run.SessionID
		out = append(out, state)
	}
	return out, next, nil
}

// Get refreshes one approved run without submitting work.
func (m *Monitor) Get(ctx context.Context, id string) (domain.RunMonitoring, error) {
	release, err := m.lock(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, err
	}
	defer release()
	run, err := m.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, failure(err)
	}
	return m.observe(ctx, run)
}

// Configure changes display deadlines and ownership labels only.
func (m *Monitor) Configure(ctx context.Context, id string, c domain.RunMonitorConfig) (domain.RunMonitoring, error) {
	if c.SilenceSeconds < 1 || c.SilenceSeconds > 86400 || c.BuildSeconds < c.SilenceSeconds || c.BuildSeconds > 604800 || len(c.NextOwner) > 200 {
		return domain.RunMonitoring{}, invalid("Silence must be 1..86400 seconds, build silence at least silence and at most 604800 seconds; owner at most 200 characters")
	}
	release, err := m.lock(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, err
	}
	defer release()
	run, err := m.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, failure(err)
	}
	state, err := m.observe(ctx, run)
	if err != nil {
		return state, err
	}
	state.Config = c
	if err := m.store.SaveRunMonitor(ctx, state); err != nil {
		return state, err
	}
	return m.observe(ctx, run)
}

// Acknowledge records display acknowledgement without consuming a report.
func (m *Monitor) Acknowledge(ctx context.Context, id, key string) (domain.RunMonitoring, error) {
	release, err := m.lock(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, err
	}
	defer release()
	run, err := m.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunMonitoring{}, failure(err)
	}
	state, err := m.observe(ctx, run)
	if err != nil {
		return state, err
	}
	if state.Attention == nil || state.Attention.Key != key {
		return state, invalid("Attention changed; refresh before acknowledging")
	}
	now := m.now().UTC()
	state.Attention.AcknowledgedAt = &now
	return state, m.store.SaveRunMonitor(ctx, state)
}
func (m *Monitor) observe(ctx context.Context, run domain.FactoryRun) (domain.RunMonitoring, error) {
	state, found, err := m.store.GetRunMonitor(ctx, run.ID)
	if err != nil {
		return state, err
	}
	now := m.now().UTC()
	if !found {
		state = domain.RunMonitoring{RunID: run.ID, ProjectID: run.ProjectID, TaskID: run.TaskID, DelegationID: run.DelegationID, Config: domain.RunMonitorConfig{SilenceSeconds: 300, BuildSeconds: 1800, NextOwner: string(run.SessionID)}, Participants: []domain.RunParticipantSnapshot{}}
	}
	history, err := m.store.CurrentRunEvidence(ctx, run.ID, run.Version)
	if err != nil {
		return state, err
	}
	approved := slices.ContainsFunc(history, func(e domain.RunEvidence) bool { return e.Kind == "created" && e.Confirmed })
	if !approved {
		return state, invalid("Only natively approved run references are monitored")
	}
	stageAt := run.CreatedAt
	stageVersion := int64(0)
	for _, e := range history {
		if e.Kind == "advance" && e.Confirmed {
			stageAt = e.RecordedAt
			stageVersion = e.Version
		}
	}
	if state.Stage != run.Stage || state.StageVersion != stageVersion {
		state.Attention = nil
		state.Config.StageDeadline = nil
		state.Config.Heavy = false
		switch run.Stage {
		case "implementation":
			state.Config.NextOwner = string(run.SessionID)
		case "review":
			state.Config.NextOwner = "human:select independent reviewer"
		default:
			state.Config.NextOwner = "human"
		}

	}
	state.SessionID = run.SessionID
	state.Stage = run.Stage
	state.StageVersion = stageVersion
	state.ObservedAt = now
	state.State = "in_progress"
	state.Ownership = "unknown"
	state.Reports = []domain.RunReportObservation{}
	sessions, err := m.store.FactoryMonitorParticipants(ctx, run.ProjectID, run.SessionID)
	if err != nil {
		return state, err
	}
	last := stageAt
	for _, session := range sessions {
		if session.ID != run.SessionID && session.Kind != domain.KindOrchestrator {
			continue
		}
		if session.IsTerminated && session.ID != run.SessionID {
			continue
		}
		if !slices.ContainsFunc(state.Participants, func(p domain.RunParticipantSnapshot) bool { return p.SessionID == session.ID }) {
			snap := domain.RunParticipantSnapshot{SessionID: session.ID, AutoReview: session.AutoReviewEnabled, AutoInjectCI: session.AutoInjectCI, AutoInjectReview: session.AutoInjectReview, CapturedAt: now, FeedbackPolicies: []string{}, ReportRoute: "worker_reports_to_project_orchestrator:display_only"}
			policies, err := m.store.FactoryMonitorPolicies(ctx, session.ID)
			if err != nil {
				return state, err
			}
			snap.FeedbackPolicies = policies
			state.Participants = append(state.Participants, snap)
		}
		if session.ID != run.SessionID {
			continue
		}
		if !session.IsTerminated && session.Activity.State != domain.ActivityExited {
			rows, err := m.store.ListSessionWorktrees(ctx, run.SessionID)
			if err != nil {
				return state, err
			}
			bindingsMatch := len(rows) == len(run.Repositories)
			if len(rows) == 0 && len(run.Repositories) == 1 {
				b := run.Repositories[0]
				bindingsMatch = sameMonitorPath(session.Metadata.WorkspacePath, b.WorktreePath) && session.Metadata.Branch == b.Branch && session.Metadata.DiffBaseSHA == b.BaseSHA
			}
			for _, binding := range run.Repositories {
				if len(rows) > 0 && !slices.ContainsFunc(rows, func(row domain.SessionWorktreeRecord) bool {
					return row.RepoName == binding.RepoName && sameMonitorPath(row.WorktreePath, binding.WorktreePath) && row.BaseSHA == binding.BaseSHA && row.Branch == binding.Branch && row.State == "active"
				}) {
					bindingsMatch = false
				}
			}
			if bindingsMatch {
				state.Ownership = "retained"
			}
		}
		if session.Activity.LastActivityAt.After(last) && !session.Activity.LastActivityAt.After(now) {
			last = session.Activity.LastActivityAt
		}
		reports, err := m.store.FactoryMonitorReports(ctx, session.ID, stageAt)
		if err != nil {
			return state, err
		}
		for _, r := range reports {
			if r.CreatedAt.Before(stageAt) || r.ProjectID != domain.ProjectID(run.ProjectID) {
				continue
			}
			if r.CreatedAt.After(last) && !r.CreatedAt.After(now) {
				last = r.CreatedAt
			}
			receipt := "unavailable"
			if r.DeliveryBatchID != "" {
				native, ok, err := m.store.ReportChatReceipt(ctx, r.DeliveryBatchID)
				if err != nil {
					return state, err
				}
				if ok {
					receipt = string(native.State)
				}
			}
			state.Reports = append(state.Reports, domain.RunReportObservation{ID: r.ID, RecordedAt: r.CreatedAt, DeliveryState: string(r.DeliveryState), NativeReceipt: receipt})
		}
	}
	slices.Reverse(state.Reports)
	state.LastActivityAt = last
	silence := state.Config.SilenceSeconds
	if state.Config.Heavy {
		silence = state.Config.BuildSeconds
	}
	state.Deadline = last.Add(time.Duration(silence) * time.Second)
	if state.Config.StageDeadline != nil && state.Config.StageDeadline.Before(state.Deadline) {
		state.Deadline = *state.Config.StageDeadline
	}
	state.Freshness = "current"
	condition := ""
	if state.Ownership == "unknown" {
		condition = "ownership_unknown"
		state.Freshness = "unknown"
	} else if !now.Before(state.Deadline) {
		condition = "silence"
		state.Freshness = "stale"
	}
	if condition == "" {
		state.Attention = nil
	} else {
		key := fmt.Sprintf("%s/%s/%s/%d/%s", run.ProjectID, run.ID, run.Stage, stageVersion, condition)
		if state.Attention == nil || state.Attention.Key != key {
			state.Attention = &domain.RunAttention{Key: key, Condition: condition, FirstAt: now}
		}
		state.Attention.LastAt = now
	}
	return state, m.store.SaveRunMonitor(ctx, state)
}

func sameMonitorPath(a, b string) bool {
	if a == b {
		return true
	}
	left, leftErr := filepath.EvalSymlinks(a)
	right, rightErr := filepath.EvalSymlinks(b)
	return leftErr == nil && rightErr == nil && left == right
}
