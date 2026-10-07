package ports

import (
	"errors"
	"fmt"
	"strings"
)

// ErrPermissionRejected marks a launch or turn the provider refused because of
// the permission or sandbox posture it asked for, for example an
// enterprise-managed requirement that forbids full access. Drivers wrap only
// refusals of that kind; any other failure must not match, because the permission
// fallback steps down on this error and nothing else.
var ErrPermissionRejected = errors.New("permission mode rejected by provider")

// PermissionRejectedError is the typed form of ErrPermissionRejected.
type PermissionRejectedError struct {
	// Mode is the permission mode whose posture the provider refused.
	Mode PermissionMode
	// Reason is the provider's own explanation, kept verbatim for the user.
	Reason string
	// Err is the underlying provider error.
	Err error
}

func (e *PermissionRejectedError) Error() string {
	return fmt.Sprintf("permission mode %q rejected: %s", e.Mode, e.Reason)
}

func (e *PermissionRejectedError) Unwrap() error { return e.Err }

// Is lets errors.Is(err, ErrPermissionRejected) classify the error.
func (e *PermissionRejectedError) Is(target error) bool { return target == ErrPermissionRejected }

// PermissionRejection records one mode the provider refused, and why.
type PermissionRejection struct {
	Mode   PermissionMode
	Reason string
}

// PermissionFallbackExhaustedError reports that every permitted mode was
// refused. It lists each one so the failure explains itself, and it still
// matches ErrPermissionRejected.
type PermissionFallbackExhaustedError struct {
	Rejected []PermissionRejection
}

func (e *PermissionFallbackExhaustedError) Error() string {
	parts := make([]string, 0, len(e.Rejected))
	for _, rejection := range e.Rejected {
		parts = append(parts, fmt.Sprintf("%s (%s)", rejection.Mode, rejection.Reason))
	}
	return "every permission mode was rejected: " + strings.Join(parts, "; ")
}

// Is lets errors.Is(err, ErrPermissionRejected) classify the error.
func (e *PermissionFallbackExhaustedError) Is(target error) bool {
	return target == ErrPermissionRejected
}

// permissionLadder orders the permission modes a refused launch steps down
// through, from most to least permissive.
//
// bypass-permissions asks for no approvals and no sandbox. auto approves routine
// actions through an automatic reviewer, and accept-edits leaves those approvals
// with the user inside the same sandbox.
//
// default is deliberately not a rung. It asks the provider for nothing, so its
// posture is whatever the provider's own configuration says, and on a given
// machine that can be more permissive than the mode that was just refused (a
// user-level sandbox_mode of danger-full-access, with a managed requirement that
// only constrains approvals). A fallback that could widen the posture would
// contradict "strictly downward", so the ladder ends at accept-edits and a user
// who wants the provider's defaults chooses default explicitly.
var permissionLadder = []PermissionMode{
	PermissionModeBypassPermissions,
	PermissionModeAuto,
	PermissionModeAcceptEdits,
}

// PermissionFallbackModes returns the modes strictly less permissive than
// requested, in the order a refused launch steps down through them. It never
// returns the requested mode or a more permissive one, so a fallback cannot
// escalate. Accept-edits, default and unknown modes have nothing below them.
func PermissionFallbackModes(requested PermissionMode) []PermissionMode {
	for i, mode := range permissionLadder {
		if mode == requested {
			return append([]PermissionMode(nil), permissionLadder[i+1:]...)
		}
	}
	return nil
}
