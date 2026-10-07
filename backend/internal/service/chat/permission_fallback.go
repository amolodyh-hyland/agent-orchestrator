package chat

import (
	"context"
	"errors"
	"log/slog"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// permissionFallback retries a launch or turn with a less permissive mode when
// the provider refuses the mode it was given.
//
// The rules are narrow on purpose:
//   - It steps down only on ports.ErrPermissionRejected, which a driver reserves
//     for a provider refusal of the permission or sandbox posture. Any other
//     failure is returned as it came.
//   - Each retry is strictly less permissive than the last (the ordering is
//     ports.PermissionFallbackModes), so it can never escalate.
//   - It never works around a managed requirement: it asks again with a weaker
//     mode, it does not rewrite the provider's configuration or retry the same
//     mode.
//   - It is never silent: every refused mode is logged with the provider's reason
//     and the mode finally used is logged and reported to the caller.
type permissionFallback struct {
	enabled bool
	log     *slog.Logger
	session domain.SessionID
	// stage names what is being attempted ("launch" or "turn") in log lines.
	stage string
}

// run attempts requested and, while the provider keeps refusing the mode,
// each strictly less permissive one. It returns the mode that succeeded.
//
// With the fallback disabled, or for an error that is not a permission refusal,
// run returns requested and the original error untouched. When every mode is
// refused it returns a ports.PermissionFallbackExhaustedError listing them.
func (f permissionFallback) run(
	ctx context.Context,
	requested ports.PermissionMode,
	attempt func(ports.PermissionMode) error,
) (ports.PermissionMode, error) {
	err := attempt(requested)
	if err == nil {
		return requested, nil
	}
	if !f.enabled || !errors.Is(err, ports.ErrPermissionRejected) {
		return requested, err
	}

	rejected := []ports.PermissionRejection{{Mode: requested, Reason: rejectionReason(err)}}
	f.log.Warn("permission mode rejected by the provider; stepping down",
		"sessionID", f.session, "stage", f.stage, "mode", requested, "reason", rejectionReason(err))

	for _, mode := range ports.PermissionFallbackModes(requested) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return requested, ctxErr
		}
		err = attempt(mode)
		if err == nil {
			f.log.Warn("permission fallback applied",
				"sessionID", f.session, "stage", f.stage, "requested", requested, "effective", mode,
				"rejected", rejectedModes(rejected))
			return mode, nil
		}
		if !errors.Is(err, ports.ErrPermissionRejected) {
			// A different failure is not a reason to keep stepping down.
			f.log.Warn("permission fallback stopped on an unrelated error",
				"sessionID", f.session, "stage", f.stage, "mode", mode, "rejected", rejectedModes(rejected), "error", err)
			return requested, err
		}
		rejected = append(rejected, ports.PermissionRejection{Mode: mode, Reason: rejectionReason(err)})
		f.log.Warn("permission mode rejected by the provider; stepping down",
			"sessionID", f.session, "stage", f.stage, "mode", mode, "reason", rejectionReason(err))
	}

	exhausted := &ports.PermissionFallbackExhaustedError{Rejected: rejected}
	f.log.Error("permission fallback exhausted: every mode was rejected",
		"sessionID", f.session, "stage", f.stage, "rejected", rejectedModes(rejected))
	return requested, exhausted
}

func rejectionReason(err error) string {
	var rejection *ports.PermissionRejectedError
	if errors.As(err, &rejection) {
		return rejection.Reason
	}
	return err.Error()
}

func rejectedModes(rejected []ports.PermissionRejection) []ports.PermissionMode {
	modes := make([]ports.PermissionMode, 0, len(rejected))
	for _, rejection := range rejected {
		modes = append(modes, rejection.Mode)
	}
	return modes
}
