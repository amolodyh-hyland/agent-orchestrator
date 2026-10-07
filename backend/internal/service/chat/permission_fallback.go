package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// permissionFallbackOutcome is what a successful run settled on.
type permissionFallbackOutcome struct {
	// Effective is the mode the provider accepted.
	Effective ports.PermissionMode
	// Rejected lists the modes the provider refused before Effective, in order,
	// with its reasons. Empty when the requested mode was accepted.
	Rejected []ports.PermissionRejection
}

// steppedDown reports whether the accepted mode is lower than the requested one.
func (o permissionFallbackOutcome) steppedDown(requested ports.PermissionMode) bool {
	return len(o.Rejected) > 0 && o.Effective != requested
}

// run attempts requested and, while the provider keeps refusing the mode,
// each strictly less permissive one. It returns the mode that succeeded and
// the modes refused on the way.
//
// With the fallback disabled, or for an error that is not a permission refusal,
// run returns the original error untouched. When every mode is refused it
// returns a ports.PermissionFallbackExhaustedError listing them.
func (f permissionFallback) run(
	ctx context.Context,
	requested ports.PermissionMode,
	attempt func(ports.PermissionMode) error,
) (permissionFallbackOutcome, error) {
	err := attempt(requested)
	if err == nil {
		return permissionFallbackOutcome{Effective: requested}, nil
	}
	if !f.enabled || !errors.Is(err, ports.ErrPermissionRejected) {
		return permissionFallbackOutcome{Effective: requested}, err
	}

	if len(ports.PermissionFallbackModes(requested)) == 0 {
		// Nothing is less permissive than what was asked for, so there is no step to
		// take. Report the refusal itself: a list of "every mode" with one entry
		// would claim a ladder was walked when none was.
		f.log.Warn("permission mode rejected by the provider; no less permissive mode to try",
			"sessionID", f.session, "stage", f.stage, "mode", requested, "reason", rejectionReason(err))
		return permissionFallbackOutcome{Effective: requested}, err
	}

	rejected := []ports.PermissionRejection{{Mode: requested, Reason: rejectionReason(err)}}
	f.log.Warn("permission mode rejected by the provider; stepping down",
		"sessionID", f.session, "stage", f.stage, "mode", requested, "reason", rejectionReason(err))

	for _, mode := range ports.PermissionFallbackModes(requested) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return permissionFallbackOutcome{Effective: requested}, ctxErr
		}
		err = attempt(mode)
		if err == nil {
			f.log.Warn("permission fallback applied",
				"sessionID", f.session, "stage", f.stage, "requested", requested, "effective", mode,
				"rejected", rejectedModes(rejected))
			return permissionFallbackOutcome{Effective: mode, Rejected: rejected}, nil
		}
		if !errors.Is(err, ports.ErrPermissionRejected) {
			// A different failure is not a reason to keep stepping down.
			f.log.Warn("permission fallback stopped on an unrelated error",
				"sessionID", f.session, "stage", f.stage, "mode", mode, "rejected", rejectedModes(rejected), "error", err)
			return permissionFallbackOutcome{Effective: requested}, err
		}
		rejected = append(rejected, ports.PermissionRejection{Mode: mode, Reason: rejectionReason(err)})
		f.log.Warn("permission mode rejected by the provider; stepping down",
			"sessionID", f.session, "stage", f.stage, "mode", mode, "reason", rejectionReason(err))
	}

	exhausted := &ports.PermissionFallbackExhaustedError{Rejected: rejected}
	f.log.Error("permission fallback exhausted: every mode was rejected",
		"sessionID", f.session, "stage", f.stage, "rejected", rejectedModes(rejected))
	return permissionFallbackOutcome{Effective: requested}, exhausted
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

// permissionFallbackActivity is the durable timeline notice for a step-down. The
// mode a conversation runs with changed at a point in it, so the row records where,
// what was asked for, what was used, and why each refused mode was refused.
func permissionFallbackActivity(
	id string,
	requested ports.PermissionMode,
	outcome permissionFallbackOutcome,
) domain.ConversationActivity {
	rejected := make([]map[string]string, 0, len(outcome.Rejected))
	for _, rejection := range outcome.Rejected {
		rejected = append(rejected, map[string]string{"mode": string(rejection.Mode), "reason": rejection.Reason})
	}
	detail, _ := json.Marshal(map[string]any{
		"event":     "permission.fallback",
		"requested": requested,
		"effective": outcome.Effective,
		"rejected":  rejected,
	})
	return domain.ConversationActivity{
		ID:             id,
		Kind:           domain.ActivityKindSystem,
		Status:         domain.ActivityStatusCompleted,
		Summary:        fmt.Sprintf("Permission mode lowered from %s to %s", requested, outcome.Effective),
		Detail:         detail,
		ProviderItemID: "ao-permission-fallback-" + id,
	}
}
