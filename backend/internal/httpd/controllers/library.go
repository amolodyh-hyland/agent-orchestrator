package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	librarysvc "github.com/aoagents/agent-orchestrator/backend/internal/service/library"
)

// LibraryService is the HTTP-facing library use-case boundary.
type LibraryService interface {
	Operate(context.Context, librarysvc.Operation) (librarysvc.Result, error)
}

// LibraryController exposes the inert local catalog and registry operations.
type LibraryController struct{ Svc LibraryService }

// Register mounts the library routes on the existing API router.
func (c *LibraryController) Register(r chi.Router) {
	r.Get("/library", c.list)
	r.Get("/library/sessions/{sessionId}", c.session)
	r.Post("/library/operations", c.operate)
}
func (c *LibraryController) list(w http.ResponseWriter, r *http.Request) {
	c.perform(w, r, librarysvc.Operation{Operation: "list"})
}
func (c *LibraryController) operate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var input librarysvc.Operation
	data, readErr := io.ReadAll(r.Body)
	canonical, canonicalErr := domain.CanonicalLibraryJSON(data)
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || readErr != nil || canonicalErr != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	c.perform(w, r, input)
}
func (c *LibraryController) perform(w http.ResponseWriter, r *http.Request, input librarysvc.Operation) {
	if c.Svc == nil {
		route := "/api/v1/library"
		if input.Operation == "session" {
			route += "/sessions/{sessionId}"
		}
		if r.Method == http.MethodPost {
			route += "/operations"
		}
		apispec.NotImplemented(w, r, r.Method, route)
		return
	}
	result, err := c.Svc.Operate(r.Context(), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *LibraryController) session(w http.ResponseWriter, r *http.Request) {
	c.perform(w, r, librarysvc.Operation{Operation: "session", SessionID: domain.SessionID(chi.URLParam(r, "sessionId"))})
}
