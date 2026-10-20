package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type contextSessionService struct{ *fakeSessionService }

func (s *contextSessionService) ProjectContext(_ context.Context, id domain.SessionID) (*domain.ProjectContextManifest, error) {
	if id == "missing" {
		return nil, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}
	if id == "legacy" {
		return nil, nil
	}
	return &domain.ProjectContextManifest{SessionID: id, ProjectID: "p", ProjectRevision: 2, SharedInstructions: "pinned instructions", Digest: "pinned-digest"}, nil
}
func TestSessionProjectContextHTTP(t *testing.T) {
	router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, httpd.APIDeps{Sessions: &contextSessionService{newFakeSessionService()}}, httpd.ControlDeps{})
	for _, tc := range []struct {
		id     string
		status int
		body   string
	}{{"p-1", 200, `"projectRevision":2`}, {"legacy", 200, `"manifest":null`}, {"missing", 404, "SESSION_NOT_FOUND"}} {
		t.Run(tc.id, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/sessions/"+tc.id+"/project-context", nil))
			if recorder.Code != tc.status || !strings.Contains(recorder.Body.String(), tc.body) {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
