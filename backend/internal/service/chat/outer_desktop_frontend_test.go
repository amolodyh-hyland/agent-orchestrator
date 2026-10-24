package chat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	projectsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/project"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type outerDesktopConversation struct {
	*fakeConversation
	inputs map[string]ports.ChatInputResponse
}

func (c *outerDesktopConversation) SendTurnWithAdmission(ctx context.Context, msg ports.ChatUserMessage, acquire func(context.Context) (func(), error)) (ports.ChatTurnRef, error) {
	release, err := acquire(ctx)
	if err != nil {
		return ports.ChatTurnRef{}, err
	}
	defer release()
	ref, err := c.SendTurn(ctx, msg)
	ref.ProviderSubmitted = err == nil
	return ref, err
}

func (c *outerDesktopConversation) ResolveInput(_ context.Context, id string, response ports.ChatInputResponse) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inputs[id] = response
	return nil
}

type outerDesktopFixture struct {
	t         *testing.T
	dir       string
	st        *sqlite.Store
	chat      *chatsvc.Service
	outer     *outer.Service
	router    http.Handler
	providers map[domain.SessionID]*outerDesktopConversation
	starts    []ports.ChatStartConfig
}

// Only provisioning is synthetic. New Task uses the real session service,
// controllers, ownership guard and SQLite; no process or provider is launched.
type outerDesktopCommander struct {
	*sessionmanager.Manager
	st *sqlite.Store
}

func (outerDesktopCommander) SessionStatusReadiness(domain.SessionRecord) string { return "ready" }
func (outerDesktopCommander) StatusRecoveryRevision() uint64                     { return 0 }

func (m outerDesktopCommander) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.SessionRecord, int, int, error) {
	if err := domain.CheckOuterOperation(ctx, m.st, "spawn", cfg.ProjectID, ""); err != nil {
		return domain.SessionRecord{}, 0, 0, err
	}
	record, err := m.st.CreateSession(ctx, domain.SessionRecord{ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: cfg.Harness, Mode: cfg.RequestedMode, Metadata: domain.SessionMetadata{Prompt: cfg.Prompt}, DisplayName: cfg.DisplayName, ClientRequestID: cfg.ClientRequestID, ClientRequestHash: cfg.ClientRequestHash, ClientRequestCommitted: true, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	return record, len(cfg.Prompt), 0, err
}

func (m outerDesktopCommander) RunBackgroundTask(context.Context, domain.SessionID, string, string) (string, error) {
	return "", domain.ErrOuterHeld
}

func (f *outerDesktopFixture) wire() {
	log := slog.New(slog.DiscardHandler)
	f.chat = chatsvc.New(chatsvc.Options{Store: f.st, Reader: fullSnapshotReader(f.st), PageReader: boundedSnapshotReader(f.st), Sessions: f.st, Log: log, NewID: uuid.NewString, Now: time.Now, DataDir: f.dir,
		Drivers: fakeRegistry{driver: fakeDriver{start: func(cfg ports.ChatStartConfig) (ports.ChatConversation, error) {
			provider := newFakeConversation()
			provider.providerConversationID = uuid.NewString()
			conv := &outerDesktopConversation{fakeConversation: provider, inputs: map[string]ports.ChatInputResponse{}}
			f.providers[cfg.SessionID] = conv
			f.starts = append(f.starts, cfg)
			return conv, nil
		}}},
	})
	f.outer = outer.New(f.st, projectsvc.New(f.st), f)
	f.outer.SetTransport(f.chat)
	f.chat.SetOuterAdmission(f.outer)
	authority, err := delegationauth.New(bytes.Repeat([]byte{13}, 32))
	if err != nil {
		f.t.Fatal(err)
	}
	sessions := sessionsvc.NewWithDeps(sessionsvc.Deps{Manager: outerDesktopCommander{st: f.st}, Store: f.st, Logger: log, DataDir: f.dir})
	f.router = httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Outer: f.outer, DelegationAuth: authority, Conversations: f.chat, Projects: projectsvc.New(f.st), Sessions: sessions}, httpd.ControlDeps{})
}

func (f *outerDesktopFixture) Spawn(ctx context.Context, cfg ports.SpawnConfig) (domain.Session, int, int, error) {
	p, found, err := f.st.GetProject(ctx, string(cfg.ProjectID))
	if err != nil || !found || p.Kind != domain.ProjectKindScratch || p.Path != "" {
		return domain.Session{}, 0, 0, domain.ErrOuterHeld
	}
	settings := p.Config.Orchestrator.AgentConfig
	r, err := f.st.CreateSession(ctx, domain.SessionRecord{ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: cfg.Harness, Mode: cfg.RequestedMode, Metadata: domain.SessionMetadata{OuterGeneration: cfg.OuterGeneration, Permissions: settings.Permissions}, CreatedAt: time.Now(), UpdatedAt: time.Now()})
	if err != nil {
		return domain.Session{}, 0, 0, err
	}
	ctrl, err := f.chat.Start(ctx, chatsvc.StartConfig{SessionID: r.ID, ProjectID: r.ProjectID, Kind: r.Kind, Harness: r.Harness, WorkspacePath: f.dir, Model: settings.Model, Effort: settings.Effort, Permissions: settings.Permissions})
	if err != nil {
		return domain.Session{}, 0, 0, err
	}
	r, _, err = f.st.GetSession(ctx, r.ID)
	if err != nil {
		return domain.Session{}, 0, 0, err
	}
	r.Metadata.ControllerGeneration, r.Metadata.ProviderConversationID = ctrl.Generation(), ctrl.ProviderConversationID()
	r.ProvisionState = domain.SessionProvisionReady
	if err := f.st.UpdateSession(ctx, r); err != nil {
		return domain.Session{}, 0, 0, err
	}
	f.providers[r.ID].emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerReady})
	deadline := time.Now().Add(5 * time.Second)
	for ctrl.State() != ports.ChatControllerReady && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if ctrl.State() != ports.ChatControllerReady {
		return domain.Session{}, 0, 0, errors.New("fake native conversation did not become ready")
	}
	return domain.Session{SessionRecord: r}, 0, 0, nil
}

func (f *outerDesktopFixture) stats() any {
	calls, approvals := 0, 0
	inputs := map[string]ports.ChatInputResponse{}
	for _, provider := range f.providers {
		provider.mu.Lock()
		calls += provider.sendCalls
		approvals += len(provider.resolved)
		for id, response := range provider.inputs {
			inputs[id] = response
		}
		provider.mu.Unlock()
	}
	requests, err := f.st.ListOuterHostRequests(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	capacity, err := f.st.OuterCapacity(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	starts := make([]map[string]any, 0, len(f.starts))
	for _, cfg := range f.starts {
		starts = append(starts, map[string]any{"sessionId": cfg.SessionID, "model": cfg.Model, "effort": cfg.Effort, "permissions": cfg.Permissions, "nativeId": f.providers[cfg.SessionID].ProviderConversationID()})
	}
	workers, err := f.st.ListAllSessions(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	workerViews := []map[string]any{}
	for _, worker := range workers {
		if worker.Kind == domain.KindWorker {
			workerViews = append(workerViews, map[string]any{"id": worker.ID, "projectId": worker.ProjectID, "metadata": map[string]any{"prompt": worker.Metadata.Prompt}})
		}
	}
	return map[string]any{"launches": len(f.starts), "sends": calls, "approvals": approvals, "inputs": inputs, "requests": requests, "reservations": capacity, "starts": starts, "workers": workerViews}
}

func (f *outerDesktopFixture) emit(kind string) {
	ctx := context.Background()
	b, _, err := f.outer.Binding(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	provider := f.providers[b.SessionID]
	if provider == nil {
		f.t.Fatal("no owned fake provider")
	}
	if kind == "uncertain" {
		provider.mu.Lock()
		provider.sendErr = errors.New("response lost after possible native acceptance")
		provider.mu.Unlock()
		return
	}
	provider.mu.Lock()
	turn := fmt.Sprintf("provider-turn-%d", provider.turnSeq)
	provider.mu.Unlock()
	event := ports.ChatEvent{ProviderTurnID: turn, ProviderEventID: uuid.NewString(), ProviderItemID: uuid.NewString()}
	switch kind {
	case "approval":
		provider.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turn, ProviderEventID: uuid.NewString(), NativeAcceptance: true})
		event.Kind, event.RequestID, event.Summary = ports.ChatEventApprovalRequested, "native-approval", "Read selected evidence"
		event.Decisions = []ports.ChatDecisionOption{{ID: "allow", Label: "Allow once", Kind: ports.ChatDecisionAllowOnce}}
	case "form", "url":
		event.Kind, event.RequestID = ports.ChatEventInputRequested, "native-"+kind
		event.Input = &ports.ChatInputRequest{Mode: ports.ChatInputModeForm, Message: "Choose evidence", Schema: map[string]any{"type": "object", "required": []string{"choice"}, "properties": map[string]any{"choice": map[string]any{"type": "string", "title": "Evidence", "enum": []string{"reports", "runs"}}}}}
		if kind == "url" {
			event.Input = &ports.ChatInputRequest{Mode: ports.ChatInputModeURL, Message: "Open evidence", URL: "https://example.invalid/selected-evidence", ElicitationID: "native-url"}
		}
	case "settle":
		event.Kind, event.TurnState, event.NativeSettlement = ports.ChatEventTurnCompleted, domain.TurnStateCompleted, true
	default:
		f.t.Fatal("unsupported test event", kind)
	}
	provider.emit(event)
	ctrl, err := f.chat.Controller(b.SessionID)
	if err != nil {
		f.t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rows, err := f.st.LoadConversationSnapshot(ctx, ctrl.ConversationID())
		if err != nil {
			f.t.Fatal(err)
		}
		if kind == "settle" {
			for _, row := range rows.Turns {
				if row.ProviderTurnID == turn && row.State == domain.TurnStateCompleted {
					return
				}
			}
		} else {
			for _, row := range rows.Activities {
				if row.RequestID == event.RequestID {
					return
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.t.Fatal("native projection did not settle", kind)
}

func TestOuterDesktopFrontendIntegration(t *testing.T) {
	if os.Getenv("AO_OUTER_DESKTOP_FRONTEND") != "1" {
		t.Skip("run npm --prefix frontend run test:outer-integration")
	}
	f := &outerDesktopFixture{t: t, dir: t.TempDir(), providers: map[domain.SessionID]*outerDesktopConversation{}}
	var err error
	f.st, err = sqlite.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.st.Close() }()
	for _, id := range []string{"a", "b"} {
		cfg := domain.ProjectConfig{}
		cfg.Worker.Harness, cfg.Orchestrator.Harness = domain.HarnessCodex, domain.HarnessCodex
		if err := f.st.UpsertProject(context.Background(), domain.ProjectRecord{ID: id, Kind: domain.ProjectKindScratch, DisplayName: strings.ToUpper(id), Config: cfg, RegisteredAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	f.wire()
	defer func() {
		for id := range f.providers {
			_ = f.chat.Stop(context.Background(), id)
		}
	}()
	fmt.Println("OUTER_DESKTOP_READY")
	decoder := json.NewDecoder(os.Stdin)
	for {
		var input struct {
			ID      int               `json:"id"`
			Kind    string            `json:"kind"`
			Method  string            `json:"method"`
			Path    string            `json:"path"`
			Body    string            `json:"body"`
			Headers map[string]string `json:"headers"`
			Event   string            `json:"event"`
		}
		if err := decoder.Decode(&input); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		var output any
		switch input.Kind {
		case "stats":
			output = f.stats()
		case "event":
			f.emit(input.Event)
			output = f.stats()
		case "restart":
			for id := range f.providers {
				_ = f.chat.Stop(context.Background(), id)
			}
			if err := f.st.Close(); err != nil {
				t.Fatal(err)
			}
			f.st, err = sqlite.Open(f.dir)
			if err != nil {
				t.Fatal(err)
			}
			f.wire()
			output = f.stats()
		default:
			req := httptest.NewRequest(input.Method, "http://127.0.0.1"+input.Path, strings.NewReader(input.Body))
			req.RemoteAddr = "127.0.0.1:23456"
			for key, value := range input.Headers {
				req.Header.Set(key, value)
			}
			response := httptest.NewRecorder()
			f.router.ServeHTTP(response, req)
			headers := map[string]string{}
			for key := range response.Header() {
				headers[key] = response.Header().Get(key)
			}
			output = map[string]any{"status": response.Code, "body": response.Body.String(), "headers": headers}
		}
		data, err := json.Marshal(map[string]any{"id": input.ID, "data": output})
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("OUTER_DESKTOP_RESULT:%s\n", data)
	}
}
