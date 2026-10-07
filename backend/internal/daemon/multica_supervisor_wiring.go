package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
	"github.com/aoagents/agent-orchestrator/backend/internal/multicasupervisor"
)

func wireMulticaSupervisor(ctx context.Context, logger *slog.Logger) (multicasupervisor.Service, func(), error) {
	return wireMulticaSupervisorWith(ctx, logger, os.Getenv, os.Executable)
}

func wireMulticaSupervisorWith(
	ctx context.Context,
	logger *slog.Logger,
	getenv func(string) string,
	executable func() (string, error),
) (multicasupervisor.Service, func(), error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	if !multicahost.Enabled(getenv) {
		return multicasupervisor.New(multicasupervisor.Config{}, logger), func() {}, nil
	}
	path, err := executable()
	if err != nil {
		return nil, func() {}, fmt.Errorf("resolve AO executable for Multica host: %w", err)
	}
	config := multicasupervisor.Config{
		Enabled:     true,
		Profile:     multicahost.Profile(getenv),
		HealthPort:  multicahost.HealthPort(getenv),
		Executable:  path,
		CLIPath:     getenv(multicahost.CLIPathEnv),
		Environment: multicasupervisor.BuildEnvironment(os.Environ()),
	}
	supervisor := multicasupervisor.New(config, logger)
	supervisor.Run(ctx)
	return supervisor, func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		if err := supervisor.Shutdown(shutdownCtx); err != nil && logger != nil {
			logger.Error("Multica host shutdown", "error", err)
		}
	}, nil
}
