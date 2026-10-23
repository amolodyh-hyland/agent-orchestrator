package library

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// operationPolicy resolves selectors from the records the mutation actually uses.
// Optional envelope fields cannot change the resource presented to managed policy.
// It runs before inspection and again against the transaction's current registry.
func (s *Service) operationPolicy(ctx context.Context, state domain.LibraryRegistry, in Operation) (PolicyDecision, []string, error) {
	request := PolicyRequest{Operation: in.Operation, SourceID: in.SourceID}
	var entries []domain.LibrarySelectedEntry
	switch in.Operation {
	case "bind", "detach_binding":
		var binding domain.LibraryBinding
		if in.Operation == "bind" {
			if in.Binding == nil {
				return PolicyDecision{}, nil, fail("invalid_binding")
			}
			binding = *in.Binding
		} else {
			var ok bool
			binding, ok = state.Bindings[in.BindingID]
			if !ok || binding.OwnerID != s.owner {
				return PolicyDecision{}, nil, fail("owner_mismatch")
			}
		}
		request.SourceID, request.EntryID, request.ProjectID = binding.SourceID, binding.EntryID, binding.ProjectID
	case "revoke":
		approval, ok := state.Approvals[in.ApprovalID]
		if !ok {
			return PolicyDecision{}, nil, fail("approval_missing")
		}
		if approval.ActorID != s.owner {
			return PolicyDecision{}, nil, fail("owner_mismatch")
		}
		request.SourceID, entries = approval.SourceID, approval.Entries
	case "approve":
		entries = in.Entries
	}
	if len(entries) == 0 {
		return s.check(ctx, request)
	}
	var combined PolicyDecision
	var warnings []string
	for index, entry := range entries {
		request.EntryID = entry.EntryID
		p, w, err := s.check(ctx, request)
		if err != nil {
			return p, w, err
		}
		if index == 0 {
			combined = p
		} else {
			if combined.Revision != p.Revision {
				return p, w, fail("policy_changed")
			}
			combined.Locks = append(combined.Locks, p.Locks...)
		}
		warnings = append(warnings, w...)
	}
	return combined, warnings, nil
}
