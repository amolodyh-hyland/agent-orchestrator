package library

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type Store interface {
	RecordLibraryAudit(context.Context, domain.LibraryAudit) error
	ReadLibraryRegistry(context.Context) (domain.LibraryRegistry, error)
	UpdateLibraryRegistry(context.Context, func(*domain.LibraryRegistry) (domain.LibraryAudit, error)) error
	GetProject(context.Context, string) (domain.ProjectRecord, bool, error)
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
}

type PolicyRequest struct {
	Operation string
	SourceID  string
	EntryID   string
	ProjectID domain.ProjectID
}

type PolicyDecision struct {
	State            string
	Mode             string
	Revision         string
	Denied           bool
	ManagedSources   map[string]bool
	Locks            []domain.LibraryBinding
	MaxSessionBytes  int64
	MaxSessionFiles  int
	MaxGuidanceBytes int64
	MaxBindings      int
}

type Policy interface {
	CheckLibrary(context.Context, PolicyRequest) (PolicyDecision, error)
}

type Service struct {
	store     Store
	owner     string
	authority string
	resolver  string
	policy    Policy
	clock     func() time.Time
	admission sync.RWMutex
}

func New(store Store, owner, authority, resolver string, policy Policy) *Service {
	return &Service{store: store, owner: owner, authority: authority, resolver: resolver, policy: policy, clock: time.Now}
}

func fail(reason string) error {
	return &apierr.Error{Kind: apierr.KindConflict, Code: "LIBRARY_UNAVAILABLE", Message: reason}
}
func reason(err error) string {
	var e *apierr.Error
	if errors.As(err, &e) {
		return e.Message
	}
	return "storage_unavailable"
}

type Operation struct {
	Operation        string                        `json:"operation"`
	SourceID         string                        `json:"sourceId,omitempty"`
	Scope            string                        `json:"scope,omitempty"`
	RootKind         string                        `json:"rootKind,omitempty"`
	LocalPath        string                        `json:"localPath,omitempty"`
	RootIdentity     *domain.LibraryRootIdentity   `json:"rootIdentity,omitempty"`
	ExpectedRevision int64                         `json:"expectedRevision"`
	Entries          []domain.LibrarySelectedEntry `json:"entries,omitempty"`
	Purposes         []string                      `json:"purposes,omitempty"`
	ExpiresAt        string                        `json:"expiresAt,omitempty"`
	ApprovalID       string                        `json:"approvalId,omitempty"`
	Binding          *domain.LibraryBinding        `json:"binding,omitempty"`
	BindingID        string                        `json:"bindingId,omitempty"`
	ProjectID        domain.ProjectID              `json:"projectId,omitempty"`
	SessionID        domain.SessionID              `json:"sessionId,omitempty"`
}

type Result struct {
	Preview         []domain.LibraryStagedEntry    `json:"preview,omitempty"`
	Status          string                         `json:"status"`
	ReasonCode      string                         `json:"reasonCode"`
	Revision        int64                          `json:"revision"`
	TrustEpoch      int64                          `json:"trustEpoch"`
	Sources         []domain.LibrarySource         `json:"sources"`
	Entries         []domain.LibraryEntry          `json:"entries"`
	Approvals       []domain.LibraryApproval       `json:"approvals"`
	Bindings        []domain.LibraryBinding        `json:"bindings"`
	Warnings        []string                       `json:"warnings"`
	RuntimeBindings []domain.LibraryRuntimeBinding `json:"runtimeBindings"`

	Snapshot *domain.LibrarySnapshot `json:"snapshot,omitempty"`
}

type Manager interface {
	Operate(context.Context, Operation) (Result, error)
}

func (s *Service) check(ctx context.Context, request PolicyRequest) (PolicyDecision, []string, error) {
	if s.policy == nil {
		return PolicyDecision{State: "absent"}, nil, nil
	}
	p, err := s.policy.CheckLibrary(ctx, request)
	if p.State == "unverifiable" && p.Mode == "optional" {
		return p, []string{"optional_policy_unavailable"}, nil
	}
	if err != nil || p.State == "unverifiable" || p.State == "" {
		return p, nil, fail("policy_unavailable")
	}
	if p.State != "verified" && p.State != "absent" {
		return p, nil, fail("policy_unavailable")
	}
	if p.Denied {
		return p, nil, fail("policy_denied")
	}
	return p, nil, nil
}

func (s *Service) Operate(ctx context.Context, in Operation) (result Result, err error) {
	defer func() {
		if err != nil {
			audit := domain.LibraryAudit{ActorID: s.owner, Purpose: "library_operation", Outcome: "denied", ReasonCode: reason(err), CorrelationID: uuid.NewString()}
			if domain.ValidLibraryID(in.SourceID) {
				audit.SourceID = in.SourceID
			}
			_ = s.store.RecordLibraryAudit(ctx, audit)
		}
	}()
	return s.operate(ctx, in)
}

func (s *Service) operate(ctx context.Context, in Operation) (Result, error) {
	if !domain.ValidLibraryID(s.owner) || !domain.ValidLibraryID(s.authority) || !domain.ValidLibraryID(s.resolver) {
		return Result{}, fail("resolver_unavailable")
	}
	p, warnings, err := s.check(ctx, PolicyRequest{Operation: in.Operation, SourceID: in.SourceID, ProjectID: in.ProjectID})
	if err != nil {
		return Result{}, err
	}
	if in.Operation == "catalog" || in.Operation == "list" {
		state, err := s.store.ReadLibraryRegistry(ctx)
		if err != nil {
			return Result{}, err
		}
		return s.view(state, warnings), nil
	}

	s.admission.Lock()
	defer s.admission.Unlock()
	var staged []domain.LibraryStagedEntry
	if in.Operation == "inspect" {
		state, err := s.store.ReadLibraryRegistry(ctx)
		if err != nil {
			return Result{}, err
		}
		local, err := s.source(state, in.SourceID)
		if err != nil {
			return Result{}, err
		}
		if state.Revision != in.ExpectedRevision {
			return Result{}, fail("revision_conflict")
		}
		if local.Source.InspectionState != "inspection_allowed" {
			return Result{}, fail("inspection_required")
		}
		if local.Source.Scope == "managed" && (p.State != "verified" || !p.ManagedSources[in.SourceID]) {
			return Result{}, fail("managed_lock")
		}
		scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		staged, err = inspectRoot(scanCtx, local, state.Entries, s.authority)
		if err != nil {
			return Result{}, err
		}
	}
	err = s.store.UpdateLibraryRegistry(ctx, func(state *domain.LibraryRegistry) (domain.LibraryAudit, error) {
		audit := domain.LibraryAudit{ActorID: s.owner, SourceID: in.SourceID, Purpose: in.Operation, Outcome: "allowed", ReasonCode: "completed", CorrelationID: uuid.NewString()}
		if state.Revision != in.ExpectedRevision {
			return audit, fail("revision_conflict")
		}
		current, _, err := s.check(ctx, PolicyRequest{Operation: in.Operation, SourceID: in.SourceID, ProjectID: in.ProjectID})
		if err != nil {
			return audit, err
		}
		p = current
		switch in.Operation {
		case "register":
			err = s.register(state, in, p)
		case "rebind":
			err = s.rebind(state, in, p)
		case "allow_inspection":
			local, e := s.source(*state, in.SourceID)
			if e != nil {
				return audit, e
			}
			if in.RootIdentity == nil || *in.RootIdentity != local.Source.LibraryRootIdentity {
				return audit, fail("root_identity_mismatch")
			}
			if local.Source.Scope == "managed" && (p.State != "verified" || !p.ManagedSources[in.SourceID]) {
				return audit, fail("managed_lock")
			}
			local.Source.InspectionState = "inspection_allowed"
			state.Sources[in.SourceID] = local
		case "inspect":
			local, e := s.source(*state, in.SourceID)
			if e != nil {
				return audit, e
			}
			local.Source.Revision++
			state.Sources[in.SourceID] = local
			for id, old := range state.Entries {
				if old.Entry.SourceID == in.SourceID {
					old.Present = false
					state.Entries[id] = old
				}
			}
			for _, entry := range staged {
				if old, exists := state.Entries[entry.Entry.EntryID]; exists && old.Entry.SourceID != entry.Entry.SourceID {
					return audit, fail("identity_conflict")
				}
				state.Entries[entry.Entry.EntryID] = entry
			}
		case "approve":
			err = s.approve(state, in, p)
		case "revoke":
			approval, ok := state.Approvals[in.ApprovalID]
			if !ok {
				return audit, fail("approval_missing")
			}
			if approval.ActorID != s.owner {
				return audit, fail("owner_mismatch")
			}
			local, ok := state.Sources[approval.SourceID]
			if !ok {
				return audit, fail("missing_source")
			}
			if local.Source.Scope == "managed" {
				return audit, fail("managed_lock")
			}
			state.TrustEpoch++
			approval.State = "revoked"
			approval.TrustEpoch = state.TrustEpoch
			state.Approvals[in.ApprovalID] = approval
		case "bind":
			err = s.bind(ctx, state, in, p)
		case "detach_binding":
			binding, ok := state.Bindings[in.BindingID]
			if !ok || binding.OwnerID != s.owner {
				return audit, fail("owner_mismatch")
			}
			for _, lock := range p.Locks {
				if binding.EntryID == lock.EntryID || binding.BindingID == lock.BindingID {
					return audit, fail("managed_lock")
				}
			}
			delete(state.Bindings, in.BindingID)
		case "detach_source":
			local, e := s.source(*state, in.SourceID)
			if e != nil {
				return audit, e
			}
			if local.Source.Scope == "managed" {
				return audit, fail("managed_lock")
			}
			for _, lock := range p.Locks {
				if lock.SourceID == in.SourceID {
					return audit, fail("managed_lock")
				}
			}
			local.Source.Detached = true
			state.Sources[in.SourceID] = local
		default:
			err = fail("unsupported_operation")
		}
		return audit, err
	})
	if err != nil {
		return Result{}, err
	}
	state, err := s.store.ReadLibraryRegistry(ctx)
	if err != nil {
		return Result{}, err
	}
	result := s.view(state, warnings)
	if in.Operation == "inspect" {
		result.Preview = staged
	}
	return result, nil
}

func (s *Service) source(state domain.LibraryRegistry, id string) (domain.LibraryLocalSource, error) {
	local, ok := state.Sources[id]
	if !ok || local.Source.Detached {
		return local, fail("missing_source")
	}
	if local.Source.OwnerID != s.owner || local.Source.ResolverID != s.resolver {
		return local, fail("owner_mismatch")
	}
	return local, nil
}

func (s *Service) register(state *domain.LibraryRegistry, in Operation, p PolicyDecision) error {
	if !domain.ValidLibraryID(in.SourceID) {
		return fail("invalid_id")
	}
	if _, ok := state.Sources[in.SourceID]; ok {
		return fail("identity_conflict")
	}
	if len(state.Sources) >= domain.MaxLibrarySources {
		return fail("source_limit")
	}
	if in.Scope != "personal" && in.Scope != "project" && in.Scope != "managed" {
		return fail("invalid_scope")
	}
	if in.Scope == "managed" && (p.State != "verified" || !p.ManagedSources[in.SourceID]) {
		return fail("managed_lock")
	}
	switch in.RootKind {
	case "claude-skills", "codex-skills", "claude-commands", "rules", "claude-personas", "codex-personas", "hooks":
	default:
		return fail("unsupported_format")
	}
	local, err := s.locator(in.LocalPath)
	if err != nil {
		return err
	}
	local.RootKind = in.RootKind
	local.Source = domain.LibrarySource{SourceID: in.SourceID, OwnerID: s.owner, Scope: in.Scope, OriginKind: "machine_local", LibraryRootIdentity: domain.LibraryRootIdentity{ResolverID: s.resolver, RootRef: "root_" + strings.ReplaceAll(uuid.NewString(), "-", ""), RootGeneration: 1}, Revision: 1, InspectionState: "registered"}
	state.Sources[in.SourceID] = local
	return nil
}

func (s *Service) locator(localPath string) (domain.LibraryLocalSource, error) {
	if !filepath.IsAbs(localPath) || strings.ContainsRune(localPath, 0) {
		return domain.LibraryLocalSource{}, fail("invalid_root")
	}
	info, err := os.Lstat(localPath)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return domain.LibraryLocalSource{}, fail("invalid_root")
	}
	canonical, err := filepath.EvalSymlinks(localPath)
	if err != nil || canonical != filepath.Clean(localPath) {
		return domain.LibraryLocalSource{}, fail("root_link_requires_explicit_target")
	}
	identity, err := targetIdentity(info)
	if err != nil {
		return domain.LibraryLocalSource{}, err
	}
	return domain.LibraryLocalSource{RootPath: canonical, TargetIdentity: identity}, nil
}

func (s *Service) rebind(state *domain.LibraryRegistry, in Operation, p PolicyDecision) error {
	old, err := s.source(*state, in.SourceID)
	if err != nil {
		return err
	}
	if old.Source.Scope == "managed" {
		return fail("managed_lock")
	}
	next, err := s.locator(in.LocalPath)
	if err != nil {
		return err
	}
	old.RootPath = next.RootPath
	old.TargetIdentity = next.TargetIdentity
	old.Source.RootGeneration++
	old.Source.Revision++
	old.Source.InspectionState = "registered"
	state.Sources[in.SourceID] = old
	state.TrustEpoch++
	return nil
}

func (s *Service) approve(state *domain.LibraryRegistry, in Operation, p PolicyDecision) error {
	local, err := s.source(*state, in.SourceID)
	if err != nil {
		return err
	}
	if local.Source.InspectionState != "inspection_allowed" || in.RootIdentity == nil || *in.RootIdentity != local.Source.LibraryRootIdentity {
		return fail("inspection_required")
	}
	if local.Source.Scope == "managed" && (p.State != "verified" || !p.ManagedSources[in.SourceID]) {
		return fail("managed_lock")
	}
	if len(in.Entries) == 0 || len(in.Purposes) == 0 {
		return fail("empty_approval")
	}
	seen := map[string]bool{}
	purposeSet := map[string]bool{}
	for _, purpose := range in.Purposes {
		switch purpose {
		case "load_context", "materialize_skill", "invoke_prompt_command":
		default:
			return fail("unsupported_purpose")
		}
		if purposeSet[purpose] {
			return fail("duplicate_purpose")
		}
		purposeSet[purpose] = true
	}
	for _, selection := range in.Entries {
		entry, ok := state.Entries[selection.EntryID]
		if !ok || !entry.Present || entry.Entry.SourceID != in.SourceID || entry.Entry.ContentHash != selection.ContentHash || entry.RootIdentity != local.Source.LibraryRootIdentity {
			return fail("changed_content")
		}
		if seen[selection.EntryID] {
			return fail("identity_conflict")
		}
		seen[selection.EntryID] = true
		if entry.Entry.Status == "unsupported_format" {
			return fail("unsupported_format")
		}
		required := entryPurpose(entry.Entry.Kind)
		if !purposeSet[required] {
			return fail("purpose_mismatch")
		}
		if err := entry.Verify(); err != nil {
			return fail("digest_mismatch")
		}
	}
	expires := ""
	if in.ExpiresAt != "" {
		t, err := time.Parse("2006-01-02T15:04:05.000Z", in.ExpiresAt)
		if err != nil || !t.After(s.clock()) {
			return fail("invalid_expiry")
		}
		expires = domain.LibraryTimestamp(t)
	}
	entries := append([]domain.LibrarySelectedEntry(nil), in.Entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].EntryID < entries[j].EntryID })
	purposes := append([]string(nil), in.Purposes...)
	sort.Strings(purposes)
	approval := domain.LibraryApproval{ApprovalID: "apr_" + strings.ReplaceAll(uuid.NewString(), "-", ""), AuthorityID: s.authority, ActorID: s.owner, SourceID: in.SourceID, RootIdentity: local.Source.LibraryRootIdentity, Entries: entries, Purposes: purposes, PolicyRevision: p.Revision, ApprovedAt: domain.LibraryTimestamp(s.clock()), ExpiresAt: expires, State: "approved", TrustEpoch: state.TrustEpoch}
	approval.SelectionDigest, err = domain.LibraryRecordDigest("shared-library-approval-v1", struct {
		Root           domain.LibraryRootIdentity    `json:"rootIdentity"`
		Entries        []domain.LibrarySelectedEntry `json:"entries"`
		Purposes       []string                      `json:"purposes"`
		PolicyRevision string                        `json:"policyRevision"`
	}{approval.RootIdentity, approval.Entries, approval.Purposes, p.Revision})
	if err != nil {
		return err
	}
	state.Approvals[approval.ApprovalID] = approval
	return nil
}

func entryPurpose(kind string) string {
	switch kind {
	case "skill":
		return "materialize_skill"
	case "prompt_command":
		return "invoke_prompt_command"
	default:
		return "load_context"
	}
}

func (s *Service) bind(ctx context.Context, state *domain.LibraryRegistry, in Operation, p PolicyDecision) error {
	if in.Binding == nil {
		return fail("invalid_binding")
	}
	b := *in.Binding
	if !domain.ValidLibraryID(b.BindingID) || b.OwnerID != s.owner || b.Position < 0 || len(b.Roles) == 0 {
		return fail("invalid_binding")
	}
	if old, ok := state.Bindings[b.BindingID]; ok && (old.OwnerID != b.OwnerID || old.ProjectID != b.ProjectID || old.SessionID != b.SessionID) {
		return fail("identity_conflict")
	}
	if _, err := s.source(*state, b.SourceID); err != nil {
		return err
	}
	entry, ok := state.Entries[b.EntryID]
	if !ok || !entry.Present || entry.Entry.SourceID != b.SourceID || entry.Entry.ContentHash != b.ApprovedContentHash {
		return fail("changed_content")
	}
	roles := map[domain.ProjectContextRole]bool{}
	for _, role := range b.Roles {
		switch role {
		case domain.ProjectContextRoleShared, domain.ProjectContextRoleWorker, domain.ProjectContextRoleCoordinator, domain.ProjectContextRoleIssueTask, domain.ProjectContextRoleChat:
		default:
			return fail("invalid_role")
		}
		if roles[role] {
			return fail("invalid_role")
		}
		roles[role] = true
	}
	for _, lock := range p.Locks {
		if lock.ProjectID == b.ProjectID && (lock.BindingID == b.BindingID || lock.EntryID == b.EntryID || entry.Entry.DisplayName == state.Entries[lock.EntryID].Entry.DisplayName) {
			return fail("managed_lock")
		}
	}
	count := 0
	if b.ProjectID != "" {
		project, found, err := s.store.GetProject(ctx, string(b.ProjectID))
		if err != nil {
			return err
		}
		if !found {
			return fail("project_missing")
		}
		for _, a := range project.Instructions.Attachments {
			if a.Enabled {
				count++
			}
		}
		if b.SessionID != "" {
			return fail("invalid_binding")
		}
	} else {
		session, found, err := s.store.GetSession(ctx, b.SessionID)
		if err != nil {
			return err
		}
		if !found || session.ProjectID != "" {
			return fail("owner_mismatch")
		}
	}
	for id, old := range state.Bindings {
		if id != b.BindingID && old.ProjectID == b.ProjectID && old.SessionID == b.SessionID && old.Enabled {
			count++
		}
	}
	limit := domain.MaxProjectContextBindings
	if p.MaxBindings > 0 && p.MaxBindings < limit {
		limit = p.MaxBindings
	}
	if b.Enabled {
		count++
	}
	if count > limit {
		return fail("binding_limit")
	}
	if _, err := s.approvalFor(*state, entry, p); err != nil {
		return err
	}
	b.Revision = state.Bindings[b.BindingID].Revision + 1
	state.Bindings[b.BindingID] = b
	return nil
}

func (s *Service) approvalFor(state domain.LibraryRegistry, entry domain.LibraryStagedEntry, p PolicyDecision) (domain.LibraryApproval, error) {
	ids := make([]string, 0, len(state.Approvals))
	for id := range state.Approvals {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		a := state.Approvals[id]
		if a.ActorID != s.owner || a.AuthorityID != s.authority || a.SourceID != entry.Entry.SourceID || a.RootIdentity != entry.RootIdentity || a.PolicyRevision != p.Revision || a.State != "approved" {
			continue
		}
		if a.ExpiresAt != "" {
			t, err := time.Parse("2006-01-02T15:04:05.000Z", a.ExpiresAt)
			if err != nil || !s.clock().Before(t) {
				continue
			}
		}
		purpose := false
		for _, v := range a.Purposes {
			purpose = purpose || v == entryPurpose(entry.Entry.Kind)
		}
		if !purpose {
			continue
		}
		for _, selected := range a.Entries {
			if selected.EntryID == entry.Entry.EntryID && selected.ContentHash == entry.Entry.ContentHash {
				return a, nil
			}
		}
	}
	return domain.LibraryApproval{}, fail("digest_approval_required")
}

func (s *Service) view(state domain.LibraryRegistry, warnings []string) Result {
	result := Result{Status: "unsupported_provider", ReasonCode: "inert_catalog", Revision: state.Revision, TrustEpoch: state.TrustEpoch, Sources: []domain.LibrarySource{}, Entries: []domain.LibraryEntry{}, Approvals: []domain.LibraryApproval{}, Bindings: []domain.LibraryBinding{}, Warnings: append([]string{}, warnings...), RuntimeBindings: []domain.LibraryRuntimeBinding{}}
	for _, local := range state.Sources {
		if local.Source.OwnerID == s.owner {
			result.Sources = append(result.Sources, local.Source)
		}
	}
	for _, staged := range state.Entries {
		if staged.Present && state.Sources[staged.Entry.SourceID].Source.OwnerID == s.owner {
			result.Entries = append(result.Entries, staged.Entry)
		}
	}
	for _, a := range state.Approvals {
		if a.ActorID == s.owner {
			result.Approvals = append(result.Approvals, a)
		}
	}
	for _, b := range state.Bindings {
		if b.OwnerID == s.owner {
			result.Bindings = append(result.Bindings, b)
		}
	}
	sort.Slice(result.Sources, func(i, j int) bool { return result.Sources[i].SourceID < result.Sources[j].SourceID })
	sort.Slice(result.Entries, func(i, j int) bool { return result.Entries[i].EntryID < result.Entries[j].EntryID })
	sort.Slice(result.Approvals, func(i, j int) bool { return result.Approvals[i].ApprovalID < result.Approvals[j].ApprovalID })
	sort.Slice(result.Bindings, func(i, j int) bool { return result.Bindings[i].BindingID < result.Bindings[j].BindingID })
	return result
}
