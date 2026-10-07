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

// permissionFieldMarkers are the settings Codex names, in backticks, when a
// constraint refuses a permission posture.
var permissionFieldMarkers = []string{"`sandbox_mode`", "`approval_policy`", "`approvals_reviewer`"}

// isPermissionConstraintMessage reports whether message is a constraint error
// about the sandbox or approval settings.
//
// The decision is made on the part before "(set by …)": what follows names the
// requirement an administrator chose, and that label is free text that could
// contain "sandbox" or "approval" in a requirement about something else. The field
// must be the backticked setting name, and the wording must be a constraint's.
func isPermissionConstraintMessage(message string) bool {
	lower := strings.ToLower(message)
	if cut := strings.Index(lower, "(set by "); cut >= 0 {
		lower = lower[:cut]
	}
	named := false
	for _, field := range permissionFieldMarkers {
		if strings.Contains(lower, field) {
			named = true
			break
		}
	}
	if !named {
		return false
	}
	return strings.Contains(lower, "is not in the allowed set") ||
		strings.Contains(lower, "disallowed by requirements")
}
