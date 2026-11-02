package chat_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/google/uuid"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type m3RunReader struct {
	branch  string
	inspect func()
}

func (r *m3RunReader) Inspect(_ context.Context, repo, worktree, base string) (domain.RunRepoFacts, error) {
	if r.inspect != nil {
		r.inspect()
	}
	return domain.RunRepoFacts{RepoPath: repo, WorktreePath: worktree, BaseSHA: base, HeadSHA: strings.Repeat("b", 40), Branch: r.branch, Fingerprint: strings.Repeat("f", 64), ChangedFiles: []string{}, Staged: []string{}, Unstaged: []string{}, Untracked: []string{}}, nil
}
func (*m3RunReader) VerifyArtifact(context.Context, string, domain.RunArtifact) error { return nil }

func m3RunFixture(t *testing.T) (*m2Fixture, *factoryrun.Service, *m3RunReader, domain.OuterActionSpec) {
	f := newM2Fixture(t)
	rec, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindWorker, Branch: "m3/run"}, false)
	if err != nil {
		t.Fatal(err)
	}
	rec.Metadata.DiffBaseSHA = strings.Repeat("a", 40)
	if err := f.st.UpdateSession(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	reader := &m3RunReader{branch: "m3/run"}
	svc := factoryrun.New(f.st, reader, f.dir)
	f.outer.SetRuns(svc)
	in := factoryrun.CreateInput{ID: "run-m3", ProjectID: "a", SessionID: rec.ID, TaskID: "bounded-task", DesignDigest: strings.Repeat("d", 64), PolicyDecision: "record intent only", RequiredChecks: []string{"unit"}, Actor: "outer-orchestrator", Decision: "Claim approved task scope"}
	payload, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	return f, svc, reader, domain.OuterActionSpec{Operation: "run.create", ProjectID: "a", SessionID: rec.ID, Run: &domain.OuterRunSpec{ID: in.ID, Payload: payload}}
}

func approveM3(t *testing.T, f *m2Fixture, spec domain.OuterActionSpec) domain.OuterPlanReceipt {
	t.Helper()
	p := f.propose(spec)
	if _, err := f.outer.ApprovePlan(context.Background(), p.Plan.ID, p.Digest); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("missing native approval", err)
	}
	r, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
	if err != nil || len(r.Actions) != 1 || r.Actions[0].State != "completed" {
		t.Fatal("exact inert action did not complete", r.Actions, err)
	}
	return r
}

func TestOuterM3RunClaimsAndDecisionRequestsLaunchNoWork(t *testing.T) {
	f, svc, _, spec := m3RunFixture(t)
	approveM3(t, f, spec)
	detail, err := svc.Get(context.Background(), spec.Run.ID)
	if err != nil || detail.Run.Stage != "design" || len(detail.Evidence) != 1 || detail.Evidence[0].Confirmed {
		t.Fatal("created claim was confirmed", detail, err)
	}
	spec.Operation = "run.evidence.request"
	spec.Run.Payload = nil
	approveM3(t, f, spec)
	after, _ := svc.Get(context.Background(), spec.Run.ID)
	if after.Run.Version != 0 {
		t.Fatal("decision request changed run")
	}
	preview, err := svc.Preview(context.Background(), spec.Run.ID, "evidence")
	if err != nil {
		t.Fatal(err)
	}
	native := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "run.confirm", Generation: "evidence", ProjectID: "a", SessionID: spec.SessionID})
	if _, err := svc.Confirm(context.Background(), spec.Run.ID, "evidence", 0, preview.Digest); err == nil {
		t.Fatal("anonymous run confirmation")
	}
	detail, err = svc.Confirm(native, spec.Run.ID, "evidence", 0, preview.Digest)
	if err != nil || detail.Run.Version != 1 {
		t.Fatal("existing native confirmation held", err)
	}
	claim := factoryrun.RecordInput{ExpectedVersion: 1, Actor: "outer-orchestrator", Decision: "unverified completion claim", Completion: &domain.RunCompletion{RepoName: domain.RootWorkspaceRepoName, Attempt: 1}}
	spec.Operation = "run.evidence"
	spec.Run.ExpectedVersion = 1
	spec.Run.Payload, _ = json.Marshal(claim)
	approveM3(t, f, spec)
	detail, err = svc.Get(context.Background(), spec.Run.ID)
	if err != nil || detail.Run.Version != 2 {
		t.Fatal(detail.Run, err)
	}
	for _, e := range detail.Evidence {
		if e.Kind == "completion" && e.Confirmed {
			t.Fatal("claim self-confirmed")
		}
	}
	spec.Operation = "run.advance.request"
	spec.Run.ExpectedVersion = 2
	spec.Run.Payload = nil
	approveM3(t, f, spec)
	detail, _ = svc.Get(context.Background(), spec.Run.ID)
	if detail.Run.Version != 2 || detail.Run.Stage != "design" {
		t.Fatal("advance request advanced stage", detail.Run)
	}
	if f.spawned != 0 || f.providers[spec.SessionID].sendCalls != 0 {
		t.Fatal("ledger adapter launched work")
	}
	if held, err := f.st.FactoryFeedbackHeld(context.Background(), spec.SessionID); err != nil || !held {
		t.Fatal("participant feedback not held", held, err)
	}
	if err := f.chat.DeliverFactoryFeedback(context.Background(), spec.SessionID, "continue from findings", "forged"); err == nil {
		t.Fatal("implicit continuation")
	}
	for _, action := range []string{"feedback", "pause_feedback", "resume_feedback"} {
		ctx := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "run.confirm", Generation: action, ProjectID: "a", SessionID: spec.SessionID})
		if err := f.st.CheckOuterOperation(ctx, "run.confirm", "a", spec.SessionID); !errors.Is(err, domain.ErrOuterHeld) {
			t.Fatal("run record expanded native scope", action, err)
		}
	}
}

func TestOuterM3RunRechecksBeforeLedgerWrite(t *testing.T) {
	f, svc, reader, spec := m3RunFixture(t)
	p := f.propose(spec)
	reader.inspect = func() {
		reader.inspect = nil
		b, _, _ := f.outer.Binding(context.Background())
		if _, err := f.outer.SetScope(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.scope"}), b.Revision, []string{"a"}, true, true); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
	if _, err := svc.Get(context.Background(), spec.Run.ID); err == nil {
		t.Fatal("paused during inspection still wrote run")
	}
	if f.providers[spec.SessionID].sendCalls != 0 {
		t.Fatal("held ledger launched work")
	}
}

func TestOuterM3RunVersionAndOwnershipAreSealed(t *testing.T) {
	f, svc, _, spec := m3RunFixture(t)
	approveM3(t, f, spec)
	spec.Operation = "run.evidence.request"
	spec.Run.Payload = nil
	p := f.propose(spec)
	preview, err := svc.Preview(context.Background(), spec.Run.ID, "evidence")
	if err != nil {
		t.Fatal(err)
	}
	native := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "run.confirm", Generation: "evidence", ProjectID: "a", SessionID: spec.SessionID})
	if _, err := svc.Confirm(native, spec.Run.ID, "evidence", 0, preview.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest); err == nil {
		t.Fatal("stale run version approved")
	}
	spec.Run.ExpectedVersion = 1
	spec.SessionID = "missing"
	if _, err := f.outer.ProposePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"}), domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}}); err == nil {
		t.Fatal("forged run owner")
	}
}

func TestOuterM3RunNativeRoutesKeepClaimsAndDecisionsSeparate(t *testing.T) {
	f, svc, _, spec := m3RunFixture(t)
	key := bytes.Repeat([]byte{23}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer, Conversations: f.chat, FactoryRuns: svc, DelegationAuth: authority}, httpd.ControlDeps{})
	b, _, _ := f.outer.Binding(context.Background())
	token, err := f.st.IssueOuterCaller(context.Background(), b.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	call := func(path string, body []byte, credential, proof string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1"+path, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("X-AO-Scope-Credential", credential)
		req.Header.Set("X-AO-Delegation-MAC", proof)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	sign := func(purpose string, raw []byte) string {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(append([]byte(purpose), raw...))
		return hex.EncodeToString(mac.Sum(nil))
	}
	proposal, _ := json.Marshal(domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
	for _, credential := range []string{"", "forged"} {
		if w := call("/api/v1/outer/plans", proposal, credential, ""); w.Code != 409 {
			t.Fatal("forged run proposal", w.Code)
		}
	}
	w := call("/api/v1/outer/plans", proposal, token, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var plan domain.OuterPlanReceipt
	if err := json.Unmarshal(w.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"operation": "plan", "planId": plan.Plan.ID, "digest": plan.Digest, "id": uuid.NewString(), "nonce": uuid.NewString(), "expires": time.Now().Add(9 * time.Second).UnixMilli()})
	if w := call("/internal/outer/native", body, token, "forged"); w.Code != 409 {
		t.Fatal("forged native run action", w.Code)
	}
	if _, err := svc.Get(context.Background(), spec.Run.ID); err == nil {
		t.Fatal("inert proposal created run")
	}
	if w := call("/internal/outer/native", body, token, sign("outer-native-v1:", body)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	detail, err := svc.Get(context.Background(), spec.Run.ID)
	if err != nil || detail.Evidence[0].Confirmed {
		t.Fatal("claim confirmed", err)
	}
	for _, path := range []string{"/api/v1/runs", "/api/v1/runs/" + spec.Run.ID + "/evidence", "/api/v1/runs/" + spec.Run.ID + "/advance"} {
		for _, credential := range []string{"", token, "forged"} {
			if w := call(path, []byte(`{"humanAuthored":true,"approved":true}`), credential, ""); w.Code != 409 {
				t.Fatal("unsealed ledger route", path, w.Code)
			}
		}
	}
	preview, err := svc.Preview(context.Background(), spec.Run.ID, "evidence")
	if err != nil {
		t.Fatal(err)
	}
	confirm, _ := json.Marshal(map[string]any{"operation": "confirm", "runId": spec.Run.ID, "action": "evidence", "expectedVersion": 0, "digest": preview.Digest, "nonce": uuid.NewString(), "expires": time.Now().Add(9 * time.Second).UnixMilli()})
	if w := call("/internal/factory-run-confirmation", confirm, token, "forged"); w.Code != 403 {
		t.Fatal("forged independent decision", w.Code)
	}
	if w := call("/internal/factory-run-confirmation", confirm, "", sign("factory-run-v1:", confirm)); w.Code != 200 {
		t.Fatal("independent native decision held", w.Code, w.Body.String())
	}
	detail, _ = svc.Get(context.Background(), spec.Run.ID)
	if detail.Run.Version != 1 {
		t.Fatal("native decision missing")
	}
	if f.providers[spec.SessionID].sendCalls != 0 {
		t.Fatal("native evidence decision launched work")
	}
}
