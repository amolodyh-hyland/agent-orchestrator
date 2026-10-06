package daemon

import (
	"context"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

func wireMulticaInProcess(ctx context.Context, logger *slog.Logger) func() {
	return wireMulticaInProcessWith(ctx, logger, multicahost.Start)
}

func wireMulticaInProcessWith(ctx context.Context, logger *slog.Logger, start func(context.Context, *slog.Logger) func()) func() {
	if start == nil {
		return func() {}
	}
	stop := start(ctx, logger)
	if stop == nil {
		return func() {}
	}
	return stop
}
