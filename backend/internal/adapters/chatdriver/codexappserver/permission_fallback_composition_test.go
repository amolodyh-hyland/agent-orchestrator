package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// These tests put the real Codex driver under the real chat service on a real
// SQLite store, with only the provider process faked. The step-down is a
// conversation between three pieces: the driver classifies the provider's refusal,
// the service retries with a lower mode, and the store keeps the result. Each is
// tested on its own elsewhere; this proves they agree with one another, which a
// fake conversation returning a ready-made rejection cannot.

const (
	composedSession = domain.SessionID("p1-1")
	composedProject = domain.ProjectID("p1")
)

// refusalFor is Codex's own wording for a managed requirement that forbids full
// access, captured live from codex-cli 0.159.2.
const composedRefusal = "invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by enterprise-managed requirements Default requirements (6e1e489a))"

// composedServer is a fake `codex app-server` that enforces the managed requirement:
// a turn asking for danger-full-access is refused, anything else runs. Each launch
// gets its own pipes, as each real launch gets its own process.
type composedServer struct {
	t *testing.T

	mu     sync.Mutex
	turns  []json.RawMessage
	failTo string // when set, every turn/start is refused with this message instead
	// refuseOnRequest refuses a turn asking for on-request approvals, as a managed
	// requirement that allows only approval policy Never would.
	refuseOnRequest bool
}

func (s *composedServer) spawn(context.Context, string, string, []string) (*process, error) {
	clientReads, serverWrites := io.Pipe()
	serverReads, clientWrites := io.Pipe()
	go s.serve(bufio.NewReader(serverReads), serverWrites)
	return &process{
		stdin:  clientWrites,
		stdout: clientReads,
		stop:   func() error { return serverWrites.Close() },
	}, nil
}

func (s *composedServer) serve(reader *bufio.Reader, out io.Writer) {
	respond := func(f frame, result string) {
		_, _ = io.WriteString(out, `{"id":`+string(*f.ID)+`,"result":`+result+"}\n")
	}
	refuse := func(f frame, message string) {
		_, _ = io.WriteString(out, `{"id":`+string(*f.ID)+`,"error":{"code":-32600,"message":`+strconv.Quote(message)+"}}\n")
	}
	for {
		line, err := readFrame(reader)
		if err != nil {
			return
		}
		var f frame
		if json.Unmarshal(line, &f) != nil || f.ID == nil || f.Method == "" {
			continue
		}
		switch f.Method {
		case "initialize":
			respond(f, `{"userAgent":"ao/test","codexHome":"/tmp/.codex"}`)
		case "model/list":
			respond(f, `{"data":[{"id":"gpt-test","displayName":"GPT Test","isDefault":true}]}`)
		case "thread/start":
			respond(f, `{"thread":{"id":"thread-1"},"model":"gpt-test","cwd":"/tmp/ws"}`)
		case "turn/start":
			s.mu.Lock()
			s.turns = append(s.turns, append(json.RawMessage(nil), f.Params...))
			failTo := s.failTo
			refuseOnRequest := s.refuseOnRequest
			s.mu.Unlock()
			switch {
			case failTo != "":
				refuse(f, failTo)
			case refuseOnRequest && strings.Contains(string(f.Params), `"approvalPolicy":"on-request"`):
				refuse(f, "invalid value for `approval_policy`: `OnRequest` is not in the allowed set [Never] (set by enterprise-managed requirements Default requirements (6e1e489a))")
			case strings.Contains(string(f.Params), `"dangerFullAccess"`):
				refuse(f, composedRefusal)
			default:
				respond(f, `{"turn":{"id":"turn-1","status":"inProgress","items":[]}}`)
			}
		default:
			respond(f, `{}`)
		}
	}
}

func (s *composedServer) turnPostures() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, params := range s.turns {
		var p struct {
			ApprovalPolicy    string `json:"approvalPolicy"`
			ApprovalsReviewer string `json:"approvalsReviewer"`
			SandboxPolicy     *struct {
				Type string `json:"type"`
			} `json:"sandboxPolicy"`
		}
		_ = json.Unmarshal(params, &p)
		sandbox := ""
		if p.SandboxPolicy != nil {
			sandbox = p.SandboxPolicy.Type
		}
		out = append(out, fmt.Sprintf("%s/%s/%s", p.ApprovalPolicy, sandbox, p.ApprovalsReviewer))
	}
	return out
}

type composedRegistry struct{ driver ports.ChatDriver }

func (r composedRegistry) Driver(domain.AgentHarness) (ports.ChatDriver, error) { return r.driver, nil }
func (r composedRegistry) SupportsChat(domain.AgentHarness) bool                { return true }

type composition struct {
	svc      *chatsvc.Service
	server   *composedServer
	reported []ports.PermissionMode
	store    interface {
		GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	}
	mu sync.Mutex
}

func newComposition(t *testing.T, permissions ports.PermissionMode, disableFallback bool) (*composition, error) {
	t.Helper()
	ctx := context.Background()
	st := sqlitetest.MustOpenAt(t, t.TempDir())
	if err := st.UpsertProject(ctx, domain.ProjectRecord{
		ID: string(composedProject), Path: t.TempDir(), RegisteredAt: time.Now().UTC().Truncate(time.Second),
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := st.CreateSession(ctx, domain.SessionRecord{
		ID: composedSession, ProjectID: composedProject, Kind: domain.KindWorker, Harness: domain.HarnessCodex,
		Mode: domain.SessionModeChat, Metadata: domain.SessionMetadata{Permissions: permissions},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	c := &composition{server: &composedServer{t: t}, store: st}
	driver := &Driver{
		plugin:       fakePlugin{bin: "codex", authStatus: ports.AgentAuthStatusAuthorized},
		log:          slog.New(slog.DiscardHandler),
		versionProbe: func(context.Context, string) (string, error) { return "codex-cli 0.159.2", nil },
		spawn:        c.server.spawn,
	}
	var counterMu sync.Mutex
	counter := 0
	c.svc = chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Drivers: composedRegistry{driver: driver},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			counterMu.Lock()
			defer counterMu.Unlock()
			counter++
			return fmt.Sprintf("id-%03d", counter)
		},
		OnPermissionsChanged: func(id domain.SessionID, mode domain.PermissionMode) {
			c.mu.Lock()
			c.reported = append(c.reported, mode)
			c.mu.Unlock()
			if _, err := st.UpdateSessionPermissions(ctx, id, mode); err != nil {
				t.Errorf("persist permissions: %v", err)
			}
		},
	})
	_, err := c.svc.Start(ctx, chatsvc.StartConfig{
		SessionID: composedSession, ProjectID: composedProject, Harness: domain.HarnessCodex,
		WorkspacePath: t.TempDir(), Permissions: permissions, DisablePermissionFallback: disableFallback,
	})
	if err == nil {
		t.Cleanup(func() { _ = c.svc.Stop(context.Background(), composedSession) })
	}
	return c, err
}

func (c *composition) send() (domain.ConversationTurn, error) {
	return c.svc.Send(context.Background(), composedSession, ports.ChatUserMessage{
		Text: "go", ClientMessageID: "client-go", Origin: domain.MessageOriginHuman,
	})
}

func (c *composition) sessionPermissions(t *testing.T) ports.PermissionMode {
	t.Helper()
	rec, ok, err := c.store.GetSession(context.Background(), composedSession)
	if err != nil || !ok {
		t.Fatalf("read session: ok=%v err=%v", ok, err)
	}
	return rec.Metadata.Permissions
}

// The managed requirement refuses the full-access turn in the provider's own words;
// the driver recognizes it, the service asks again with approve-for-me, the provider
// accepts, and the session row and the conversation both say so.
func TestManagedRefusalStepsDownThroughTheRealDriverAndService(t *testing.T) {
	c, err := newComposition(t, ports.PermissionModeBypassPermissions, false)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turn, err := c.send()
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if turn.State != domain.TurnStateRunning {
		t.Fatalf("turn state = %q, want running", turn.State)
	}

	want := []string{"never/dangerFullAccess/user", "on-request/workspaceWrite/auto_review"}
	if got := c.server.turnPostures(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("turn/start postures = %v, want %v", got, want)
	}
	if got := c.sessionPermissions(t); got != ports.PermissionModeAuto {
		t.Fatalf("session permissions = %q, want the accepted auto", got)
	}
	controller, err := c.svc.Controller(composedSession)
	if err != nil {
		t.Fatalf("Controller: %v", err)
	}
	if got := controller.Settings().ApprovalMode; got != ports.PermissionModeAuto {
		t.Fatalf("conversation approval mode = %q, want auto", got)
	}
}

// With the fallback off the same refusal must reach the caller verbatim and the
// provider must be asked exactly once: AO does not retry around a managed policy.
func TestManagedRefusalIsSurfacedWhenTheFallbackIsOff(t *testing.T) {
	c, err := newComposition(t, ports.PermissionModeBypassPermissions, true)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	_, err = c.send()
	if !errors.Is(err, ports.ErrPermissionRejected) || !strings.Contains(err.Error(), "`DangerFullAccess` is not in the allowed set") {
		t.Fatalf("Send error = %v, want the provider's refusal", err)
	}
	if got := len(c.server.turnPostures()); got != 1 {
		t.Fatalf("provider saw %d turn/start requests, want 1", got)
	}
	if got := c.sessionPermissions(t); got != ports.PermissionModeBypassPermissions {
		t.Fatalf("session permissions = %q; a refused turn must leave them alone", got)
	}
}

// Any other provider failure is not a permission refusal, so the service must not
// walk down the ladder for it.
func TestUnrelatedProviderFailureDoesNotStepDown(t *testing.T) {
	c, err := newComposition(t, ports.PermissionModeBypassPermissions, false)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	c.server.mu.Lock()
	c.server.failTo = "Usage limit reached. Resets tomorrow."
	c.server.mu.Unlock()

	_, err = c.send()
	if err == nil || errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Send error = %v, want the provider's plain failure", err)
	}
	if got := len(c.server.turnPostures()); got != 1 {
		t.Fatalf("provider saw %d turn/start requests, want 1: an unrelated failure must not step down", got)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.reported) != 0 {
		t.Fatalf("session permissions reported %v after an unrelated failure", c.reported)
	}
}

// A thread launched with full access whose picker is then set to Codex defaults gets
// the reset posture. If a managed requirement refuses that posture, the user is told
// exactly that: one attempt, no claim that every mode was tried, and no mislabelled
// "default" rejection.
func TestRefusedResetIsReportedAsItselfThroughTheRealStack(t *testing.T) {
	c, err := newComposition(t, ports.PermissionModeBypassPermissions, false)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	c.server.mu.Lock()
	c.server.refuseOnRequest = true
	c.server.mu.Unlock()
	if _, err := c.svc.SetTurnSettings(context.Background(), composedSession, domain.ConversationSettings{
		ApprovalMode: ports.PermissionModeDefault,
	}); err != nil {
		t.Fatalf("SetTurnSettings: %v", err)
	}

	_, err = c.send()

	if !errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("Send error = %v, want a permission rejection", err)
	}
	if strings.Contains(err.Error(), "every permission mode was rejected") {
		t.Fatalf("Send error = %v; no ladder was walked, so it must not claim one was", err)
	}
	if !strings.Contains(err.Error(), "returning to Codex defaults sent the ask-for-approval posture") ||
		!strings.Contains(err.Error(), "accept-edits") {
		t.Fatalf("Send error = %v, want the posture that was sent named", err)
	}
	if got := len(c.server.turnPostures()); got != 1 {
		t.Fatalf("provider saw %d turn/start requests, want exactly 1", got)
	}
	if got := c.sessionPermissions(t); got != ports.PermissionModeBypassPermissions {
		t.Fatalf("session permissions = %q; a refused turn must leave them alone", got)
	}
}
