package chat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

const (
	bypass     = ports.PermissionModeBypassPermissions
	autoMode   = ports.PermissionModeAuto
	acceptEdit = ports.PermissionModeAcceptEdits
	defaultMod = ports.PermissionModeDefault
)

var errProviderBusy = errors.New("provider is overloaded, try again later")

// modeRejectingConversation refuses a turn whose permission mode is in reject, the
// way Codex refuses an override outside a managed requirement's allowed set. It
// records the mode of every attempt, so a test can assert the exact step-down.
type modeRejectingConversation struct {
	*fakeConversation

	modeMu   sync.Mutex
	reject   map[ports.PermissionMode]error
	attempts []ports.PermissionMode
}

func rejected(mode ports.PermissionMode) error {
	reason := fmt.Sprintf("managed requirements do not allow %s", mode)
	return &ports.PermissionRejectedError{Mode: mode, Reason: reason, Err: errors.New(reason)}
}

func (c *modeRejectingConversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	c.modeMu.Lock()
	c.attempts = append(c.attempts, msg.Settings.Approval)
	err := c.reject[msg.Settings.Approval]
	c.modeMu.Unlock()
	if err != nil {
		return ports.ChatTurnRef{}, err
	}
	return c.fakeConversation.SendTurn(ctx, msg)
}

func (c *modeRejectingConversation) attemptedModes() []ports.PermissionMode {
	c.modeMu.Lock()
	defer c.modeMu.Unlock()
	return append([]ports.PermissionMode(nil), c.attempts...)
}

type fallbackOptions struct {
	permissions     ports.PermissionMode
	disableFallback bool
	reject          map[ports.PermissionMode]error
	// start overrides how the provider answers a launch. It is handed the
	// conversation double to return once it accepts the mode.
	start func(ports.ChatStartConfig, ports.ChatConversation) (ports.ChatConversation, error)
	caps  ports.ChatCapabilities
	// readOnly starts a read-only conversation, as a reviewer does.
	readOnly bool
}

type fallbackFixture struct {
	svc  *chatsvc.Service
	st   *sqlite.Store
	ctrl *chatsvc.Controller
	conv *modeRejectingConversation
	logs *bytes.Buffer

	startErr error

	changedMu sync.Mutex
	changed   []ports.PermissionMode
}

func newFallbackFixture(t *testing.T, opts fallbackOptions) *fallbackFixture {
	t.Helper()
	st := openStore(t)
	f := &fallbackFixture{st: st, logs: &bytes.Buffer{}}
	f.conv = &modeRejectingConversation{fakeConversation: newFakeConversation(), reject: opts.reject}
	var counterMu sync.Mutex
	counter := 0
	var start func(ports.ChatStartConfig) (ports.ChatConversation, error)
	if opts.start != nil {
		start = func(cfg ports.ChatStartConfig) (ports.ChatConversation, error) { return opts.start(cfg, f.conv) }
	}
	f.svc = chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Drivers: fakeRegistry{driver: fakeDriver{conv: f.conv, start: start, caps: opts.caps}},
		Log:     slog.New(slog.NewTextHandler(&lockedWriter{w: f.logs}, nil)),
		NewID: func() string {
			counterMu.Lock()
			defer counterMu.Unlock()
			counter++
			return fmt.Sprintf("id-%03d", counter)
		},
		OnPermissionsChanged: func(id domain.SessionID, mode domain.PermissionMode) {
			f.changedMu.Lock()
			defer f.changedMu.Unlock()
			if id != testSession {
				panic("unexpected session " + string(id))
			}
			f.changed = append(f.changed, mode)
		},
	})
	startCfg := chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
		WorkspacePath: t.TempDir(), Permissions: opts.permissions,
		DisablePermissionFallback: opts.disableFallback,
		ReadOnly:                  opts.readOnly,
	}
	f.ctrl, f.startErr = f.svc.Start(context.Background(), startCfg)
	if f.startErr == nil {
		t.Cleanup(func() { _ = f.svc.Stop(context.Background(), testSession) })
	}
	return f
}

type lockedWriter struct {
	mu sync.Mutex
	w  *bytes.Buffer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func (f *fallbackFixture) send(text string) (domain.ConversationTurn, error) {
	return f.svc.Send(context.Background(), testSession, ports.ChatUserMessage{
		Text: text, ClientMessageID: "client-" + text, Origin: domain.MessageOriginHuman,
	})
}

func (f *fallbackFixture) persistedMode(t *testing.T) ports.PermissionMode {
	t.Helper()
	snapshot, err := f.st.LoadConversationSnapshot(context.Background(), f.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	return snapshot.Conversation.Settings.ApprovalMode
}

// fallbackNotice is the decoded detail of a permission.fallback timeline row.
type fallbackNotice struct {
	Event     string `json:"event"`
	Requested string `json:"requested"`
	Effective string `json:"effective"`
	Rejected  []struct {
		Mode   string `json:"mode"`
		Reason string `json:"reason"`
	} `json:"rejected"`
}

// fallbackNotices returns the durable timeline notices a step-down left, so the
// step-down is visible to someone reading the conversation, not only the logs.
func (f *fallbackFixture) fallbackNotices(t *testing.T) []fallbackNotice {
	t.Helper()
	snapshot, err := f.st.LoadConversationSnapshot(context.Background(), f.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	var notices []fallbackNotice
	for _, activity := range snapshot.Activities {
		var notice fallbackNotice
		if json.Unmarshal(activity.Detail, &notice) == nil && notice.Event == "permission.fallback" {
			if activity.Kind != domain.ActivityKindSystem {
				t.Errorf("notice kind = %q, want system", activity.Kind)
			}
			notices = append(notices, notice)
		}
	}
	return notices
}

func (f *fallbackFixture) changedModes() []ports.PermissionMode {
	f.changedMu.Lock()
	defer f.changedMu.Unlock()
	return append([]ports.PermissionMode(nil), f.changed...)
}

func reject(modes ...ports.PermissionMode) map[ports.PermissionMode]error {
	out := map[ports.PermissionMode]error{}
	for _, mode := range modes {
		out[mode] = rejected(mode)
	}
	return out
}

/* ---- turn-level step-down --------------------------------------------- */

// Each rung of the ladder, one test row per rung the turn ends up on.
func TestTurnStepsDownOneModeAtATimeUntilAccepted(t *testing.T) {
	for _, tc := range []struct {
		name      string
		refuse    []ports.PermissionMode
		wantRun   ports.PermissionMode
		wantTried []ports.PermissionMode
	}{
		{"bypass to auto", []ports.PermissionMode{bypass}, autoMode, []ports.PermissionMode{bypass, autoMode}},
		{"auto to accept-edits", []ports.PermissionMode{bypass, autoMode}, acceptEdit, []ports.PermissionMode{bypass, autoMode, acceptEdit}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFallbackFixture(t, fallbackOptions{permissions: bypass, reject: reject(tc.refuse...)})
			if f.startErr != nil {
				t.Fatalf("Start: %v", f.startErr)
			}
			turn, err := f.send("first")
			if err != nil {
				t.Fatalf("Send: %v", err)
			}
			if turn.State != domain.TurnStateRunning {
				t.Fatalf("turn state = %q, want running", turn.State)
			}
			if got := f.conv.attemptedModes(); !reflect.DeepEqual(got, tc.wantTried) {
				t.Fatalf("modes tried = %v, want %v", got, tc.wantTried)
			}
			// The effective mode is what the conversation shows, durably and live.
			if got := f.ctrl.Settings().ApprovalMode; got != tc.wantRun {
				t.Fatalf("controller approval mode = %q, want %q", got, tc.wantRun)
			}
			if got := f.persistedMode(t); got != tc.wantRun {
				t.Fatalf("persisted approval mode = %q, want %q", got, tc.wantRun)
			}
			if got := f.changedModes(); !reflect.DeepEqual(got, []ports.PermissionMode{tc.wantRun}) {
				t.Fatalf("session permissions reported = %v, want [%s]", got, tc.wantRun)
			}
			// The step-down is never silent: each refused mode and the result are logged.
			logs := f.logs.String()
			for _, refused := range tc.refuse {
				if !strings.Contains(logs, "mode="+string(refused)) || !strings.Contains(logs, "managed requirements do not allow "+string(refused)) {
					t.Errorf("log does not record %s being rejected:\n%s", refused, logs)
				}
			}
			if !strings.Contains(logs, "permission fallback applied") || !strings.Contains(logs, "effective="+string(tc.wantRun)) {
				t.Errorf("log does not record the effective mode %s:\n%s", tc.wantRun, logs)
			}
			// ...and it is a durable timeline row naming what was asked, what ran, and why.
			notices := f.fallbackNotices(t)
			if len(notices) != 1 {
				t.Fatalf("timeline has %d permission notices, want 1", len(notices))
			}
			if notices[0].Requested != string(bypass) || notices[0].Effective != string(tc.wantRun) || len(notices[0].Rejected) != len(tc.refuse) {
				t.Fatalf("notice = %+v, want requested bypass, effective %s and %d rejected modes", notices[0], tc.wantRun, len(tc.refuse))
			}
			for i, refused := range tc.refuse {
				if notices[0].Rejected[i].Mode != string(refused) || !strings.Contains(notices[0].Rejected[i].Reason, "managed requirements do not allow") {
					t.Errorf("notice rejected[%d] = %+v, want %s with the provider's reason", i, notices[0].Rejected[i], refused)
				}
			}
		})
	}
}

// Once a turn has been accepted at a lower mode, later turns start from it rather
// than asking the provider for the rejected mode again.
func TestStepDownIsRememberedForLaterTurns(t *testing.T) {
	f := newFallbackFixture(t, fallbackOptions{permissions: bypass, reject: reject(bypass)})
	if f.startErr != nil {
		t.Fatalf("Start: %v", f.startErr)
	}
	first, err := f.send("first")
	if err != nil {
		t.Fatalf("first Send: %v", err)
	}
	f.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: first.ProviderTurnID},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: first.ProviderTurnID, TurnState: domain.TurnStateCompleted},
	)
	waitForTurnToSettle(t, f)
	if _, err := f.send("second"); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	if got, want := f.conv.attemptedModes(), []ports.PermissionMode{bypass, autoMode, autoMode}; !reflect.DeepEqual(got, want) {
		t.Fatalf("modes tried across two turns = %v, want %v", got, want)
	}
	if got := f.changedModes(); len(got) != 1 {
		t.Fatalf("session permissions reported %d times, want once: %v", len(got), got)
	}
}

// waitForTurnToSettle polls the durable rows until the first turn has completed,
// so a following message dispatches instead of queueing behind it.
func waitForTurnToSettle(t *testing.T, f *fallbackFixture) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err := f.st.LoadConversationSnapshot(context.Background(), f.ctrl.ConversationID())
		if err != nil {
			t.Fatalf("load conversation: %v", err)
		}
		if len(snapshot.Turns) == 1 && snapshot.Turns[0].State == domain.TurnStateCompleted {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the first turn never completed")
}

// Steps down only on a permission rejection: any other provider failure surfaces
// as it is, on the first attempt or after a step-down.
func TestNoStepDownOnUnrelatedErrors(t *testing.T) {
	t.Run("on the requested mode", func(t *testing.T) {
		f := newFallbackFixture(t, fallbackOptions{
			permissions: bypass, reject: map[ports.PermissionMode]error{bypass: errProviderBusy},
		})
		_, err := f.send("first")
		if !errors.Is(err, errProviderBusy) {
			t.Fatalf("Send error = %v, want the provider's own error", err)
		}
		if got, want := f.conv.attemptedModes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
			t.Fatalf("modes tried = %v, want only %v", got, want)
		}
		if f.ctrl.Settings().ApprovalMode != bypass || len(f.changedModes()) != 0 {
			t.Fatalf("an unrelated failure changed the mode: %q, reported %v", f.ctrl.Settings().ApprovalMode, f.changedModes())
		}
	})
	t.Run("after a step-down", func(t *testing.T) {
		f := newFallbackFixture(t, fallbackOptions{
			permissions: bypass,
			reject:      map[ports.PermissionMode]error{bypass: rejected(bypass), autoMode: errProviderBusy},
		})
		_, err := f.send("first")
		if !errors.Is(err, errProviderBusy) || errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("Send error = %v, want the unrelated provider error", err)
		}
		if got, want := f.conv.attemptedModes(), []ports.PermissionMode{bypass, autoMode}; !reflect.DeepEqual(got, want) {
			t.Fatalf("modes tried = %v, want %v and no further step", got, want)
		}
		if f.ctrl.Settings().ApprovalMode != bypass {
			t.Fatalf("approval mode = %q; a failed turn must not change it", f.ctrl.Settings().ApprovalMode)
		}
	})
}

// A fallback may only ever lower the mode: it never retries the same mode and
// never offers a more permissive one.
func TestStepDownNeverEscalates(t *testing.T) {
	for _, tc := range []struct {
		requested ports.PermissionMode
		want      []ports.PermissionMode
	}{
		{acceptEdit, []ports.PermissionMode{acceptEdit}},
		{autoMode, []ports.PermissionMode{autoMode, acceptEdit}},
		{defaultMod, []ports.PermissionMode{defaultMod}},
	} {
		t.Run(string(tc.requested), func(t *testing.T) {
			f := newFallbackFixture(t, fallbackOptions{
				permissions: tc.requested, reject: reject(bypass, autoMode, acceptEdit, defaultMod),
			})
			if _, err := f.send("first"); err == nil {
				t.Fatal("Send succeeded though every mode is rejected")
			}
			if got := f.conv.attemptedModes(); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("modes tried from %q = %v, want %v", tc.requested, got, tc.want)
			}
		})
	}
}

func TestEveryModeRejectedFailsClearlyListingThem(t *testing.T) {
	f := newFallbackFixture(t, fallbackOptions{
		permissions: bypass, reject: reject(bypass, autoMode, acceptEdit),
	})
	turn, err := f.send("first")
	var exhausted *ports.PermissionFallbackExhaustedError
	if !errors.As(err, &exhausted) || !errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Send error = %v, want a permission fallback exhausted error", err)
	}
	want := []ports.PermissionMode{bypass, autoMode, acceptEdit}
	if got := f.conv.attemptedModes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("modes tried = %v, want %v", got, want)
	}
	for _, mode := range want {
		if !strings.Contains(err.Error(), string(mode)) {
			t.Errorf("error %q does not list %q", err.Error(), mode)
		}
	}
	if turn.State != domain.TurnStateFailed {
		t.Fatalf("turn state = %q, want failed", turn.State)
	}
	if f.ctrl.Settings().ApprovalMode != bypass || len(f.changedModes()) != 0 {
		t.Fatalf("a total failure changed the mode: %q, reported %v", f.ctrl.Settings().ApprovalMode, f.changedModes())
	}
}

// A turn that ran with the requested mode, or that failed outright, leaves no
// notice: the timeline only says a mode was lowered when one really was.
func TestNoTimelineNoticeWithoutAStepDown(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reject map[ports.PermissionMode]error
		fail   bool
	}{
		{"requested mode accepted", nil, false},
		{"unrelated failure", map[ports.PermissionMode]error{bypass: errProviderBusy}, true},
		{"every mode rejected", reject(bypass, autoMode, acceptEdit), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFallbackFixture(t, fallbackOptions{permissions: bypass, reject: tc.reject})
			_, err := f.send("first")
			if (err != nil) != tc.fail {
				t.Fatalf("Send error = %v, want failure=%t", err, tc.fail)
			}
			if got := f.fallbackNotices(t); len(got) != 0 {
				t.Fatalf("timeline has permission notices %+v, want none", got)
			}
		})
	}
}

func TestFallbackDisabledSurfacesTheProviderRejection(t *testing.T) {
	f := newFallbackFixture(t, fallbackOptions{
		permissions: bypass, disableFallback: true, reject: reject(bypass),
	})
	_, err := f.send("first")
	if !errors.Is(err, ports.ErrPermissionRejected) || errors.As(err, new(*ports.PermissionFallbackExhaustedError)) {
		t.Fatalf("Send error = %v, want the plain permission rejection", err)
	}
	if !strings.Contains(err.Error(), "managed requirements do not allow bypass-permissions") {
		t.Fatalf("error %q does not carry the provider's reason", err.Error())
	}
	if got, want := f.conv.attemptedModes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
		t.Fatalf("modes tried = %v, want only %v with the fallback off", got, want)
	}
	if f.ctrl.Settings().ApprovalMode != bypass || len(f.changedModes()) != 0 {
		t.Fatalf("a disabled fallback changed the mode: %q, reported %v", f.ctrl.Settings().ApprovalMode, f.changedModes())
	}
}

// A mode the user picks while a turn is being sent is theirs; a fallback that
// finishes afterwards must not overwrite it.
func TestStepDownDoesNotOverwriteAConcurrentChoice(t *testing.T) {
	f := newFallbackFixture(t, fallbackOptions{permissions: bypass, reject: reject(bypass)})
	if f.startErr != nil {
		t.Fatalf("Start: %v", f.startErr)
	}
	f.conv.onSend = func(string) {
		if _, err := f.svc.SetTurnSettings(context.Background(), testSession, domain.ConversationSettings{ApprovalMode: acceptEdit}); err != nil {
			t.Errorf("SetTurnSettings: %v", err)
		}
	}
	if _, err := f.send("first"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got := f.ctrl.Settings().ApprovalMode; got != acceptEdit {
		t.Fatalf("approval mode = %q, want the user's concurrent choice %q", got, acceptEdit)
	}
}

/* ---- launch-level step-down ------------------------------------------- */

// launchRecorder answers a launch the way a provider with a managed requirement
// does, and records the mode of every attempt.
type launchRecorder struct {
	mu       sync.Mutex
	attempts []ports.PermissionMode
	reject   map[ports.PermissionMode]error
}

func (l *launchRecorder) start(cfg ports.ChatStartConfig, conv ports.ChatConversation) (ports.ChatConversation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempts = append(l.attempts, cfg.Permissions)
	if err := l.reject[cfg.Permissions]; err != nil {
		return nil, err
	}
	return conv, nil
}

func (l *launchRecorder) modes() []ports.PermissionMode {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ports.PermissionMode(nil), l.attempts...)
}

func newLaunchFixture(t *testing.T, requested ports.PermissionMode, disable bool, refuse map[ports.PermissionMode]error) (*fallbackFixture, *launchRecorder) {
	t.Helper()
	recorder := &launchRecorder{reject: refuse}
	f := newFallbackFixture(t, fallbackOptions{
		permissions: requested, disableFallback: disable, start: recorder.start,
	})
	return f, recorder
}

func TestLaunchStepsDownWhenTheProviderRejectsTheMode(t *testing.T) {
	f, recorder := newLaunchFixture(t, bypass, false, reject(bypass, autoMode))
	if f.startErr != nil {
		t.Fatalf("Start: %v", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass, autoMode, acceptEdit}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want %v", got, want)
	}
	if got := f.ctrl.Settings().ApprovalMode; got != acceptEdit {
		t.Fatalf("controller approval mode = %q, want %q", got, acceptEdit)
	}
	if got := f.persistedMode(t); got != acceptEdit {
		t.Fatalf("persisted approval mode = %q, want %q", got, acceptEdit)
	}
	if got := f.changedModes(); !reflect.DeepEqual(got, []ports.PermissionMode{acceptEdit}) {
		t.Fatalf("session permissions reported = %v, want [%s]", got, acceptEdit)
	}
	if !strings.Contains(f.logs.String(), "stage=launch") {
		t.Errorf("launch step-down was not logged:\n%s", f.logs.String())
	}
	notices := f.fallbackNotices(t)
	if len(notices) != 1 || notices[0].Requested != string(bypass) || notices[0].Effective != string(acceptEdit) || len(notices[0].Rejected) != 2 {
		t.Fatalf("timeline notices = %+v, want one bypass -> accept-edits notice listing two rejected modes", notices)
	}
}

func TestLaunchNoStepDownOnUnrelatedErrors(t *testing.T) {
	f, recorder := newLaunchFixture(t, bypass, false, map[ports.PermissionMode]error{bypass: errProviderBusy})
	if !errors.Is(f.startErr, errProviderBusy) {
		t.Fatalf("Start error = %v, want the provider's own error", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want only %v", got, want)
	}
}

func TestLaunchAllModesRejectedFailsListingThem(t *testing.T) {
	f, recorder := newLaunchFixture(t, bypass, false, reject(bypass, autoMode, acceptEdit))
	var exhausted *ports.PermissionFallbackExhaustedError
	if !errors.As(f.startErr, &exhausted) {
		t.Fatalf("Start error = %v, want a permission fallback exhausted error", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass, autoMode, acceptEdit}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want %v", got, want)
	}
	if got := len(exhausted.Rejected); got != 3 {
		t.Fatalf("exhausted error lists %d modes, want 3", got)
	}
}

// The provider's own defaults are never a fallback: a launch that every explicit
// mode refused fails, it does not quietly run with whatever the provider's
// configuration says, which could be wider than anything that was refused.
func TestLaunchNeverFallsBackToTheProvidersOwnDefaults(t *testing.T) {
	_, recorder := newLaunchFixture(t, bypass, false, reject(bypass, autoMode, acceptEdit))
	for _, mode := range recorder.modes() {
		if mode == defaultMod {
			t.Fatalf("launch tried default after the explicit modes were refused: %v", recorder.modes())
		}
	}
}

func TestLaunchFallbackDisabled(t *testing.T) {
	f, recorder := newLaunchFixture(t, bypass, true, reject(bypass))
	if !errors.Is(f.startErr, ports.ErrPermissionRejected) {
		t.Fatalf("Start error = %v, want the permission rejection", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want only %v with the fallback off", got, want)
	}
}

func TestLaunchNeverEscalates(t *testing.T) {
	f, recorder := newLaunchFixture(t, acceptEdit, false, reject(acceptEdit))
	if got, want := recorder.modes(), []ports.PermissionMode{acceptEdit}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want only %v and nothing more permissive", got, want)
	}
	if !errors.Is(f.startErr, ports.ErrPermissionRejected) {
		t.Fatalf("Start error = %v, want the rejection reported as is", f.startErr)
	}
}

// A lower mode can need an approval channel the provider lacks. That is a refusal
// of the mode, not a reason to launch something that could stall unattended.
func TestLaunchSkipsModesTheProviderCannotAdmit(t *testing.T) {
	noApprovals := ports.ChatCapabilities{
		ports.ChatCapabilityStreaming: true,
		ports.ChatCapabilityInterrupt: true,
		ports.ChatCapabilityResume:    true,
	}
	recorder := &launchRecorder{reject: reject(bypass)}
	f := newFallbackFixture(t, fallbackOptions{permissions: bypass, caps: noApprovals, start: recorder.start})
	var exhausted *ports.PermissionFallbackExhaustedError
	if !errors.As(f.startErr, &exhausted) {
		t.Fatalf("Start error = %v, want exhausted: every lower mode needs an approval channel", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v; modes that cannot be admitted must not be launched", got)
	}
}

// A read-only conversation (a reviewer) never steps down: its sandbox does not
// depend on the permission mode, so a lower mode could not change the outcome.
func TestReadOnlyLaunchNeverStepsDown(t *testing.T) {
	recorder := &launchRecorder{reject: reject(bypass)}
	f := newFallbackFixture(t, fallbackOptions{permissions: bypass, readOnly: true, start: recorder.start})
	if !errors.Is(f.startErr, ports.ErrPermissionRejected) {
		t.Fatalf("Start error = %v, want the rejection reported as is", f.startErr)
	}
	if got, want := recorder.modes(), []ports.PermissionMode{bypass}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launch modes tried = %v, want only %v for a read-only conversation", got, want)
	}
}

// The whole persistence chain on a real database: a step-down reports the mode, the
// hook writes it with the targeted session query, and reading the session back
// shows it. Fakes cannot prove this, because the general session update does not
// write the pinned permissions at all; only the targeted write does.
func TestStepDownIsPersistedOnTheSessionRow(t *testing.T) {
	for _, tc := range []struct {
		name   string
		launch bool
	}{
		{"turn step-down", false},
		{"launch step-down", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := openStore(t)
			ctx := context.Background()
			if updated, err := st.UpdateSessionPermissions(ctx, testSession, bypass); err != nil || !updated {
				t.Fatalf("seed pinned permissions: updated=%v err=%v", updated, err)
			}
			conv := &modeRejectingConversation{fakeConversation: newFakeConversation(), reject: reject(bypass)}
			recorder := &launchRecorder{reject: reject(bypass)}
			start := func(cfg ports.ChatStartConfig) (ports.ChatConversation, error) { return recorder.start(cfg, conv) }
			if !tc.launch {
				start = nil
			}
			svc := chatsvc.New(chatsvc.Options{
				Store: st, Sessions: st,
				Drivers: fakeRegistry{driver: fakeDriver{conv: conv, start: start}},
				Log:     slog.New(slog.DiscardHandler),
				NewID:   func() string { return "id-" + tc.name },
				OnPermissionsChanged: func(id domain.SessionID, mode domain.PermissionMode) {
					if _, err := st.UpdateSessionPermissions(ctx, id, mode); err != nil {
						t.Errorf("persist: %v", err)
					}
				},
			})
			if _, err := svc.Start(ctx, chatsvc.StartConfig{
				SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
				WorkspacePath: t.TempDir(), Permissions: bypass,
			}); err != nil {
				t.Fatalf("Start: %v", err)
			}
			t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })
			if !tc.launch {
				if _, err := svc.Send(ctx, testSession, ports.ChatUserMessage{
					Text: "go", ClientMessageID: "client-go", Origin: domain.MessageOriginHuman,
				}); err != nil {
					t.Fatalf("Send: %v", err)
				}
			}

			got, ok, err := st.GetSession(ctx, testSession)
			if err != nil || !ok {
				t.Fatalf("read session: ok=%v err=%v", ok, err)
			}
			if got.Metadata.Permissions != autoMode {
				t.Fatalf("session permissions = %q, want the lower mode that was accepted", got.Metadata.Permissions)
			}
			if got.Metadata.Permissions == bypass {
				t.Fatal("the session still pins the refused bypass-permissions")
			}
		})
	}
}
