package daemon

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

func TestWireMulticaInProcessPassesLifecycleAndLoggerAndReturnsStop(t *testing.T) {
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	started := false
	stopped := false
	stop := wireMulticaInProcessWith(ctx, logger, func(gotCtx context.Context, gotLogger *slog.Logger) func() {
		if gotCtx != ctx {
			t.Fatal("wiring passed a different lifecycle context")
		}
		if gotLogger != logger {
			t.Fatal("wiring passed a different logger")
		}
		started = true
		return func() { stopped = true }
	})
	if !started {
		t.Fatal("in-process host was not started")
	}
	stop()
	if !stopped {
		t.Fatal("stop function was not returned to the caller")
	}
}

func TestWireMulticaInProcessHandlesNilStop(t *testing.T) {
	stop := wireMulticaInProcessWith(context.Background(), slog.Default(), func(context.Context, *slog.Logger) func() {
		return nil
	})
	stop()
}
