package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/persistenthost"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The wording is Codex's own, captured live from codex-cli 0.159.2 against an
// enterprise-managed requirement that allows only ReadOnly and WorkspaceWrite.
// resetExplanation is the text a refused return to the default mode adds, so the user
// is told why a posture they did not choose was sent.
const resetExplanation = "returning to Codex defaults sent the ask-for-approval posture"

const managedSandboxRejection = "invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by enterprise-managed requirements Default requirements (6e1e489a-e29e-4073-8f8c-01fd3ae783df))"

// assertLabelledRejection checks a marked refusal still says which request failed,
// carries the provider's wording verbatim, and keeps the provider's own error
// reachable: the classification adds to the failure, it does not replace it.
func assertLabelledRejection(t *testing.T, err error, label string) {
	t.Helper()
	if !strings.HasPrefix(err.Error(), label) {
		t.Errorf("error %q does not start with the request label %q", err.Error(), label)
	}
	if !strings.Contains(err.Error(), managedSandboxRejection) {
		t.Errorf("error %q lost the provider's wording", err.Error())
	}
	var cause *rpcError
	if !errors.As(err, &cause) || cause.Message != managedSandboxRejection {
		t.Errorf("the provider's error is not reachable from %v", err)
	}
}

func TestPermissionConstraintMessages(t *testing.T) {
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		{"managed sandbox rejection", managedSandboxRejection, true},
		{"approval policy outside the allowed set", "invalid value for `approval_policy`: `Never` is not in the allowed set [OnRequest, UnlessTrusted]", true},
		{"disallowed by requirements", "Configured value for `approval_policy` is disallowed by requirements", true},
		// The reviewer is the third field a mode sends (auto picks the automatic one), so a
		// refusal naming only it must be recognised on its own.
		{"approvals reviewer outside the allowed set", "invalid value for `approvals_reviewer`: `AutoReview` is not in the allowed set [User]", true},
		{"approvals reviewer disallowed by requirements", "Configured value for `approvals_reviewer` is disallowed by requirements", true},
		{"a constraint on something else", "invalid value for `features.ultrafast_mode`: `true` is not in the allowed set [false]", false},
		{"usage limit", "Usage limit reached. Resets tomorrow.", false},
		{"unknown thread", "unknown thread", false},
		{"sandbox mentioned without a constraint", "sandbox failed to start", false},
		{
			"another managed rejection under a requirement named like a permission setting",
			"invalid value for `model`: `gpt-x` is not in the allowed set [gpt-y] (set by enterprise-managed requirements Sandbox and approval policy)",
			false,
		},
		{"the setting named without backticks", "sandbox_mode DangerFullAccess is not in the allowed set", false},
		// Codex's own wording for conflicts that are not constraint refusals: the field
		// is backticked, but nothing says a value was outside an allowed set.
		{"two permission overrides that cannot be combined", "`sandbox_mode` and `permission_profile` overrides cannot both be set", false},
		{"a backticked setting in a message that is not a constraint", "invalid value for `sandbox_mode`: expected a string", false},
		// The label after "(set by …)" is free text an administrator chose; a
		// backticked setting name inside it is not what was refused.
		{
			"a requirement label that contains a backticked setting",
			"invalid value for `model`: `gpt-x` is not in the allowed set [gpt-y] (set by enterprise-managed requirements `sandbox_mode` policy)",
			false,
		},
		{"empty", "", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isPermissionConstraintMessage(test.message); got != test.want {
				t.Fatalf("isPermissionConstraintMessage(%q) = %t, want %t", test.message, got, test.want)
			}
		})
	}
}

func TestPermissionRejectionOnlyMarksProviderConstraintErrors(t *testing.T) {
	rejected := permissionRejection(ports.PermissionModeBypassPermissions, &rpcError{Code: -32600, Message: managedSandboxRejection})
	var typed *ports.PermissionRejectedError
	if !errors.Is(rejected, ports.ErrPermissionRejected) || !errors.As(rejected, &typed) {
		t.Fatalf("a managed-requirement error was not marked: %v", rejected)
	}
	if typed.Mode != ports.PermissionModeBypassPermissions || typed.Reason != managedSandboxRejection {
		t.Fatalf("rejection = %+v, want the mode and the provider's verbatim reason", typed)
	}
	// The provider's own error stays reachable underneath, so a caller can still read
	// its code and so the original failure is not lost behind the classification.
	var cause *rpcError
	if !errors.As(rejected, &cause) || cause.Code != -32600 || cause.Message != managedSandboxRejection {
		t.Fatalf("the provider's error is not reachable through the rejection: %v", rejected)
	}
	// A stored mode AO does not recognise means the provider's default, never a mode
	// the ladder would step down from.
	odd := permissionRejection("not-a-mode", &rpcError{Code: -32600, Message: managedSandboxRejection})
	if !errors.As(odd, &typed) || typed.Mode != ports.PermissionModeDefault {
		t.Fatalf("an unrecognised mode was recorded as %+v, want default", typed)
	}

	for name, err := range map[string]error{
		"provider error": &rpcError{Code: -32000, Message: "Usage limit reached"},
		"transport":      ErrConnClosed,
		"cancelled":      context.Canceled,
	} {
		if got := permissionRejection(ports.PermissionModeBypassPermissions, err); errors.Is(got, ports.ErrPermissionRejected) {
			t.Errorf("%s was marked as a permission rejection", name)
		}
	}
}

func TestTurnRejectionIsMarkedForEveryExplicitMode(t *testing.T) {
	for _, mode := range []ports.PermissionMode{
		ports.PermissionModeBypassPermissions, ports.PermissionModeAuto, ports.PermissionModeAcceptEdits,
	} {
		t.Run(string(mode), func(t *testing.T) {
			d, srv := newTestDriver(t)
			srv.mu.Lock()
			srv.failures["turn/start"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
			srv.mu.Unlock()
			conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			defer func() { _ = conv.Close() }()

			_, err = conv.SendTurn(context.Background(), ports.ChatUserMessage{
				Text: "go", Settings: ports.ChatTurnSettings{Approval: mode},
			})
			var typed *ports.PermissionRejectedError
			if !errors.Is(err, ports.ErrPermissionRejected) || !errors.As(err, &typed) || typed.Mode != mode {
				t.Fatalf("SendTurn error = %v, want a permission rejection for %q", err, mode)
			}
			assertLabelledRejection(t, err, "turn/start: ")
			// Only a return to the default mode sends a posture the user did not pick, so only
			// that refusal explains itself that way.
			if strings.Contains(err.Error(), resetExplanation) {
				t.Errorf("a refusal of the explicit mode %q was explained as a reset: %v", mode, err)
			}
		})
	}
}

// The default mode sends no approval fields, so a refusal can never be about them:
// the same provider message is an ordinary failure there, not a reason to step down.
func TestDefaultModeFailureIsNotAPermissionRejection(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	srv.failures["turn/start"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
	srv.mu.Unlock()
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	_, err = conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeDefault},
	})
	if err == nil || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("SendTurn error = %v, want a plain failure", err)
	}
}

func TestReadOnlyTurnFailureIsNotAPermissionRejection(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	srv.failures["turn/start"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
	srv.mu.Unlock()
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws", ReadOnly: true})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	_, err = conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "go"})
	if err == nil || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("SendTurn error = %v, want a plain failure for a read-only conversation", err)
	}
}

func TestThreadStartRejectionIsMarkedOnlyWhenAnOverrideWasSent(t *testing.T) {
	for _, tc := range []struct {
		mode ports.PermissionMode
		want bool
	}{
		{ports.PermissionModeBypassPermissions, true},
		{ports.PermissionModeAuto, true},
		{ports.PermissionModeDefault, false},
	} {
		t.Run(string(tc.mode), func(t *testing.T) {
			d, srv := newTestDriver(t)
			srv.mu.Lock()
			srv.failures["thread/start"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
			srv.mu.Unlock()
			_, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws", Permissions: tc.mode})
			if err == nil {
				t.Fatal("Start succeeded against a rejecting provider")
			}
			if got := errors.Is(err, ports.ErrPermissionRejected); got != tc.want {
				t.Fatalf("Start(%q) marked as a permission rejection = %t, want %t: %v", tc.mode, got, tc.want, err)
			}
			// Marked or not, the failure still names the request and keeps the provider's error.
			assertLabelledRejection(t, err, "thread/start: ")
		})
	}
}

// The conversation is fine when the provider refuses the permission mode, so the
// error must not read as an unresumable conversation (which offers a fresh one).
func TestThreadResumePermissionRejectionIsNotAResumeFailure(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	srv.failures["thread/resume"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
	srv.mu.Unlock()
	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if !errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Resume error = %v, want a permission rejection", err)
	}
	if errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("Resume error = %v; a policy refusal must not be reported as an unresumable conversation", err)
	}
	assertLabelledRejection(t, err, "thread/resume: ")
}

// Anything else that goes wrong resuming still means the conversation could not be
// resumed.
func TestThreadResumeOtherFailureIsStillAResumeFailure(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	srv.failures["thread/resume"] = `{"code":-32602,"message":"unknown thread"}`
	srv.mu.Unlock()
	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if !errors.Is(err, ports.ErrChatResumeFailed) || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Resume error = %v, want a plain resume failure", err)
	}
}

// A read-only launch always sends never/read-only whatever AO mode was asked for, so
// a refusal of it says nothing about a permission mode AO could lower. Marking it
// would send the fallback round a ladder that cannot change what was refused.
func TestReadOnlyLaunchRefusalIsNotAPermissionRejection(t *testing.T) {
	failure := `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
	t.Run("start", func(t *testing.T) {
		d, srv := newTestDriver(t)
		srv.mu.Lock()
		srv.failures["thread/start"] = failure
		srv.mu.Unlock()
		_, err := d.Start(context.Background(), ports.ChatStartConfig{
			WorkspacePath: "/tmp/ws", ReadOnly: true, Permissions: ports.PermissionModeBypassPermissions,
		})
		if err == nil || errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("read-only Start error = %v, want a plain failure", err)
		}
	})
	t.Run("resume", func(t *testing.T) {
		d, srv := newTestDriver(t)
		srv.mu.Lock()
		srv.failures["thread/resume"] = failure
		srv.mu.Unlock()
		_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
			SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
			ReadOnly: true, Permissions: ports.PermissionModeBypassPermissions,
		})
		if err == nil || errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("read-only Resume error = %v, want a plain failure", err)
		}
	})
}

/* ---- returning to the default mode ------------------------------------- */

// turnPosture decodes the approval fields a turn/start frame carried.
type turnPosture struct {
	ApprovalPolicy    string `json:"approvalPolicy"`
	ApprovalsReviewer string `json:"approvalsReviewer"`
	SandboxPolicy     *struct {
		Type string `json:"type"`
	} `json:"sandboxPolicy"`
}

// turnPostures returns the approval fields of every turn/start sent so far, in order.
func turnPostures(t *testing.T, srv *scriptedServer) []turnPosture {
	t.Helper()
	srv.mu.Lock()
	defer srv.mu.Unlock()
	var out []turnPosture
	for _, f := range srv.seen {
		if f.Method != "turn/start" {
			continue
		}
		var posture turnPosture
		if err := json.Unmarshal(f.Params, &posture); err != nil {
			t.Fatalf("decode turn/start params: %v", err)
		}
		out = append(out, posture)
	}
	return out
}

func sendWithMode(t *testing.T, conv ports.ChatConversation, mode ports.PermissionMode) error {
	t.Helper()
	_, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "go", Settings: ports.ChatTurnSettings{Approval: mode},
	})
	return err
}

func (p turnPosture) isEmpty() bool {
	return p.ApprovalPolicy == "" && p.ApprovalsReviewer == "" && p.SandboxPolicy == nil
}

func (p turnPosture) isAskForApproval() bool {
	return p.ApprovalPolicy == "on-request" && p.ApprovalsReviewer == "user" &&
		p.SandboxPolicy != nil && p.SandboxPolicy.Type == "workspaceWrite"
}

// Codex applies a turn's override to later turns and cannot withdraw it, so a
// switch back to "Codex defaults" after an explicit mode must send a posture:
// sending nothing would leave, say, full access running under that label.
func TestDroppingToTheDefaultModeAfterAnExplicitOneResetsThePosture(t *testing.T) {
	for _, tc := range []struct {
		name  string
		start ports.PermissionMode
		first ports.PermissionMode // an explicit mode sent on a turn, or "" for none
	}{
		{"launched with an explicit mode", ports.PermissionModeBypassPermissions, ""},
		{"launched with approve-for-me", ports.PermissionModeAuto, ""},
		{"explicit mode chosen on a turn", ports.PermissionModeDefault, ports.PermissionModeBypassPermissions},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, srv := newTestDriver(t)
			conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws", Permissions: tc.start})
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			defer func() { _ = conv.Close() }()
			if tc.first != "" {
				if err := sendWithMode(t, conv, tc.first); err != nil {
					t.Fatalf("explicit turn: %v", err)
				}
			}
			if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
				t.Fatalf("default turn: %v", err)
			}
			if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
				t.Fatalf("second default turn: %v", err)
			}

			postures := turnPostures(t, srv)
			reset, again := postures[len(postures)-2], postures[len(postures)-1]
			if !reset.isAskForApproval() {
				t.Errorf("the turn that returned to defaults sent %+v, want the explicit ask-for-approval posture", reset)
			}
			if !again.isEmpty() {
				t.Errorf("a later default turn sent %+v; once reset, the default mode overrides nothing", again)
			}
		})
	}
}

// A thread that never carried an explicit posture has nothing to withdraw, so the
// default mode stays the legacy no-override launch on every turn.
func TestDefaultModeOnAnUntouchedThreadNeverSendsAPosture(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()
	for i := 0; i < 3; i++ {
		if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
			t.Fatalf("default turn %d: %v", i, err)
		}
	}
	for i, posture := range turnPostures(t, srv) {
		if !posture.isEmpty() {
			t.Errorf("default turn %d sent %+v on a thread that never overrode anything", i, posture)
		}
	}
}

// A reset the provider refused did not happen, so the next default turn tries it
// again instead of assuming the thread is back at its defaults.
func TestRefusedResetIsRetriedOnTheNextDefaultTurn(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: "/tmp/ws", Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	srv.mu.Lock()
	srv.failures["turn/start"] = `{"code":-32600,"message":"provider busy"}`
	srv.mu.Unlock()
	err = sendWithMode(t, conv, ports.PermissionModeDefault)
	if err == nil {
		t.Fatal("the refused reset reported success")
	}
	// The provider was merely busy, which says nothing about the posture: it must read
	// as itself, not as a refusal of the reset.
	if strings.Contains(err.Error(), resetExplanation) || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("a non-permission failure of the reset was labelled as a refusal: %v", err)
	}
	srv.mu.Lock()
	delete(srv.failures, "turn/start")
	srv.mu.Unlock()
	if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
		t.Fatalf("retried default turn: %v", err)
	}
	postures := turnPostures(t, srv)
	if len(postures) != 2 || !postures[0].isAskForApproval() || !postures[1].isAskForApproval() {
		t.Fatalf("postures = %+v, want the reset attempted twice", postures)
	}
}

// A read-only conversation sends its own fixed posture and has nothing to reset.
func TestReadOnlyConversationNeverResets(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: "/tmp/ws", ReadOnly: true, Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()
	if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
		t.Fatalf("turn: %v", err)
	}
	postures := turnPostures(t, srv)
	if len(postures) != 1 || postures[0].SandboxPolicy == nil || postures[0].SandboxPolicy.Type != "readOnly" {
		t.Fatalf("postures = %+v, want the fixed read-only posture", postures)
	}
}

// A resumed thread keeps the override its last turn left, even when the resume sends
// none: Codex restores it (checked live, a prior turn's automatic reviewer survived a
// plain thread/resume). So whatever mode a resume carries, the first default turn
// afterwards resets rather than trusting the label; only a read-only conversation,
// whose posture is fixed, has nothing to reset.
func TestResumeAssumesThePriorPostureMayRemain(t *testing.T) {
	for _, tc := range []struct {
		name      string
		mode      ports.PermissionMode
		readOnly  bool
		wantReset bool
	}{
		{"resumed with an explicit mode", ports.PermissionModeBypassPermissions, false, true},
		{"resumed with approve-for-me", ports.PermissionModeAuto, false, true},
		{"resumed with the default mode", ports.PermissionModeDefault, false, true},
		{"read-only conversation", ports.PermissionModeDefault, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, srv := newTestDriver(t)
			conv, err := d.Resume(context.Background(), ports.ChatResumeConfig{
				SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
				Permissions: tc.mode, ReadOnly: tc.readOnly,
			})
			if err != nil {
				t.Fatalf("Resume: %v", err)
			}
			defer func() { _ = conv.Close() }()
			if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
				t.Fatalf("default turn: %v", err)
			}
			posture := turnPostures(t, srv)[0]
			if tc.wantReset && !posture.isAskForApproval() {
				t.Errorf("first default turn sent %+v, want the reset posture", posture)
			}
			if !tc.wantReset && (posture.SandboxPolicy == nil || posture.SandboxPolicy.Type != "readOnly") {
				t.Errorf("read-only turn sent %+v, want its fixed read-only posture", posture)
			}
		})
	}
}

// A host that survived a daemon restart may still carry an override from before it,
// whatever mode is stored now: the stored mode can be default while the thread is
// still on full access. Its first default turn must reset, not trust the label.
func TestReconnectedHostIsResetOnTheFirstDefaultTurn(t *testing.T) {
	for _, tc := range []struct {
		name      string
		readOnly  bool
		wantReset bool
	}{
		{"writable conversation", false, true},
		{"read-only conversation", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, srv := newTestDriver(t)
			proc, err := d.spawn(context.Background(), "codex", "/tmp/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			d.persistent = true
			d.connectHost = func(context.Context, persistenthost.Config) (*persistenthost.Transport, error) {
				return &persistenthost.Transport{Stdin: proc.stdin, Stdout: proc.stdout, Reconnected: true, NextRequestID: 41}, nil
			}
			conv, err := d.Resume(context.Background(), ports.ChatResumeConfig{
				SessionID: "ao-reconnect", ProviderConversationID: "thread-survived", DataDir: t.TempDir(),
				WorkspacePath: "/tmp/ws", Permissions: ports.PermissionModeDefault, ReadOnly: tc.readOnly,
			})
			if err != nil {
				t.Fatalf("Resume: %v", err)
			}
			defer func() { _ = conv.Close() }()

			if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
				t.Fatalf("default turn: %v", err)
			}
			if err := sendWithMode(t, conv, ports.PermissionModeDefault); err != nil {
				t.Fatalf("second default turn: %v", err)
			}
			postures := turnPostures(t, srv)
			if tc.wantReset {
				if !postures[0].isAskForApproval() {
					t.Errorf("first default turn on a surviving host sent %+v, want the reset posture", postures[0])
				}
				if !postures[1].isEmpty() {
					t.Errorf("second default turn sent %+v; once reset it overrides nothing", postures[1])
				}
				return
			}
			if postures[0].SandboxPolicy == nil || postures[0].SandboxPolicy.Type != "readOnly" {
				t.Errorf("read-only turn sent %+v, want its fixed read-only posture", postures[0])
			}
		})
	}
}

// A refused return to the default mode was a refusal of the posture AO sent, not of
// "default" (which sends nothing). The error must name that posture and say why it
// was sent, or the user is told a mode that asks for nothing was rejected.
func TestRefusedResetNamesThePostureThatWasSent(t *testing.T) {
	d, srv := newTestDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: "/tmp/ws", Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()
	srv.mu.Lock()
	srv.failures["turn/start"] = `{"code":-32600,"message":` + strconv.Quote(
		"invalid value for `approval_policy`: `OnRequest` is not in the allowed set [Never] (set by enterprise-managed requirements x)") + `}`
	srv.mu.Unlock()

	err = sendWithMode(t, conv, ports.PermissionModeDefault)

	var refused *ports.PermissionRejectedError
	if !errors.As(err, &refused) {
		t.Fatalf("error = %v, want a permission rejection", err)
	}
	if refused.Mode != ports.PermissionModeAcceptEdits {
		t.Errorf("rejected mode = %q, want accept-edits: the posture AO actually sent", refused.Mode)
	}
	if !strings.Contains(err.Error(), resetExplanation) {
		t.Errorf("error %q does not explain why that posture was sent", err.Error())
	}
}
