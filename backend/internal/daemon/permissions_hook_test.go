package daemon

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
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
