package library

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Admission reports the protected session input boundary and stop requirements.
type Admission struct {
	SessionID           domain.SessionID `json:"sessionId"`
	SnapshotID          string           `json:"snapshotId,omitempty"`
	State               string           `json:"state"`
	ReasonCode          string           `json:"reasonCode"`
	InputAllowed        bool             `json:"inputAllowed"`
	StopRequired        bool             `json:"stopRequired"`
	ReplacementRequired bool             `json:"replacementRequired"`
	MidTurnBoundary     string           `json:"midTurnBoundary"`
	TrustEpoch          int64            `json:"trustEpoch"`
}

func (s *Service) retained(ctx context.Context, id domain.SessionID) (domain.LibrarySnapshot, Admission, error) {
	admission := Admission{SessionID: id, State: "legacy_no_library", ReasonCode: "no_library_selection", InputAllowed: true, MidTurnBoundary: "not_enforceable"}
	store, ok := s.store.(snapshotStore)
	if !ok {
		return domain.LibrarySnapshot{}, admission, fail("snapshot_store_unavailable")
	}
	snapshot, found, err := store.GetLibrarySnapshot(ctx, id)
	if err != nil {
		return snapshot, admission, err
	}
	if !found {
		return snapshot, admission, nil
	}
	admission.SnapshotID = snapshot.SnapshotID
	if len(snapshot.Entries) == 0 {
		return snapshot, admission, nil
	}
	admission.State = "input_open"
	admission.ReasonCode = "retained_selection"
	state, err := s.store.ReadLibraryRegistry(ctx)
	if err != nil {
		return snapshot, admission, err
	}
	admission.TrustEpoch = state.TrustEpoch
	p, _, err := s.check(ctx, PolicyRequest{Operation: "retained_selection", ProjectID: snapshot.ProjectID})
	why := ""
	if err != nil {
		why = reason(err)
	}
	if why == "" {
		for _, entry := range snapshot.Entries {
			if entry.ApprovalID == "" {
				continue
			}
			a, ok := state.Approvals[entry.ApprovalID]
			if !ok || a.State != "approved" {
				why = "revoked"
				break
			}
			if a.ActorID != s.owner || a.AuthorityID != s.authority || a.SourceID != entry.Entry.SourceID || a.RootIdentity != entry.RootIdentity {
				why = "approval_mismatch"
				break
			}
			source, ok := state.Sources[a.SourceID]
			if !ok || source.Source.OwnerID != s.owner || source.Source.LibraryRootIdentity != a.RootIdentity {
				why = "root_identity_changed"
				break
			}
			if a.ExpiresAt != "" {
				expires, err := time.Parse("2006-01-02T15:04:05.000Z", a.ExpiresAt)
				if err != nil || !s.clock().Before(expires) {
					why = "approval_expired"
					break
				}
			}
			matched := false
			for _, selected := range a.Entries {
				matched = matched || selected.EntryID == entry.Entry.EntryID && selected.ContentHash == entry.Entry.ContentHash
			}
			if !matched {
				why = "approval_mismatch"
				break
			}
			if source.Source.Scope == "managed" && !managedAllowed(p, source) {
				why = "managed_lock"
				break
			}
			if _, _, err := s.check(ctx, PolicyRequest{Operation: "retained_entry", ProjectID: snapshot.ProjectID, SourceID: a.SourceID, EntryID: entry.Entry.EntryID}); err != nil {
				why = reason(err)
				break
			}
		}
	}
	if why == "" {
		if err := s.validateRetainedBudget(ctx, snapshot, p); err != nil {
			why = reason(err)
		}
	}
	if why != "" {
		admission.InputAllowed = false
		admission.StopRequired = true
		admission.ReplacementRequired = true
		admission.State = "input_closed_stop_or_replace_required"
		admission.ReasonCode = why
		if rec, found, err := s.store.GetSession(ctx, id); err == nil && found && rec.IsTerminated {
			admission.State = "stopped_replacement_required"
			admission.StopRequired = false
		}
	}
	return snapshot, admission, nil
}

func (s *Service) validateRetainedBudget(ctx context.Context, snapshot domain.LibrarySnapshot, p PolicyDecision) error {
	store, ok := s.store.(snapshotStore)
	if !ok {
		return fail("snapshot_store_unavailable")
	}
	parent, found, err := store.GetProjectContextSnapshot(ctx, snapshot.SessionID)
	if err != nil {
		return err
	}
	if !found {
		return fail("context_snapshot_missing")
	}
	return validateAggregateBudget(parent, snapshot, p)
}

// CheckLaunch rechecks retained trust and refuses unproved required runtime bindings.
func (s *Service) CheckLaunch(ctx context.Context, id domain.SessionID) error {
	s.admission.RLock()
	defer s.admission.RUnlock()
	snapshot, admission, err := s.retained(ctx, id)
	if err != nil {
		return err
	}
	outcome, why := "allowed", "retained_selection"
	if !admission.InputAllowed {
		outcome = "denied"
		why = admission.ReasonCode
	}
	if outcome == "allowed" {
		for _, entry := range snapshot.Entries {
			if entry.Required {
				outcome = "denied"
				why = entry.ReasonCode
				break
			}
		}
	}
	if len(snapshot.Entries) > 0 {
		p, _, _ := s.check(ctx, PolicyRequest{Operation: "launch", ProjectID: snapshot.ProjectID})
		if auditErr := s.store.RecordLibraryAudit(ctx, domain.LibraryAudit{ActorID: s.owner, Purpose: "launch_or_resume", Outcome: outcome, ReasonCode: why, PolicyRevision: p.Revision, TrustEpoch: admission.TrustEpoch}); auditErr != nil {
			return auditErr
		}
	}
	if outcome == "denied" {
		return fail(why)
	}
	return nil
}

// AcquireTaskInput leases session-wide admission for raw terminal bytes.
func (s *Service) AcquireTaskInput(id domain.SessionID) (func(), bool) {
	s.admission.RLock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, admission, err := s.retained(ctx, id)
	if err != nil || !admission.InputAllowed {
		s.admission.RUnlock()
		return nil, false
	}
	var once sync.Once
	return func() { once.Do(s.admission.RUnlock) }, true
}

// AcquireChatInput validates controlled dispatch and holds trust stable through submission.
func (s *Service) AcquireChatInput(ctx context.Context, id domain.SessionID, text string) (func(), error) {
	s.admission.RLock()
	snapshot, admission, err := s.retained(ctx, id)
	if err == nil && !admission.InputAllowed {
		err = fail(admission.ReasonCode)
	}
	if err == nil {
		for _, entry := range snapshot.Entries {
			name := entry.Entry.DisplayName
			for _, word := range strings.Fields(text) {
				if word == "/"+name || word == "$"+name {
					err = fail("unsupported_provider")
					break
				}
			}
			if err != nil {
				break
			}
		}
	}
	if err != nil {
		s.admission.RUnlock()
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(s.admission.RUnlock) }, nil
}

func (s *Service) sessionView(ctx context.Context, id domain.SessionID, warnings []string) (Result, error) {
	if _, found, err := s.store.GetSession(ctx, id); err != nil {
		return Result{}, err
	} else if !found {
		return Result{}, fail("session_missing")
	}
	s.admission.RLock()
	defer s.admission.RUnlock()
	snapshot, admission, err := s.retained(ctx, id)
	if err != nil {
		return Result{}, err
	}
	state, err := s.store.ReadLibraryRegistry(ctx)
	if err != nil {
		return Result{}, err
	}
	result := s.view(state, warnings)
	result.Admission = &admission
	if snapshot.SnapshotID != "" {
		result.Snapshot = &snapshot
	}
	for _, entry := range snapshot.Entries {
		status, why := entry.Status, entry.ReasonCode
		if !admission.InputAllowed {
			status = "revoked"
			why = admission.ReasonCode
		}
		result.RuntimeBindings = append(result.RuntimeBindings, domain.LibraryRuntimeBinding{SessionID: id, SnapshotID: snapshot.SnapshotID, EntryID: entry.Entry.EntryID, ContentHash: entry.Entry.ContentHash, ProviderID: snapshot.ProviderID, AdapterID: snapshot.AdapterID, AdapterVersion: snapshot.AdapterVersion, TrustEpoch: state.TrustEpoch, Status: status, ReasonCode: why, CanInvoke: false})
	}
	return result, nil
}
