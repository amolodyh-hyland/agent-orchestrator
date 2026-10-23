package factoryrun

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// MonitorStore reads existing participant facts and persists observation snapshots.
type MonitorStore interface {
	Store
	ApprovedActiveFactoryRuns(context.Context) ([]domain.FactoryRun, error)
	GetRunMonitor(context.Context, string) (domain.RunMonitoring, bool, error)
	SaveRunMonitor(context.Context, domain.RunMonitoring) error
	ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error)
	ListReportsBySession(context.Context, domain.SessionID) ([]domain.ReportRecord, error)
	ReportChatReceipt(context.Context, string) (domain.ReportDeliveryReceipt, bool, error)
	ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error)
	ListPRComments(context.Context, string) ([]domain.PullRequestComment, error)
	ListPRReviews(context.Context, string) ([]domain.PullRequestReview, error)
}

// Monitor restores passive observation without an execution callback.
type Monitor struct {
	store MonitorStore
	mu    chan struct{}
	now   func() time.Time
}

// NewMonitor constructs a monitor using durable run and report records.
func NewMonitor(store MonitorStore) *Monitor {
	return &Monitor{store: store, now: time.Now, mu: make(chan struct{}, 1)}
}

func (m *Monitor) lock(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case m.mu <- struct{}{}:
		return nil
	}
}

// Scan observes only confirmed run references, optionally within one project.
func (m *Monitor) Scan(ctx context.Context, project string) ([]domain.RunMonitoring, error) {
	if err := m.lock(ctx); err != nil {
		return nil, err
	}
	defer func() { <-m.mu }()
	runs, err := m.store.ApprovedActiveFactoryRuns(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RunMonitoring, 0, len(runs))
	for _, run := range runs {
		if project != "" && run.ProjectID != project {
			continue
		}
		observation, err := m.observe(ctx, run)
		if err != nil {
			return nil, err
		}
		out = append(out, observation)
	}
	return out, nil
}

// Get refreshes one approved run without submitting work.
func (m *Monitor) Get(ctx context.Context, id string) (domain.RunMonitoring, error) {
	if err := m.lock(ctx); err != nil {
		return domain.RunMonitoring{}, err
	}
	defer func() { <-m.mu }()
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
	if err := m.lock(ctx); err != nil {
		return domain.RunMonitoring{}, err
	}
	defer func() { <-m.mu }()
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
	if err := m.lock(ctx); err != nil {
		return domain.RunMonitoring{}, err
	}
	defer func() { <-m.mu }()
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
	state.Stage = run.Stage
	state.StageVersion = stageVersion
	state.ObservedAt = now
	state.State = "in_progress"
	state.Ownership = "unknown"
	state.Reports = []domain.RunReportObservation{}
	sessions, err := m.store.ListSessions(ctx, domain.ProjectID(run.ProjectID))
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
			prs, err := m.store.ListPRsBySession(ctx, session.ID)
			if err != nil {
				return state, err
			}
			for _, pr := range prs {
				snap.FeedbackPolicies = append(snap.FeedbackPolicies, fmt.Sprintf("pr:%s:ci=%t", pr.URL, pr.AutoInjectCI))
				comments, err := m.store.ListPRComments(ctx, pr.URL)
				if err != nil {
					return state, err
				}
				reviews, err := m.store.ListPRReviews(ctx, pr.URL)
				if err != nil {
					return state, err
				}
				for _, c := range comments {
					snap.FeedbackPolicies = append(snap.FeedbackPolicies, fmt.Sprintf("comment:%s:review=%t", c.ID, c.AutoInjectReview))
				}
				for _, r := range reviews {
					snap.FeedbackPolicies = append(snap.FeedbackPolicies, fmt.Sprintf("review:%s:review=%t", r.ID, r.AutoInjectReview))
				}
			}
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
		reports, err := m.store.ListReportsBySession(ctx, session.ID)
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
	if len(state.Reports) > 100 {
		state.Reports = state.Reports[len(state.Reports)-100:]
	}
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
