package store

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ResolveSessionInput resolves persisted terminal ownership without trusting a
// handle's spelling. Missing or conflicting mappings never authorize input.
func (s *Store) ResolveSessionInput(ctx context.Context, handle string) (domain.SessionID, bool, error) {
	if handle == "" {
		return "", false, nil
	}
	owners, err := s.qr.SessionInputOwners(ctx, domain.SessionID(handle))
	if err != nil {
		return "", false, err
	}
	if len(owners) != 1 {
		return "", false, nil
	}
	owner := owners[0]
	if owner.OwnerID != "" {
		return owner.OwnerID, true, nil
	}
	// Project-only shells cannot prove an independent execution target. Hold
	// them while that project is enrolled; unscoped trusted shells stay usable.
	if owner.ProjectID != nil && *owner.ProjectID != "" {
		runs, err := s.ApprovedFactoryRunPage(ctx, string(*owner.ProjectID), "", 1)
		if err != nil {
			return "", false, err
		}
		if len(runs) != 0 {
			return "", false, nil
		}
	}
	return domain.SessionID(handle), true, nil
}
