package chat

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	librarysvc "github.com/aoagents/agent-orchestrator/backend/internal/service/library"
)

// ErrSkillsUnsupported distinguishes unavailable listing from an empty catalog.
var ErrSkillsUnsupported = errors.New("chat driver cannot list skills")

func skillError(reason string) error {
	return &apierr.Error{Kind: apierr.KindConflict, Code: "CHAT_SKILL_UNAVAILABLE", Message: reason}
}

func (s *Service) librarySkillView(ctx context.Context, id domain.SessionID) (librarysvc.Result, error) {
	s.mu.RLock()
	admission := s.libraryAdmission
	s.mu.RUnlock()
	if admission == nil {
		return librarysvc.Result{}, nil
	}
	manager, ok := admission.(librarysvc.Manager)
	if !ok {
		return librarysvc.Result{}, skillError("library_catalog_unavailable")
	}
	return manager.Operate(ctx, librarysvc.Operation{Operation: "session", SessionID: id})
}

func (s *Service) skillControllerCurrent(ctx context.Context, c *Controller) bool {
	s.mu.RLock()
	current := s.ownerControllers[c.owner()]
	s.mu.RUnlock()
	if c.State() == ports.ChatControllerStopped {
		return false
	}
	if current == c {
		return !c.handoffActive()
	}
	// An edited branch records its first prompt before publishing the replacement.
	// Only its already-committed durable generation can cross that private boundary.
	if current == nil || !current.handoffActive() || s.sessions == nil || c.reviewID != "" {
		return false
	}
	rec, found, err := s.sessions.GetSession(ctx, c.sessionID)
	return err == nil && found && rec.Metadata.ControllerGeneration == c.generation
}

// Skills returns the current controller-scoped catalog rows.
func (s *Service) Skills(ctx context.Context, id domain.SessionID) ([]ports.ChatSkill, error) {
	catalog, err := s.SkillCatalog(ctx, id, false, "")
	if err != nil {
		return nil, err
	}
	if catalog.Status == "unsupported_provider" {
		return nil, ErrSkillsUnsupported
	}
	if catalog.Status == "controller_not_ready" {
		return nil, ErrNoController
	}
	return catalog.Skills, nil
}

// SkillCatalog refreshes observations of the pinned snapshot. A requested new
// selection is a successor-session transition, never an in-place replacement.
func (s *Service) SkillCatalog(ctx context.Context, id domain.SessionID, reload bool, requestedSnapshot string) (ports.ChatSkillCatalog, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return ports.ChatSkillCatalog{}, err
	}
	c, err := s.Controller(id)
	if errors.Is(err, ErrNoController) {
		return ports.ChatSkillCatalog{SessionID: id, Status: "controller_not_ready", ReasonCode: "controller_not_ready", Skills: []ports.ChatSkill{}}, nil
	}
	if err != nil {
		return ports.ChatSkillCatalog{}, err
	}
	return c.loadSkillCatalog(ctx, reload, requestedSnapshot)
}

func (c *Controller) loadSkillCatalog(ctx context.Context, reload bool, requestedSnapshot string) (ports.ChatSkillCatalog, error) {
	c.skillsMu.Lock()
	defer c.skillsMu.Unlock()
	return c.loadSkillCatalogLocked(ctx, reload, requestedSnapshot)
}

func (c *Controller) loadSkillCatalogLocked(ctx context.Context, reload bool, requestedSnapshot string) (ports.ChatSkillCatalog, error) {
	out := ports.ChatSkillCatalog{SessionID: c.sessionID, ControllerGeneration: c.generation, ProviderID: string(c.harness), AdapterVersion: "chat-catalog-v1", Status: "ready", Skills: []ports.ChatSkill{}}
	if !c.skillIsCurrent(ctx) {
		out.Status = "controller_not_ready"
		out.ReasonCode = "stale_controller"
		return out, nil
	}
	view := librarysvc.Result{}
	var err error
	if c.skillView != nil {
		view, err = c.skillView(ctx, c.sessionID)
		if err != nil {
			return out, err
		}
	}
	out.TrustEpoch = view.TrustEpoch
	if view.Snapshot != nil {
		out.SnapshotID = view.Snapshot.SnapshotID
		out.ProjectRevision = view.Snapshot.ProjectRevision
	}
	if len(view.Sources) > 0 {
		out.ResolverID = view.Sources[0].ResolverID
	}
	lister, supported := c.conv.(ports.ChatSkillLister)
	out.CanList = supported
	reloader, canReload := c.conv.(ports.ChatSkillReloader)
	out.CanReloadSameSnapshot = canReload
	if requestedSnapshot != "" && requestedSnapshot != out.SnapshotID {
		out.Status = "restart_required"
		out.ReasonCode = "snapshot_change_requires_successor"
		out.PendingSelectionID = requestedSnapshot
		out.NextAction = "start_successor_session"
		return out, nil
	}
	var native []ports.ChatSkill
	switch {
	case !supported:
		out.Status = "unsupported_provider"
		out.ReasonCode = "listing_unsupported"
	case reload && !out.CanReloadSameSnapshot:
		out.Status = "unsupported_provider"
		out.ReasonCode = "reload_unsupported"
	case reload:
		native, err = reloader.ReloadSkills(ctx)
	default:
		native, err = lister.ListSkills(ctx)
	}
	if err != nil {
		if errors.Is(err, ports.ErrChatSkillsNotReady) {
			out.Status = "controller_not_ready"
			out.ReasonCode = "catalog_not_observed"
		} else if reload {
			out.Status = "restart_required"
			out.ReasonCode = "reload_failed"
			out.NextAction = "start_successor_session"
		} else {
			return out, err
		}
		return out, nil
	}
	if !c.skillIsCurrent(ctx) {
		return ports.ChatSkillCatalog{}, skillError("stale_controller")
	}
	for i, row := range native {
		row.TrustState = "native_unverified"
		row.Scope = row.Source
		row.Kind = "native_action"
		if row.Transport == "native_skill" {
			row.Kind = "skill"
		}
		row.Status = "native_passthrough"
		if row.Transport == "" {
			row.Transport = "native_text"
			row.Token = "/" + row.Name
			row.CanInvoke = true
		}
		if row.ObservationID == "" {
			row.ObservationID = skillDigest(fmt.Sprintf("%d:%s:%s", i, row.Name, row.Source))
		}
		row.ObservationID = skillDigest(string(c.sessionID) + ":" + c.generation + ":" + row.ObservationID)
		row.ControllerGeneration = c.generation
		row.SnapshotID = out.SnapshotID
		out.Skills = append(out.Skills, row)
	}
	if view.Snapshot != nil {
		for _, selected := range view.Snapshot.Entries {
			entry := selected.Entry
			row := ports.ChatSkill{Kind: entry.Kind, Format: entry.Format, Name: entry.DisplayName, DisplayName: entry.DisplayName, EntryID: entry.EntryID, SourceID: entry.SourceID, ContentHash: entry.ContentHash, SnapshotID: out.SnapshotID, ControllerGeneration: c.generation, TrustState: "approved", Status: selected.Status, ReasonCode: selected.ReasonCode, Transport: "unsupported", Source: "library"}
			for _, source := range view.Sources {
				if source.SourceID == entry.SourceID {
					row.Scope = source.Scope
				}
			}
			if selected.ApprovalID == "" {
				row.TrustState = "unapproved"
			}
			for _, binding := range view.RuntimeBindings {
				if binding.EntryID == entry.EntryID {
					row.Status = binding.Status
					row.ReasonCode = binding.ReasonCode
				}
			}
			if row.Status == "revoked" {
				row.TrustState = "revoked"
			}
			// Until native resolution evidence is available, library rows are inert.
			if row.Status == "" || row.Status == "ready" {
				row.Status = "unsupported_provider"
				row.ReasonCode = "version_evidence_required"
			}
			for _, token := range libraryTokens(selected) {
				for i := range out.Skills {
					if out.Skills[i].Token == token {
						out.Skills[i].CanInvoke = false
						out.Skills[i].Status = "conflict"
						out.Skills[i].ReasonCode = "unproved_library_collision"
					}
				}
			}
			out.Skills = append(out.Skills, row)
		}
		if pendingLibrarySelection(view) {
			out.PendingSelectionID = fmt.Sprintf("selection_%d", view.Revision)
			out.NextAction = "start_successor_session"
			out.Status = "restart_required"
			out.ReasonCode = "snapshot_change_requires_successor"
		}
	}
	counts := map[string]int{}
	for _, row := range out.Skills {
		if row.Transport == "native_text" {
			counts[row.Token]++
		}
	}
	for i := range out.Skills {
		row := &out.Skills[i]
		if counts[row.Token] > 1 {
			row.CanInvoke = false
			row.Status = "conflict"
			row.ReasonCode = "ambiguous_native_name"
		}
	}
	// Paths participate in backend identity but are never serialized to clients.
	identity, _ := json.Marshal(struct {
		Session                                           domain.SessionID
		Generation, Snapshot, Provider, Adapter, Resolver string
		Epoch, ProjectRevision                            int64
		Rows                                              []ports.ChatSkill
	}{c.sessionID, c.generation, out.SnapshotID, out.ProviderID, out.AdapterVersion, out.ResolverID, out.TrustEpoch, out.ProjectRevision, out.Skills})
	paths := ""
	for _, row := range out.Skills {
		paths += fmt.Sprintf("%d:%s", len(row.NativePath), row.NativePath)
	}
	out.CatalogRevision = skillDigest(string(identity) + paths)
	for i := range out.Skills {
		row := &out.Skills[i]
		row.CatalogRevision = out.CatalogRevision
		row.BindingRef = skillDigest(out.CatalogRevision + ":" + row.ObservationID + ":" + row.EntryID)
	}
	if c.skillView != nil {
		latest, err := c.skillView(ctx, c.sessionID)
		if err != nil {
			return out, err
		}
		snapshot := ""
		if latest.Snapshot != nil {
			snapshot = latest.Snapshot.SnapshotID
		}
		if latest.TrustEpoch != out.TrustEpoch || snapshot != out.SnapshotID {
			return out, skillError("stale_library_view")
		}
	}
	if !c.skillIsCurrent(ctx) {
		return out, skillError("stale_controller")
	}
	return out, nil
}

func (c *Controller) skillIsCurrent(ctx context.Context) bool {
	return c.skillCurrent == nil || c.skillCurrent(ctx, c)
}

func skillDigest(s string) string { return fmt.Sprintf("obs_%x", sha256.Sum256([]byte(s))) }

// libraryTokens is a temporary chat-side binding helper. It derives native
// names only from pinned content; display labels do not authorize invocation.
func libraryTokens(selected domain.LibrarySnapshotEntry) []string {
	e := selected.Entry
	if e.Kind != "skill" && e.Kind != "prompt_command" {
		return nil
	}
	name := e.DisplayName
	if e.Kind == "prompt_command" {
		name = strings.TrimSuffix(e.EntryPoint, path.Ext(e.EntryPoint))
		name = strings.ReplaceAll(name, "/", ":")
	}
	text := strings.ReplaceAll(selected.Content[e.EntryPoint], "\r\n", "\n")
	if e.Kind == "skill" && strings.HasPrefix(text, "---\n") {
		if end := strings.Index(text[4:], "\n---"); end >= 0 {
			var fields struct {
				Name string `yaml:"name"`
			}
			if yaml.Unmarshal([]byte(text[4:4+end]), &fields) == nil && fields.Name != "" {
				name = fields.Name
			}
		}
	}
	tokens := []string{"/" + name, "$" + name, "/" + e.DisplayName, "$" + e.DisplayName}
	if e.Kind == "skill" {
		folder := path.Base(path.Dir(e.EntryPoint))
		if folder != "." {
			tokens = append(tokens, "/"+folder, "$"+folder)
		}
	}
	return tokens
}

func pendingLibrarySelection(view librarysvc.Result) bool {
	if view.Snapshot == nil {
		return false
	}
	pinned := map[string]int64{}
	hashes := map[string]string{}
	for _, entry := range view.Snapshot.Entries {
		hashes[entry.Entry.EntryID] = entry.Entry.ContentHash
		for i, id := range entry.BindingIDs {
			if i < len(entry.BindingRevisions) {
				pinned[id] = entry.BindingRevisions[i]
			}
		}
	}
	for _, entry := range view.Entries {
		if hash, ok := hashes[entry.EntryID]; ok && hash != entry.ContentHash {
			return true
		}
	}
	for _, binding := range view.Bindings {
		if rev, ok := pinned[binding.BindingID]; ok {
			if rev != binding.Revision {
				return true
			}
			delete(pinned, binding.BindingID)
			continue
		}
		if !binding.Enabled || binding.ProjectID != view.Snapshot.ProjectID || (binding.ProjectID == "" && binding.SessionID != view.Snapshot.SessionID) {
			continue
		}
		for _, role := range binding.Roles {
			if role == domain.ProjectContextRoleShared || role == view.Snapshot.Role {
				return true
			}
		}
	}
	return len(pinned) > 0
}

func (m *sideManager) resolveSideSkillMessage(ctx context.Context, runtime *sideRuntime, side domain.SideConversation, text string) (ports.ChatUserMessage, error) {
	c := &Controller{
		sessionID: side.SessionID, generation: side.Generation, harness: side.Harness,
		conv: runtime.conv, skillView: m.service.librarySkillView,
		skillCurrent: func(ctx context.Context, _ *Controller) bool {
			current, err := m.store.SideConversation(ctx, side.ID)
			return err == nil && current.State == "ready" && current.Generation == side.Generation
		},
	}
	return c.resolveSkillMessage(ctx, ports.ChatUserMessage{Text: text})
}

// resolveSkillMessage is called again at dispatch, including queued and retry
// delivery. It strips opaque metadata before the native driver receives content.
func (c *Controller) resolveSkillMessage(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatUserMessage, error) {
	var selection *ports.ChatSkillSelection
	content := make([]ports.ChatContent, 0, len(msg.Content))
	for _, block := range msg.Content {
		if block.Type == "skill_selection" {
			if selection != nil || !block.Internal || block.SkillSelection == nil {
				return msg, skillError("invalid_selection")
			}
			selection = block.SkillSelection
		} else {
			content = append(content, block)
		}
	}
	msg.Content = content
	msg.NativeSkills = nil
	hasToken := false
	hasDollarToken := false
	for _, word := range strings.Fields(msg.Text) {
		if strings.HasPrefix(word, "$") || strings.HasPrefix(word, "/") {
			hasToken = true
		}
		if strings.HasPrefix(word, "$") && len(word) > 1 {
			hasDollarToken = true
		}
	}
	if !hasToken {
		return msg, nil
	}
	catalog, err := c.loadSkillCatalog(ctx, false, "")
	if err != nil {
		return msg, err
	}
	activeSelection := selection != nil && skillTokenPresent(msg.Text, selection.Token)
	catalogUnavailable := catalog.Status == "controller_not_ready" || !catalog.CanList
	if catalogUnavailable && (activeSelection || c.harness == domain.HarnessCodex && hasDollarToken) {
		return msg, skillError(catalog.ReasonCode)
	}
	var chosen *ports.ChatSkill
	if activeSelection {
		if selection.ControllerGeneration != c.generation || selection.CatalogRevision != catalog.CatalogRevision || selection.SnapshotID != catalog.SnapshotID {
			return msg, skillError("stale_selection")
		}
		for i := range catalog.Skills {
			row := &catalog.Skills[i]
			if row.BindingRef == selection.BindingRef && row.EntryID == selection.EntryID && row.Token == selection.Token {
				chosen = row
				break
			}
		}
		if chosen == nil {
			return msg, skillError("invalid_binding")
		}
		if !chosen.CanInvoke {
			return msg, skillError(chosen.ReasonCode)
		}
	}
	for _, word := range strings.Fields(msg.Text) {
		matches := make([]ports.ChatSkill, 0, 1)
		for _, row := range catalog.Skills {
			if row.Token == word {
				matches = append(matches, row)
			}
		}
		if len(matches) == 0 {
			continue
		}
		if chosen != nil && chosen.Token == word {
			matches = []ports.ChatSkill{*chosen}
		}
		if len(matches) != 1 {
			return msg, skillError("ambiguous_native_name")
		}
		row := matches[0]
		if !row.CanInvoke {
			return msg, skillError(row.ReasonCode)
		}
		if len(msg.Text) > 64<<10 {
			return msg, skillError("runtime_limit")
		}
		if row.Transport == "native_skill" {
			msg.NativeSkills = append(msg.NativeSkills, ports.ChatNativeSkill{Name: row.Name, Path: row.NativePath})
		}
	}
	if c.skillView != nil {
		view, err := c.skillView(ctx, c.sessionID)
		if err != nil {
			return msg, err
		}
		if view.TrustEpoch != catalog.TrustEpoch {
			return msg, skillError("stale_trust_epoch")
		}
		if view.Snapshot != nil {
			for _, entry := range view.Snapshot.Entries {
				for _, token := range libraryTokens(entry) {
					if skillTokenPresent(msg.Text, token) {
						return msg, skillError("version_evidence_required")
					}
				}
			}
		}
	}
	if !c.skillIsCurrent(ctx) {
		return msg, skillError("stale_controller")
	}
	return msg, nil
}

func skillTokenPresent(text, token string) bool {
	if token == "" {
		return false
	}
	for _, word := range strings.Fields(text) {
		if word == token {
			return true
		}
	}
	return false
}
