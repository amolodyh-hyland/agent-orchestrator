package controllers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/outer"
)

// OuterController serves passive outer state, facts and audit projections.
type OuterController struct{ Svc *outer.Service }

// OuterFactsResponse contains bounded labeled Project evidence.
type OuterFactsResponse struct {
	Facts []domain.OuterFact `json:"facts"`
}

// OuterAuditResponse contains a bounded append-only timeline page.
type OuterAuditResponse struct {
	Events []domain.OuterAudit `json:"events"`
}

// OuterFactsQuery selects one allowed Project projection and page bound.
type OuterFactsQuery struct {
	ProjectID string `query:"projectId" json:"projectId"`
	Kind      string `query:"kind" json:"kind"`
	Limit     int    `query:"limit" json:"limit"`
}

// OuterAuditQuery selects an exclusive timeline cursor and page bound.
type OuterAuditQuery struct {
	After     int64  `query:"after" json:"after"`
	Limit     int    `query:"limit" json:"limit"`
	ProjectID string `query:"projectId" json:"projectId,omitempty"`
}

// Register mounts the passive outer projections.
func (c *OuterController) Register(r chi.Router) {
	r.Post("/outer/plans", c.proposePlan)
	r.Get("/outer", c.view)
	r.Get("/outer/facts", c.facts)
	r.Get("/outer/audit", c.audit)
}
func (c *OuterController) ready(w http.ResponseWriter, r *http.Request) bool {
	if c.Svc != nil {
		return true
	}
	apispec.NotImplemented(w, r, r.Method, r.URL.Path)
	return false
}
func (c *OuterController) view(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	v, err := c.Svc.View(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, v)
}
func (c *OuterController) facts(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit == 0 {
		limit = 20
	}
	v, err := c.Svc.Read(r.Context(), r.URL.Query().Get("projectId"), r.URL.Query().Get("kind"), limit)
	if err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Selected source is held; inspect scope and provenance", nil)
		return
	}
	envelope.WriteJSON(w, 200, OuterFactsResponse{Facts: v})
}
func (c *OuterController) audit(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit == 0 {
		limit = 50
	}
	var v []domain.OuterAudit
	var err error
	if project := r.URL.Query().Get("projectId"); project != "" {
		v, err = c.Svc.AuditProject(r.Context(), project, after, limit)
	} else {
		v, err = c.Svc.Audit(r.Context(), after, limit)
	}
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, 200, OuterAuditResponse{Events: v})
}

func (c *OuterController) proposePlan(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	var in domain.OuterPlanProposal
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Exact bounded proposal required", nil)
		return
	}
	plan, err := c.Svc.ProposePlan(r.Context(), in)
	if err != nil {
		envelope.WriteAPIError(w, r, 409, "conflict", "OUTER_HELD", "Plan held; inspect target, source clarification and participant controls", nil)
		return
	}
	envelope.WriteJSON(w, 200, plan)
}
