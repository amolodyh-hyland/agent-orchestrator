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
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

type fakeFactoryRuns struct{ calls int }

func (f *fakeFactoryRuns) List(context.Context, string) ([]domain.FactoryRun, error) {
	f.calls++
	return []domain.FactoryRun{}, nil
}
func (f *fakeFactoryRuns) Get(context.Context, string) (domain.RunDetail, error) {
	f.calls++
	return domain.RunDetail{}, nil
}
func (f *fakeFactoryRuns) Create(context.Context, factoryrun.CreateInput) (domain.RunDetail, error) {
	f.calls++
	return domain.RunDetail{}, nil
}
func (f *fakeFactoryRuns) Record(context.Context, string, factoryrun.RecordInput) (domain.RunDetail, error) {
	f.calls++
	return domain.RunDetail{}, nil
}
func (f *fakeFactoryRuns) Advance(context.Context, string, factoryrun.AdvanceInput) (domain.RunDetail, error) {
	f.calls++
	return domain.RunDetail{}, nil
}

func TestFactoryRunRoutesAndBoundedStrictInput(t *testing.T) {
	svc := &fakeFactoryRuns{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{FactoryRuns: svc}, httpd.ControlDeps{})
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/v1/runs?projectId=p", "", 200},
		{"GET", "/api/v1/runs/r", "", 200},
		{"POST", "/api/v1/runs", `{"id":"r","actor":"human","decision":"approved"}`, 201},
		{"POST", "/api/v1/runs/r/evidence", `{"expectedVersion":0,"actor":"human","decision":"receipt"}`, 200},
		{"POST", "/api/v1/runs/r/advance", `{"expectedVersion":1,"actor":"human","decision":"advance"}`, 200},
		{"POST", "/api/v1/runs/r/advance", `{"launch":true}`, 400},
		{"POST", "/api/v1/runs/r/advance", `{"actor":"human","decision":"missing version"}`, 400},
		{"POST", "/api/v1/runs/r/evidence", `{"expectedVersion":null}`, 400},
		{"POST", "/api/v1/runs", `{} {}`, 400},
		{"POST", "/api/v1/runs", `{"id":"` + strings.Repeat("x", 256<<10) + `"}`, 400},
	} {
		before := svc.calls
		request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Errorf("%s %s: %d %s", tc.method, tc.path, response.Code, response.Body.String())
		}
		if tc.status == 400 && svc.calls != before {
			t.Error("invalid JSON reached service")
		}
	}
	unavailable := httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{})
	response := httptest.NewRecorder()
	unavailable.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/runs", nil))
	if response.Code != http.StatusNotImplemented {
		t.Fatalf("nil service: %d", response.Code)
	}
}
