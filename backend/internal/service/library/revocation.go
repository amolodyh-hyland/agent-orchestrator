package library

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type libraryAffectedSessions interface {
	ListLibrarySessionsByApproval(context.Context, string) ([]domain.SessionID, error)
}

func (s *Service) SetTaskLibraryLifecycle(lifecycle ports.TaskLibraryLifecycle) {
	s.revokeMu.Lock()
	defer s.revokeMu.Unlock()
	s.lifecycle = lifecycle
}

func (s *Service) revokeRuntimes(ctx context.Context, in Operation) (Result, error) {
	s.revokeMu.Lock()
	defer s.revokeMu.Unlock()
	s.revoking.Store(in.ApprovalID)
	defer s.revoking.Store("")
	store, ok := s.store.(libraryAffectedSessions)
	if !ok {
		return Result{}, fail("runtime_inventory_unavailable")
	}
	// Authorize before closing terminals, including stale-revision and managed-lock refusals.
	state, err := s.store.ReadLibraryRegistry(ctx)
	if err != nil {
		return Result{}, err
	}
	if state.Revision != in.ExpectedRevision {
		return Result{}, fail("revision_conflict")
	}
	p, _, err := s.operationPolicy(ctx, state, in)
	if err != nil {
		return Result{}, err
	}
	approval := state.Approvals[in.ApprovalID]
	source, ok := state.Sources[approval.SourceID]
	if !ok {
		return Result{}, fail("missing_source")
	}
	if source.Source.Scope == "managed" {
		return Result{}, fail("managed_lock")
	}
	for _, lock := range p.Locks {
		for _, e := range approval.Entries {
			if lock.SourceID == approval.SourceID && lock.EntryID == e.EntryID {
				return Result{}, fail("managed_lock")
			}
		}
	}
	ids, err := store.ListLibrarySessionsByApproval(ctx, in.ApprovalID)
	if err != nil {
		return Result{}, err
	}
	var releases []func()
	committed := false
	fenced := map[domain.SessionID]bool{}
	defer func() {
		if !committed {
			for _, release := range releases {
				if release != nil {
					release()
				}
			}
		}
	}()
	if s.lifecycle != nil {
		for _, id := range ids {
			release, err := s.lifecycle.FenceLibraryInput(ctx, id)
			if err != nil {
				return Result{}, fail("runtime_input_fence_failed")
			}
			releases = append(releases, release)
			fenced[id] = true
		}
	}
	result, err := s.operate(ctx, in)
	if err != nil {
		return result, err
	}
	committed = true
	// Commit revocation even if stopping fails. Admission stays closed from the durable ledger.
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	ids, err = store.ListLibrarySessionsByApproval(stopCtx, in.ApprovalID)
	if err != nil {
		return result, fail("runtime_inventory_unavailable")
	}
	failed := false
	for _, id := range ids {
		rec, found, e := s.store.GetSession(stopCtx, id)
		if e != nil {
			failed = true
			continue
		}
		if !found || rec.IsTerminated {
			continue
		}
		if rec.Metadata.RuntimeHandleID == "" && rec.Metadata.ProviderConversationID == "" {
			continue
		}
		if s.lifecycle == nil {
			failed = true
			continue
		}
		if !fenced[id] {
			if _, e = s.lifecycle.FenceLibraryInput(stopCtx, id); e != nil {
				failed = true
			}
		}
		if e = s.lifecycle.StopLibraryRuntime(stopCtx, id); e != nil {
			failed = true
		}
	}
	if failed {
		_ = s.store.RecordLibraryAudit(stopCtx, domain.LibraryAudit{ActorID: s.owner, Purpose: "revoke_runtime", Outcome: "denied", ReasonCode: "runtime_stop_failed", TrustEpoch: result.TrustEpoch})
		result.Status, result.ReasonCode = "unavailable", "runtime_stop_failed"
		return result, fail("runtime_stop_failed")
	}
	return result, nil
}

func (s *Service) selectionRevoking(snapshot domain.LibrarySnapshot) bool {
	id, _ := s.revoking.Load().(string)
	if id == "" {
		return false
	}
	for _, e := range snapshot.Entries {
		if e.ApprovalID == id {
			return true
		}
	}
	return false
}

func (s *Service) sessionRevoking(ctx context.Context, id domain.SessionID) bool {
	approval, _ := s.revoking.Load().(string)
	if approval == "" {
		return false
	}
	store, ok := s.store.(snapshotStore)
	if !ok {
		return true
	}
	snapshot, _, err := store.GetLibrarySnapshot(ctx, id)
	return err != nil || s.selectionRevoking(snapshot)
}
