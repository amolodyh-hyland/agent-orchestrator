// Scratch integration fixture: never starts the daemon or reads application data.
package main

import (
	"context"
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
		MulticaDelegationPolicy: func(ctx context.Context, req agentcreds.DelegationPolicyRequest) agentcreds.DelegationPolicyDecision {
			return agentcreds.ResolveManagedDelegationPolicy(ctx, req, agentcreds.ResolveOptions{ConfigDir: os.Args[1], ManagedSettingsDir: filepath.Join(os.Args[1], "managed"), GOOS: "linux", Env: func(string) string { return "" }}, time.Now())
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
