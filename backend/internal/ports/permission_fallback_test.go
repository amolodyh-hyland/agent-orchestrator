package ports

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPermissionFallbackModesStepsStrictlyDown(t *testing.T) {
	tests := []struct {
		requested PermissionMode
		want      []PermissionMode
	}{
		{PermissionModeBypassPermissions, []PermissionMode{PermissionModeAuto, PermissionModeAcceptEdits}},
		{PermissionModeAuto, []PermissionMode{PermissionModeAcceptEdits}},
		{PermissionModeAcceptEdits, nil},
		{PermissionModeDefault, nil},
		{"", nil},
		{"nonsense", nil},
	}
	for _, test := range tests {
		t.Run(string(test.requested), func(t *testing.T) {
			got := PermissionFallbackModes(test.requested)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("PermissionFallbackModes(%q) = %v, want %v", test.requested, got, test.want)
			}
		})
	}
}

// A fallback must never offer the requested mode again or a more permissive one.
func TestPermissionFallbackModesNeverEscalate(t *testing.T) {
	rank := map[PermissionMode]int{}
	for i, mode := range permissionLadder {
		rank[mode] = len(permissionLadder) - i
	}
	for _, requested := range permissionLadder {
		for _, mode := range PermissionFallbackModes(requested) {
			if rank[mode] >= rank[requested] {
				t.Errorf("fallback from %q offers %q, which is not strictly less permissive", requested, mode)
			}
		}
	}
}

func TestPermissionFallbackModesReturnsACopy(t *testing.T) {
	first := PermissionFallbackModes(PermissionModeBypassPermissions)
	first[0] = PermissionModeBypassPermissions
	if got := PermissionFallbackModes(PermissionModeBypassPermissions)[0]; got != PermissionModeAuto {
		t.Fatalf("mutating a result changed the ladder: %q", got)
	}
}

func TestPermissionRejectedErrorClassification(t *testing.T) {
	cause := errors.New("provider says no")
	err := error(&PermissionRejectedError{Mode: PermissionModeBypassPermissions, Reason: "not allowed", Err: cause})
	if !errors.Is(err, ErrPermissionRejected) {
		t.Fatal("a rejected-permission error does not match ErrPermissionRejected")
	}
	if !errors.Is(err, cause) {
		t.Fatal("the provider's error is not reachable through Unwrap")
	}
	if errors.Is(cause, ErrPermissionRejected) {
		t.Fatal("an unrelated provider error matches ErrPermissionRejected")
	}
}

func TestPermissionFallbackExhaustedErrorListsEveryMode(t *testing.T) {
	err := error(&PermissionFallbackExhaustedError{Rejected: []PermissionRejection{
		{Mode: PermissionModeBypassPermissions, Reason: "no full access"},
		{Mode: PermissionModeAuto, Reason: "no reviewer"},
	}})
	if !errors.Is(err, ErrPermissionRejected) {
		t.Fatal("an exhausted fallback does not match ErrPermissionRejected")
	}
	for _, want := range []string{"bypass-permissions (no full access)", "auto (no reviewer)"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%q does not mention %q", err.Error(), want)
		}
	}
}

// default asks the provider for nothing, so its posture is the provider's own
// configuration and can be more permissive than a mode that was just refused. It
// is therefore never a rung a refusal steps down to.
func TestPermissionFallbackNeverStepsDownToDefault(t *testing.T) {
	for _, requested := range []PermissionMode{
		PermissionModeBypassPermissions, PermissionModeAuto, PermissionModeAcceptEdits, PermissionModeDefault, "",
	} {
		for _, mode := range PermissionFallbackModes(requested) {
			if mode == PermissionModeDefault {
				t.Errorf("fallback from %q offers default", requested)
			}
		}
	}
}
