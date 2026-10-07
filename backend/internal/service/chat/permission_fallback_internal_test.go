package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func rejection(mode ports.PermissionMode) error {
	return &ports.PermissionRejectedError{Mode: mode, Reason: "managed policy", Err: errors.New("managed policy")}
}

// Once the context is done the fallback stops stepping down, so a cancelled spawn
// does not keep launching provider processes down the ladder.
func TestPermissionFallbackStopsWhenTheContextIsDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var attempts []ports.PermissionMode
	fallback := permissionFallback{enabled: true, log: slog.New(slog.DiscardHandler), session: "s", stage: "turn"}

	_, err := fallback.run(ctx, ports.PermissionModeBypassPermissions, func(mode ports.PermissionMode) error {
		attempts = append(attempts, mode)
		cancel()
		return rejection(mode)
	})

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v, want context.Canceled", err)
	}
	if want := []ports.PermissionMode{ports.PermissionModeBypassPermissions}; !reflect.DeepEqual(attempts, want) {
		t.Fatalf("attempts = %v, want %v: nothing may be tried after cancellation", attempts, want)
	}
}

// fakeSender is a provider conversation that only knows how to refuse or accept a
// turn by permission mode.
type fakeSender struct {
	ports.ChatConversation
	refuse map[ports.PermissionMode]bool
	modes  []ports.PermissionMode
}

func (f *fakeSender) SendTurn(_ context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	f.modes = append(f.modes, msg.Settings.Approval)
	if f.refuse[msg.Settings.Approval] {
		return ports.ChatTurnRef{}, rejection(msg.Settings.Approval)
	}
	return ports.ChatTurnRef{ProviderTurnID: "turn-1"}, nil
}

// A controller that replaces another (a branch switch, an edit, or restoring the
// source after a failed edit) must keep the settings the session was launched with.
// Losing them would silently turn a disabled fallback back on, and stop reporting
// the effective mode to the session record.
func TestReplacementControllerKeepsThePermissionFallbackSettings(t *testing.T) {
	service := &Service{
		log:   slog.New(slog.DiscardHandler),
		newID: func() string { return "id" },
		now:   func() time.Time { return time.Unix(0, 0) },
	}
	source := newController("s", domain.SessionConversationOwner("s"), domain.ConversationRecord{}, "gen-1",
		domain.HarnessCodex, &fakeSender{}, nil, nil, slog.New(slog.DiscardHandler), service.newID, service.now, nil, nil)

	t.Run("disabled stays disabled", func(t *testing.T) {
		source.permissionFallbackOff = true
		provider := &fakeSender{refuse: map[ports.PermissionMode]bool{ports.PermissionModeBypassPermissions: true}}
		replacement := service.newReplacementController("s", source, domain.ConversationRecord{}, "gen-2", provider)

		_, err := replacement.sendTurn(context.Background(), ports.ChatUserMessage{
			Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeBypassPermissions},
		})
		if !errors.Is(err, ports.ErrPermissionRejected) {
			t.Fatalf("sendTurn error = %v, want the rejection reported as is", err)
		}
		if want := []ports.PermissionMode{ports.PermissionModeBypassPermissions}; !reflect.DeepEqual(provider.modes, want) {
			t.Fatalf("modes tried = %v, want only %v: the replacement turned the fallback back on", provider.modes, want)
		}
	})

	t.Run("effective mode keeps reaching the session record", func(t *testing.T) {
		source.permissionFallbackOff = false
		var reported []ports.PermissionMode
		source.onPermissionsChanged = func(_ domain.SessionID, mode domain.PermissionMode) { reported = append(reported, mode) }
		provider := &fakeSender{refuse: map[ports.PermissionMode]bool{ports.PermissionModeBypassPermissions: true}}
		replacement := service.newReplacementController("s", source, domain.ConversationRecord{}, "gen-2", provider)
		replacement.store = noopSettingsStore{}
		replacement.settings.ApprovalMode = ports.PermissionModeBypassPermissions

		if _, err := replacement.sendTurn(context.Background(), ports.ChatUserMessage{
			Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeBypassPermissions},
		}); err != nil {
			t.Fatalf("sendTurn: %v", err)
		}
		if want := []ports.PermissionMode{ports.PermissionModeAuto}; !reflect.DeepEqual(reported, want) {
			t.Fatalf("reported modes = %v, want %v", reported, want)
		}
	})
}

// noopSettingsStore accepts the two writes a step-down makes; anything else would
// reach the embedded nil Store and fail the test loudly.
type noopSettingsStore struct{ Store }

func (noopSettingsStore) UpsertActivity(context.Context, string, string, domain.ConversationActivity, time.Time) error {
	return nil
}

func (noopSettingsStore) SetConversationSettings(context.Context, string, domain.ConversationSettings, time.Time) error {
	return nil
}

// A review controller never steps a turn down, even if its provider answered with a
// permission rejection: its sandbox is forced, so a lower mode changes nothing.
func TestReviewControllerTurnNeverStepsDown(t *testing.T) {
	provider := &fakeSender{refuse: map[ports.PermissionMode]bool{ports.PermissionModeBypassPermissions: true}}
	var reported []ports.PermissionMode
	controller := newController("s", domain.ReviewConversationOwner("review-1"), domain.ConversationRecord{}, "gen-1",
		domain.HarnessCodex, provider, nil, nil, slog.New(slog.DiscardHandler),
		func() string { return "id" }, func() time.Time { return time.Unix(0, 0) }, nil, nil)
	controller.onPermissionsChanged = func(_ domain.SessionID, mode domain.PermissionMode) { reported = append(reported, mode) }

	_, err := controller.sendTurn(context.Background(), ports.ChatUserMessage{
		Text: "go", Settings: ports.ChatTurnSettings{Approval: ports.PermissionModeBypassPermissions},
	})

	if !errors.Is(err, ports.ErrPermissionRejected) {
		t.Fatalf("sendTurn error = %v, want the rejection reported as is", err)
	}
	if want := []ports.PermissionMode{ports.PermissionModeBypassPermissions}; !reflect.DeepEqual(provider.modes, want) {
		t.Fatalf("modes tried = %v, want only %v for a review controller", provider.modes, want)
	}
	if len(reported) != 0 {
		t.Fatalf("a review controller reported session permissions %v", reported)
	}
}

// With nothing less permissive than the requested mode there is no ladder to walk, so
// the refusal is reported as it is. An "every permission mode was rejected" list with
// one entry would claim a fallback was tried when none was.
func TestRefusalWithNoLowerModeIsReportedAsIs(t *testing.T) {
	for _, requested := range []ports.PermissionMode{ports.PermissionModeAcceptEdits, ports.PermissionModeDefault} {
		t.Run(string(requested), func(t *testing.T) {
			var attempts []ports.PermissionMode
			fallback := permissionFallback{enabled: true, log: slog.New(slog.DiscardHandler), session: "s", stage: "turn"}

			_, err := fallback.run(context.Background(), requested, func(mode ports.PermissionMode) error {
				attempts = append(attempts, mode)
				return rejection(mode)
			})

			var exhausted *ports.PermissionFallbackExhaustedError
			if errors.As(err, &exhausted) {
				t.Fatalf("run reported %v as an exhausted ladder", err)
			}
			var refused *ports.PermissionRejectedError
			if !errors.As(err, &refused) || refused.Mode != requested {
				t.Fatalf("run error = %v, want the provider's refusal of %q", err, requested)
			}
			if want := []ports.PermissionMode{requested}; !reflect.DeepEqual(attempts, want) {
				t.Fatalf("attempts = %v, want %v", attempts, want)
			}
		})
	}
}

// The timeline notice is the user's only durable record of a step-down, and its
// provider item id is what makes republishing it idempotent, so each field is pinned.
func TestPermissionFallbackActivityRecordsTheStepDown(t *testing.T) {
	outcome := permissionFallbackOutcome{
		Effective: ports.PermissionModeAcceptEdits,
		Rejected: []ports.PermissionRejection{
			{Mode: ports.PermissionModeBypassPermissions, Reason: "no full access"},
			{Mode: ports.PermissionModeAuto, Reason: "no reviewer"},
		},
	}

	got := permissionFallbackActivity("id-7", ports.PermissionModeBypassPermissions, outcome)

	if got.ID != "id-7" || got.Kind != domain.ActivityKindSystem || got.Status != domain.ActivityStatusCompleted {
		t.Fatalf("activity identity = %q/%q/%q, want id-7 as a completed system activity", got.ID, got.Kind, got.Status)
	}
	if want := "Permission mode lowered from bypass-permissions to accept-edits"; got.Summary != want {
		t.Fatalf("summary = %q, want %q", got.Summary, want)
	}
	if want := "ao-permission-fallback-id-7"; got.ProviderItemID != want {
		t.Fatalf("provider item id = %q, want %q", got.ProviderItemID, want)
	}
	var detail struct {
		Event     string `json:"event"`
		Requested string `json:"requested"`
		Effective string `json:"effective"`
		Rejected  []struct {
			Mode   string `json:"mode"`
			Reason string `json:"reason"`
		} `json:"rejected"`
	}
	if err := json.Unmarshal(got.Detail, &detail); err != nil {
		t.Fatalf("detail is not JSON: %v", err)
	}
	if detail.Event != "permission.fallback" || detail.Requested != "bypass-permissions" || detail.Effective != "accept-edits" {
		t.Fatalf("detail = %+v", detail)
	}
	if len(detail.Rejected) != 2 ||
		detail.Rejected[0].Mode != "bypass-permissions" || detail.Rejected[0].Reason != "no full access" ||
		detail.Rejected[1].Mode != "auto" || detail.Rejected[1].Reason != "no reviewer" {
		t.Fatalf("rejected = %+v, want both refusals in the order they happened", detail.Rejected)
	}
}

// The reason shown to the user is the provider's own words, not the typed error's
// framing of them, and a failure that is not a typed refusal reads as itself.
func TestRejectionReasonIsTheProvidersOwnWords(t *testing.T) {
	typed := &ports.PermissionRejectedError{Mode: ports.PermissionModeAuto, Reason: "not in the allowed set"}
	for name, err := range map[string]error{
		"typed":   typed,
		"wrapped": fmt.Errorf("turn/start: %w", typed),
	} {
		if got := rejectionReason(err); got != "not in the allowed set" {
			t.Errorf("%s: reason = %q, want the provider's verbatim reason", name, got)
		}
	}
	if got := rejectionReason(errors.New("plain failure")); got != "plain failure" {
		t.Errorf("a plain error's reason = %q, want its own text", got)
	}
}

func TestRejectedModesKeepsTheOrderTheyWereRefusedIn(t *testing.T) {
	got := rejectedModes([]ports.PermissionRejection{
		{Mode: ports.PermissionModeBypassPermissions}, {Mode: ports.PermissionModeAuto},
	})
	want := []ports.PermissionMode{ports.PermissionModeBypassPermissions, ports.PermissionModeAuto}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rejectedModes = %v, want %v", got, want)
	}
}
