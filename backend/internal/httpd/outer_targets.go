package httpd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
)

// URL resource ownership always wins over any unrelated JSON fields. The
// prefixes name concrete route parameters, rather than interpreting every
// parameter called "id" or accepting a body as an ownership fallback.
var outerResourceRoutes = []struct{ Prefix, Parameter, Kind string }{
	{"/api/v1/sessions/{sessionId}", "sessionId", "session"},
	{"/api/v1/projects/{id}", "id", "project"},
	{"/api/v1/projects/{projectId}", "projectId", "project"},
	{"/api/v1/prs/{id}", "id", "pr"},
	{"/api/v1/runs/{runId}", "runId", "run"},
	{"/api/v1/reviews/{reviewId}", "reviewId", "review"},
	{"/api/v1/reviews/{reviewSessionID}", "reviewSessionID", "review"},
	{"/api/v1/reports/{reportId}", "reportId", "report"},
	{"/api/v1/automations/{automationId}", "automationId", "automation"},
	{"/api/v1/cues/{cueId}", "cueId", "cue"},
	{"/api/v1/awake/sessions/{awakeId}", "awakeId", "awake"},
	{"/api/v1/agents/accounts/sessions/{sessionId}", "sessionId", "session"},
	{"/api/v1/shell-terminals/{handleId}", "handleId", "terminal"},
}

func resolveOuterRouteTarget(w http.ResponseWriter, r *http.Request, match *chi.Context, pattern string, svc *outer.Service) (domain.ProjectID, domain.SessionID, error) {
	// Merge addresses the tracked PR by its exact URL, with the path number
	// acting as a consistency check in the controller. Numbers alone collide
	// across repositories. Project/session claims are never PR ownership.
	key := r.Method + " " + pattern
	if key == "POST /api/v1/prs/{id}/merge" {
		var in struct {
			PRURL string `json:"prUrl"`
		}
		if decodeOuterOwnerBody(w, r, &in) != nil {
			return "", "", domain.ErrOuterHeld
		}
		return svc.ResolveTarget(r.Context(), "pr_url", in.PRURL)
	}
	for _, owner := range outerResourceRoutes {
		if pattern == owner.Prefix || strings.HasPrefix(pattern, owner.Prefix+"/") {
			return svc.ResolveTarget(r.Context(), owner.Kind, match.URLParam(owner.Parameter))
		}
	}
	// Only these creation contracts select an existing owner in their body.
	// All other routes are host-scoped or held; JSON cannot move their scope.
	switch key {
	case "POST /api/v1/sessions", "POST /api/v1/orchestrators", "POST /api/v1/orchestrators/delegate", "POST /api/v1/runs", "POST /api/v1/reports", "POST /api/v1/automations", "POST /api/v1/awake/sessions":
	default:
		return "", "", nil
	}
	var in struct {
		ProjectID       domain.ProjectID `json:"projectId"`
		SessionID       domain.SessionID `json:"sessionId"`
		ParentSessionID domain.SessionID `json:"parentSessionId"`
		Scope           string           `json:"scope"`
	}
	if decodeOuterOwnerBody(w, r, &in) != nil {
		return "", "", domain.ErrOuterHeld
	}
	if key == "POST /api/v1/reports" || key == "POST /api/v1/runs" || (key == "POST /api/v1/awake/sessions" && in.Scope == "session") {
		project, session, err := svc.ResolveTarget(r.Context(), "session", string(in.SessionID))
		if err == nil && in.ProjectID != "" && project != in.ProjectID {
			err = domain.ErrOuterHeld
		}
		return project, session, err
	}
	if key == "POST /api/v1/awake/sessions" {
		return "", "", nil
	}
	if in.ProjectID == "" {
		return "", "", nil // Standalone creation still requires native authority.
	}
	project, session, err := svc.ResolveTarget(r.Context(), "project", string(in.ProjectID))
	if key == "POST /api/v1/sessions" && in.ParentSessionID != "" {
		parentProject, _, parentErr := svc.ResolveTarget(r.Context(), "session", string(in.ParentSessionID))
		if parentErr != nil || parentProject != project {
			err = domain.ErrOuterHeld
		}
	}
	return project, session, err
}

func decodeOuterOwnerBody(w http.ResponseWriter, r *http.Request, value any) error {
	if r.Body == nil {
		return domain.ErrOuterHeld
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return json.Unmarshal(raw, value)
}
