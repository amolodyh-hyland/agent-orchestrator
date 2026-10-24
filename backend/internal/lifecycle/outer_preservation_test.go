package lifecycle

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type outerPreservingStore struct{ *fakeStore }

func (*outerPreservingStore) IsOuterParticipant(context.Context, domain.SessionID) (bool, error) {
	return true, nil
}

func TestOuterM2TerminationRetainsContainersAcrossRepeatedObservation(t *testing.T) {
	reaper := &fakeLifecycleContainerReaper{removed: 2}
	st := newFakeStore()
	st.sessions["mer-1"] = working("mer-1")
	m := New(&outerPreservingStore{st}, &fakeMessenger{}, WithContainerReaper(reaper, nil))
	for range 2 {
		if err := m.MarkTerminated(context.Background(), "mer-1"); err != nil {
			t.Fatal(err)
		}
	}
	if len(reaper.sessions) != 0 {
		t.Fatal("preserving stop reaped containers", reaper.sessions)
	}
}
