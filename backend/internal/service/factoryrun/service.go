package factoryrun

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionartifacts"
)

// Store provides existing ownership/report/review facts and the run ledger.
type Store interface {
	feedbackStore
	GetProject(context.Context, string) (domain.ProjectRecord, bool, error)
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListSessionWorktrees(context.Context, domain.SessionID) ([]domain.SessionWorktreeRecord, error)
	ListWorkspaceRepos(context.Context, string) ([]domain.WorkspaceRepoRecord, error)
	GetReport(context.Context, string) (domain.ReportRecord, bool, error)
	GetReviewRun(context.Context, string) (domain.ReviewRun, bool, error)
	GetReviewByID(context.Context, string) (domain.Review, bool, error)
	GetFactoryRun(context.Context, string) (domain.FactoryRun, error)
	ListFactoryRuns(context.Context, string) ([]domain.FactoryRun, error)
	ListRunEvidence(context.Context, string) ([]domain.RunEvidence, error)
	PageRunEvidence(context.Context, string, int64, int64) ([]domain.RunEvidence, error)
	CurrentRunEvidence(context.Context, string, int64) ([]domain.RunEvidence, error)
	SaveFactoryRun(context.Context, domain.FactoryRun, domain.RunEvidence, bool) error
}

// RepositoryReader observes owned source and verifies referenced artifact bytes.
type RepositoryReader interface {
	Inspect(context.Context, string, string, string) (domain.RunRepoFacts, error)
	VerifyArtifact(context.Context, string, domain.RunArtifact) error
}

// CreateInput records a human-approved task and its required evidence.
type CreateInput struct {
	ID             string           `json:"id"`
	ProjectID      string           `json:"projectId"`
	TaskID         string           `json:"taskId"`
	SessionID      domain.SessionID `json:"sessionId"`
	Source         domain.RunSource `json:"source"`
	DesignDigest   string           `json:"designDigest"`
	PolicyDecision string           `json:"policyDecision"`
	DelegationID   string           `json:"delegationId,omitempty"`
	RequiredChecks []string         `json:"requiredChecks"`
	Actor          string           `json:"actor"`
	Decision       string           `json:"decision"`
}

// RecordInput appends one receipt at an expected version.
type RecordInput struct {
	ExpectedVersion int64                    `json:"expectedVersion"`
	Actor           string                   `json:"actor"`
	Decision        string                   `json:"decision"`
	Completion      *domain.RunCompletion    `json:"completion,omitempty"`
	Review          *domain.RunReviewReceipt `json:"review,omitempty"`
}

// AdvanceInput records a human stage decision at an expected version.
type AdvanceInput struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Actor           string `json:"actor"`
	Decision        string `json:"decision"`
}

// Service verifies evidence and gates explicitly confirmed findings continuations.
type Service struct {
	store    Store
	repos    RepositoryReader
	dataDir  string
	feedback FeedbackTransport
	epoch    string
	now      func() time.Time
}

// Option configures the run evidence service.
type Option func(*Service)

// WithClock supplies the authority deadline clock.
func WithClock(now func() time.Time) Option { return func(s *Service) { s.now = now } }

// New constructs the run evidence service with read-only source inspection.
func New(store Store, repos RepositoryReader, dataDir string, options ...Option) *Service {
	s := &Service{store: store, repos: repos, dataDir: dataDir, epoch: uuid.NewString(), now: time.Now}
	for _, option := range options {
		option(s)
	}
	return s
}

func invalid(message string) error { return apierr.Invalid("RUN_INVALID", message, nil) }
func failure(err error) error {
	if errors.Is(err, domain.ErrRunConflict) {
		return apierr.Conflict("RUN_VERSION_CONFLICT", "Run changed; read the latest version before retrying", nil)
	}
	if errors.Is(err, domain.ErrRunNotFound) {
		return apierr.NotFound("RUN_NOT_FOUND", "Run not found")
	}
	return err
}
func bounded(value any) bool {
	data, err := json.Marshal(value)
	return err == nil && len(data) <= 64<<10
}
func decision(actor, note string) bool {
	return strings.TrimSpace(actor) != "" && strings.TrimSpace(note) != "" && len(actor) <= 200 && len(note) <= 1000
}

// List returns persisted runs without changing delivery or execution.
func (s *Service) List(ctx context.Context, projectID string) ([]domain.FactoryRun, error) {
	if projectID == "" {
		return nil, invalid("Project id is required")
	}
	return s.store.ListFactoryRuns(ctx, projectID)
}

// Create snapshots owned bindings and records the initial human decision.
func (s *Service) Create(ctx context.Context, in CreateInput) (domain.RunDetail, error) {
	if !bounded(in) || !decision(in.Actor, in.Decision) || in.ID == "" || len(in.ID) > 128 || in.TaskID == "" || in.PolicyDecision == "" || !domain.SHA256Digest(in.DesignDigest) || len(in.RequiredChecks) == 0 || len(in.RequiredChecks) > 50 {
		return domain.RunDetail{}, invalid("Run id, task, approved design digest, policy decision, required checks and human decision are required")
	}
	seen := map[string]bool{}
	for _, name := range in.RequiredChecks {
		if strings.TrimSpace(name) == "" || len(name) > 128 || seen[name] {
			return domain.RunDetail{}, invalid("Check names must be nonempty and unique")
		}
		seen[name] = true
	}
	run := domain.FactoryRun{ID: in.ID, ProjectID: in.ProjectID, TaskID: in.TaskID, SessionID: in.SessionID, Source: in.Source, DesignDigest: in.DesignDigest, PolicyDecision: in.PolicyDecision, DelegationID: in.DelegationID, RequiredChecks: slices.Clone(in.RequiredChecks), Stage: "design", CreatedAt: time.Now().UTC()}
	_, repos, err := s.owned(ctx, run)
	if err != nil {
		return domain.RunDetail{}, err
	}
	for _, repo := range repos {
		facts, err := s.repos.Inspect(ctx, repo.path, repo.row.WorktreePath, repo.row.BaseSHA)
		if err != nil || facts.Branch != repo.row.Branch {
			return domain.RunDetail{}, invalid("Owned repository facts are unavailable or inconsistent")
		}
		run.Repositories = append(run.Repositories, domain.RunRepoBinding{RepoName: repo.row.RepoName, RepoPath: facts.RepoPath, WorktreePath: facts.WorktreePath, BaseSHA: facts.BaseSHA, Branch: facts.Branch})
	}
	evidence := event(run, "created", in.Actor, in.Decision)
	if err := s.store.SaveFactoryRun(ctx, run, evidence, true); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, run.ID)
}

func event(run domain.FactoryRun, kind, actor, note string) domain.RunEvidence {
	return domain.RunEvidence{ID: "runev_" + uuid.NewString(), RunID: run.ID, Version: run.Version, Kind: kind, Actor: actor, Decision: note, Stage: run.Stage, RecordedAt: time.Now().UTC(), Blockers: []string{}, Observed: []domain.RunRepoFacts{}}
}

type ownedRepo struct {
	path string
	row  domain.SessionWorktreeRecord
}

func (s *Service) owned(ctx context.Context, run domain.FactoryRun) (domain.SessionRecord, []ownedRepo, error) {
	session, ok, err := s.store.GetSession(ctx, run.SessionID)
	if err != nil {
		return session, nil, err
	}
	if !ok || string(session.ProjectID) != run.ProjectID {
		return session, nil, invalid("Session must belong to the run project")
	}
	project, ok, err := s.store.GetProject(ctx, run.ProjectID)
	if err != nil {
		return session, nil, err
	}
	if !ok || project.Kind == domain.ProjectKindScratch {
		return session, nil, invalid("A registered repository project is required")
	}
	rows, err := s.store.ListSessionWorktrees(ctx, run.SessionID)
	if err != nil {
		return session, nil, err
	}
	if len(rows) == 0 && project.Kind.WithDefault() == domain.ProjectKindSingleRepo {
		rows = []domain.SessionWorktreeRecord{{SessionID: session.ID, RepoName: domain.RootWorkspaceRepoName, Branch: session.Metadata.Branch, BaseSHA: session.Metadata.DiffBaseSHA, WorktreePath: session.Metadata.WorkspacePath, State: "active"}}
	}
	if len(rows) > 8 {
		return session, nil, invalid("At most eight owned repositories are supported per run")
	}
	if len(rows) == 0 {
		return session, nil, invalid("Owned worktree records are required")
	}
	paths := map[string]string{domain.RootWorkspaceRepoName: project.Path}
	if project.Kind == domain.ProjectKindWorkspace {
		children, err := s.store.ListWorkspaceRepos(ctx, run.ProjectID)
		if err != nil {
			return session, nil, err
		}
		for _, child := range children {
			if !filepath.IsLocal(child.RelativePath) {
				return session, nil, invalid("Registered child repository path is invalid")
			}
			paths[child.Name] = filepath.Join(project.Path, child.RelativePath)
		}
		if len(rows) != len(paths) {
			return session, nil, invalid("Every registered repository needs an owned worktree")
		}
	}
	repos := make([]ownedRepo, 0, len(rows))
	for _, row := range rows {
		path := paths[row.RepoName]
		if path == "" || row.WorktreePath == "" || !domain.FullCommit(row.BaseSHA) || row.Branch == "" || row.State != "active" {
			return session, nil, invalid("Owned repository, worktree, branch and base are required")
		}
		repos = append(repos, ownedRepo{path: path, row: row})
	}
	if len(run.Repositories) > 0 && len(run.Repositories) != len(repos) {
		return session, nil, invalid("Owned repository set changed")
	}
	return session, repos, nil
}

// Get rechecks evidence against current ownership, source and artifact facts.
func (s *Service) Get(ctx context.Context, id string) (domain.RunDetail, error) {
	run, err := s.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunDetail{}, failure(err)
	}
	history, err := s.store.CurrentRunEvidence(ctx, id, run.Version)
	if err != nil {
		return domain.RunDetail{}, err
	}

	page, err := s.store.PageRunEvidence(ctx, id, max(-1, run.Version-100), min(100, run.Version+1))
	if err != nil {
		return domain.RunDetail{}, err
	}
	feedback, err := s.feedbackReceipts(ctx, run.ID)
	if err != nil {
		return domain.RunDetail{}, err
	}
	revision, paused, err := s.feedbackControl(ctx, run.ID)
	if err != nil {
		return domain.RunDetail{}, err
	}
	detail := domain.RunDetail{FeedbackRevision: revision, FeedbackPaused: paused, Feedback: feedback, Run: run, Evidence: page, Blockers: []string{}, Observed: []domain.RunRepoFacts{}}
	detail.Blockers, detail.Observed = s.evaluate(ctx, run, history, run.Stage == "review" || run.Stage == "handoff")
	switch run.Stage {
	case "design":
		detail.NextAction = "advance_to_implementation"
		detail.Blockers = slices.DeleteFunc(detail.Blockers, func(code string) bool { return strings.HasSuffix(code, ":completion_missing") })
	case "implementation":
		detail.NextAction = "advance_to_review"
	case "review":
		detail.NextAction = "advance_to_handoff"
	case "handoff":
		detail.NextAction = "human_release_decision"
		if !handoffMatches(history, detail.Observed) {
			detail.Blockers = append(detail.Blockers, "handoff_decision_stale")
		}
	}
	if len(detail.Blockers) > 0 {
		detail.NextAction = "hold"
	}
	return detail, nil
}

func handoffMatches(history []domain.RunEvidence, observed []domain.RunRepoFacts) bool {
	for i := len(history) - 1; i >= 0; i-- {
		evidence := history[i]
		if !evidence.Confirmed || evidence.Kind != "advance" || evidence.Stage != "handoff" {
			continue
		}
		if len(evidence.Observed) != len(observed) {
			return false
		}
		for _, facts := range observed {
			index := slices.IndexFunc(evidence.Observed, func(before domain.RunRepoFacts) bool { return before.WorktreePath == facts.WorktreePath })
			if index < 0 || !sameFacts(evidence.Observed[index], facts) {
				return false
			}
		}
		return len(observed) > 0
	}
	return false
}

// Record retains a completion or review claim even when verification holds readiness.
func (s *Service) Record(ctx context.Context, id string, in RecordInput) (domain.RunDetail, error) {
	if !bounded(in) || !decision(in.Actor, in.Decision) || (in.Completion == nil) == (in.Review == nil) {
		return domain.RunDetail{}, invalid("One completion or review receipt and a human decision are required")
	}
	run, err := s.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunDetail{}, failure(err)
	}
	if run.Version >= 511 {
		return domain.RunDetail{}, invalid("Run evidence limit reached; history is preserved and read-only")
	}
	if run.Version != in.ExpectedVersion {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	repoName := ""
	if in.Completion != nil {
		repoName = in.Completion.RepoName
	}
	if in.Review != nil {
		repoName = in.Review.RepoName
	}
	if !slices.ContainsFunc(run.Repositories, func(b domain.RunRepoBinding) bool { return b.RepoName == repoName }) {
		return domain.RunDetail{}, invalid("Receipt repository is not owned by this run")
	}
	if in.Review != nil {
		duplicate, err := s.admitReview(ctx, run, *in.Review)
		if err != nil {
			return domain.RunDetail{}, err
		}
		if duplicate {
			return s.Get(ctx, id)
		}
	}
	run.Version++
	kind := "completion"
	if in.Review != nil {
		kind = "review"
	}
	evidence := event(run, kind, in.Actor, in.Decision)
	if in.Completion != nil {
		claim := *in.Completion
		claim.Facts.ChangedFiles = append([]string{}, claim.Facts.ChangedFiles...)
		claim.Facts.Staged = append([]string{}, claim.Facts.Staged...)
		claim.Facts.Unstaged = append([]string{}, claim.Facts.Unstaged...)
		claim.Facts.Untracked = append([]string{}, claim.Facts.Untracked...)
		claim.Inputs = append([]domain.RunArtifact{}, claim.Inputs...)
		claim.Outputs = append([]domain.RunArtifact{}, claim.Outputs...)
		claim.Checks = append([]domain.RunCheckReceipt{}, claim.Checks...)
		evidence.Completion = &claim
	}
	if in.Review != nil {
		receipt := *in.Review
		receipt.Findings = append([]domain.RunFinding{}, receipt.Findings...)
		evidence.Review = &receipt
	}
	history, err := s.store.CurrentRunEvidence(ctx, id, run.Version)
	if err != nil {
		return domain.RunDetail{}, err
	}
	evidence.Blockers, evidence.Observed = s.evaluate(ctx, run, append(history, evidence), in.Review != nil || run.Stage == "review" || run.Stage == "handoff")
	if err := s.store.SaveFactoryRun(ctx, run, evidence, false); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, id)
}

// Advance records a human decision and retains the stage if evidence is missing.
func (s *Service) Advance(ctx context.Context, id string, in AdvanceInput) (domain.RunDetail, error) {
	if !bounded(in) || !decision(in.Actor, in.Decision) {
		return domain.RunDetail{}, invalid("A human decision is required")
	}
	detail, err := s.Get(ctx, id)
	if err != nil {
		return detail, err
	}
	return s.advanceDecision(ctx, detail, in, false, "")
}

// Apply only the source snapshot actually bound to the approved native preview.
// Re-observing after approval must never turn an approved hold into an advance.
func (s *Service) advanceDecision(ctx context.Context, detail domain.RunDetail, in AdvanceInput, confirmed bool, digest string) (domain.RunDetail, error) {
	id := detail.Run.ID
	run := detail.Run
	if run.Version >= 511 {
		return domain.RunDetail{}, invalid("Run evidence limit reached; history is preserved and read-only")
	}
	if run.Version != in.ExpectedVersion {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	blockers := slices.Clone(detail.Blockers)
	if run.Stage == "handoff" {
		if len(blockers) == 0 {
			return detail, invalid("Handoff retains separate human release authority")
		}
		blockers = slices.DeleteFunc(blockers, func(code string) bool { return code == "handoff_decision_stale" })
	}
	if !confirmed {
		blockers = append(blockers, "human_confirmation_required")
	}
	kind := "hold"
	if len(blockers) == 0 {
		kind = "advance"
		switch run.Stage {
		case "design":
			run.Stage = "implementation"
		case "implementation":
			run.Stage = "review"
		case "review":
			run.Stage = "handoff"
		}
	}
	run.Version++
	evidence := event(run, kind, in.Actor, in.Decision)
	evidence.Confirmed = confirmed
	evidence.ConfirmationDigest = digest
	evidence.Blockers = blockers
	if kind == "advance" {
		evidence.Blockers = []string{}
	}
	evidence.Observed = detail.Observed
	if kind == "hold" && len(detail.Evidence) > 0 {
		last := detail.Evidence[len(detail.Evidence)-1]
		if last.Kind == "hold" && last.Actor == evidence.Actor && last.Decision == evidence.Decision && last.Confirmed == evidence.Confirmed && slices.Equal(last.Blockers, evidence.Blockers) && sameObservations(last.Observed, evidence.Observed) {
			return detail, nil
		}
	}
	if err := s.store.SaveFactoryRun(ctx, run, evidence, false); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, id)
}
func sameObservations(a, b []domain.RunRepoFacts) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

func (s *Service) artifact(ctx context.Context, session domain.SessionRecord, repo ownedRepo, artifact domain.RunArtifact) bool {
	root := ""
	switch artifact.Root {
	case "worktree":
		root = repo.row.WorktreePath
	case "artifacts":
		root = sessionartifacts.Dir(s.dataDir, session.ID)
	}
	return root != "" && s.repos.VerifyArtifact(ctx, root, artifact) == nil
}

func sameFacts(a, b domain.RunRepoFacts) bool {
	if a.RepoPath != b.RepoPath || a.WorktreePath != b.WorktreePath || a.BaseSHA != b.BaseSHA || a.HeadSHA != b.HeadSHA || a.Branch != b.Branch {
		return false
	}
	for _, pair := range [][2][]string{{a.ChangedFiles, b.ChangedFiles}, {a.Staged, b.Staged}, {a.Unstaged, b.Unstaged}, {a.Untracked, b.Untracked}} {
		left, right := slices.Clone(pair[0]), slices.Clone(pair[1])
		slices.Sort(left)
		slices.Sort(right)
		if !slices.Equal(left, right) {
			return false
		}
	}
	return a.Fingerprint == "" || a.Fingerprint == b.Fingerprint
}

func (s *Service) evaluate(ctx context.Context, run domain.FactoryRun, history []domain.RunEvidence, reviewRequired bool) ([]string, []domain.RunRepoFacts) {
	blockers := []string{}
	session, repos, err := s.owned(ctx, run)
	if err != nil {
		return []string{"ownership_unavailable"}, []domain.RunRepoFacts{}
	}
	completions := map[string]*domain.RunCompletion{}
	reviews := map[string]*domain.RunReviewReceipt{}
	createdConfirmed := false
	for _, e := range history {
		if e.Kind == "created" && e.Confirmed {
			createdConfirmed = true
		}
	}
	if !createdConfirmed {
		blockers = append(blockers, "human_creation_confirmation_required")
	}
	for _, evidence := range history {
		if (evidence.Completion != nil || evidence.Review != nil) && !evidence.Confirmed {
			blockers = append(blockers, "human_evidence_confirmation_required")
		}
		if evidence.Completion != nil {
			completions[evidence.Completion.RepoName] = evidence.Completion
		}
		if evidence.Review != nil {
			reviews[evidence.Review.RepoName] = evidence.Review
		}
	}
	observed := []domain.RunRepoFacts{}
	for _, repo := range repos {
		prefix := repo.row.RepoName + ":"
		claim := completions[repo.row.RepoName]
		facts, err := s.repos.Inspect(ctx, repo.path, repo.row.WorktreePath, repo.row.BaseSHA)
		if err != nil {
			blockers = append(blockers, prefix+"repository_unavailable")
			continue
		}
		observed = append(observed, facts)
		bindingIndex := slices.IndexFunc(run.Repositories, func(binding domain.RunRepoBinding) bool { return binding.RepoName == repo.row.RepoName })
		if bindingIndex < 0 {
			blockers = append(blockers, prefix+"ownership_changed")
		} else {
			binding := run.Repositories[bindingIndex]
			if binding.RepoPath != facts.RepoPath || binding.WorktreePath != facts.WorktreePath || binding.BaseSHA != facts.BaseSHA || binding.Branch != facts.Branch {
				blockers = append(blockers, prefix+"ownership_changed")
			}
		}
		if claim == nil {
			blockers = append(blockers, prefix+"completion_missing")
			continue
		}
		if claim.Attempt < 1 || claim.Attempt > 3 || !sameFacts(claim.Facts, facts) || facts.Branch != repo.row.Branch {
			blockers = append(blockers, prefix+"completion_mismatch")
		}
		if len(facts.Staged)+len(facts.Unstaged)+len(facts.Untracked) != 0 {
			blockers = append(blockers, prefix+"dirty_source")
		}
		report, ok, err := s.store.GetReport(ctx, claim.ReportID)
		if err != nil || !ok || report.SessionID != run.SessionID || string(report.ProjectID) != run.ProjectID || report.State != domain.ReportDone {
			blockers = append(blockers, prefix+"done_report_missing")
		}
		if len(claim.Outputs) == 0 {
			blockers = append(blockers, prefix+"outputs_missing")
		}
		for _, artifact := range append(slices.Clone(claim.Inputs), claim.Outputs...) {
			if !s.artifact(ctx, session, repo, artifact) {
				blockers = append(blockers, prefix+"artifact_unverified")
			}
		}
		checks := map[string]bool{}
		for _, check := range claim.Checks {
			valid := check.SHA == facts.HeadSHA && domain.FullCommit(check.SHA) && strings.TrimSpace(check.Environment) != "" && check.ExitCode == 0 && strings.TrimSpace(check.VerifiedBy) != "" && s.artifact(ctx, session, repo, check.Output)
			if _, exists := checks[check.Name]; exists {
				valid = false
			}
			checks[check.Name] = valid
			if !valid {
				blockers = append(blockers, prefix+"check_unverified:"+check.Name)
			}
		}
		for _, name := range run.RequiredChecks {
			if !checks[name] {
				blockers = append(blockers, prefix+"check_missing:"+name)
			}
		}
		if reviewRequired {
			receipt := reviews[repo.row.RepoName]
			blockers = append(blockers, s.reviewBlockers(ctx, run, session, repo, facts, receipt)...)
		}
	}
	return slices.Compact(blockers), observed
}

func (s *Service) reviewBlockers(ctx context.Context, run domain.FactoryRun, session domain.SessionRecord, repo ownedRepo, facts domain.RunRepoFacts, receipt *domain.RunReviewReceipt) []string {
	prefix := repo.row.RepoName + ":"
	if receipt == nil {
		return []string{prefix + "review_missing"}
	}
	valid := receipt.ReadOnly && domain.FullCommit(receipt.SHA) && receipt.Independent && strings.TrimSpace(receipt.ReviewerID) != "" && receipt.ReviewerID != string(run.SessionID) && receipt.ReviewerID != session.Metadata.AgentSessionID && receipt.ReviewerID != session.Metadata.ProviderConversationID && receipt.Round >= 1 && receipt.Round <= 3 && receipt.SHA == facts.HeadSHA && receipt.BeforeFingerprint == facts.Fingerprint && receipt.AfterFingerprint == facts.Fingerprint && receipt.Verdict == "approved" && s.artifact(ctx, session, repo, receipt.Artifact)
	for _, finding := range receipt.Findings {
		if finding.ID == "" || !slices.Contains([]string{"P3", "P4"}, finding.Severity) {
			valid = false
		}
	}
	if receipt.ReviewRunID != "" {
		native, ok, err := s.store.GetReviewRun(ctx, receipt.ReviewRunID)
		if err != nil || !ok || native.SessionID != run.SessionID || native.TargetSHA != facts.HeadSHA || (native.Status != domain.ReviewRunComplete && native.Status != domain.ReviewRunDelivered) || native.Verdict != domain.VerdictApproved {
			valid = false
		}
		reviewer, reviewerOK, reviewerErr := s.store.GetReviewByID(ctx, native.ReviewID)
		if reviewerErr != nil || !reviewerOK || reviewer.SessionID != run.SessionID || string(reviewer.ProjectID) != run.ProjectID || (receipt.ReviewerID != reviewer.ID && receipt.ReviewerID != reviewer.AgentSessionID) || (reviewer.AgentSessionID != "" && (reviewer.AgentSessionID == session.Metadata.AgentSessionID || reviewer.AgentSessionID == session.Metadata.ProviderConversationID)) {
			valid = false
		}
	}
	if !valid {
		return []string{prefix + "review_unverified"}
	}
	return nil
}

// ConfirmationPreview binds the exact run version, current claims, source facts,
// artifact verification results and requested action to a native dialog.
type ConfirmationPreview struct {
	Detail   domain.RunDetail           `json:"detail"`
	Action   string                     `json:"action"`
	Digest   string                     `json:"digest"`
	Feedback *domain.RunFeedbackBinding `json:"feedback,omitempty"`
}

// Preview is read-only; possessing its digest grants no authority.
func (s *Service) Preview(ctx context.Context, id, action string) (ConfirmationPreview, error) {
	if action != "evidence" && action != "advance" && action != "feedback" && action != "pause_feedback" && action != "resume_feedback" {
		return ConfirmationPreview{}, invalid("Unknown confirmation action")
	}
	d, err := s.Get(ctx, id)
	if err != nil {
		return ConfirmationPreview{}, err
	}
	current, err := s.store.CurrentRunEvidence(ctx, id, d.Run.Version)
	if err != nil {
		return ConfirmationPreview{}, err
	}
	d.Evidence = current
	p := ConfirmationPreview{Detail: d, Action: action}
	if action == "feedback" {
		binding, err := s.feedbackProposal(ctx, d)
		if err != nil {
			return p, err
		}
		p.Feedback = &binding
	}
	data, err := json.Marshal(p)
	if err != nil {
		return p, err
	}
	sum := sha256.Sum256(data)
	p.Digest = hex.EncodeToString(sum[:])
	return p, nil
}

// Confirm is a private desktop composition boundary. Never mount it on public
// controllers: the caller must authenticate an exact request with the boot key.
func (s *Service) Confirm(ctx context.Context, id, action string, version int64, digest string) (domain.RunDetail, error) {
	preview, err := s.Preview(ctx, id, action)
	if err != nil {
		return domain.RunDetail{}, err
	}
	if version >= 511 {
		return domain.RunDetail{}, invalid("Run evidence limit reached; history is preserved and read-only")
	}
	if preview.Detail.Run.Version != version || !domain.SHA256Digest(digest) || preview.Digest != digest {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	if action == "pause_feedback" || action == "resume_feedback" {
		st := s.store
		if err := st.SetFactoryFeedbackControl(ctx, id, preview.Detail.FeedbackRevision, action == "pause_feedback"); err != nil {
			return domain.RunDetail{}, failure(err)
		}
		return s.Get(ctx, id)
	}
	if action == "feedback" {
		return s.confirmFeedback(ctx, preview)
	}
	if action == "advance" {
		return s.advanceDecision(ctx, preview.Detail, AdvanceInput{ExpectedVersion: version, Actor: "desktop-user", Decision: "Native confirmation of " + digest}, true, digest)
	}
	history := preview.Detail.Evidence
	if len(history) == 0 {
		return domain.RunDetail{}, invalid("No claim to confirm")
	}
	index := -1
	for i := len(history) - 1; i >= 0; i-- {
		if !history[i].Confirmed && slices.Contains([]string{"created", "completion", "review"}, history[i].Kind) {
			index = i
			break
		}
	}
	if index < 0 {
		return domain.RunDetail{}, invalid("No pending claim to confirm")
	}
	last := history[index]
	if last.Confirmed {
		return domain.RunDetail{}, invalid("Latest event is not an unconfirmed claim")
	}
	run := preview.Detail.Run
	run.Version++
	e := event(run, last.Kind, "desktop-user", "Native confirmation of "+digest)
	e.Confirmed = true
	e.ConfirmationDigest = digest
	e.Completion = last.Completion
	e.Review = last.Review
	e.Observed = preview.Detail.Observed
	e.Blockers = preview.Detail.Blockers
	if err := s.store.SaveFactoryRun(ctx, run, e, false); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, id)
}

// History returns an exclusive version page; observation never loads the ledger.
func (s *Service) History(ctx context.Context, id string, after, limit int64) ([]domain.RunEvidence, error) {
	if after < -1 || limit < 1 || limit > 100 {
		return nil, invalid("History cursor >= -1 and limit 1..100 required")
	}
	if _, err := s.store.GetFactoryRun(ctx, id); err != nil {
		return nil, failure(err)
	}
	return s.store.PageRunEvidence(ctx, id, after, limit)
}
