package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type factoryInputStore struct {
	*fakeStore
	held map[domain.SessionID]bool
	err  error
}

func (s *factoryInputStore) FactoryFeedbackHeld(_ context.Context, id domain.SessionID) (bool, error) {
	return s.held[id], s.err
}

type factoryInputLibrary struct {
	LibrarySelection
	admit    func()
	releases int
}

func (l *factoryInputLibrary) AcquireTaskInput(domain.SessionID) (func(), bool) {
	l.admit()
	return func() { l.releases++ }, true
}

func TestFactoryRawInputHoldsEnrolledParticipants(t *testing.T) {
	m := newInputLeaseTestManager()
	st := &factoryInputStore{fakeStore: newFakeStore(), held: map[domain.SessionID]bool{"worker": true, "recipient": true}}
	m.store = st
	for _, id := range []domain.SessionID{"worker", "recipient"} {
		if release, ok := m.AcquireSessionInput(id); ok || release != nil {
			t.Fatalf("raw input admitted for %s", id)
		}
	}
	release, ok := m.AcquireSessionInput("unrelated")
	if !ok {
		t.Fatal("unrelated session held")
	}
	release()
	release()
	st.err = errors.New("policy unavailable")
	if _, ok := m.AcquireSessionInput("unrelated"); ok {
		t.Fatal("unreadable policy allowed a PTY write")
	}
	if len(m.inputLeases) != 0 {
		t.Fatal("refused raw input leaked a lease")
	}
}

func TestFactoryRawInputRechecksEnrollmentAfterAdmission(t *testing.T) {
	m := newInputLeaseTestManager()
	st := &factoryInputStore{fakeStore: newFakeStore(), held: map[domain.SessionID]bool{}}
	m.store = st
	library := &factoryInputLibrary{admit: func() { st.held["worker"] = true }}
	m.SetLibrarySelection(library)
	if _, ok := m.AcquireSessionInput("worker"); ok {
		t.Fatal("enrollment during library admission reached PTY input")
	}
	if library.releases != 1 || len(m.inputLeases) != 0 {
		t.Fatal("held input leaked admission")
	}
}
