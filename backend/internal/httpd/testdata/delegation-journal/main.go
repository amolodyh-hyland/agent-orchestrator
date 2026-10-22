// Scratch integration fixture: never starts the daemon or reads application data.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/delegationauth"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentcreds"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "journal fixture failed")
		os.Exit(1)
	}
}
func run() error {
	_, authority, err := delegationauth.ReadDesktopHandoff(os.Stdin)
	if err != nil {
		return err
	}
	store, err := sqlite.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	handler := httpd.NewRouterWithControl(config.Config{DataDir: os.Args[1]}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, httpd.APIDeps{MulticaDelegations: store, DelegationAuth: authority,
		MulticaDelegationPolicy: func(_ context.Context, _ agentcreds.DelegationPolicyRequest) agentcreds.DelegationPolicyDecision {
			// This fixture injects decisions, not a user-writable policy authority.
			raw, err := os.ReadFile(filepath.Join(os.Args[1], "policy-decision.json"))
			if errors.Is(err, os.ErrNotExist) {
				return agentcreds.DelegationPolicyDecision{Code: "policy_absent"}
			}
			var decision agentcreds.DelegationPolicyDecision
			if err != nil || json.Unmarshal(raw, &decision) != nil {
				return agentcreds.DelegationPolicyDecision{Code: "policy_unavailable"}
			}
			return decision
		},
	}, httpd.ControlDeps{})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	defer func() { _ = server.Close() }()
	go func() { _ = server.Serve(listener) }()
	fmt.Println("journal-test-origin:http://" + listener.Addr().String())
	_, _ = io.Copy(io.Discard, os.Stdin)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return server.Shutdown(ctx)
}
