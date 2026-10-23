package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

// FactoryRunService is the manual run ledger boundary exposed over HTTP.
type FactoryRunService interface {
	List(context.Context, string) ([]domain.FactoryRun, error)
	Get(context.Context, string) (domain.RunDetail, error)
	Create(context.Context, factoryrun.CreateInput) (domain.RunDetail, error)
	Record(context.Context, string, factoryrun.RecordInput) (domain.RunDetail, error)
	Advance(context.Context, string, factoryrun.AdvanceInput) (domain.RunDetail, error)
}

// FactoryRunsController serves manual decisions and read-only evidence projections.
type FactoryRunsController struct {
	Svc     FactoryRunService
	Monitor *factoryrun.Monitor
}

// Register mounts run routes without any execution-producing callback.
func (c *FactoryRunsController) Register(r chi.Router) {
	r.Get("/runs", c.list)
	r.Get("/runs/monitoring", c.monitorList)
	r.Get("/runs/{runId}/status", c.monitorStatus)
	r.Post("/runs/{runId}/monitor", c.monitorConfigure)
	r.Post("/runs/{runId}/attention", c.monitorAcknowledge)
	r.Get("/runs/{runId}", c.get)
	r.Get("/runs/{runId}/evidence", c.history)
	r.Post("/runs", c.create)
	r.Post("/runs/{runId}/evidence", c.record)
	r.Post("/runs/{runId}/advance", c.advance)
}

func (c *FactoryRunsController) ready(w http.ResponseWriter, r *http.Request) bool {
	if c.Svc != nil {
		return true
	}
	apispec.NotImplemented(w, r, r.Method, r.URL.Path)
	return false
}

func (c *FactoryRunsController) list(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	runs, err := c.Svc.List(r.Context(), r.URL.Query().Get("projectId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListFactoryRunsResponse{Runs: runs})
}

func (c *FactoryRunsController) get(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	detail, err := c.Svc.Get(r.Context(), chi.URLParam(r, "runId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, detail)
}

func decodeRunInput(w http.ResponseWriter, r *http.Request, input any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	var data json.RawMessage
	if err := decoder.Decode(&data); err == nil {
		var trailing any
		if decoder.Decode(&trailing) == io.EOF {
			strict := json.NewDecoder(bytes.NewReader(data))
			strict.DisallowUnknownFields()
			if strict.Decode(input) == nil {
				switch input.(type) {
				case *factoryrun.RecordInput, *factoryrun.AdvanceInput:
					var fields map[string]json.RawMessage
					if json.Unmarshal(data, &fields) == nil && len(fields["expectedVersion"]) > 0 && string(fields["expectedVersion"]) != "null" {
						return true
					}
				default:
					return true
				}
			}
		}
	}
	envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "One bounded JSON object with required version fields is required", nil)
	return false
}

func (c *FactoryRunsController) create(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	var input factoryrun.CreateInput
	if !decodeRunInput(w, r, &input) {
		return
	}
	detail, err := c.Svc.Create(r.Context(), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusCreated, detail)
}

func (c *FactoryRunsController) record(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	var input factoryrun.RecordInput
	if !decodeRunInput(w, r, &input) {
		return
	}
	detail, err := c.Svc.Record(r.Context(), chi.URLParam(r, "runId"), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, detail)
}

func (c *FactoryRunsController) advance(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	var input factoryrun.AdvanceInput
	if !decodeRunInput(w, r, &input) {
		return
	}
	detail, err := c.Svc.Advance(r.Context(), chi.URLParam(r, "runId"), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, detail)
}

func (c *FactoryRunsController) history(w http.ResponseWriter, r *http.Request) {
	if !c.ready(w, r) {
		return
	}
	svc, ok := c.Svc.(interface {
		History(context.Context, string, int64, int64) ([]domain.RunEvidence, error)
	})
	if !ok {
		apispec.NotImplemented(w, r, r.Method, r.URL.Path)
		return
	}
	after, limit := int64(-1), int64(100)
	var err error
	if raw := r.URL.Query().Get("afterVersion"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
	}
	if err == nil {
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, err = strconv.ParseInt(raw, 10, 64)
		}
	}
	if err != nil {
		envelope.WriteAPIError(w, r, 400, "bad_request", "RUN_INVALID", "Invalid history cursor", nil)
		return
	}
	records, err := svc.History(r.Context(), chi.URLParam(r, "runId"), after, limit)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	next := after
	if len(records) > 0 {
		next = records[len(records)-1].Version
	}
	envelope.WriteJSON(w, http.StatusOK, RunEvidencePage{Evidence: records, NextAfterVersion: next})
}

func (c *FactoryRunsController) monitorList(w http.ResponseWriter, r *http.Request) {
	if c.Monitor == nil {
		apispec.NotImplemented(w, r, r.Method, r.URL.Path)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := c.Monitor.Scan(ctx, r.URL.Query().Get("projectId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RunMonitoringList{Runs: rows})
}
func (c *FactoryRunsController) monitorStatus(w http.ResponseWriter, r *http.Request) {
	if c.Monitor == nil {
		apispec.NotImplemented(w, r, r.Method, r.URL.Path)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	row, err := c.Monitor.Get(ctx, chi.URLParam(r, "runId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, row)
}
func (c *FactoryRunsController) monitorConfigure(w http.ResponseWriter, r *http.Request) {
	if c.Monitor == nil {
		apispec.NotImplemented(w, r, r.Method, r.URL.Path)
		return
	}
	var input domain.RunMonitorConfig
	if !decodeRunInput(w, r, &input) {
		return
	}
	row, err := c.Monitor.Configure(r.Context(), chi.URLParam(r, "runId"), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, row)
}
func (c *FactoryRunsController) monitorAcknowledge(w http.ResponseWriter, r *http.Request) {
	if c.Monitor == nil {
		apispec.NotImplemented(w, r, r.Method, r.URL.Path)
		return
	}
	var input RunAttentionAck
	if !decodeRunInput(w, r, &input) {
		return
	}
	row, err := c.Monitor.Acknowledge(r.Context(), chi.URLParam(r, "runId"), input.Key)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, row)
}
