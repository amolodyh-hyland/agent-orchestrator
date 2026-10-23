package chat

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// LibraryAdmission guards controlled chat submissions against current library trust.
type LibraryAdmission interface {
	AcquireChatInput(context.Context, domain.SessionID, string) (func(), error)
}

// SetLibraryAdmission wires the daemon-owned trust boundary into controlled dispatch.
func (s *Service) SetLibraryAdmission(admission LibraryAdmission) {
	s.mu.Lock()
	s.libraryAdmission = admission
	s.mu.Unlock()
}
func (s *Service) acquireLibraryInput(ctx context.Context, id domain.SessionID, text string) (func(), error) {
	s.mu.RLock()
	admission := s.libraryAdmission
	s.mu.RUnlock()
	if admission == nil {
		return func() {}, nil
	}
	return admission.AcquireChatInput(ctx, id, text)
}
func (c *Controller) acquireLibraryInput(ctx context.Context, text string) (func(), error) {
	if c.libraryInput == nil {
		return func() {}, nil
	}
	return c.libraryInput(ctx, c.sessionID, text)
}

// startLibraryDeferredTurn revalidates after preparation and durable binding. The
// lease covers the actual provider dispatch, so revocation either precedes this
// check or waits until the start has completed.
func startLibraryDeferredTurn(ctx context.Context, deferred ports.ChatDeferredTurnStarter, id, text string, acquire func(context.Context, string) (func(), error)) error {
	release, err := acquire(ctx, text)
	if err == nil {
		err = deferred.StartDeferredTurn(id)
		release()
	}
	if err != nil {
		deferred.DiscardDeferredTurn(id)
	}
	return err
}
