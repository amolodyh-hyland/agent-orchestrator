package daemon

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type recordingPermissionsPersister struct {
	calls []string
	err   error
}

func (r *recordingPermissionsPersister) PersistChatPermissions(_ context.Context, id domain.SessionID, permissions domain.PermissionMode) error {
	r.calls = append(r.calls, string(id)+"="+string(permissions))
	return r.err
}

// The Chat service reports a permission step-down through this hook. If it writes
// nothing the session reads back, and restores with, the mode the provider refused,
// so the wiring itself needs a test: nothing else exercises it.
func TestChatPermissionsRecorderPersistsTheEffectiveMode(t *testing.T) {
	persister := &recordingPermissionsPersister{}
	hook := chatPermissionsRecorder(context.Background(), func() chatPermissionsPersister { return persister }, slog.New(slog.DiscardHandler))

	hook("ao-1", domain.PermissionModeAuto)
	hook("ao-2", domain.PermissionModeAcceptEdits)

	if got, want := strings.Join(persister.calls, ","), "ao-1=auto,ao-2=accept-edits"; got != want {
		t.Fatalf("persisted %q, want %q", got, want)
	}
}

// The Session Manager is built after the Chat service, so the hook can fire before
// it exists; that must be a quiet no-op, not a nil dereference.
func TestChatPermissionsRecorderToleratesAMissingSessionManager(t *testing.T) {
	hook := chatPermissionsRecorder(context.Background(), func() chatPermissionsPersister { return nil }, slog.New(slog.DiscardHandler))
	hook("ao-1", domain.PermissionModeAuto)
}

func TestChatPermissionsRecorderLogsAFailedWrite(t *testing.T) {
	var logs bytes.Buffer
	persister := &recordingPermissionsPersister{err: errors.New("disk full")}
	hook := chatPermissionsRecorder(context.Background(), func() chatPermissionsPersister { return persister },
		slog.New(slog.NewTextHandler(&logs, nil)))

	hook("ao-1", domain.PermissionModeAuto)

	if !strings.Contains(logs.String(), "disk full") || !strings.Contains(logs.String(), "ao-1") {
		t.Fatalf("a failed write was not logged:\n%s", logs.String())
	}
}

// recordingLifecycle is the Session Manager as the daemon hooks see it.
type recordingLifecycle struct {
	*fakeSessionLifecycle
	permissions []string
	models      []string
}

func (r *recordingLifecycle) PersistChatPermissions(_ context.Context, id domain.SessionID, permissions domain.PermissionMode) error {
	r.permissions = append(r.permissions, string(id)+"="+string(permissions))
	return nil
}

func (r *recordingLifecycle) PersistChatModel(_ context.Context, id domain.SessionID, model string) error {
	r.models = append(r.models, string(id)+"="+model)
	return nil
}

// newChatServiceOptions is where the daemon wires the Chat service to the Session
// Manager. The two hooks that write session records have to be present and reach it,
// and the Session Manager has to be read when the hook fires, because it is built
// after the Chat service. A hook that is omitted, or that captured a nil Session
// Manager, would leave sessions reading back a mode and model they are not using.
func TestChatServiceOptionsWireTheSessionRecordHooksToTheSessionManager(t *testing.T) {
	var current sessionLifecycle // not built yet, as at daemon startup
	opts := newChatServiceOptions(context.Background(), chatServiceDeps{
		Log:          slog.New(slog.DiscardHandler),
		AgentService: func() *agentsvc.Service { return nil },
		Sessions:     func() sessionLifecycle { return current },
	})
	if opts.OnPermissionsChanged == nil || opts.OnModelChanged == nil {
		t.Fatalf("session record hooks missing: permissions=%t model=%t",
			opts.OnPermissionsChanged != nil, opts.OnModelChanged != nil)
	}

	// Firing before the Session Manager exists is a quiet no-op.
	opts.OnPermissionsChanged("ao-0", domain.PermissionModeAuto)
	opts.OnModelChanged("ao-0", "early")

	sessions := &recordingLifecycle{fakeSessionLifecycle: &fakeSessionLifecycle{}}
	current = sessions // built later; the hooks must see it now

	opts.OnPermissionsChanged("ao-1", domain.PermissionModeAuto)
	opts.OnModelChanged("ao-1", "gpt-test")

	if got, want := strings.Join(sessions.permissions, ","), "ao-1=auto"; got != want {
		t.Fatalf("permissions persisted %q, want %q", got, want)
	}
	if got, want := strings.Join(sessions.models, ","), "ao-1=gpt-test"; got != want {
		t.Fatalf("models persisted %q, want %q", got, want)
	}
}
