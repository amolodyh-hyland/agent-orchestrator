package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestOuterMailboxCLIEnforcesRemovedSourceImports(t *testing.T) {
	ctx := context.Background()
	cfg := setConfigEnv(t)
	dataDir := t.TempDir()
	st, err := sqlite.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, id := range []string{"anchor", "a", "b"} {
		if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: id, Kind: domain.ProjectKindSingleRepo, Path: t.TempDir(), RegisteredAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	sessions := map[string]domain.SessionRecord{}
	for _, project := range []string{"anchor", "a"} {
		session, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: domain.ProjectID(project), Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat, Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{ControllerGeneration: "owned-" + project, ProviderConversationID: "native-" + project}})
		if err != nil {
			t.Fatal(err)
		}
		sessions[project] = session
	}
	coordinator := sessions["a"]
	binding := domain.OuterBinding{AnchorProjectID: "anchor", SessionID: sessions["anchor"].ID, Revision: 1, ScopeRevision: 1, Generation: 1, ProjectIDs: []string{"a", "b"}}
	if err := st.SaveOuterBinding(ctx, binding, 0, domain.OuterAudit{Operation: "setup"}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	secret := "retained B-derived mailbox evidence"
	for _, id := range []string{"receipt", "unread", "reply"} {
		message := domain.OuterMailboxMessage{ID: id, ProjectID: "a", CoordinatorID: coordinator.ID, SenderID: sessions["anchor"].ID, RecipientID: coordinator.ID, Direction: "to_coordinator", Text: secret, RecordedAt: time.Now(), Sources: []domain.OuterSource{{ProjectID: "b", Kind: "retained", ID: "b-evidence", Unknown: true, Sources: []string{"b"}}}}
		if id == "reply" {
			message.SenderID, message.RecipientID, message.Direction = coordinator.ID, sessions["anchor"].ID, "to_outer"
		}
		document, err := json.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO outer_mailbox(id,project_id,coordinator_id,document) VALUES(?,?,?,?)", id, "a", coordinator.ID, string(document)); err != nil {
			t.Fatal(err)
		}
	}
	svc := outer.New(st, nil, nil, outer.WithActionsEnabled(true))
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: svc}, httpd.ControlDeps{})
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		req.RemoteAddr = "127.0.0.1:23456"
		response := httptest.NewRecorder()
		if req.URL.Path == "/internal/telemetry/cli-invoked" {
			response.WriteHeader(http.StatusNoContent)
		} else {
			router.ServeHTTP(response, req)
		}
		return response.Result(), nil
	})}
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 9999, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	token, err := st.IssueOuterCaller(ctx, coordinator.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_SCOPE_CREDENTIAL", token)
	deps := Deps{ProcessAlive: func(int) bool { return true }, HTTPClient: client}
	for _, args := range [][]string{
		{"outer", "mailbox", "--session", string(coordinator.ID)},
		{"outer", "mailbox", "receipt", "--session", string(coordinator.ID), "--id", "receipt"},
	} {
		out, _, err := executeCLI(t, deps, args...)
		if err != nil || !strings.Contains(out, secret) {
			t.Fatal("legitimate CLI import", out, err)
		}
	}
	imports, err := st.OuterSources(ctx, coordinator.Metadata.ProviderConversationID)
	if err != nil || !slices.ContainsFunc(imports, func(source domain.OuterSource) bool { return slices.Contains(source.Sources, "b") }) {
		t.Fatal("CLI import omitted recipient lineage", imports, err)
	}
	binding.Revision, binding.ScopeRevision, binding.ProjectIDs = 2, 2, []string{"a"}
	if err := st.SaveOuterBinding(ctx, binding, 1, domain.OuterAudit{Operation: "scope"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AuthenticateOuterCaller(ctx, token); err != nil {
		t.Fatal("A credential is not live", err)
	}
	for _, args := range [][]string{
		{"outer", "mailbox", "--session", string(coordinator.ID)},
		{"outer", "mailbox", "receipt", "--session", string(coordinator.ID), "--id", "receipt"},
		{"outer", "mailbox", "receipt", "--session", string(coordinator.ID), "--id", "unread"},
		{"outer", "mailbox", "append", "--session", string(coordinator.ID), "--id", "reply", "--text", secret},
		{"outer", "mailbox", "append", "--session", string(coordinator.ID), "--id", "new-export", "--text", "statement derived from the retained context"},
	} {
		out, _, err := executeCLI(t, deps, args...)
		if err == nil || !strings.Contains(err.Error(), "OUTER_HELD") || strings.Contains(out, secret) {
			t.Fatal("CLI reimported removed B content", out, err)
		}
	}
	retained, err := st.GetOuterMailbox(ctx, "unread")
	if err != nil || retained.Text != secret || !retained.AcknowledgedAt.IsZero() || !slices.Contains(domain.OuterMailboxFact(retained).Source.Sources, "b") {
		t.Fatal("CLI denial changed retained evidence", retained, err)
	}
	if _, err := st.GetOuterMailbox(ctx, "new-export"); err == nil {
		t.Fatal("CLI re-export persisted after source removal")
	}
}
