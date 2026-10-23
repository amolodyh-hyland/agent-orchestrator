package acp

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	librarysvc "github.com/aoagents/agent-orchestrator/backend/internal/service/library"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// Use the durable registry and its admission/revocation lock. Every path and
// database belongs to this test.
func newPromptLibrary(t *testing.T) (func(context.Context) (func(), error), func() error) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "guide.md"), []byte("owned rule"), 0600); err != nil {
		t.Fatal(err)
	}
	svc := librarysvc.New(st, "local_user", "authority", "resolver", nil)
	var result librarysvc.Result
	operate := func(in librarysvc.Operation) {
		t.Helper()
		in.ExpectedRevision = result.Revision
		var err error
		result, err = svc.Operate(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
	}
	operate(librarysvc.Operation{Operation: "register", SourceID: "source", Scope: "personal", RootKind: "rules", LocalPath: root})
	identity := result.Sources[0].LibraryRootIdentity
	operate(librarysvc.Operation{Operation: "allow_inspection", SourceID: "source", RootIdentity: &identity})
	operate(librarysvc.Operation{Operation: "inspect", SourceID: "source"})
	entry := result.Entries[0]
	operate(librarysvc.Operation{Operation: "approve", SourceID: "source", RootIdentity: &identity, Entries: []domain.LibrarySelectedEntry{{EntryID: entry.EntryID, ContentHash: entry.ContentHash}}, Purposes: []string{"load_context"}})
	approvalID := result.Approvals[0].ApprovalID
	now := time.Now().UTC()
	rec, err := st.CreateSession(ctx, domain.SessionRecord{Kind: domain.KindWorker, Mode: domain.SessionModeChat, Harness: domain.HarnessClaudeCode, Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	operate(librarysvc.Operation{Operation: "bind", Binding: &domain.LibraryBinding{BindingID: "binding", OwnerID: "local_user", SessionID: rec.ID, SourceID: "source", EntryID: entry.EntryID, ApprovedContentHash: entry.ContentHash, Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true}})
	parent := domain.ProjectContextManifest{SessionID: rec.ID, Role: domain.ProjectContextRoleWorker, Channel: domain.SessionModeChat, CreatedAt: now, Attachments: []domain.ProjectContextManifestEntry{}}
	parent.Digest, err = parent.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Pin(ctx, parent, domain.ProjectRecord{}, "claude-code"); err != nil {
		t.Fatal(err)
	}
	acquire := func(ctx context.Context) (func(), error) { return svc.AcquireChatInput(ctx, rec.ID, "continue") }
	release, err := acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	release()
	return acquire, func() error {
		_, err := svc.Operate(ctx, librarysvc.Operation{Operation: "revoke", ApprovalID: approvalID, ExpectedRevision: result.Revision})
		return err
	}
}

func newAdmissionConversation(t *testing.T, agent *fakeAgent) *conversation {
	t.Helper()
	driver := New(Config{Harness: domain.HarnessClaudeCode,
		SessionPreamble: func(cfg LaunchConfig) []acpsdk.ContentBlock {
			return []acpsdk.ContentBlock{acpsdk.TextBlock(cfg.SystemPrompt)}
		},
		Probe:  func(context.Context) error { return nil },
		Launch: func(context.Context, LaunchConfig) (Launch, error) { return Launch{Command: "fake"}, nil },
	}, slog.New(slog.DiscardHandler))
	driver.useTestProcess(fakeSpawn(agent))
	opened, err := driver.Start(context.Background(), ports.ChatStartConfig{WorkspacePath: t.TempDir(), SystemPrompt: "standing context"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	return opened.(*conversation)
}

func awaitAdmissionCompletion(t *testing.T, conv *conversation) ports.ChatEvent {
	t.Helper()
	var completion ports.ChatEvent
	for {
		event := nextEvent(t, conv.Events())
		if event.Kind == ports.ChatEventTurnCompleted {
			completion = event
		}
		if event.Kind == ports.ChatEventControllerState && event.ControllerState == ports.ChatControllerReady && completion.ProviderTurnID != "" {
			return completion
		}
	}
}

func TestACPDeferredAdmissionRejectsRevocationAfterScheduling(t *testing.T) {
	acquire, revoke := newPromptLibrary(t)
	var prompts atomic.Int32
	agent := &fakeAgent{customPrompt: func(context.Context, acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
		prompts.Add(1)
		return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
	}}
	conv := newAdmissionConversation(t, agent)
	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	scheduled, resume := make(chan struct{}), make(chan struct{})
	var resumeOnce sync.Once
	t.Cleanup(func() { resumeOnce.Do(func() { close(resume) }) })
	// This is the production asynchronous StartDeferredTurn -> runTurn -> SDK
	// Prompt -> transport path. Pause before the transport's admission check,
	// after StartDeferredTurnWithAdmission has returned to its caller.
	if err := conv.StartDeferredTurnWithAdmission(ref.ProviderTurnID, func(ctx context.Context) (func(), error) {
		close(scheduled)
		select {
		case <-resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return acquire(ctx)
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-scheduled:
	case <-time.After(5 * time.Second):
		t.Fatal("worker never reached submission")
	}
	if err := revoke(); err != nil {
		t.Fatal(err)
	}
	resumeOnce.Do(func() { close(resume) })
	event := awaitAdmissionCompletion(t, conv)
	if event.TurnState != domain.TurnStateFailed || event.Err == nil || !strings.Contains(event.Err.Error(), "revoked") {
		t.Fatalf("refusal not settled: %+v", event)
	}
	if prompts.Load() != 0 {
		t.Fatalf("revoked prompt reached fake connection: %d", prompts.Load())
	}
	conv.mu.Lock()
	spent := conv.preambleSpent
	conv.mu.Unlock()
	if spent {
		t.Fatal("refused submission consumed standing context")
	}
}

func TestACPDeferredAdmissionReleasesBeforePromptResponse(t *testing.T) {
	acquire, revoke := newPromptLibrary(t)
	started, revoked := make(chan struct{}), make(chan struct{})
	agent := &fakeAgent{customPrompt: func(ctx context.Context, _ acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
		close(started)
		// The provider cannot finish until revocation has completed. Holding
		// admission until Prompt returns would deadlock this real SDK exchange.
		select {
		case <-revoked:
			return acpsdk.PromptResponse{StopReason: acpsdk.StopReasonEndTurn}, nil
		case <-ctx.Done():
			return acpsdk.PromptResponse{}, ctx.Err()
		}
	}}
	conv := newAdmissionConversation(t, agent)
	ref, err := conv.SendTurn(context.Background(), ports.ChatUserMessage{Text: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	if err := conv.StartDeferredTurnWithAdmission(ref.ProviderTurnID, acquire); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("prompt not submitted")
	}
	done := make(chan error, 1)
	go func() { err := revoke(); close(revoked); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight Prompt prevented revocation")
	}
	if event := awaitAdmissionCompletion(t, conv); event.TurnState != domain.TurnStateCompleted {
		t.Fatalf("prompt did not finish after revocation: %+v", event)
	}
	if release, err := acquire(context.Background()); err == nil {
		release()
		t.Fatal("revocation did not close subsequent admission")
	}
}

type notifyingPromptWriter struct {
	io.WriteCloser
	entered chan struct{}
}

func (w notifyingPromptWriter) Write(data []byte) (int, error) {
	close(w.entered)
	return w.WriteCloser.Write(data)
}

func TestACPDeferredAdmissionBoundsBlockedTransportWrite(t *testing.T) {
	for _, mode := range []string{"cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			reader, writer := io.Pipe()
			defer reader.Close()
			defer writer.Close()
			var admission sync.RWMutex
			entered := make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			submission := &promptSubmission{ctx: ctx, acquire: func(context.Context) (func(), error) {
				admission.RLock()
				return admission.RUnlock, nil
			}}
			transport := &lockedWriteCloser{inner: notifyingPromptWriter{WriteCloser: writer, entered: entered}}
			transport.prompt.Store(submission)
			done := make(chan error, 1)
			go func() { _, err := transport.Write([]byte(`{"method":"session/prompt"}`)); done <- err }()
			<-entered
			if admission.TryLock() {
				admission.Unlock()
				t.Fatal("frame write has no admission lease")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, io.ErrClosedPipe) {
					t.Fatalf("blocked write: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("blocked write retained admission")
			}
			if !admission.TryLock() {
				t.Fatal("transport write leaked admission")
			}
			admission.Unlock()
		})
	}
}
