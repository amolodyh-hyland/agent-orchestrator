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

// The wording is what a user reads when a mode is refused, so it must carry the mode
// and the provider's reason, and the types must match only the sentinel they stand for.
func TestPermissionRejectedErrorMessageNamesTheModeAndTheReason(t *testing.T) {
	err := &PermissionRejectedError{Mode: PermissionModeBypassPermissions, Reason: "not allowed by policy"}
	if got, want := err.Error(), `permission mode "bypass-permissions" rejected: not allowed by policy`; got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
}

func TestPermissionFallbackExhaustedErrorMessageIsOrderedAndSeparated(t *testing.T) {
	err := &PermissionFallbackExhaustedError{Rejected: []PermissionRejection{
		{Mode: PermissionModeBypassPermissions, Reason: "no full access"},
		{Mode: PermissionModeAuto, Reason: "no reviewer"},
		{Mode: PermissionModeAcceptEdits, Reason: "no sandbox"},
	}}
	want := "every permission mode was rejected: bypass-permissions (no full access); auto (no reviewer); accept-edits (no sandbox)"
	if got := err.Error(); got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}
}

func TestPermissionErrorsMatchOnlyTheirOwnSentinel(t *testing.T) {
	other := errors.New("some other failure")
	for name, err := range map[string]error{
		"rejected":  &PermissionRejectedError{Mode: PermissionModeAuto, Reason: "no"},
		"exhausted": &PermissionFallbackExhaustedError{Rejected: []PermissionRejection{{Mode: PermissionModeAuto, Reason: "no"}}},
	} {
		if !errors.Is(err, ErrPermissionRejected) {
			t.Errorf("%s does not match ErrPermissionRejected", name)
		}
		if errors.Is(err, other) {
			t.Errorf("%s matches an unrelated error", name)
		}
	}
}

// The chat service reads this contract structurally, without importing the type, to
// settle an edit or steer refused over the permission mode as a definitive rejection.
func TestPermissionErrorsAreChatRefusals(t *testing.T) {
	for name, err := range map[string]error{
		"rejected":  &PermissionRejectedError{Mode: PermissionModeAuto},
		"exhausted": &PermissionFallbackExhaustedError{},
	} {
		refusal, ok := err.(interface{ ChatRefusal() bool })
		if !ok || !refusal.ChatRefusal() {
			t.Errorf("%s does not report itself as a chat refusal", name)
		}
	}
}
