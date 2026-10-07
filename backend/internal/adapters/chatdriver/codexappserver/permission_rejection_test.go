package codexappserver

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// The wording is Codex's own, captured live from codex-cli 0.159.2 against an
// enterprise-managed requirement that allows only ReadOnly and WorkspaceWrite.
const managedSandboxRejection = "invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by enterprise-managed requirements Default requirements (6e1e489a-e29e-4073-8f8c-01fd3ae783df))"

func TestPermissionConstraintMessages(t *testing.T) {
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		{"managed sandbox rejection", managedSandboxRejection, true},
		{"approval policy outside the allowed set", "invalid value for `approval_policy`: `Never` is not in the allowed set [OnRequest, UnlessTrusted]", true},
		{"disallowed by requirements", "Configured value for `approval_policy` is disallowed by requirements", true},
		{"a constraint on something else", "invalid value for `features.ultrafast_mode`: `true` is not in the allowed set [false]", false},
		{"usage limit", "Usage limit reached. Resets tomorrow.", false},
		{"unknown thread", "unknown thread", false},
		{"sandbox mentioned without a constraint", "sandbox failed to start", false},
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
		})
	}
}

func TestThreadResumeRejectionKeepsResumeFailureAndMarksPermission(t *testing.T) {
	d, srv := newTestDriver(t)
	srv.mu.Lock()
	srv.failures["thread/resume"] = `{"code":-32600,"message":` + strconv.Quote(managedSandboxRejection) + `}`
	srv.mu.Unlock()
	_, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if !errors.Is(err, ports.ErrChatResumeFailed) || !errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Resume error = %v, want both a resume failure and a permission rejection", err)
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
