package library

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type snapshotStore interface {
	CreateLibrarySessionSelection(context.Context, domain.ProjectContextManifest, domain.LibrarySnapshot, int64) (bool, error)
	GetLibrarySnapshot(context.Context, domain.SessionID) (domain.LibrarySnapshot, bool, error)
	GetProjectContextSnapshot(context.Context, domain.SessionID) (domain.ProjectContextManifest, bool, error)
}

// Pin stores approved immutable bytes together with their Project context parent.
func (s *Service) Pin(ctx context.Context, parent domain.ProjectContextManifest, project domain.ProjectRecord, provider string) error {
	store, ok := s.store.(snapshotStore)
	if !ok {
		return fail("snapshot_store_unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	s.admission.Lock()
	defer s.admission.Unlock()
	if _, found, err := store.GetLibrarySnapshot(ctx, parent.SessionID); err != nil {
		return err
	} else if found {
		return nil
	}
	state, err := s.store.ReadLibraryRegistry(ctx)
	if err != nil {
		return err
	}
	p, warnings, err := s.check(ctx, PolicyRequest{Operation: "snapshot", ProjectID: parent.ProjectID})
	if err != nil {
		affected := len(p.Locks) > 0
		for _, b := range state.Bindings {
			affected = affected || b.Enabled && b.ProjectID == parent.ProjectID && (b.ProjectID != "" || b.SessionID == parent.SessionID)
		}
		if affected {
			return err
		}
		p = PolicyDecision{State: "absent"}
	}
	snapshot := domain.LibrarySnapshot{SchemaVersion: 1, SnapshotID: "snap_" + strings.ReplaceAll(uuid.NewString(), "-", ""), SessionID: parent.SessionID, ProjectID: parent.ProjectID, ProjectRevision: parent.ProjectRevision, ProjectContextDigest: parent.Digest, Role: parent.Role, Channel: parent.Channel, RegistryRevision: state.Revision, TrustEpoch: state.TrustEpoch, OwnedSnapshotRef: "session-library://" + string(parent.SessionID), ProviderID: provider, AdapterID: "inert-library-v1", AdapterVersion: "1", CreatedAt: domain.LibraryTimestamp(s.clock()), Entries: []domain.LibrarySnapshotEntry{}, Warnings: append([]string{}, warnings...)}
	bindings, err := s.selectedBindings(state, parent, p)
	if err != nil {
		return err
	}
	bindingCount := 0
	for _, b := range state.Bindings {
		if b.Enabled && b.ProjectID == parent.ProjectID && (parent.ProjectID != "" || b.SessionID == parent.SessionID) {
			bindingCount++
		}
	}
	for _, a := range project.Instructions.Attachments {
		if a.Enabled {
			bindingCount++
		}
	}
	for _, b := range p.Locks {
		if b.Enabled && b.ProjectID == parent.ProjectID {
			bindingCount++
		}
	}
	maxBindings := domain.MaxProjectContextBindings
	if p.MaxBindings > 0 && p.MaxBindings < maxBindings {
		maxBindings = p.MaxBindings
	}
	if bindingCount > maxBindings {
		return fail("binding_limit")
	}
	inspected := map[string]map[string]domain.LibraryStagedEntry{}
	dedup := map[string]int{}
	for _, b := range bindings {
		staged, status, why := s.resolveBinding(ctx, state, b, p, inspected)
		if status != "selected" && b.Required {
			return fail(why)
		}
		key := b.SourceID + ":" + b.EntryID + ":" + b.ApprovedContentHash
		if i, ok := dedup[key]; ok {
			snapshot.Entries[i].Required = snapshot.Entries[i].Required || b.Required
			snapshot.Entries[i].BindingIDs = append(snapshot.Entries[i].BindingIDs, b.BindingID)
			snapshot.Entries[i].BindingRevisions = append(snapshot.Entries[i].BindingRevisions, b.Revision)
			continue
		}
		child := domain.LibrarySnapshotEntry{Entry: staged.Entry, RootIdentity: staged.RootIdentity, SourceRevision: state.Sources[b.SourceID].Source.Revision, BindingIDs: []string{b.BindingID}, BindingRevisions: []int64{b.Revision}, Content: map[string]string{}, Status: status, ReasonCode: why, Required: b.Required}
		if status == "selected" {
			approval, err := s.approvalFor(state, staged, p)
			if err != nil {
				return err
			}
			child.ApprovalID = approval.ApprovalID
			child.Content = staged.Content
			child.Status = "unsupported_provider"
			child.ReasonCode = "version_evidence_required"
		}
		dedup[key] = len(snapshot.Entries)
		snapshot.Entries = append(snapshot.Entries, child)
	}
	if err := validateAggregateBudget(parent, snapshot, p); err != nil {
		return err
	}
	snapshot.SnapshotDigest, err = snapshot.ComputeDigest()
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fail("resolution_timeout")
	}
	latest, _, err := s.check(ctx, PolicyRequest{Operation: "snapshot", ProjectID: parent.ProjectID})
	if err != nil && len(snapshot.Entries) > 0 {
		return err
	}
	if len(snapshot.Entries) > 0 && latest.Revision != p.Revision {
		return fail("policy_changed")
	}
	created, err := store.CreateLibrarySessionSelection(ctx, parent, snapshot, state.Revision)
	if err == nil && created {
		err = s.store.RecordLibraryAudit(ctx, domain.LibraryAudit{ActorID: s.owner, Purpose: "pin_selection", Outcome: "allowed", ReasonCode: "immutable_selection", PolicyRevision: p.Revision, CorrelationID: uuid.NewString(), Revision: state.Revision, TrustEpoch: state.TrustEpoch})
	}
	return err
}

func (s *Service) selectedBindings(state domain.LibraryRegistry, parent domain.ProjectContextManifest, p PolicyDecision) ([]domain.LibraryBinding, error) {
	selected := []domain.LibraryBinding{}
	locks := map[string]domain.LibraryBinding{}
	for _, b := range p.Locks {
		if b.ProjectID == parent.ProjectID && b.Enabled {
			locks[b.BindingID] = b
			selected = append(selected, b)
		}
	}
	for _, b := range state.Bindings {
		if !b.Enabled || b.ProjectID != parent.ProjectID || (b.ProjectID == "" && b.SessionID != parent.SessionID) {
			continue
		}
		if b.OwnerID != s.owner {
			return nil, fail("owner_mismatch")
		}
		if _, ok := locks[b.BindingID]; ok {
			return nil, fail("managed_lock")
		}
		for _, lock := range locks {
			if b.EntryID == lock.EntryID || state.Entries[b.EntryID].Entry.DisplayName == state.Entries[lock.EntryID].Entry.DisplayName {
				return nil, fail("managed_lock")
			}
		}
		wanted := false
		for _, role := range b.Roles {
			wanted = wanted || role == domain.ProjectContextRoleShared || role == parent.Role || role == domain.ProjectContextRoleChat && parent.Channel == domain.SessionModeChat || role == domain.ProjectContextRoleIssueTask && parent.IssueTask
		}
		if wanted {
			selected = append(selected, b)
		}
	}
	sort.Slice(selected, func(i, j int) bool {
		layer := func(b domain.LibraryBinding) int {
			if _, ok := locks[b.BindingID]; ok {
				return 0
			}
			for _, r := range b.Roles {
				if r == domain.ProjectContextRoleShared {
					return 1
				}
			}
			return 2
		}
		if layer(selected[i]) != layer(selected[j]) {
			return layer(selected[i]) < layer(selected[j])
		}
		if selected[i].Position != selected[j].Position {
			return selected[i].Position < selected[j].Position
		}
		return selected[i].BindingID < selected[j].BindingID
	})
	return selected, nil
}

func (s *Service) resolveBinding(ctx context.Context, state domain.LibraryRegistry, b domain.LibraryBinding, p PolicyDecision, cache map[string]map[string]domain.LibraryStagedEntry) (domain.LibraryStagedEntry, string, string) {
	staged, ok := state.Entries[b.EntryID]
	if !ok {
		staged.Entry = domain.LibraryEntry{SchemaVersion: 1, EntryID: b.EntryID, SourceID: b.SourceID, ContentHash: b.ApprovedContentHash, Files: []domain.LibraryFile{}, Requirements: []string{}}
		return staged, "missing_source", "missing_source"
	}
	local, err := s.source(state, b.SourceID)
	if err != nil {
		return staged, "missing_source", reason(err)
	}
	if staged.Entry.SourceID != b.SourceID {
		return staged, "conflict", "identity_conflict"
	}
	if !staged.Present || staged.Entry.ContentHash != b.ApprovedContentHash || staged.RootIdentity != local.Source.LibraryRootIdentity {
		return staged, "changed_content", "changed_content"
	}
	if staged.Entry.Status == "unsupported_format" {
		return staged, "unsupported_format", staged.Entry.ReasonCode
	}
	if local.Source.InspectionState != "inspection_allowed" {
		return staged, "unapproved", "inspection_required"
	}
	if local.Source.Scope == "managed" && !managedAllowed(p, local) {
		return staged, "policy_denied", "managed_lock"
	}
	decision, _, err := s.check(ctx, PolicyRequest{Operation: "snapshot_entry", ProjectID: b.ProjectID, SourceID: b.SourceID, EntryID: b.EntryID})
	if err != nil {
		return staged, "policy_denied", reason(err)
	}
	if decision.Revision != p.Revision {
		return staged, "policy_denied", "policy_changed"
	}
	if _, err := s.approvalFor(state, staged, p); err != nil {
		return staged, "unapproved", reason(err)
	}
	if err := staged.Verify(); err != nil {
		return staged, "changed_content", "digest_mismatch"
	}
	if _, ok := cache[b.SourceID]; !ok {
		scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		fresh, err := inspectRoot(scanCtx, local, state.Entries, s.authority)
		if err != nil {
			return staged, "missing_source", reason(err)
		}
		cache[b.SourceID] = map[string]domain.LibraryStagedEntry{}
		for _, candidate := range fresh {
			cache[b.SourceID][candidate.Entry.EntryID] = candidate
		}
	}
	fresh, ok := cache[b.SourceID][b.EntryID]
	if !ok || fresh.Entry.ContentHash != staged.Entry.ContentHash {
		return staged, "changed_content", "changed_content"
	}
	return staged, "selected", "approved_inert_selection"
}

func validateAggregateBudget(parent domain.ProjectContextManifest, child domain.LibrarySnapshot, p PolicyDecision) error {
	guidance := int64(len(parent.SharedInstructions) + len(parent.RoleInstructions) + len(parent.RoleRules))
	total := guidance
	files := 0
	for _, a := range parent.Attachments {
		if a.Availability == domain.ProjectContextAvailable {
			total += a.ByteCount
			files++
		}
	}
	for _, e := range child.Entries {
		if e.ApprovalID == "" {
			continue
		}
		for _, text := range e.Content {
			total += int64(len(text))
			files++
			if e.Entry.Kind == "rule" {
				guidance += int64(len(text))
			}
		}
	}
	maxBytes := int64(domain.MaxProjectContextSessionBytes)
	maxFiles := domain.MaxLibrarySessionFiles
	maxGuidance := int64(domain.MaxProjectContextInstructionBytes)
	if p.MaxSessionBytes > 0 && p.MaxSessionBytes < maxBytes {
		maxBytes = p.MaxSessionBytes
	}
	if p.MaxSessionFiles > 0 && p.MaxSessionFiles < maxFiles {
		maxFiles = p.MaxSessionFiles
	}
	if p.MaxGuidanceBytes > 0 && p.MaxGuidanceBytes < maxGuidance {
		maxGuidance = p.MaxGuidanceBytes
	}
	if total > maxBytes || files > maxFiles || guidance > maxGuidance {
		return fail("runtime_limit")
	}
	return nil
}
