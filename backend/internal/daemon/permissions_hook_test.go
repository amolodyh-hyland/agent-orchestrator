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
// after the Chat service and handed over through the returned bind function. A hook
// that is omitted, that never sees the bound manager, or that captured a nil one,
// would leave sessions reading back a mode and model they are not using.
func TestChatServiceOptionsWireTheSessionRecordHooksToTheSessionManager(t *testing.T) {
	opts, bind := newChatServiceOptions(context.Background(), chatServiceDeps{
		Log:          slog.New(slog.DiscardHandler),
		AgentService: func() *agentsvc.Service { return nil },
	})
	if bind == nil {
		t.Fatal("no bind function returned: the daemon has no way to hand the hooks the Session Manager")
	}
	if opts.OnPermissionsChanged == nil || opts.OnModelChanged == nil {
		t.Fatalf("session record hooks missing: permissions=%t model=%t",
			opts.OnPermissionsChanged != nil, opts.OnModelChanged != nil)
	}

	// Firing before the Session Manager exists is a quiet no-op.
	opts.OnPermissionsChanged("ao-0", domain.PermissionModeAuto)
	opts.OnModelChanged("ao-0", "early")

	sessions := &recordingLifecycle{fakeSessionLifecycle: &fakeSessionLifecycle{}}
	bind(sessions) // built later; the hooks must see it now

	opts.OnPermissionsChanged("ao-1", domain.PermissionModeAuto)
	opts.OnModelChanged("ao-1", "gpt-test")

	if got, want := strings.Join(sessions.permissions, ","), "ao-1=auto"; got != want {
		t.Fatalf("permissions persisted %q, want %q", got, want)
	}
	if got, want := strings.Join(sessions.models, ","), "ao-1=gpt-test"; got != want {
		t.Fatalf("models persisted %q, want %q", got, want)
	}
}

// Each daemon builds its own options, so a manager bound for one must not leak into
// another's hooks (a package-level holder would).
func TestChatServiceOptionsBindTheSessionManagerPerInstance(t *testing.T) {
	deps := chatServiceDeps{Log: slog.New(slog.DiscardHandler), AgentService: func() *agentsvc.Service { return nil }}
	first, bindFirst := newChatServiceOptions(context.Background(), deps)
	second, _ := newChatServiceOptions(context.Background(), deps)

	sessions := &recordingLifecycle{fakeSessionLifecycle: &fakeSessionLifecycle{}}
	bindFirst(sessions)
	second.OnPermissionsChanged("ao-2", domain.PermissionModeAcceptEdits)
	second.OnModelChanged("ao-2", "other")
	first.OnPermissionsChanged("ao-1", domain.PermissionModeAuto)

	if got, want := strings.Join(sessions.permissions, ","), "ao-1=auto"; got != want {
		t.Fatalf("permissions persisted %q, want %q: the second instance's hooks reached the first's manager", got, want)
	}
	if len(sessions.models) != 0 {
		t.Fatalf("models persisted %v from an instance that was never bound", sessions.models)
	}
}
