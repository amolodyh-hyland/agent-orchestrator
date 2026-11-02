package chat_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runrepo"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/google/uuid"
)

type m3ResultStore struct {
	*sqlite.Store
	before func()
}

func (s *m3ResultStore) UpdateReviewRunResult(ctx context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, providerID string, inject bool) (bool, error) {
	if s.before != nil {
		s.before()
	}
	return s.Store.UpdateReviewRunResult(ctx, id, status, verdict, body, providerID, inject)
}

type m3ResultReader struct{ facts domain.RunRepoFacts }

func (r m3ResultReader) Inspect(context.Context, string, string, string) (domain.RunRepoFacts, error) {
	return r.facts, nil
}
func (m3ResultReader) VerifyArtifact(ctx context.Context, root string, artifact domain.RunArtifact) error {
	return (runrepo.Reader{}).VerifyArtifact(ctx, root, artifact)
}

func m3ResultFactory(t *testing.T, f *m2Fixture, worker domain.SessionRecord, native domain.ReviewRun) *factoryrun.Service {
	t.Helper()
	ctx := context.Background()
	facts := domain.RunRepoFacts{RepoPath: f.dir, WorktreePath: worker.Metadata.WorkspacePath, Branch: worker.Metadata.Branch, BaseSHA: worker.Metadata.DiffBaseSHA, HeadSHA: native.TargetSHA, Fingerprint: strings.Repeat("f", 64), ChangedFiles: []string{}, Staged: []string{}, Unstaged: []string{}, Untracked: []string{}}
	digest := sha256.Sum256([]byte("work and artifacts"))
	artifact := domain.RunArtifact{Root: "worktree", Path: "preserve.txt", Digest: hex.EncodeToString(digest[:])}
	now := time.Now().UTC()
	report, err := f.st.CreateReport(ctx, domain.ReportRecord{ID: "result-done", SessionID: worker.ID, ProjectID: worker.ProjectID, State: domain.ReportDone, Note: "done", CreatedAt: now, AvailableAt: now, SettlementDeadline: now.Add(time.Minute), RepeatCount: 1, DeliveryState: domain.ReportPending})
	if err != nil {
		t.Fatal(err)
	}
	run := domain.FactoryRun{ID: "result-factory", ProjectID: string(worker.ProjectID), SessionID: worker.ID, TaskID: "M3-result", Stage: "review", DesignDigest: strings.Repeat("d", 64), RequiredChecks: []string{"unit"}, Repositories: []domain.RunRepoBinding{{RepoName: domain.RootWorkspaceRepoName, RepoPath: facts.RepoPath, WorktreePath: facts.WorktreePath, BaseSHA: facts.BaseSHA, Branch: facts.Branch}}, CreatedAt: now}
	events := []domain.RunEvidence{
		{Kind: "created"},
		{Kind: "completion", Completion: &domain.RunCompletion{RepoName: domain.RootWorkspaceRepoName, ReportID: report.ID, Attempt: 1, Facts: facts, Outputs: []domain.RunArtifact{artifact}, Checks: []domain.RunCheckReceipt{{Name: "unit", SHA: native.TargetSHA, Environment: "fixture", VerifiedBy: "human", Output: artifact}}}},
		{Kind: "review", Review: &domain.RunReviewReceipt{RepoName: domain.RootWorkspaceRepoName, ReviewRunID: native.ID, ReviewerID: native.ReviewID, Independent: true, ReadOnly: true, SHA: native.TargetSHA, BeforeFingerprint: facts.Fingerprint, AfterFingerprint: facts.Fingerprint, Verdict: "approved", Round: 1, Artifact: artifact}},
	}
	for i, event := range events {
		run.Version = int64(i)
		event.ID, event.RunID, event.Version, event.Confirmed = uuid.NewString(), run.ID, run.Version, true
		if err := f.st.SaveFactoryRun(ctx, run, event, i == 0); err != nil {
			t.Fatal(err)
		}
	}
	return factoryrun.New(f.st, m3ResultReader{facts: facts}, f.dir)
}

func TestOuterM3ReviewResultTransportSatisfiesNativeFactoryGate(t *testing.T) {
	f, launcher, spec := m3ReviewFixture(t)
	ctx := context.Background()
	worker, _, _ := f.st.GetSession(ctx, spec.SessionID)
	worker.Metadata.Branch, worker.Metadata.DiffBaseSHA, worker.AutoInjectReview = "m3/result", strings.Repeat("b", 40), true
	if err := f.st.UpdateSession(ctx, worker); err != nil {
		t.Fatal(err)
	}
	resultStore := &m3ResultStore{Store: f.st}
	svc := reviewsvc.New(reviewcore.New(reviewcore.Deps{Store: f.st, Sessions: f.st, PRs: f.st, Projects: f.st, Launcher: launcher}), resultStore)
	key := bytes.Repeat([]byte{28}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer, Conversations: f.chat, Reviews: svc, DelegationAuth: authority}, httpd.ControlDeps{})
	call := func(method, path, token string, body []byte, proof string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1"+path, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-AO-Scope-Credential", token)
		req.Header.Set("X-AO-Delegation-MAC", proof)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	plan := f.propose(spec)
	body, _ := json.Marshal(map[string]any{"operation": "plan", "planId": plan.Plan.ID, "digest": plan.Digest, "id": uuid.NewString(), "nonce": uuid.NewString(), "expires": time.Now().Add(9 * time.Second).UnixMilli()})
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(append([]byte("outer-native-v1:"), body...))
	if w := call(http.MethodPost, "/internal/outer/native", "", body, hex.EncodeToString(mac.Sum(nil))); w.Code != 200 {
		t.Fatal("native review trigger", w.Code, w.Body.String())
	}
	runs, err := f.st.ListReviewRunsBySession(ctx, spec.SessionID)
	if err != nil || len(runs) != 1 {
		t.Fatal(runs, err)
	}
	run := runs[0]
	credential := m3ResultCredential(t, f, run)
	path := "/api/v1/sessions/" + string(worker.ID) + "/reviews/submit"
	result, _ := json.Marshal(map[string]any{"reviews": []map[string]string{{"runId": run.ID, "verdict": "approved", "body": "reviewed exact head", "githubReviewId": "provider-review"}}})
	if w := call(http.MethodPost, path, credential, result, ""); w.Code != 409 {
		t.Fatal("result accepted before native reviewer acceptance", w.Code)
	}
	provider := f.providers[domain.SessionID("review-"+run.ReviewID)]
	waitM2(t, func() bool { r, _ := f.st.GetOuterRequest(ctx, run.BatchID); return !r.SubmittedAt.IsZero() })
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", ProviderEventID: uuid.NewString(), NativeAcceptance: true})
	waitM2(t, func() bool { r, _ := f.st.GetOuterRequest(ctx, run.BatchID); return !r.AcceptedAt.IsZero() })
	b, _, _ := f.outer.Binding(ctx)
	outerToken, _ := f.st.IssueOuterCaller(ctx, b.SessionID)
	workerToken, _ := f.st.IssueOuterCaller(ctx, worker.ID)
	for _, token := range []string{"", strings.Repeat("x", 43), outerToken, workerToken} {
		if w := call(http.MethodPost, path, token, result, ""); w.Code != 409 {
			t.Fatal("unowned result", w.Code, w.Body.String())
		}
	}
	for _, invalid := range []string{
		`{"runId":"other-head-run","verdict":"approved"}`,
		`{"reviews":[{"runId":"` + run.ID + `","verdict":"approved"},{"runId":"other-head-run","verdict":"approved"}]}`,
	} {
		if w := call(http.MethodPost, path, credential, []byte(invalid), ""); w.Code != 409 {
			t.Fatal("mismatched result receipt", w.Code, w.Body.String())
		}
	}
	for _, target := range []struct{ method, path string }{{http.MethodPost, "/api/v1/sessions/other/reviews/submit"}, {http.MethodPost, "/api/v1/sessions/" + string(worker.ID) + "/reviews/trigger"}, {http.MethodPost, "/api/v1/sessions/" + string(worker.ID) + "/reviews/cancel"}, {http.MethodGet, "/api/v1/sessions/" + string(worker.ID)}, {http.MethodPost, "/api/v1/outer/plans"}} {
		if w := call(target.method, target.path, credential, result, ""); w.Code != 409 {
			t.Fatal("result credential widened", target.path, w.Code)
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("UPDATE review_run SET target_sha=? WHERE id=?", strings.Repeat("c", 40), run.ID); err != nil {
		t.Fatal(err)
	}
	if w := call(http.MethodPost, path, credential, result, ""); w.Code != 409 {
		t.Fatal("changed review head accepted", w.Code)
	}
	if _, err := db.Exec("UPDATE review_run SET target_sha=? WHERE id=?", run.TargetSHA, run.ID); err != nil {
		t.Fatal(err)
	}
	reviewer, _, _ := f.st.GetReviewByID(ctx, run.ReviewID)
	resultStore.before = func() {
		if _, err := f.st.ClaimReviewChatController(ctx, reviewer.ID, reviewer.ProviderConversationID, "replacement-generation", time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if w := call(http.MethodPost, path, credential, result, ""); w.Code != 409 {
		t.Fatal("final result write accepted replaced controller", w.Code, w.Body.String())
	}
	resultStore.before = nil
	if _, err := f.st.ClaimReviewChatController(ctx, reviewer.ID, reviewer.ProviderConversationID, reviewer.ControllerGeneration, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Submit(ctx, worker.ID, run.ID, domain.VerdictApproved, "forged", ""); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("service omitted reviewer authority", err)
	}
	if _, err := f.st.UpdateReviewRunResult(ctx, run.ID, domain.ReviewRunComplete, domain.VerdictApproved, "forged", "", true); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("store omitted reviewer authority", err)
	}
	factory := m3ResultFactory(t, f, worker, run)
	before, err := factory.Get(ctx, "result-factory")
	if err != nil || len(before.Blockers) != 1 || !strings.Contains(before.Blockers[0], "review_unverified") {
		t.Fatal("factory gate did not require native verdict", before.Blockers, err)
	}
	if _, err := db.Exec("CREATE TRIGGER reject_m3_result_audit BEFORE INSERT ON outer_audit WHEN json_extract(NEW.document,'$.operation')='review.result' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"); err != nil {
		t.Fatal(err)
	}
	if w := call(http.MethodPost, path, credential, result, ""); w.Code != 500 {
		t.Fatal("unaudited result accepted", w.Code, w.Body.String())
	}
	if retained, _, _ := f.st.GetReviewRun(ctx, run.ID); retained.Status != domain.ReviewRunRunning {
		t.Fatal("verdict survived audit rollback", retained)
	}
	if _, err := db.Exec("DROP TRIGGER reject_m3_result_audit"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if w := call(http.MethodPost, path, credential, result, ""); w.Code != 200 {
			t.Fatal("native result intake/retry", w.Code, w.Body.String())
		}
	}
	recorded, _, _ := f.st.GetReviewRun(ctx, run.ID)
	if recorded.Status != domain.ReviewRunComplete || recorded.Verdict != domain.VerdictApproved || recorded.AutoInjectReview || recorded.DeliveredAt != nil {
		t.Fatal("result did not remain receipt-only", recorded)
	}
	after, err := factory.Get(ctx, "result-factory")
	if err != nil || len(after.Blockers) != 0 || after.NextAction != "advance_to_handoff" || after.Run.Stage != "review" {
		t.Fatal("recorded verdict did not satisfy independent gate", after.Blockers, err)
	}
	changed := after.Observed[0]
	changed.HeadSHA = strings.Repeat("c", 40)
	otherHead, err := factoryrun.New(f.st, m3ResultReader{facts: changed}, f.dir).Get(ctx, "result-factory")
	if err != nil || !strings.Contains(strings.Join(otherHead.Blockers, ","), "review_unverified") {
		t.Fatal("verdict authorized another head", otherHead.Blockers, err)
	}
	if f.providers[worker.ID].sendCalls != 0 || provider.sendCalls != 1 || launcher.starts != 1 {
		t.Fatal("result launched follow-up work")
	}
	if err := f.chat.DeliverFactoryFeedback(ctx, worker.ID, "continue", "forged"); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("result enabled continuation", err)
	}
	capacity, _ := f.st.OuterCapacity(ctx)
	if len(capacity) != 1 {
		t.Fatal("result released unsettled native review capacity")
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", ProviderEventID: uuid.NewString(), NativeSettlement: true})
	waitM2(t, func() bool { capacity, _ := f.st.OuterCapacity(ctx); return len(capacity) == 0 })
}
