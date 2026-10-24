package cli

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
	reportsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/report"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestOuterCLIUsesOwnedCredentialAndCannotReplaceItWithEnvironmentLabels(t *testing.T) {
	ctx := context.Background()
	cfg := setConfigEnv(t)
	st, err := sqlite.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, id := range []string{"anchor", "selected", "other"} {
		if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: id, Kind: domain.ProjectKindScratch, RegisteredAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	sessions := map[string]domain.SessionRecord{}
	for _, id := range []string{"anchor", "selected", "other"} {
		kind := domain.KindWorker
		if id == "anchor" {
			kind = domain.KindOrchestrator
		}
		r, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: domain.ProjectID(id), Kind: kind, Mode: domain.SessionModeChat, Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{ControllerGeneration: "owned-launch"}})
		if err != nil {
			t.Fatal(err)
		}
		sessions[id] = r
	}
	if err := st.SaveOuterBinding(ctx, domain.OuterBinding{AnchorProjectID: "anchor", SessionID: sessions["anchor"].ID, Revision: 1, ScopeRevision: 1, Generation: 1, ProjectIDs: []string{"selected"}}, 0, domain.OuterAudit{Operation: "setup"}); err != nil {
		t.Fatal(err)
	}
	service := reportsvc.New(reportsvc.Deps{Store: st})
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: outer.New(st, nil, nil), Reports: service}, httpd.ControlDeps{})
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 9999, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	c := &commandContext{deps: Deps{ProcessAlive: func(pid int) bool { return pid == os.Getpid() }, HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		req.RemoteAddr = "127.0.0.1:23456"
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response.Result(), nil
	})}}}
	worker := sessions["selected"]
	credential, err := st.IssueOuterCaller(ctx, worker.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_SCOPE_CREDENTIAL", credential)
	t.Setenv("AO_PROJECT_ID", "forged-project-label")
	t.Setenv("AO_SESSION_ID", "forged-session-label")
	body := map[string]any{"sessionId": worker.ID, "state": "done", "note": "owned caller report"}
	if err := c.postJSON(ctx, "reports", body, nil); err != nil {
		t.Fatal("updated CLI lost its actual owned caller", err)
	}
	if rows, err := st.ListReportsByProject(ctx, "selected"); err != nil || len(rows) != 1 || rows[0].SessionID != worker.ID {
		t.Fatal("legitimate CLI report did not persist under its real owner", rows, err)
	}
	for _, forgery := range []map[string]any{
		{"sessionId": sessions["other"].ID, "projectId": "selected", "state": "done", "note": "forged ownership"},
		{"sessionId": sessions["other"].ID, "state": "done", "note": "cross-project"},
	} {
		if err := c.postJSON(ctx, "reports", forgery, nil); err == nil {
			t.Fatal("project-local caller escaped its actual Project")
		}
	}
	for _, token := range []string{"", "forged-credential"} {
		t.Setenv("AO_SCOPE_CREDENTIAL", token)
		t.Setenv("AO_PROJECT_ID", "selected")
		t.Setenv("AO_SESSION_ID", string(worker.ID))
		if err := c.postJSON(ctx, "reports", body, nil); err == nil {
			t.Fatal("environment labels replaced owned launch authority")
		}
	}
	t.Setenv("AO_SCOPE_CREDENTIAL", credential)
	worker.Metadata.ControllerGeneration = "replacement-launch"
	if err := st.UpdateSession(ctx, worker); err != nil {
		t.Fatal(err)
	}
	if err := c.postJSON(ctx, "reports", body, nil); err == nil {
		t.Fatal("old project-local credential survived replacement")
	}
	if _, err := service.Create(ctx, reportsvc.CreateInput{SessionID: worker.ID, State: domain.ReportCheckpoint, Note: "daemon-owned inert report"}); err != nil {
		t.Fatal("daemon producer was mistaken for a human issuer", err)
	}
	if rows, err := st.ListReportsByProject(ctx, "selected"); err != nil || len(rows) != 2 {
		t.Fatal("held requests changed durable reports", rows, err)
	}
}
