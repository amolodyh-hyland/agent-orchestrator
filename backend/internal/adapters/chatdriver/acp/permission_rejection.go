package acp

import (
	"errors"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func permissionModeRejection(mode ports.PermissionMode, nativeMode string, err error) error {
	var rpc *acpsdk.RequestError
	if !errors.As(err, &rpc) || isACPAuthRequired(err) {
		return err
	}
	reason := rpc.Error()
	lower := strings.ToLower(reason)
	compact := strings.NewReplacer(" ", "", "-", "", "_", "").Replace(lower)
	named := strings.Contains(compact, strings.ToLower(nativeMode)) ||
		strings.Contains(compact, "permissionmode") || strings.Contains(compact, "permissionsmode")
	refused := strings.Contains(lower, "not available") || strings.Contains(lower, "unsupported") ||
		strings.Contains(lower, "not supported") || strings.Contains(lower, "not allowed") ||
		strings.Contains(lower, "disabled") || strings.Contains(lower, "forbidden") ||
		strings.Contains(lower, "disallowed") || strings.Contains(lower, "unknown mode") ||
		strings.Contains(lower, "invalid mode") || strings.Contains(lower, "cannot enable") ||
		strings.Contains(lower, "unavailable") || strings.Contains(lower, "not permitted")
	if !named || !refused {
		return err
	}
	return &ports.PermissionRejectedError{Mode: ports.NormalizePermissionMode(mode), Reason: reason, Err: err}
}
