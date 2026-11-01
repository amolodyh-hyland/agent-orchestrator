package chat_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
	"github.com/google/uuid"
)

type m3ReviewLauncher struct {
	f            *m2Fixture
	beforeWrite  func()
	preflightErr error
	launchErr    error
	dead         bool
	starts       int
	notifies     int
	cancels      int
}

func (*m3ReviewLauncher) InterfaceMode(domain.ReviewerHarness) domain.ReviewerInterfaceMode {
	return domain.ReviewerInterfaceChat
}
func (l *m3ReviewLauncher) Preflight(context.Context, domain.ReviewerHarness, string, ...domain.ReviewerInterfaceMode) error {
	return l.preflightErr
}
func (*m3ReviewLauncher) Reusable(domain.ReviewerHarness) bool                  { return true }
func (l *m3ReviewLauncher) Alive(context.Context, string, string) (bool, error) { return !l.dead, nil }
func (l *m3ReviewLauncher) Destroy(context.Context, string) error {
	return errors.New("unexpected destruction")
}
func (l *m3ReviewLauncher) RestoreTerminal(context.Context, reviewcore.LaunchSpec) (reviewcore.LaunchResult, error) {
	return reviewcore.LaunchResult{}, errors.New("unexpected restore")
}
func (l *m3ReviewLauncher) Cancel(ctx context.Context, handle string, _ domain.ReviewerHarness) error {
	l.cancels++
	return l.f.chat.InterruptForOwner(ctx, domain.ReviewConversationOwner(strings.TrimPrefix(handle, "review-chat:")))
}
func (l *m3ReviewLauncher) Notify(ctx context.Context, _ string, s reviewcore.LaunchSpec) error {
	l.notifies++
	return l.send(ctx, s)
}
func (l *m3ReviewLauncher) send(ctx context.Context, s reviewcore.LaunchSpec) error {
	if l.beforeWrite != nil {
		l.beforeWrite()
	}
	_, err := l.f.chat.SendForOwner(ctx, domain.ReviewConversationOwner(s.ReviewSessionID), ports.ChatUserMessage{Text: "Review only " + s.TargetSHA + " at " + s.PRURL, Origin: domain.MessageOriginDaemon, ClientMessageID: reviewcore.BatchMessageID(s.BatchID)})
	return err
}
func (l *m3ReviewLauncher) Spawn(ctx context.Context, s reviewcore.LaunchSpec) (reviewcore.LaunchResult, error) {
	l.starts++
	if l.launchErr != nil {
		return reviewcore.LaunchResult{}, l.launchErr
	}
	owner := domain.ReviewConversationOwner(s.ReviewSessionID)
	c, err := l.f.chat.Start(ctx, chatsvc.StartConfig{Owner: owner, SessionID: s.WorkerID, ProjectID: s.ProjectID, Harness: domain.HarnessCodex, Kind: domain.KindWorker, WorkspacePath: s.WorkspacePath, Model: s.AgentConfig.Model, Effort: s.AgentConfig.Effort, Permissions: ports.PermissionModeAuto})
	if err != nil {
		return reviewcore.LaunchResult{}, err
	}
	p := l.f.providers[domain.SessionID("review-"+s.ReviewSessionID)]
	p.emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerReady})
	waitM2(l.f.t, func() bool { return c.State() == ports.ChatControllerReady })
	err = l.send(ctx, s)
	return reviewcore.LaunchResult{HandleID: "review-chat:" + s.ReviewSessionID, AgentSessionID: c.ProviderConversationID()}, err
}

func m3ReviewFixture(t *testing.T, wrap ...func(ports.ChatStartConfig, *outerDesktopConversation) ports.ChatConversation) (*m2Fixture, *m3ReviewLauncher, domain.OuterActionSpec) {
	f := newM2Fixture(t, wrap...)
	rec, err := f.provision(context.Background(), ports.SpawnConfig{ProjectID: "a", Kind: domain.KindWorker}, false)
	if err != nil {
		t.Fatal(err)
	}
	pr := domain.PullRequest{URL: "https://github.com/o/r/pull/1", SessionID: rec.ID, HeadSHA: strings.Repeat("a", 40), Number: 1, UpdatedAt: time.Now()}
	if err := f.st.WriteSCMObservation(context.Background(), pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	l := &m3ReviewLauncher{f: f}
	engine := reviewcore.New(reviewcore.Deps{Store: f.st, Sessions: f.st, PRs: f.st, Projects: f.st, Launcher: l})
	f.outer.SetReviews(reviewsvc.New(engine, f.st))
	spec := domain.OuterActionSpec{Operation: "review.trigger", ProjectID: "a", SessionID: rec.ID, Config: domain.AgentConfig{Model: "gpt-test", Effort: "high", Permissions: domain.PermissionModeAuto}, Review: &domain.OuterReviewSpec{PRURL: pr.URL, HeadSHA: pr.HeadSHA}}
	return f, l, spec
}

func TestOuterM3ExactReviewAuthority(t *testing.T) {
	f, l, spec := m3ReviewFixture(t)
	ctx := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"})
	p, err := f.outer.ProposePlan(ctx, domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
	if err != nil {
		t.Fatal(err)
	}
	if l.starts != 0 {
		t.Fatal("proposal launched reviewer")
	}
	if _, err := f.outer.ApprovePlan(context.Background(), p.Plan.ID, p.Digest); !errors.Is(err, domain.ErrOuterHeld) {
		t.Fatal("omitted native authority", err)
	}
	approved, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if l.starts != 1 {
		t.Fatalf("review starts=%d receipts=%+v", l.starts, approved.Actions)
	}
	req, err := f.st.GetOuterRequest(context.Background(), p.Plan.Actions[0].ID)
	if err != nil {
		t.Fatal("review request missing", err)
	}
	if req.Request.ReviewID == "" || req.Request.Payload == "" {
		t.Fatal("missing reviewer binding")
	}
	waitM2(t, func() bool {
		r, _ := f.st.GetOuterRequest(context.Background(), req.Request.ID)
		return !r.AttemptedAt.IsZero()
	})
	r, _ := f.st.GetOuterRequest(context.Background(), req.Request.ID)
	if r.Request.SettingsDigest == "" {
		t.Fatal("settings not frozen")
	}
	if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest); err == nil {
		t.Fatal("replayed approval")
	}
	if _, err := f.chat.SendForOwner(context.Background(), domain.ReviewConversationOwner(r.Request.ReviewID), ports.ChatUserMessage{Text: "forged fix continuation", Origin: domain.MessageOriginHuman, ClientMessageID: uuid.NewString()}); err == nil {
		t.Fatal("review continued without native authority")
	}
}

func TestOuterM3ReviewChangedHeadAndPermissionsHold(t *testing.T) {
	for _, changed := range []string{"head", "permissions", "expired", "scope"} {
		t.Run(changed, func(t *testing.T) {
			f, l, spec := m3ReviewFixture(t)
			if changed == "permissions" {
				spec.Config.Permissions = domain.PermissionModeBypassPermissions
			}
			ctx := domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.read"})
			p, err := f.outer.ProposePlan(ctx, domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
			if changed == "permissions" {
				if err == nil {
					t.Fatal("mutable review permissions")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if changed == "head" {
				pr, _, _ := f.st.GetPR(context.Background(), spec.Review.PRURL)
				pr.HeadSHA = strings.Repeat("b", 40)
				if err := f.st.WriteSCMObservation(context.Background(), pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
					t.Fatal(err)
				}
			}
			if changed == "expired" {
				f.advance()
			}
			if changed == "scope" {
				b, _, _ := f.outer.Binding(context.Background())
				_, err = f.outer.SetScope(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.scope"}), b.Revision, []string{"a"}, true, true)
				if err != nil {
					t.Fatal(err)
				}
			}
			if changed == "expired" {
				l.beforeWrite = f.advance
			}
			_, _ = f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
			if changed != "expired" && l.starts != 0 {
				t.Fatal("changed authority launched reviewer")
			}
		})
	}
}

func (c *outerDesktopConversation) InterruptWithAdmission(ctx context.Context, turn string, acquire func(context.Context) (func(), error)) error {
	release, err := acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	return c.Interrupt(ctx, turn)
}

func TestOuterM3CancelExactReviewAndRetainUncertainReservation(t *testing.T) {
	f, l, spec := m3ReviewFixture(t)
	p := f.propose(spec)
	if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest); err != nil {
		t.Fatal(err)
	}
	runs, err := f.st.ListReviewRunsBySession(context.Background(), spec.SessionID)
	if err != nil || len(runs) != 1 {
		t.Fatal("run missing", runs, err)
	}
	r, err := f.st.GetOuterRequest(context.Background(), p.Plan.Actions[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	provider := f.providers[domain.SessionID("review-"+r.Request.ReviewID)]
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", ProviderEventID: uuid.NewString(), NativeAcceptance: true})
	waitM2(t, func() bool {
		r, _ := f.st.GetOuterRequest(context.Background(), p.Plan.Actions[0].ID)
		return !r.AcceptedAt.IsZero()
	})
	spec.Operation = "review.cancel"
	spec.Review.RunID = runs[0].ID
	cancelPlan := f.propose(spec)
	if _, err := f.outer.ApprovePlan(context.Background(), cancelPlan.Plan.ID, cancelPlan.Digest); err == nil {
		t.Fatal("anonymous cancel")
	}
	if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: cancelPlan.Plan.ID}), cancelPlan.Plan.ID, cancelPlan.Digest); err != nil {
		t.Fatal(err)
	}
	if l.cancels != 1 {
		t.Fatal("exact cancel not dispatched", l.cancels)
	}
	run, _, _ := f.st.GetReviewRun(context.Background(), runs[0].ID)
	if run.Status != domain.ReviewRunCancelled {
		t.Fatal("not cancelled", run.Status)
	}
	capacity, _ := f.st.OuterCapacity(context.Background())
	if len(capacity) != 1 {
		t.Fatal("cancel released uncertain station", capacity)
	}
	provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-1", ProviderEventID: uuid.NewString(), NativeSettlement: true})
	waitM2(t, func() bool { capacity, _ := f.st.OuterCapacity(context.Background()); return len(capacity) == 0 })
}

func TestOuterM3ReviewRoutesRequireSealedNativeAuthority(t *testing.T) {
	f, l, spec := m3ReviewFixture(t)
	key := bytes.Repeat([]byte{19}, 32)
	authority, err := delegationauth.New(key)
	if err != nil {
		t.Fatal(err)
	}
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer, Conversations: f.chat, DelegationAuth: authority}, httpd.ControlDeps{})
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
	proposal, _ := json.Marshal(domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a"}, Actions: []domain.OuterActionSpec{spec}})
	for _, credential := range []string{"", "forged"} {
		if w := call("/api/v1/outer/plans", proposal, credential, ""); w.Code != 409 {
			t.Fatal("forged proposal", w.Code, w.Body.String())
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
		t.Fatal("forged native authority", w.Code)
	}
	if l.starts != 0 {
		t.Fatal("proposal or forged native action launched")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(append([]byte("outer-native-v1:"), body...))
	if w := call("/internal/outer/native", body, token, hex.EncodeToString(mac.Sum(nil))); w.Code != 200 {
		t.Fatal("native exact review", w.Code, w.Body.String())
	}
	if l.starts != 1 {
		t.Fatal("missing legitimate review", l.starts)
	}
	for _, operation := range []string{"trigger", "cancel", "submit", "restore", "switch", "rerequest", "comments/resolve"} {
		for _, credential := range []string{"", token} {
			w := call("/api/v1/sessions/"+string(spec.SessionID)+"/reviews/"+operation, []byte(`{"humanAuthored":true,"approved":true}`), credential, "")
			if w.Code != 409 {
				t.Fatal("unsealed review route", operation, w.Code)
			}
		}
	}
}

type m3CancelWrite struct {
	*outerDesktopConversation
	before func()
}

func (c *m3CancelWrite) InterruptWithAdmission(ctx context.Context, id string, admit func(context.Context) (func(), error)) error {
	c.before()
	return c.outerDesktopConversation.InterruptWithAdmission(ctx, id, admit)
}
func TestOuterM3ReviewCancelHoldsRevocationAtFinalWrite(t *testing.T) {
	var before func()
	f, _, spec := m3ReviewFixture(t, func(_ ports.ChatStartConfig, c *outerDesktopConversation) ports.ChatConversation {
		return &m3CancelWrite{outerDesktopConversation: c, before: func() {
			if before != nil {
				before()
			}
		}}
	})
	p := f.propose(spec)
	if _, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest); err != nil {
		t.Fatal(err)
	}
	runs, _ := f.st.ListReviewRunsBySession(context.Background(), spec.SessionID)
	if len(runs) != 1 {
		t.Fatal("review did not start")
	}
	req, err := f.st.GetOuterRequest(context.Background(), p.Plan.Actions[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	f.providers[domain.SessionID("review-"+req.Request.ReviewID)].emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-1", ProviderEventID: uuid.NewString(), NativeAcceptance: true})
	waitM2(t, func() bool {
		r, _ := f.st.GetOuterRequest(context.Background(), req.Request.ID)
		return !r.AcceptedAt.IsZero()
	})
	spec.Operation = "review.cancel"
	spec.Review.RunID = runs[0].ID
	cancelPlan := f.propose(spec)
	before = func() {
		before = nil
		b, _, _ := f.outer.Binding(context.Background())
		if _, err := f.outer.SetScope(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.scope"}), b.Revision, []string{"a"}, true, true); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: cancelPlan.Plan.ID}), cancelPlan.Plan.ID, cancelPlan.Digest)
	run, _, _ := f.st.GetReviewRun(context.Background(), runs[0].ID)
	if run.Status != domain.ReviewRunRunning {
		t.Fatal("revoked cancellation changed run", run.Status)
	}
	capacity, _ := f.st.OuterCapacity(context.Background())
	if len(capacity) != 1 {
		t.Fatal("revoked cancel released uncertain capacity", capacity)
	}
}

func TestOuterM3ReviewerCapacityReleasesOnlyDefinitiveNoStart(t *testing.T) {
	for _, definite := range []bool{true, false} {
		t.Run(fmt.Sprint(definite), func(t *testing.T) {
			f, l, spec := m3ReviewFixture(t)
			if definite {
				l.preflightErr = errors.New("unavailable before launch")
			} else {
				l.launchErr = errors.New("ambiguous launch result")
			}
			p := f.propose(spec)
			r, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
			if err != nil {
				t.Fatal(err)
			}
			capacity, err := f.st.OuterCapacity(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if definite {
				if len(capacity) != 0 || r.Actions[0].State != "not_started" || l.starts != 0 {
					t.Fatal("definitive no-start did not release", capacity, r.Actions, l.starts)
				}
			} else {
				if len(capacity) != 1 || r.Actions[0].State != "unknown" {
					t.Fatal("uncertain launch released capacity", capacity, r.Actions)
				}
			}
		})
	}
}

func TestOuterM3ReviewerCannotRestoreOrSwitchImplicitly(t *testing.T) {
	for _, mode := range []string{"restore", "config-switch"} {
		t.Run(mode, func(t *testing.T) {
			f, l, spec := m3ReviewFixture(t)
			if mode == "restore" {
				l.dead = true
				if _, err := f.st.SetSessionReviewerConfig(context.Background(), spec.SessionID, domain.ReviewerCodex, spec.Config, time.Now()); err != nil {
					t.Fatal(err)
				}
			}
			previous := domain.Review{ID: "old-review", SessionID: spec.SessionID, ProjectID: "a", Harness: domain.ReviewerCodex, InterfaceMode: domain.ReviewerInterfaceChat, ReviewerHandleID: "review-chat:old-review", ReviewerActivityState: domain.ActivityIdle, AgentSessionID: "old-native", ProviderConversationID: "old-native", ControllerGeneration: "old-generation", CreatedAt: time.Now(), UpdatedAt: time.Now()}
			if err := f.st.UpsertReview(context.Background(), previous); err != nil {
				t.Fatal(err)
			}
			p := f.propose(spec)
			r, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(context.Background(), domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: p.Plan.ID}), p.Plan.ID, p.Digest)
			if err != nil {
				t.Fatal(err)
			}
			if l.starts != 0 || r.Actions[0].State != "not_started" {
				t.Fatal("held reviewer adapter launched", l.starts, r.Actions)
			}
			current, _, _ := f.st.GetReviewByID(context.Background(), previous.ID)
			if current.ProviderConversationID != previous.ProviderConversationID || current.ControllerGeneration != previous.ControllerGeneration {
				t.Fatal("held adapter changed reviewer identity", current)
			}
		})
	}
}
