package review

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type factoryHeldReviewStore struct {
	*fakeStore
	held atomic.Bool
}

func (s *factoryHeldReviewStore) FactoryFeedbackHeld(_ context.Context, id domain.SessionID) (bool, error) {
	return id == liveWorker().ID && s.held.Load(), nil
}

type factoryEnrollmentLauncher struct {
	*fakeLauncher
	onPreflight func()
	onAlive     func()
}

func (l *factoryEnrollmentLauncher) Preflight(ctx context.Context, harness domain.ReviewerHarness, workspace string, mode ...domain.ReviewerInterfaceMode) error {
	if l.onPreflight != nil {
		l.onPreflight()
	}
	return l.fakeLauncher.Preflight(ctx, harness, workspace, mode...)
}

func (l *factoryEnrollmentLauncher) Alive(ctx context.Context, handle, launch string) (bool, error) {
	if l.onAlive != nil {
		l.onAlive()
	}
	return l.fakeLauncher.Alive(ctx, handle, launch)
}

func factoryReviewFixture(reuse bool) (*factoryHeldReviewStore, *fakeLauncher) {
	store := &factoryHeldReviewStore{fakeStore: &fakeStore{}}
	launcher := &fakeLauncher{handle: "review-mer-1", alive: reuse}
	if reuse {
		store.review = &domain.Review{ID: "rev-1", SessionID: "mer-1", Harness: domain.ReviewerClaudeCode,
			InterfaceMode: domain.ReviewerInterfaceTUI, ReviewerHandleID: launcher.handle, AgentSessionID: "native-1"}
	}
	return store, launcher
}

// These calls use the real engine, including its recovery gate and worker lock.
// Both fresh TUI launches and notifications must observe enrollment after waiting.
func TestTriggerFactoryEnrollmentDuringEngineWaits(t *testing.T) {
	for _, source := range []domain.ReviewTriggerSource{domain.ReviewTriggerAgent, domain.ReviewTriggerAuto, domain.ReviewTriggerManual} {
		for _, wait := range []string{"startup_recovery", "worker_lock"} {
			for _, operation := range []string{"spawn", "notify"} {
				t.Run(string(source)+"/"+wait+"/"+operation, func(t *testing.T) {
					store, launcher := factoryReviewFixture(operation == "notify")
					eng := newEngineForTest(store, fakeSessions{rec: liveWorker(), ok: true}, prAt("sha1"), fakeProjects{}, launcher)
					var release func()
					if wait == "startup_recovery" {
						recovered := make(chan struct{})
						eng.chatRecoveryDone = recovered
						release = func() { close(recovered) }
					} else {
						release = eng.lockWorker("mer-1")
					}
					started := make(chan struct{})
					result := make(chan error, 1)
					go func() {
						close(started)
						_, err := eng.TriggerWithOptions(context.Background(), "mer-1", TriggerOptions{Source: source})
						result <- err
					}()
					<-started
					select {
					case err := <-result:
						release()
						t.Fatalf("trigger passed the engine wait: %v", err)
					case <-time.After(25 * time.Millisecond):
					}
					store.held.Store(true)
					release()
					select {
					case err := <-result:
						if !errors.Is(err, domain.ErrFactoryFeedbackHeld) {
							t.Fatalf("trigger after enrollment = %v, want factory hold", err)
						}
					case <-time.After(5 * time.Second):
						t.Fatal("trigger did not finish after releasing the engine wait")
					}
					if launcher.spawned || launcher.notified || launcher.destroyed {
						t.Fatalf("held trigger changed reviewer execution: %+v", launcher)
					}
					if len(store.runs) != 1 || store.runs[0].Status != domain.ReviewRunFailed {
						t.Fatalf("held trigger left a running claim: %+v", store.runs)
					}
				})
			}
		}
	}
}

// Enrollment can also happen after the engine waits, during launcher I/O.
// These regressions require checks immediately before Spawn and Notify.
func TestTriggerFactoryEnrollmentAtExecutionBoundaries(t *testing.T) {
	for _, operation := range []string{"spawn", "notify"} {
		t.Run(operation, func(t *testing.T) {
			store, base := factoryReviewFixture(operation == "notify")
			launcher := &factoryEnrollmentLauncher{fakeLauncher: base}
			enroll := func() { store.held.Store(true) }
			if operation == "spawn" {
				launcher.onPreflight = enroll
			} else {
				launcher.onAlive = enroll
			}
			eng := newEngineForTest(store, fakeSessions{rec: liveWorker(), ok: true}, prAt("sha1"), fakeProjects{}, launcher)
			_, err := eng.TriggerWithOptions(context.Background(), "mer-1", TriggerOptions{Source: domain.ReviewTriggerAgent})
			if !errors.Is(err, domain.ErrFactoryFeedbackHeld) || base.spawned || base.notified || base.destroyed {
				t.Fatalf("enrollment at %s: err=%v launcher=%+v", operation, err, base)
			}
			if len(store.runs) != 1 || store.runs[0].Status != domain.ReviewRunFailed {
				t.Fatalf("held trigger left a running claim: %+v", store.runs)
			}
		})
	}
}

func TestTriggerFactoryEnrollmentBeforeDeferredNotification(t *testing.T) {
	old := domain.Review{ID: "rev-1", SessionID: "mer-1", Harness: domain.ReviewerCodex,
		ReviewerHandleID: "chat-pane", AgentSessionID: "conv-1", InterfaceMode: domain.ReviewerInterfaceChat,
		ProviderConversationID: "conv-1", ControllerGeneration: "generation-1"}
	store := &factoryHeldReviewStore{fakeStore: &fakeStore{review: &old, reviews: map[domain.ReviewerHarness]domain.Review{domain.ReviewerCodex: old},
		runs: []domain.ReviewRun{{ID: "run-1", ReviewID: old.ID, SessionID: "mer-1", Harness: domain.ReviewerCodex,
			PRURL: "https://github.com/o/r/pull/1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}}}
	launcher := &fakeLauncher{interfaceMode: domain.ReviewerInterfaceChat, alive: true, handle: "replacement-pane",
		onSpawn: func(LaunchSpec) { store.held.Store(true) }}
	eng := newEngineForTest(store, fakeSessions{rec: liveWorker(), ok: true}, prAt("sha1"), fakeProjects{}, launcher)
	_, err := eng.TriggerWithOptions(context.Background(), "mer-1", TriggerOptions{Harness: domain.ReviewerCodex, InterfaceMode: domain.ReviewerInterfaceTUI})
	if !errors.Is(err, domain.ErrFactoryFeedbackHeld) || !launcher.spawned || !launcher.gotSpec.DeferInitialMessage || launcher.notified {
		t.Fatalf("deferred notification after enrollment: err=%v launcher=%+v", err, launcher)
	}
	if launcher.destroyCalls != 2 || launcher.destroyedHandle != "replacement-pane" || store.runs[0].Status != domain.ReviewRunFailed {
		t.Fatalf("replacement cleanup or run failure missing: launcher=%+v runs=%+v", launcher, store.runs)
	}
}
