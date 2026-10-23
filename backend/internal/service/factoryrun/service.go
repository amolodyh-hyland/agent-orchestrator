package factoryrun

import (
	"context"
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

// Service records and verifies evidence without steering execution.
type Service struct {
	store   Store
	repos   RepositoryReader
	dataDir string
}

// New constructs the run evidence service with read-only source inspection.
func New(store Store, repos RepositoryReader, dataDir string) *Service {
	return &Service{store: store, repos: repos, dataDir: dataDir}
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
	if !decision(in.Actor, in.Decision) || in.ID == "" || len(in.ID) > 128 || in.TaskID == "" || in.PolicyDecision == "" || !domain.SHA256Digest(in.DesignDigest) || len(in.RequiredChecks) == 0 || len(in.RequiredChecks) > 50 {
		return domain.RunDetail{}, invalid("Run id, task, approved design digest, policy decision, required checks and human decision are required")
	}
	seen := map[string]bool{}
	for _, name := range in.RequiredChecks {
		if strings.TrimSpace(name) == "" || seen[name] {
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
	history, err := s.store.ListRunEvidence(ctx, id)
	if err != nil {
		return domain.RunDetail{}, err
	}
	if len(history) != int(run.Version)+1 {
		return domain.RunDetail{}, apierr.Conflict("RUN_SNAPSHOT_CHANGED", "Run changed while reading; retry", nil)
	}
	detail := domain.RunDetail{Run: run, Evidence: history, Blockers: []string{}, Observed: []domain.RunRepoFacts{}}
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
	}
	if len(detail.Blockers) > 0 {
		detail.NextAction = "hold"
	}
	return detail, nil
}

// Record retains a completion or review claim even when verification holds readiness.
func (s *Service) Record(ctx context.Context, id string, in RecordInput) (domain.RunDetail, error) {
	if !decision(in.Actor, in.Decision) || (in.Completion == nil) == (in.Review == nil) {
		return domain.RunDetail{}, invalid("One completion or review receipt and a human decision are required")
	}
	run, err := s.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunDetail{}, failure(err)
	}
	if run.Version != in.ExpectedVersion {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
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
	history, err := s.store.ListRunEvidence(ctx, id)
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
	if !decision(in.Actor, in.Decision) {
		return domain.RunDetail{}, invalid("A human decision is required")
	}
	detail, err := s.Get(ctx, id)
	if err != nil {
		return detail, err
	}
	run := detail.Run
	if run.Version != in.ExpectedVersion {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	if run.Stage == "handoff" {
		return detail, invalid("Handoff retains separate human release authority")
	}
	kind := "hold"
	if len(detail.Blockers) == 0 {
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
	evidence.Blockers = detail.Blockers
	evidence.Observed = detail.Observed
	if err := s.store.SaveFactoryRun(ctx, run, evidence, false); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, id)
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
	for _, evidence := range history {
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
	valid := receipt.Independent && strings.TrimSpace(receipt.ReviewerID) != "" && receipt.ReviewerID != string(run.SessionID) && receipt.ReviewerID != session.Metadata.AgentSessionID && receipt.Round >= 1 && receipt.Round <= 3 && receipt.SHA == facts.HeadSHA && receipt.BeforeFingerprint == facts.Fingerprint && receipt.AfterFingerprint == facts.Fingerprint && receipt.Verdict == "approved" && s.artifact(ctx, session, repo, receipt.Artifact)
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
		if reviewerErr != nil || !reviewerOK || reviewer.SessionID != run.SessionID || string(reviewer.ProjectID) != run.ProjectID || (receipt.ReviewerID != reviewer.ID && receipt.ReviewerID != reviewer.AgentSessionID) || (reviewer.AgentSessionID != "" && reviewer.AgentSessionID == session.Metadata.AgentSessionID) {
			valid = false
		}
	}
	if !valid {
		return []string{prefix + "review_unverified"}
	}
	return nil
}
