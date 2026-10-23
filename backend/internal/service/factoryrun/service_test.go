package factoryrun_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runrepo"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionartifacts"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type fixture struct {
	t                         *testing.T
	ctx                       context.Context
	db                        *sqlite.Store
	svc                       *factoryrun.Service
	dir, repo, worktree, base string
	session                   domain.SessionRecord
	artifact                  domain.RunArtifact
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + os.DevNull, "-C", dir}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func setup(t *testing.T) *fixture {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	f := &fixture{t: t, ctx: context.Background(), dir: t.TempDir(), repo: t.TempDir(), worktree: filepath.Join(t.TempDir(), "owned")}
	git(t, f.repo, "init", "-b", "main")
	git(t, f.repo, "config", "user.email", "fixture@example.invalid")
	git(t, f.repo, "config", "user.name", "Fixture")
	if err := os.WriteFile(filepath.Join(f.repo, "source.txt"), []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	git(t, f.repo, "add", "source.txt")
	git(t, f.repo, "commit", "-m", "base")
	f.base = git(t, f.repo, "rev-parse", "HEAD")
	git(t, f.repo, "worktree", "add", "-b", "worker", f.worktree)
	if err := os.WriteFile(filepath.Join(f.worktree, "source.txt"), []byte("candidate"), 0600); err != nil {
		t.Fatal(err)
	}
	git(t, f.worktree, "commit", "-am", "candidate")
	var err error
	f.db, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.db.Close() })
	now := time.Now().UTC()
	if err := f.db.UpsertProject(f.ctx, domain.ProjectRecord{ID: "p", Path: f.repo, RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	f.session, err = f.db.CreateSession(f.ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now, Metadata: domain.SessionMetadata{WorkspacePath: f.worktree, Branch: "worker", DiffBaseSHA: f.base}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertSessionWorktree(f.ctx, domain.SessionWorktreeRecord{SessionID: f.session.ID, RepoName: domain.RootWorkspaceRepoName, Branch: "worker", BaseSHA: f.base, WorktreePath: f.worktree, State: "active"}); err != nil {
		t.Fatal(err)
	}
	_, err = reportsvc.New(reportsvc.Deps{Store: f.db, NewID: func() string { return "done" }}).Create(f.ctx, reportsvc.CreateInput{SessionID: f.session.ID, State: domain.ReportDone, Note: "done"})
	if err != nil {
		t.Fatal(err)
	}
	artifacts := sessionartifacts.Dir(f.dir, f.session.ID)
	if err := os.MkdirAll(artifacts, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artifacts, "checks.txt"), []byte("passed"), 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("passed"))
	f.artifact = domain.RunArtifact{Root: "artifacts", Path: "checks.txt", Digest: hex.EncodeToString(sum[:])}
	f.svc = factoryrun.New(f.db, runrepo.Reader{}, f.dir)
	return f
}

func (f *fixture) create() domain.RunDetail {
	f.t.Helper()
	detail, err := f.svc.Create(f.ctx, factoryrun.CreateInput{ID: "run-1", ProjectID: "p", TaskID: "WI-FAC-05", SessionID: f.session.ID, DesignDigest: strings.Repeat("a", 64), PolicyDecision: "decision-6-b", RequiredChecks: []string{"focused"}, Actor: "human", Decision: "approved design"})
	if err != nil {
		f.t.Fatal(err)
	}
	return detail
}
func (f *fixture) advance(detail domain.RunDetail) domain.RunDetail {
	f.t.Helper()
	result, err := f.svc.Advance(f.ctx, detail.Run.ID, factoryrun.AdvanceInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "next stage"})
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}
func (f *fixture) claim() *domain.RunCompletion {
	f.t.Helper()
	facts, err := (runrepo.Reader{}).Inspect(f.ctx, f.repo, f.worktree, f.base)
	if err != nil {
		f.t.Fatal(err)
	}
	return &domain.RunCompletion{RepoName: domain.RootWorkspaceRepoName, ReportID: "done", Attempt: 1, Facts: facts, Outputs: []domain.RunArtifact{f.artifact}, Checks: []domain.RunCheckReceipt{{Name: "focused", SHA: facts.HeadSHA, Environment: "disposable linux/go", ExitCode: 0, VerifiedBy: "human", Output: f.artifact}}}
}
func (f *fixture) record(detail domain.RunDetail, claim *domain.RunCompletion) domain.RunDetail {
	f.t.Helper()
	result, err := f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "verify receipt", Completion: claim})
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}
func blocked(t *testing.T, detail domain.RunDetail, code string) {
	t.Helper()
	if detail.NextAction != "hold" || !strings.Contains(strings.Join(detail.Blockers, ","), code) {
		t.Fatalf("want hold %q; got %s %v", code, detail.NextAction, detail.Blockers)
	}
}

func TestFactoryRunManualProgressionAndRestart(t *testing.T) {
	f := setup(t)
	detail := f.advance(f.create())
	blocked(t, detail, "completion_missing")
	held := f.advance(detail)
	if held.Run.Stage != "implementation" || held.Evidence[len(held.Evidence)-1].Kind != "hold" {
		t.Fatalf("hold lost: %+v", held)
	}
	claim := f.claim()
	detail = f.record(held, claim)
	if len(detail.Blockers) > 0 || detail.Run.Stage != "implementation" {
		t.Fatalf("claim unexpectedly advanced or blocked: %+v", detail)
	}
	detail = f.advance(detail)
	blocked(t, detail, "review_missing")
	review := &domain.RunReviewReceipt{RepoName: claim.RepoName, ReviewerID: "independent-reviewer", Independent: true, SHA: claim.Facts.HeadSHA, BeforeFingerprint: claim.Facts.Fingerprint, AfterFingerprint: claim.Facts.Fingerprint, Verdict: "approved", Round: 1, Artifact: f.artifact}
	detail, err := f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "accept local review", Review: review})
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Blockers) > 0 {
		t.Fatal(detail.Blockers)
	}
	detail = f.advance(detail)
	if detail.Run.Stage != "handoff" || detail.NextAction != "human_release_decision" {
		t.Fatalf("handoff: %+v", detail)
	}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	f.db, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.svc = factoryrun.New(f.db, runrepo.Reader{}, f.dir)
	restored, err := f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil || restored.Run.Version != detail.Run.Version || len(restored.Evidence) != len(detail.Evidence) {
		t.Fatalf("restart lost history: %+v %v", restored, err)
	}
	report, ok, err := f.db.GetReport(f.ctx, "done")
	if err != nil || !ok || report.DeliveryState != domain.ReportPending {
		t.Fatalf("run touched outbox: %+v %v", report, err)
	}
	session, ok, err := f.db.GetSession(f.ctx, f.session.ID)
	if err != nil || !ok || session.Activity.State != domain.ActivityIdle || session.IsTerminated {
		t.Fatalf("run touched execution: %+v %v", session, err)
	}
	git(t, f.worktree, "commit", "--allow-empty", "-m", "new head")
	stale, err := f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocked(t, stale, "completion_mismatch")
	blocked(t, stale, "review_unverified")
	if stale.Run.Version != detail.Run.Version {
		t.Fatal("read mutated history")
	}
}

func TestFactoryRunFalseDoneAndMissingEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*fixture, *domain.RunCompletion)
	}{
		{"wrong head", "completion_mismatch", func(_ *fixture, c *domain.RunCompletion) { c.Facts.HeadSHA = strings.Repeat("0", 40) }},
		{"wrong repository", "completion_mismatch", func(_ *fixture, c *domain.RunCompletion) { c.Facts.RepoPath = "/untrusted" }},
		{"wrong base", "completion_mismatch", func(_ *fixture, c *domain.RunCompletion) { c.Facts.BaseSHA = c.Facts.HeadSHA }},
		{"wrong changed files", "completion_mismatch", func(_ *fixture, c *domain.RunCompletion) { c.Facts.ChangedFiles = nil }},
		{"no checks", "check_missing", func(_ *fixture, c *domain.RunCompletion) { c.Checks = nil }},
		{"stale check", "check_unverified", func(_ *fixture, c *domain.RunCompletion) { c.Checks[0].SHA = strings.Repeat("0", 40) }},
		{"failed check", "check_unverified", func(_ *fixture, c *domain.RunCompletion) { c.Checks[0].ExitCode = 1 }},
		{"unverified check", "check_unverified", func(_ *fixture, c *domain.RunCompletion) { c.Checks[0].VerifiedBy = "" }},
		{"missing output", "outputs_missing", func(_ *fixture, c *domain.RunCompletion) { c.Outputs = nil }},
		{"missing file", "artifact_unverified", func(f *fixture, _ *domain.RunCompletion) {
			if err := os.Remove(filepath.Join(sessionartifacts.Dir(f.dir, f.session.ID), f.artifact.Path)); err != nil {
				f.t.Fatal(err)
			}
		}},
		{"changed file digest", "artifact_unverified", func(f *fixture, _ *domain.RunCompletion) {
			if err := os.WriteFile(filepath.Join(sessionartifacts.Dir(f.dir, f.session.ID), f.artifact.Path), []byte("changed"), 0600); err != nil {
				f.t.Fatal(err)
			}
		}},
		{"missing report", "done_report_missing", func(_ *fixture, c *domain.RunCompletion) { c.ReportID = "missing" }},
		{"path escape", "artifact_unverified", func(_ *fixture, c *domain.RunCompletion) { c.Outputs[0].Path = "../secret" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			detail := f.advance(f.create())
			claim := f.claim()
			tc.change(f, claim)
			detail = f.record(detail, claim)
			blocked(t, detail, tc.code)
			held := f.advance(detail)
			if held.Run.Stage != "implementation" || len(held.Evidence) != len(detail.Evidence)+1 {
				t.Fatal("bad claim advanced or lost evidence")
			}
		})
	}
}

func TestFactoryRunDirtyAndDeletedSource(t *testing.T) {
	for _, state := range []string{"unstaged", "staged", "untracked", "deleted"} {
		t.Run(state, func(t *testing.T) {
			f := setup(t)
			detail := f.advance(f.create())
			claim := f.claim()
			switch state {
			case "untracked":
				if err := os.WriteFile(filepath.Join(f.worktree, "extra.txt"), []byte("extra"), 0600); err != nil {
					t.Fatal(err)
				}
			case "deleted":
				if err := os.Remove(filepath.Join(f.worktree, "source.txt")); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.WriteFile(filepath.Join(f.worktree, "source.txt"), []byte("dirty"), 0600); err != nil {
					t.Fatal(err)
				}
				if state == "staged" {
					git(t, f.worktree, "add", "source.txt")
				}
			}
			detail = f.record(detail, claim)
			blocked(t, detail, "dirty_source")
			blocked(t, detail, "completion_mismatch")
		})
	}
}

func TestFactoryRunConcurrentClaimsKeepOneHistory(t *testing.T) {
	f := setup(t)
	detail := f.advance(f.create())
	claim := f.claim()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "concurrent receipt", Completion: claim})
			results <- err
		})
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		var api *apierr.Error
		if err == nil {
			successes++
		} else if errors.As(err, &api) && api.Kind == apierr.KindConflict {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	got, err := f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil || got.Run.Version != detail.Run.Version+1 || len(got.Evidence) != int(got.Run.Version)+1 {
		t.Fatalf("history: %+v %v", got, err)
	}
}

func TestFactoryRunCrashHelper(t *testing.T) {
	path := os.Getenv("FACTORY_RUN_CRASH_DB")
	if path == "" {
		return
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		os.Exit(21)
	}
	tx, err := db.Begin()
	if err != nil {
		os.Exit(22)
	}
	if _, err := tx.Exec("UPDATE factory_runs SET version=999 WHERE id='run-1'"); err != nil {
		os.Exit(23)
	}
	if _, err := tx.Exec("INSERT INTO factory_run_evidence(id,run_id,version,document) VALUES('crash','run-1',999,'{}')"); err != nil {
		os.Exit(24)
	}
	os.Exit(29)
}

func TestFactoryRunCrashRollsBackAndRestartRetainsHistory(t *testing.T) {
	f := setup(t)
	detail := f.create()
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(os.Args[0], "-test.run=^TestFactoryRunCrashHelper$")
	command.Env = append(os.Environ(), "FACTORY_RUN_CRASH_DB="+filepath.Join(f.dir, "ao.db"))
	err := command.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 29 {
		t.Fatalf("crash helper: %v", err)
	}
	f.db, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.svc = factoryrun.New(f.db, runrepo.Reader{}, f.dir)
	restored, err := f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil || restored.Run.Version != 0 || len(restored.Evidence) != 1 {
		t.Fatalf("crash retained partial transaction: %+v %v", restored, err)
	}
}

func TestFactoryRunReviewCannotMaskFindingsOrMutation(t *testing.T) {
	for _, mode := range []string{"self", "mutated", "stale", "findings", "native missing", "exhausted"} {
		t.Run(mode, func(t *testing.T) {
			f := setup(t)
			detail := f.advance(f.create())
			claim := f.claim()
			detail = f.record(detail, claim)
			detail = f.advance(detail)
			receipt := &domain.RunReviewReceipt{RepoName: claim.RepoName, ReviewerID: "reviewer", Independent: true, SHA: claim.Facts.HeadSHA, BeforeFingerprint: claim.Facts.Fingerprint, AfterFingerprint: claim.Facts.Fingerprint, Verdict: "approved", Round: 1, Artifact: f.artifact}
			switch mode {
			case "self":
				receipt.ReviewerID = string(f.session.ID)
			case "mutated":
				receipt.AfterFingerprint = strings.Repeat("0", 64)
			case "stale":
				receipt.SHA = f.base
			case "findings":
				receipt.Findings = []domain.RunFinding{{ID: "F1", Severity: "P2"}}
			case "native missing":
				receipt.ReviewRunID = "missing"
			case "exhausted":
				receipt.Round = 4
			}
			got, err := f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "review receipt", Review: receipt})
			if err != nil {
				t.Fatal(err)
			}
			blocked(t, got, "review_unverified")
		})
	}
}

func TestFactoryRunHiddenIndexChangesAndOwnershipDrift(t *testing.T) {
	for _, mode := range []string{"assume unchanged", "skip worktree", "missing worktree", "new base", "new branch"} {
		t.Run(mode, func(t *testing.T) {
			f := setup(t)
			detail := f.advance(f.create())
			claim := f.claim()
			detail = f.record(detail, claim)
			switch mode {
			case "assume unchanged":
				git(t, f.worktree, "update-index", "--assume-unchanged", "source.txt")
			case "skip worktree":
				git(t, f.worktree, "update-index", "--skip-worktree", "source.txt")
			case "missing worktree":
				if err := os.Rename(f.worktree, f.worktree+"-moved"); err != nil {
					t.Fatal(err)
				}
			case "new base":
				if err := f.db.UpsertSessionWorktree(f.ctx, domain.SessionWorktreeRecord{SessionID: f.session.ID, RepoName: domain.RootWorkspaceRepoName, Branch: "worker", BaseSHA: claim.Facts.HeadSHA, WorktreePath: f.worktree, State: "active"}); err != nil {
					t.Fatal(err)
				}
			case "new branch":
				git(t, f.worktree, "switch", "-c", "unexpected")
			}
			got, err := f.svc.Get(f.ctx, detail.Run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.NextAction != "hold" || len(got.Blockers) == 0 {
				t.Fatalf("drift passed: %+v", got)
			}
		})
	}
}

func TestFactoryRunReferencesNativePerSHAReviewWithoutDelivery(t *testing.T) {
	f := setup(t)
	detail := f.advance(f.create())
	claim := f.claim()
	detail = f.record(detail, claim)
	detail = f.advance(detail)
	now := time.Now().UTC()
	native := domain.Review{ID: "reviewer-record", SessionID: f.session.ID, ProjectID: "p", Harness: domain.ReviewerCodex, AgentSessionID: "independent-native", CreatedAt: now, UpdatedAt: now}
	if err := f.db.UpsertReview(f.ctx, native); err != nil {
		t.Fatal(err)
	}
	if err := f.db.InsertReviewRun(f.ctx, domain.ReviewRun{ID: "native-pass", ReviewID: native.ID, SessionID: f.session.ID, Harness: domain.ReviewerCodex, TargetSHA: claim.Facts.HeadSHA, Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	receipt := &domain.RunReviewReceipt{RepoName: claim.RepoName, ReviewRunID: "native-pass", ReviewerID: native.ID, Independent: true, SHA: claim.Facts.HeadSHA, BeforeFingerprint: claim.Facts.Fingerprint, AfterFingerprint: claim.Facts.Fingerprint, Verdict: "approved", Round: 1, Artifact: f.artifact}
	detail, err := f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "record existing native review", Review: receipt})
	if err != nil || len(detail.Blockers) > 0 {
		t.Fatalf("native receipt: %v %v", detail.Blockers, err)
	}
	pass, ok, err := f.db.GetReviewRun(f.ctx, "native-pass")
	if err != nil || !ok || pass.DeliveredAt != nil || pass.Status != domain.ReviewRunComplete {
		t.Fatalf("record changed native delivery: %+v %v", pass, err)
	}
	receipt.ReviewerID = "another-reviewer"
	detail, err = f.svc.Record(f.ctx, detail.Run.ID, factoryrun.RecordInput{ExpectedVersion: detail.Run.Version, Actor: "human", Decision: "mismatched reviewer", Review: receipt})
	if err != nil {
		t.Fatal(err)
	}
	blocked(t, detail, "review_unverified")
}

func TestFactoryRunRequiresHumanDecisionAndSupportsLegacyOwnership(t *testing.T) {
	f := setup(t)
	if err := f.db.DeleteSessionWorktrees(f.ctx, f.session.ID); err != nil {
		t.Fatal(err)
	}
	detail := f.create()
	_, err := f.svc.Advance(f.ctx, detail.Run.ID, factoryrun.AdvanceInput{ExpectedVersion: 0})
	var api *apierr.Error
	if !errors.As(err, &api) || api.Kind != apierr.KindInvalid {
		t.Fatalf("missing human decision: %v", err)
	}
	unchanged, err := f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil || unchanged.Run.Version != 0 || len(unchanged.Evidence) != 1 {
		t.Fatalf("invalid decision changed run: %+v %v", unchanged, err)
	}
	detail = f.advance(detail)
	detail = f.record(detail, f.claim())
	if len(detail.Blockers) > 0 {
		t.Fatal(detail.Blockers)
	}
}

func TestFactoryRunWorkspaceRequiresEveryOwnedRepository(t *testing.T) {
	f := setup(t)
	if err := os.WriteFile(filepath.Join(f.repo, ".gitignore"), []byte("child/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(t, f.repo, "add", ".gitignore")
	git(t, f.repo, "commit", "-m", "ignore child repository")
	child := filepath.Join(f.repo, "child")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	git(t, child, "init", "-b", "main")
	git(t, child, "config", "user.name", "Fixture")
	git(t, child, "config", "user.email", "fixture@example.invalid")
	git(t, child, "commit", "--allow-empty", "-m", "child base")
	base := git(t, child, "rev-parse", "HEAD")
	ownedChild := filepath.Join(t.TempDir(), "child")
	git(t, child, "worktree", "add", "-b", "child-worker", ownedChild)
	project, _, err := f.db.GetProject(f.ctx, "p")
	if err != nil {
		t.Fatal(err)
	}
	project.Kind = domain.ProjectKindWorkspace
	children := []domain.WorkspaceRepoRecord{{ProjectID: "p", Name: "child", RelativePath: "child", RegisteredAt: time.Now().UTC()}}
	if err := f.db.UpsertWorkspaceProject(f.ctx, project, children); err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertSessionWorktree(f.ctx, domain.SessionWorktreeRecord{SessionID: f.session.ID, RepoName: "child", Branch: "child-worker", BaseSHA: base, WorktreePath: ownedChild, State: "active"}); err != nil {
		t.Fatal(err)
	}
	detail := f.advance(f.create())
	detail = f.record(detail, f.claim())
	blocked(t, detail, "child:completion_missing")
	facts, err := (runrepo.Reader{}).Inspect(f.ctx, child, ownedChild, base)
	if err != nil {
		t.Fatal(err)
	}
	claim := f.claim()
	claim.RepoName = "child"
	claim.Facts = facts
	claim.Checks[0].SHA = facts.HeadSHA
	detail = f.record(detail, claim)
	if len(detail.Blockers) > 0 {
		t.Fatal(detail.Blockers)
	}
	if err := f.db.UpsertWorkspaceProject(f.ctx, project, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.db.DeleteSessionWorktrees(f.ctx, f.session.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertSessionWorktree(f.ctx, domain.SessionWorktreeRecord{SessionID: f.session.ID, RepoName: domain.RootWorkspaceRepoName, Branch: "worker", BaseSHA: f.base, WorktreePath: f.worktree, State: "active"}); err != nil {
		t.Fatal(err)
	}
	detail, err = f.svc.Get(f.ctx, detail.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocked(t, detail, "ownership_unavailable")
}
