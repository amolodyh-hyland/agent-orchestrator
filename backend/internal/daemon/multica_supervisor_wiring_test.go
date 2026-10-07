package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
	"github.com/aoagents/agent-orchestrator/backend/internal/multicasupervisor"
)

func TestWireMulticaSupervisorDisabledDoesNotResolveExecutableOrStart(t *testing.T) {
	service, stop, err := wireMulticaSupervisorWith(context.Background(), slog.New(slog.DiscardHandler), func(key string) string {
		if key == multicahost.FlagEnv {
			return "off"
		}
		return ""
	}, func() (string, error) {
		t.Fatal("disabled wiring resolved the executable")
		return "", errors.New("unexpected executable lookup")
	})
	if err != nil {
		t.Fatal(err)
	}
	status := service.Status()
	if status.Enabled || status.State != multicasupervisor.StateDisabled {
		t.Fatalf("unexpected disabled status: %+v", status)
	}
	if err := service.Start(context.Background()); !errors.Is(err, multicasupervisor.ErrDisabled) {
		t.Fatalf("disabled service Start() error = %v", err)
	}
	stop()
}

func TestWireMulticaSupervisorEnabledUsesContractEnvironment(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"running","pid":22,"daemon_id":"external"}`)
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	values := map[string]string{
		multicahost.FlagEnv:       "true",
		multicahost.ProfileEnv:    "dev",
		multicahost.HealthPortEnv: fmt.Sprint(port),
		multicahost.CLIPathEnv:    "/tmp/multica",
	}
	service, stop, err := wireMulticaSupervisorWith(context.Background(), slog.New(slog.DiscardHandler), func(key string) string {
		return values[key]
	}, func() (string, error) {
		return "/tmp/ao", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	status := service.Status()
	if !status.Enabled || status.Profile != "dev" || status.HealthPort != port {
		t.Fatalf("wiring did not apply contract settings: %+v", status)
	}
	deadline := time.Now().Add(time.Second)
	for service.Status().State != multicasupervisor.StateExternal && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if service.Status().State != multicasupervisor.StateExternal {
		t.Fatalf("wiring did not detect the existing daemon: %+v", service.Status())
	}
	stop()
}
