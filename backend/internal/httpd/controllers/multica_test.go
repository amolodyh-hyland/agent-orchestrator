package controllers_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/multicasupervisor"
)

type fakeMulticaService struct {
	status    multicasupervisor.Status
	counts    map[string]int
	actionErr map[string]error
	ctxErrs   []error
}

func (f *fakeMulticaService) Status() multicasupervisor.Status { return f.status }

func (f *fakeMulticaService) Start(ctx context.Context) error   { return f.run(ctx, "start") }
func (f *fakeMulticaService) Stop(ctx context.Context) error    { return f.run(ctx, "stop") }
func (f *fakeMulticaService) Restart(ctx context.Context) error { return f.run(ctx, "restart") }

func (f *fakeMulticaService) run(ctx context.Context, action string) error {
	if f.counts == nil {
		f.counts = make(map[string]int)
	}
	f.counts[action]++
	f.ctxErrs = append(f.ctxErrs, ctx.Err())
	if err := f.actionErr[action]; err != nil {
		return err
	}
	switch action {
	case "start", "restart":
		f.status.State = multicasupervisor.StateRunning
		f.status.Desired = multicasupervisor.DesiredRunning
	case "stop":
		f.status.State = multicasupervisor.StateStopped
		f.status.Desired = multicasupervisor.DesiredStopped
	}
	return nil
}

func newMulticaRouter(svc controllers.MulticaService) http.Handler {
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		(&controllers.MulticaController{Svc: svc}).Register(r)
	})
	return r
}

func multicaRequest(ctx context.Context, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestMulticaStatusMapsEveryField(t *testing.T) {
	startedAt := time.Date(2026, 10, 6, 1, 2, 3, 0, time.UTC)
	nextRetryAt := time.Date(2026, 10, 6, 1, 3, 4, 0, time.UTC)
	lastExitAt := time.Date(2026, 10, 6, 0, 59, 58, 0, time.UTC)
	svc := &fakeMulticaService{status: multicasupervisor.Status{
		Enabled:     true,
		State:       multicasupervisor.StateRunning,
		Desired:     multicasupervisor.DesiredRunning,
		PID:         1234,
		Profile:     "work",
		HealthPort:  47832,
		StartedAt:   startedAt,
		Restarts:    2,
		NextRetryAt: nextRetryAt,
		LastExit: &multicasupervisor.ExitStatus{
			Code:     7,
			Signal:   "SIGTERM",
			At:       lastExitAt,
			Graceful: true,
			Crash:    false,
		},
		LastError: "last problem",
		LogLines:  []string{"ready", "listening"},
		Health: &multicasupervisor.Health{
			Status:         "ok",
			PID:            1234,
			DaemonID:       "daemon-1",
			Profile:        "work",
			DeviceName:     "build machine",
			ServerURL:      "http://127.0.0.1:47832",
			Agents:         []string{"codex", "claude"},
			WorkspaceCount: 3,
			RuntimeIDs:     []string{"tmux", "docker"},
		},
	}}

	rec := multicaRequest(context.Background(), newMulticaRouter(svc), http.MethodGet, "/api/v1/multica/status", "")
	want := `{"daemon":{"enabled":true,"state":"running","desired":"running","pid":1234,"profile":"work","healthPort":47832,"startedAt":"2026-10-06T01:02:03Z","restarts":2,"nextRetryAt":"2026-10-06T01:03:04Z","lastExit":{"code":7,"signal":"SIGTERM","at":"2026-10-06T00:59:58Z","graceful":true,"crash":false},"lastError":"last problem","logLines":["ready","listening"],"health":{"status":"ok","pid":1234,"daemonId":"daemon-1","profile":"work","deviceName":"build machine","serverUrl":"http://127.0.0.1:47832","agents":["codex","claude"],"workspaceCount":3,"runtimeIds":["tmux","docker"]}}}`
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("GET multica status = %d %s, want 200 %s", rec.Code, rec.Body.String(), want)
	}
}

func TestMulticaDisabledStatusOmitsUnsetValues(t *testing.T) {
	svc := &fakeMulticaService{status: multicasupervisor.Status{
		State:    multicasupervisor.StateDisabled,
		Desired:  multicasupervisor.DesiredStopped,
		Profile:  "local",
		Restarts: 0,
	}}
	rec := multicaRequest(context.Background(), newMulticaRouter(svc), http.MethodGet, "/api/v1/multica/status", `{"ignored":true}`)
	want := `{"daemon":{"enabled":false,"state":"disabled","desired":"stopped","profile":"local","healthPort":0,"restarts":0}}`
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != want {
		t.Fatalf("GET disabled multica status = %d %s, want 200 %s", rec.Code, rec.Body.String(), want)
	}
}

func TestMulticaActionsReturnPostActionStatus(t *testing.T) {
	for _, tc := range []struct {
		action  string
		path    string
		state   multicasupervisor.State
		desired multicasupervisor.Desired
	}{
		{action: "start", path: "/api/v1/multica/start", state: multicasupervisor.StateRunning, desired: multicasupervisor.DesiredRunning},
		{action: "stop", path: "/api/v1/multica/stop", state: multicasupervisor.StateStopped, desired: multicasupervisor.DesiredStopped},
		{action: "restart", path: "/api/v1/multica/restart", state: multicasupervisor.StateRunning, desired: multicasupervisor.DesiredRunning},
	} {
		t.Run(tc.action, func(t *testing.T) {
			svc := &fakeMulticaService{status: multicasupervisor.Status{
				Enabled: true, State: multicasupervisor.StateStopped, Desired: multicasupervisor.DesiredStopped,
				Profile: "local",
			}}
			rec := multicaRequest(context.Background(), newMulticaRouter(svc), http.MethodPost, tc.path, "")
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"`+string(tc.state)+`"`) || !strings.Contains(rec.Body.String(), `"desired":"`+string(tc.desired)+`"`) {
				t.Fatalf("POST %s = %d %s", tc.path, rec.Code, rec.Body.String())
			}
			if svc.counts[tc.action] != 1 {
				t.Fatalf("%s calls = %d, want 1", tc.action, svc.counts[tc.action])
			}
		})
	}
}

func TestMulticaActionUsesContextIndependentOfRequestCancellation(t *testing.T) {
	svc := &fakeMulticaService{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := multicaRequest(ctx, newMulticaRouter(svc), http.MethodPost, "/api/v1/multica/start", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST multica start = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if len(svc.ctxErrs) != 1 || svc.ctxErrs[0] != nil {
		t.Fatalf("action context error = %v, want nil", svc.ctxErrs)
	}
}

func TestMulticaActionErrors(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		statusCode int
		code       string
	}{
		{name: "disabled", err: multicasupervisor.ErrDisabled, statusCode: http.StatusConflict, code: "MULTICA_DISABLED"},
		{name: "external", err: multicasupervisor.ErrExternal, statusCode: http.StatusConflict, code: "MULTICA_EXTERNAL"},
		{name: "not running", err: multicasupervisor.ErrNotRunning, statusCode: http.StatusServiceUnavailable, code: "MULTICA_UNAVAILABLE"},
		{name: "stopped", err: multicasupervisor.ErrStopped, statusCode: http.StatusConflict, code: "MULTICA_STOPPED"},
		{name: "unknown", err: fmt.Errorf("unexpected failure"), statusCode: http.StatusInternalServerError, code: "INTERNAL_ERROR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeMulticaService{actionErr: map[string]error{"start": fmt.Errorf("wrapped: %w", tc.err)}}
			rec := multicaRequest(context.Background(), newMulticaRouter(svc), http.MethodPost, "/api/v1/multica/start", "")
			if rec.Code != tc.statusCode || !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("POST multica start = %d %s, want %d code %s", rec.Code, rec.Body.String(), tc.statusCode, tc.code)
			}
			if svc.counts["start"] != 1 {
				t.Fatalf("start calls = %d, want 1", svc.counts["start"])
			}
		})
	}
}

func TestMulticaNilServiceAndUnsupportedMethods(t *testing.T) {
	handler := newMulticaRouter(nil)
	for _, tc := range []struct {
		method string
		path   string
		body   string
		status int
		code   string
	}{
		{method: http.MethodGet, path: "/api/v1/multica/status", status: http.StatusNotImplemented, code: "NOT_IMPLEMENTED"},
		{method: http.MethodPost, path: "/api/v1/multica/start", status: http.StatusNotImplemented, code: "NOT_IMPLEMENTED"},
		{method: http.MethodPost, path: "/api/v1/multica/stop", status: http.StatusNotImplemented, code: "NOT_IMPLEMENTED"},
		{method: http.MethodPost, path: "/api/v1/multica/restart", status: http.StatusNotImplemented, code: "NOT_IMPLEMENTED"},
		{method: http.MethodGet, path: "/api/v1/multica/start", body: `{"ignored":true}`, status: http.StatusMethodNotAllowed},
		{method: http.MethodPost, path: "/api/v1/multica/status", status: http.StatusMethodNotAllowed},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rec := multicaRequest(context.Background(), handler, tc.method, tc.path, tc.body)
			if rec.Code != tc.status {
				t.Fatalf("%s %s = %d %s, want %d", tc.method, tc.path, rec.Code, rec.Body.String(), tc.status)
			}
			if tc.code != "" && !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("%s %s response missing %s: %s", tc.method, tc.path, tc.code, rec.Body.String())
			}
		})
	}
}
