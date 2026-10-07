package codexappserver

import (
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// permissionRejection marks err as a refusal of the permission posture AO asked
// for when the provider said so, and returns it unchanged otherwise.
//
// Codex enforces enterprise-managed requirements as constraints on the sandbox
// and approval settings. A request outside the allowed set comes back as a
// JSON-RPC error naming the field and the set, for example
//
//	invalid thread settings override: invalid value for `sandbox_mode`:
//	`DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite]
//
// Only an error of that shape counts. The permission fallback steps down on this
// classification and on nothing else, so a transport failure, a timeout or an
// unrelated provider error must never match.
func permissionRejection(mode ports.PermissionMode, err error) error {
	var rpc *rpcError
	if !errors.As(err, &rpc) || !isPermissionConstraintMessage(rpc.Message) {
		return err
	}
	return &ports.PermissionRejectedError{
		Mode:   ports.NormalizePermissionMode(mode),
		Reason: rpc.Message,
		Err:    err,
	}
}

func isPermissionConstraintMessage(message string) bool {
	message = strings.ToLower(message)
	if !strings.Contains(message, "sandbox") && !strings.Contains(message, "approval") {
		return false
	}
	for _, marker := range []string{
		"is not in the allowed set",
		"disallowed by requirements",
		"managed requirements",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}
