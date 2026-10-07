package codexappserver

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/persistenthost"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// A managed requirement that allows only approval policy Never refuses the posture
// a return to the default mode sends. A thread reopened after a daemon restart is
// only assumed to need that return, so the refusal must not lock the default mode
// out: before this was handled, every default turn re-sent the refused posture and
// the explicit modes were refused too, leaving no way to send a message.

const (
	noPostureOverride = "//"
	resetPosture      = "on-request/workspaceWrite/user"
)

func newManagedDriver(t *testing.T) (*Driver, *composedServer) {
	t.Helper()
	server := &composedServer{t: t, refuseOnRequest: true}
	return &Driver{
		plugin:       fakePlugin{bin: "codex", authStatus: ports.AgentAuthStatusAuthorized},
		log:          slog.New(slog.DiscardHandler),
		versionProbe: func(context.Context, string) (string, error) { return "codex-cli 0.159.2", nil },
		spawn:        server.spawn,
	}, server
}

func sendDefault(conv ports.ChatConversation) error {
	_, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeDefault},
	})
	return err
}

func resumeDefaultThread(t *testing.T, d *Driver, reconnect bool) ports.ChatConversation {
	t.Helper()
	cfg := ports.ChatResumeConfig{
		SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
		Permissions: ports.PermissionModeDefault,
	}
	if reconnect {
		proc, err := d.spawn(context.Background(), "codex", "/tmp/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		d.persistent = true
		d.connectHost = func(context.Context, persistenthost.Config) (*persistenthost.Transport, error) {
			return &persistenthost.Transport{Stdin: proc.stdin, Stdout: proc.stdout, Reconnected: true, NextRequestID: 41}, nil
		}
		cfg.DataDir = t.TempDir()
	}
	conv, err := d.Resume(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	t.Cleanup(func() { _ = conv.Close() })
	return conv
}

func TestRefusedResetOnAnAssumedPostureDoesNotLockOutTheDefaultMode(t *testing.T) {
	for _, tc := range []struct {
		name      string
		reconnect bool
	}{
		{"thread resumed in a new app-server", false},
		{"host that outlived the daemon", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, server := newManagedDriver(t)
			conv := resumeDefaultThread(t, d, tc.reconnect)

			err := sendDefault(conv)
			if !errors.Is(err, ports.ErrPermissionRejected) {
				t.Fatalf("first default turn error = %v, want the refusal reported", err)
			}
			if !strings.Contains(err.Error(), "may still carry the permission override") {
				t.Fatalf("error %q does not warn that an earlier override may remain", err.Error())
			}
			for i := 0; i < 2; i++ {
				if err := sendDefault(conv); err != nil {
					t.Fatalf("default turn %d after the refusal: %v", i+2, err)
				}
			}

			got := server.turnPostures()
			want := []string{resetPosture, noPostureOverride, noPostureOverride}
			if strings.Join(got, " ") != strings.Join(want, " ") {
				t.Fatalf("turn postures = %v, want %v: ask once, then stop assuming", got, want)
			}
		})
	}
}

// A posture this process sent is known, not assumed: the user can return to that
// mode, so the refused reset keeps being reported rather than being waved through
// under a "Codex defaults" label while the thread still has the wider override.
func TestRefusedResetOfAPostureThisProcessSentKeepsBeingRefused(t *testing.T) {
	d, server := newManagedDriver(t)
	conv, err := d.Start(context.Background(), ports.ChatStartConfig{
		WorkspacePath: "/tmp/ws", Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	for i := 0; i < 2; i++ {
		err := sendDefault(conv)
		if !errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("default turn %d error = %v, want the refusal", i+1, err)
		}
		if strings.Contains(err.Error(), "may still carry the permission override") {
			t.Fatalf("error %q treats a known override as a guess", err.Error())
		}
	}
	if got := server.turnPostures(); strings.Join(got, " ") != resetPosture+" "+resetPosture {
		t.Fatalf("turn postures = %v, want the reset asked for both times", got)
	}
}

// A resume that itself sent an override applied it, so that posture is known too.
func TestRefusedResetAfterAResumeThatSentAnOverrideKeepsBeingRefused(t *testing.T) {
	d, server := newManagedDriver(t)
	server.refuseOnRequest = false
	conv, err := d.Resume(context.Background(), ports.ChatResumeConfig{
		SessionID: "ao-1", ProviderConversationID: "thread-1", WorkspacePath: "/tmp/ws",
		Permissions: ports.PermissionModeAuto,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	defer func() { _ = conv.Close() }()
	server.mu.Lock()
	server.refuseOnRequest = true
	server.mu.Unlock()

	for i := 0; i < 2; i++ {
		if err := sendDefault(conv); !errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("default turn %d error = %v, want the refusal", i+1, err)
		}
	}
	if got := server.turnPostures(); strings.Join(got, " ") != resetPosture+" "+resetPosture {
		t.Fatalf("turn postures = %v, want the reset asked for both times", got)
	}
}

// Only a refusal of the posture ends the assumption. Any other failure says nothing
// about whether the thread needs resetting, so the reset is asked for again.
func TestUnrelatedFailureKeepsAssumingTheResumedPosture(t *testing.T) {
	d, server := newManagedDriver(t)
	server.refuseOnRequest = false
	conv := resumeDefaultThread(t, d, false)
	server.mu.Lock()
	server.failTo = "Usage limit reached. Resets tomorrow."
	server.mu.Unlock()
	if err := sendDefault(conv); err == nil || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("error = %v, want the provider's plain failure", err)
	}
	server.mu.Lock()
	server.failTo = ""
	server.mu.Unlock()
	if err := sendDefault(conv); err != nil {
		t.Fatalf("retried default turn: %v", err)
	}
	if got := server.turnPostures(); strings.Join(got, " ") != resetPosture+" "+resetPosture {
		t.Fatalf("turn postures = %v, want the reset asked for again", got)
	}
}

// An override that was accepted is the thread's known posture from then on, so a
// later refused reset is reported, not waved through.
func TestAcceptedOverrideOnAResumedThreadMakesItsPostureKnown(t *testing.T) {
	d, server := newManagedDriver(t)
	server.refuseOnRequest = false
	conv := resumeDefaultThread(t, d, false)
	if _, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{
		Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeAuto},
	}); err != nil {
		t.Fatalf("auto turn: %v", err)
	}
	server.mu.Lock()
	server.refuseOnRequest = true
	server.mu.Unlock()

	for i := 0; i < 2; i++ {
		err := sendDefault(conv)
		if !errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("default turn %d error = %v, want the refusal", i+1, err)
		}
		if strings.Contains(err.Error(), "may still carry the permission override") {
			t.Fatalf("error %q treats an accepted override as a guess", err.Error())
		}
	}
}
