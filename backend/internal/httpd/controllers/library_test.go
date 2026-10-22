package controllers_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	librarysvc "github.com/aoagents/agent-orchestrator/backend/internal/service/library"
	"github.com/go-chi/chi/v5"
)

type libraryStub struct {
	request librarysvc.Operation
	err     error
}

func (s *libraryStub) Operate(_ context.Context, in librarysvc.Operation) (librarysvc.Result, error) {
	s.request = in
	return librarysvc.Result{Status: "unsupported_provider", ReasonCode: "inert_catalog"}, s.err
}
func TestLibraryHTTPBoundary(t *testing.T) {
	for _, tc := range []struct {
		method, body string
		status       int
		missing      bool
		err          error
	}{
		{method: "GET", status: 200},
		{method: "POST", body: `{"operation":"inspect","sourceId":"source","expectedRevision":1}`, status: 200},
		{method: "POST", body: `{"operation":"inspect","policy":{"allow":true}}`, status: 400},
		{method: "POST", body: `{"operation":"inspect"} {}`, status: 400},
		{method: "POST", body: `{"operation":"inspect"}`, status: 409, err: apierr.Conflict("LIBRARY_UNAVAILABLE", "inspection_required", nil)},
		{method: "GET", status: 501, missing: true},
	} {
		t.Run(tc.method+tc.body, func(t *testing.T) {
			stub := &libraryStub{err: tc.err}
			c := controllers.LibraryController{Svc: stub}
			if tc.missing {
				c.Svc = nil
			}
			r := chi.NewRouter()
			r.Route("/api/v1", c.Register)
			url := "/api/v1/library"
			if tc.method == "POST" {
				url += "/operations"
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(tc.method, url, strings.NewReader(tc.body)))
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
