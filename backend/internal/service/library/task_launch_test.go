package library

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type taskLifecycleFixture struct {
	fence        func(domain.SessionID) error
	stop         func(domain.SessionID) error
	releaseFence func()
}

func (f taskLifecycleFixture) FenceLibraryInput(_ context.Context, id domain.SessionID) (func(), error) {
	release := f.releaseFence
	if release == nil {
		release = func() {}
	}
	if f.fence != nil {
		return release, f.fence(id)
	}
	return release, nil
}
func (f taskLifecycleFixture) StopLibraryRuntime(_ context.Context, id domain.SessionID) error {
	if f.stop != nil {
		return f.stop(id)
	}
	return nil
}

func pinnedTaskFixture(t *testing.T) (*fixture, domain.SessionRecord) {
	t.Helper()
	f := newFixture(t, "claude-skills")
	f.write("review/SKILL.md", "---\nname: review\n---\nReview\n")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	rec.Metadata.RuntimeHandleID = "fake-runtime"
	if err := f.store.UpdateSession(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	return f, rec
}
func TestTaskLibraryRevocationStopsImplicitRuntimeWithoutInput(t *testing.T) {
	for _, stopFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "stopped", true: "stop_failed"}[stopFails], func(t *testing.T) {
			f, rec := pinnedTaskFixture(t)
			var events []string
			f.svc.SetTaskLibraryLifecycle(taskLifecycleFixture{fence: func(id domain.SessionID) error { events = append(events, "fence"); return nil }, stop: func(id domain.SessionID) error {
				events = append(events, "stop")
				if release, ok := f.svc.AcquireTaskInput(id); ok {
					release()
					t.Fatal("input open during runtime stop")
				}
				if stopFails {
					return errors.New("fake stop failure")
				}
				rec.IsTerminated = true
				return f.store.UpdateSession(context.Background(), rec)
			}})
			result, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
			if stopFails {
				if reason(err) != "runtime_stop_failed" || result.ReasonCode != "runtime_stop_failed" {
					t.Fatalf("%+v %v", result, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if len(events) < 2 || events[0] != "fence" || events[len(events)-1] != "stop" {
				t.Fatal(events)
			}
			if err := f.svc.CheckLaunch(context.Background(), rec.ID); reason(err) != "revoked" {
				t.Fatal(err)
			}
			if _, _, release, err := f.svc.AcquireTaskLaunch(context.Background(), rec.ID); err == nil {
				release()
				t.Fatal("revoked resume allowed")
			}
			view, err := f.svc.Operate(context.Background(), Operation{Operation: "session", SessionID: rec.ID})
			if err != nil || view.Admission.InputAllowed || view.Admission.StopRequired != stopFails || !view.Admission.ReplacementRequired {
				t.Fatalf("%+v %v", view.Admission, err)
			}
		})
	}
}
func TestTaskLibraryRevocationDrainsLeasedStartupAndDeniesRacingInput(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	leaseCtx, snapshot, release, err := f.svc.AcquireTaskLaunch(context.Background(), rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	fenced := make(chan struct{}, 2)
	stopped := make(chan struct{}, 1)
	f.svc.SetTaskLibraryLifecycle(taskLifecycleFixture{fence: func(domain.SessionID) error { fenced <- struct{}{}; return nil }, stop: func(domain.SessionID) error { stopped <- struct{}{}; return nil }})
	done := make(chan error, 1)
	go func() {
		_, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
		done <- err
	}()
	select {
	case <-fenced:
	case <-time.After(time.Second):
		t.Fatal("fence missing")
	}
	if _, ok := f.svc.AcquireTaskInput(rec.ID); ok {
		t.Fatal("racing terminal input admitted")
	}
	// A nested startup operation uses the held lease rather than deadlocking behind the revocation writer.
	if _, again, nestedRelease, err := f.svc.AcquireTaskLaunch(leaseCtx, rec.ID); err != nil || again.SnapshotDigest != snapshot.SnapshotDigest {
		t.Fatal(err)
	} else {
		nestedRelease()
	}
	select {
	case <-stopped:
		t.Fatal("stop overtook launch handle publication")
	default:
	}
	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("revoke did not drain")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("implicit runtime not stopped")
	}
}
func TestTaskLibraryRetainedSourceMutationAndScope(t *testing.T) {
	for _, test := range []struct {
		role    domain.ProjectContextRole
		channel domain.SessionMode
		want    int
	}{{domain.ProjectContextRoleWorker, domain.SessionModeTUI, 1}, {domain.ProjectContextRoleCoordinator, domain.SessionModeTUI, 0}, {domain.ProjectContextRoleWorker, domain.SessionModeChat, 1}} {
		f := newFixture(t, "rules")
		f.write("guide.md", "original\n")
		f.inspect()
		f.approve()
		rec, parent, project := f.session("planning")
		parent.Role, parent.Channel = test.role, test.channel
		rec.Mode = test.channel
		if test.role == domain.ProjectContextRoleCoordinator {
			rec.Kind = domain.KindOrchestrator
		}
		rec.ID = ""
		var createErr error
		rec, createErr = f.store.CreateSession(context.Background(), rec)
		if createErr != nil {
			t.Fatal(createErr)
		}
		parent.SessionID = rec.ID
		parent.Digest, _ = parent.ComputeDigest()
		f.bindEntry("planning", "", false, domain.ProjectContextRoleWorker)
		if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
			t.Fatal(err)
		}
		f.write("guide.md", "changed source\n")
		_, snapshot, release, err := f.svc.AcquireTaskLaunch(context.Background(), rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		release()
		if len(snapshot.Entries) != test.want {
			t.Fatalf("scope leak: %+v", snapshot)
		}
		if test.want > 0 && snapshot.Entries[0].Content["guide.md"] != "original\n" {
			t.Fatal("resume reread external bytes")
		}
	}
}

func TestTaskLibraryRevocationDiscardsBufferedLeaseBeforeCommit(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	bufferedRelease, ok := f.svc.AcquireTaskInput(rec.ID)
	if !ok {
		t.Fatal("initial lease refused")
	}
	f.svc.SetTaskLibraryLifecycle(taskLifecycleFixture{fence: func(id domain.SessionID) error { bufferedRelease(); return nil }, stop: func(id domain.SessionID) error { return nil }})
	_, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if release, ok := f.svc.AcquireTaskInput(rec.ID); ok {
		release()
		t.Fatal("revoked buffered runtime reopened")
	}
}

func TestTaskLibraryReleasedLaunchContextCannotBypassRevocation(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	ctx, _, release, err := f.svc.AcquireTaskLaunch(context.Background(), rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	release()
	f.svc.SetTaskLibraryLifecycle(taskLifecycleFixture{})
	if _, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, _, release, err := f.svc.AcquireTaskLaunch(ctx, rec.ID); err == nil {
		release()
		t.Fatal("released launch context bypassed ledger")
	}
	if err := f.svc.CheckLaunch(ctx, rec.ID); reason(err) != "revoked" {
		t.Fatal(err)
	}
}

func TestTaskLibraryDeniedRevocationReleasesPrecommitFence(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	released, stopped := false, false
	f.svc.SetTaskLibraryLifecycle(taskLifecycleFixture{releaseFence: func() { released = true }, stop: func(domain.SessionID) error { stopped = true; return nil }})
	checks := 0
	f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
		checks++
		return PolicyDecision{State: "verified", Denied: checks > 1}, nil
	})
	_, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
	if reason(err) != "policy_denied" || !released || stopped {
		t.Fatalf("err=%v released=%v stopped=%v", err, released, stopped)
	}
	f.svc.policy = nil
	if release, ok := f.svc.AcquireTaskInput(rec.ID); !ok {
		t.Fatal("denied mutation left admission closed")
	} else {
		release()
	}
}
