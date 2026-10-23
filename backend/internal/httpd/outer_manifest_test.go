package httpd

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/go-chi/chi/v5"
)

func TestOuterMutationRouteInventory(t *testing.T) {
	r := NewRouterWithControl(config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, APIDeps{}, ControlDeps{})
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1/") || method == "GET" || method == "HEAD" || method == "OPTIONS" {
			return nil
		}
		if _, ok := outerMutationManifest[method+" "+route]; !ok {
			t.Errorf("MISSING %s %s", method, route)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
