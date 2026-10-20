package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type projectContextTestStore struct {
	Store
	snapshots map[domain.SessionID]domain.ProjectContextManifest
	sources   map[string]domain.ProjectContextLocalSourceRecord
}

func (s *projectContextTestStore) CreateProjectContextSnapshot(_ context.Context, manifest domain.ProjectContextManifest) (bool, error) {
	if _, exists := s.snapshots[manifest.SessionID]; exists {
		return false, nil
	}
	s.snapshots[manifest.SessionID] = manifest
	return true, nil
}

func (s *projectContextTestStore) GetProjectContextSnapshot(_ context.Context, id domain.SessionID) (domain.ProjectContextManifest, bool, error) {
	manifest, ok := s.snapshots[id]
	return manifest, ok, nil
}

func (s *projectContextTestStore) GetProjectContextLocalSource(_ context.Context, ref string) (domain.ProjectContextLocalSourceRecord, bool, error) {
	source, ok := s.sources[ref]
	return source, ok, nil
}

type projectContextPolicyFunc func(context.Context, ProjectContextPolicyRequest) error

func (f projectContextPolicyFunc) AllowProjectContext(ctx context.Context, request ProjectContextPolicyRequest) error {
	return f(ctx, request)
}

func newProjectContextManager() *Manager {
	return &Manager{clock: func() time.Time { return time.Unix(100, 0).UTC() }}
}

func inlineContextBinding(id string, role domain.ProjectContextRole, text string) domain.ProjectContextAttachment {
	return domain.ProjectContextAttachment{
		ID: id, SourceKind: domain.ProjectContextInlineText, MediaType: "text/plain",
		Roles: []domain.ProjectContextRole{role}, Position: 0, Enabled: true, Text: text,
	}
}

func TestProjectContextRoleAndChannelMatrix(t *testing.T) {
	project := domain.ProjectRecord{
		ID: "p", Revision: 7, DisplayName: "Project",
		Config: domain.ProjectConfig{AgentRules: "legacy worker rules", OrchestratorRules: "legacy coordinator rules"},
		Instructions: domain.ProjectInstructions{
			Shared: "shared instructions", Worker: "worker instructions", Coordinator: "coordinator instructions",
			Attachments: []domain.ProjectContextAttachment{
				inlineContextBinding("shared", domain.ProjectContextRoleShared, "shared attachment"),
				inlineContextBinding("worker", domain.ProjectContextRoleWorker, "worker attachment"),
				inlineContextBinding("coordinator", domain.ProjectContextRoleCoordinator, "coordinator attachment"),
				inlineContextBinding("issue", domain.ProjectContextRoleIssueTask, "issue attachment"),
				inlineContextBinding("chat", domain.ProjectContextRoleChat, "chat attachment"),
				{ID: "disabled", SourceKind: domain.ProjectContextInlineText, MediaType: "text/plain", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: false, Text: "disabled"},
			},
		},
	}
	manager := newProjectContextManager()
	tests := []struct {
		name      string
		kind      domain.SessionKind
		mode      domain.SessionMode
		issue     domain.IssueID
		wantRole  domain.ProjectContextRole
		wantRules string
		wantText  string
		wantIDs   []string
		wantIssue bool
	}{
		{"worker tui", domain.KindWorker, domain.SessionModeTUI, "", domain.ProjectContextRoleWorker, "legacy worker rules", "worker instructions", []string{"shared", "worker"}, false},
		{"worker chat issue", domain.KindWorker, domain.SessionModeChat, "ISSUE-1", domain.ProjectContextRoleWorker, "legacy worker rules", "worker instructions", []string{"chat", "issue", "shared", "worker"}, true},
		{"coordinator chat", domain.KindOrchestrator, domain.SessionModeChat, "", domain.ProjectContextRoleCoordinator, "legacy coordinator rules", "coordinator instructions", []string{"chat", "coordinator", "shared"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: tt.kind, Mode: tt.mode, IssueID: tt.issue}
			manifest, err := manager.resolveProjectContext(context.Background(), rec, project)
			if err != nil {
				t.Fatalf("resolveProjectContext(): %v", err)
			}
			if manifest.ProjectRevision != 7 || manifest.Role != tt.wantRole || manifest.Channel != tt.mode || manifest.IssueTask != tt.wantIssue {
				t.Fatalf("manifest identity = %#v", manifest)
			}
			if manifest.SharedInstructions != "shared instructions" || manifest.RoleInstructions != tt.wantText || manifest.RoleRules != tt.wantRules {
				t.Fatalf("manifest guidance = shared %q role %q rules %q", manifest.SharedInstructions, manifest.RoleInstructions, manifest.RoleRules)
			}
			if len(manifest.Attachments) != len(tt.wantIDs) {
				t.Fatalf("attachment count = %d, want %d: %#v", len(manifest.Attachments), len(tt.wantIDs), manifest.Attachments)
			}
			for i, want := range tt.wantIDs {
				if got := manifest.Attachments[i].Binding.ID; got != want {
					t.Fatalf("attachment[%d] = %q, want %q", i, got, want)
				}
				if manifest.Attachments[i].Availability != domain.ProjectContextAvailable {
					t.Fatalf("attachment %q state = %q", want, manifest.Attachments[i].Availability)
				}
			}
			if err := manifest.VerifyDigest(); err != nil {
				t.Fatalf("manifest digest: %v", err)
			}
		})
	}
}

func TestProjectContextWorksWithoutRepository(t *testing.T) {
	project := domain.ProjectRecord{ID: "planning", Revision: 1, Instructions: domain.ProjectInstructions{Shared: "Plan using the shared context."}}
	rec := domain.SessionRecord{ID: "planning-1", ProjectID: "planning", Kind: domain.KindWorker, Mode: domain.SessionModeChat}
	manifest, err := newProjectContextManager().resolveProjectContext(context.Background(), rec, project)
	if err != nil {
		t.Fatalf("resolveProjectContext(): %v", err)
	}
	if manifest.ProjectID != "planning" || manifest.SharedInstructions != "Plan using the shared context." || len(manifest.Attachments) != 0 {
		t.Fatalf("manifest = %#v", manifest)
	}
}

func TestProjectContextMissingOptionalAndRequiredReferences(t *testing.T) {
	optional := domain.ProjectContextAttachment{
		ID: "optional", SourceKind: domain.ProjectContextRepoRelativeFile, SourceRef: "missing-source", MachineID: "machine-a",
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
	project := domain.ProjectRecord{ID: "p", Revision: 1, Instructions: domain.ProjectInstructions{Attachments: []domain.ProjectContextAttachment{optional}}}
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	manager := newProjectContextManager()
	manager.store = &projectContextTestStore{sources: map[string]domain.ProjectContextLocalSourceRecord{}}
	manager.SetProjectContextMachineID("machine-a")
	manifest, err := manager.resolveProjectContext(context.Background(), rec, project)
	if err != nil {
		t.Fatalf("optional missing source failed: %v", err)
	}
	entry := manifest.Attachments[0]
	if entry.Availability != domain.ProjectContextUnavailable || entry.Reason != "missing" || entry.SnapshotRef == "" {
		t.Fatalf("optional entry = %#v", entry)
	}

	optional.Required = true
	project.Instructions.Attachments[0] = optional
	_, err = manager.resolveProjectContext(context.Background(), rec, project)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.BindingID != "optional" || resolutionErr.Reason != "missing" {
		t.Fatalf("required missing error = %#v (%v)", resolutionErr, err)
	}
}

func TestProjectContextPolicyIsOptionalAndDenyOnly(t *testing.T) {
	project := domain.ProjectRecord{ID: "p", Revision: 1, Instructions: domain.ProjectInstructions{
		Attachments: []domain.ProjectContextAttachment{inlineContextBinding("guide", domain.ProjectContextRoleShared, "private guidance")},
	}}
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	manifest, err := newProjectContextManager().resolveProjectContext(context.Background(), rec, project)
	if err != nil || manifest.Attachments[0].Content != "private guidance" {
		t.Fatalf("no-policy resolution = %#v, %v", manifest, err)
	}

	manager := newProjectContextManager()
	manager.projectContextPolicy = projectContextPolicyFunc(func(_ context.Context, request ProjectContextPolicyRequest) error {
		if request.Attachment != nil {
			return errors.New("managed policy denied source")
		}
		return nil
	})
	manifest, err = manager.resolveProjectContext(context.Background(), rec, project)
	if err != nil {
		t.Fatalf("optional denied source failed session: %v", err)
	}
	if got := manifest.Attachments[0]; got.Availability != domain.ProjectContextUnavailable || got.Reason != "denied" || got.Content != "" {
		t.Fatalf("denied optional entry = %#v", got)
	}
	project.Instructions.Attachments[0].Required = true
	_, err = manager.resolveProjectContext(context.Background(), rec, project)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.Reason != "denied" {
		t.Fatalf("required denial error = %#v (%v)", resolutionErr, err)
	}
}

func TestProjectContextRepoFileIsContainedAndBounded(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("outside secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, "link.md")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	binding := domain.ProjectContextAttachment{
		ID: "linked", SourceKind: domain.ProjectContextRepoRelativeFile, SourceRef: "linked-source", MachineID: "machine-a",
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
	manager := newProjectContextManager()
	manager.store = &projectContextTestStore{sources: map[string]domain.ProjectContextLocalSourceRecord{
		"linked-source": {SourceRef: "linked-source", MachineID: "machine-a", RootPath: root, RelativePath: "link.md", MediaType: "text/markdown", OwnerKind: domain.ProjectContextOwnerProject, OwnerID: "p"},
	}}
	manager.SetProjectContextMachineID("machine-a")
	project := domain.ProjectRecord{ID: "p", Revision: 1}
	entry, _, err := manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
	if err != nil {
		t.Fatalf("optional escaping symlink: %v", err)
	}
	if entry.Availability != domain.ProjectContextUnavailable || entry.Content != "" {
		t.Fatalf("escaping symlink entry = %#v", entry)
	}

	large := strings.Repeat("x", domain.MaxProjectContextAttachmentBytes+1)
	if err := os.WriteFile(filepath.Join(root, "large.md"), []byte(large), 0o600); err != nil {
		t.Fatal(err)
	}
	binding.ID = "large"
	binding.SourceRef = "large-source"
	manager.store.(*projectContextTestStore).sources["large-source"] = domain.ProjectContextLocalSourceRecord{
		SourceRef: "large-source", MachineID: "machine-a", RootPath: root, RelativePath: "large.md",
		MediaType: "text/markdown", OwnerKind: domain.ProjectContextOwnerProject, OwnerID: "p",
	}
	_, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.Reason != "attachment_size_limit" {
		t.Fatalf("oversize attachment error = %#v (%v)", resolutionErr, err)
	}
}

func TestProjectContextSymlinkSwapNeverReadsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "inside.md"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "switch.md")
	install := func(target string, n int) error {
		temp := filepath.Join(root, fmt.Sprintf("switch-%d", n))
		_ = os.Remove(temp)
		if err := os.Symlink(target, temp); err != nil {
			return err
		}
		return os.Rename(temp, link)
	}
	if err := install(filepath.Join(root, "inside.md"), 0); err != nil {
		t.Skipf("symlink swap unavailable: %v", err)
	}
	binding := domain.ProjectContextAttachment{
		ID: "swap", SourceKind: domain.ProjectContextRepoRelativeFile, SourceRef: "swap-source", MachineID: "machine-a",
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
	manager := newProjectContextManager()
	manager.store = &projectContextTestStore{sources: map[string]domain.ProjectContextLocalSourceRecord{
		"swap-source": {SourceRef: "swap-source", MachineID: "machine-a", RootPath: root, RelativePath: "switch.md", MediaType: "text/markdown", OwnerKind: domain.ProjectContextOwnerProject, OwnerID: "p"},
	}}
	manager.SetProjectContextMachineID("machine-a")
	project := domain.ProjectRecord{ID: "p", Revision: 1}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 1; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			target := filepath.Join(root, "inside.md")
			if i%2 == 0 {
				target = filepath.Join(outside, "secret.md")
			}
			if err := install(target, i); err != nil {
				return
			}
		}
	}()
	defer func() {
		close(stop)
		<-done
	}()
	for i := 0; i < 100; i++ {
		entry, _, err := manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
		if err != nil {
			var resolutionErr *ProjectContextResolutionError
			if !errors.As(err, &resolutionErr) {
				t.Fatalf("unexpected resolution error: %v", err)
			}
			continue
		}
		if entry.Availability == domain.ProjectContextAvailable && entry.Content != "inside" {
			t.Fatalf("read content outside project root: %q", entry.Content)
		}
	}
}

func TestProjectContextMachineLocalFileRequiresOwningMachine(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("local notes"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &projectContextTestStore{
		sources: map[string]domain.ProjectContextLocalSourceRecord{
			"source-1": {SourceRef: "source-1", MachineID: "machine-a", RootPath: root, RelativePath: "notes.md", MediaType: "text/markdown", OwnerKind: domain.ProjectContextOwnerUser, OwnerID: "library-1"},
		},
	}
	manager := newProjectContextManager()
	manager.store = store
	manager.SetProjectContextMachineID("machine-a")
	binding := domain.ProjectContextAttachment{
		ID: "local", OwnerKind: domain.ProjectContextOwnerUser, OwnerID: "library-1",
		SourceKind: domain.ProjectContextMachineLocalFile, SourceRef: "source-1", MachineID: "machine-a",
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
	project := domain.ProjectRecord{ID: "p", Revision: 1}
	entry, _, err := manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
	if err != nil || entry.Availability != domain.ProjectContextAvailable || entry.Content != "local notes" {
		t.Fatalf("owning-machine resolution = %#v, %v", entry, err)
	}
	manager.SetProjectContextMachineID("machine-b")
	entry, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-2", binding)
	if err != nil || entry.Availability != domain.ProjectContextUnavailable || entry.Reason != "machine_mismatch" || entry.Content != "" {
		t.Fatalf("other-machine resolution = %#v, %v", entry, err)
	}
	binding.Required = true
	_, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-3", binding)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.Reason != "machine_mismatch" {
		t.Fatalf("required other-machine error = %#v (%v)", resolutionErr, err)
	}

	binding.Required = false
	binding.SourceKind = domain.ProjectContextRepoRelativeFile
	manager.SetProjectContextMachineID("machine-b")
	entry, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-4", binding)
	if err != nil || entry.Availability != domain.ProjectContextUnavailable || entry.Reason != "machine_mismatch" {
		t.Fatalf("other-machine repo reference = %#v, %v", entry, err)
	}

	binding.SourceKind = domain.ProjectContextImportedBundle
	binding.MachineID = ""
	manager.SetProjectContextMachineID("machine-a")
	entry, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-5", binding)
	if err != nil || entry.Availability != domain.ProjectContextAvailable {
		t.Fatalf("owning-machine import resolution = %#v, %v", entry, err)
	}
	manager.SetProjectContextMachineID("machine-b")
	entry, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-6", binding)
	if err != nil || entry.Availability != domain.ProjectContextUnavailable || entry.Reason != "machine_mismatch" {
		t.Fatalf("remote import resolution = %#v, %v", entry, err)
	}
}

func TestProjectContextSessionSizeLimitIncludesInstructions(t *testing.T) {
	project := domain.ProjectRecord{ID: "p", Revision: 1}
	for i := 0; i < 9; i++ {
		project.Instructions.Attachments = append(project.Instructions.Attachments,
			inlineContextBinding(fmt.Sprintf("large-%d", i), domain.ProjectContextRoleShared, strings.Repeat("x", domain.MaxProjectContextAttachmentBytes)))
	}
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	_, err := newProjectContextManager().resolveProjectContext(context.Background(), rec, project)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.Reason != "session_size_limit" {
		t.Fatalf("session size error = %#v (%v)", resolutionErr, err)
	}
}

func TestProjectContextSnapshotIsPinnedAcrossProjectUpdates(t *testing.T) {
	store := &projectContextTestStore{snapshots: make(map[domain.SessionID]domain.ProjectContextManifest)}
	manager := newProjectContextManager()
	manager.store = store
	project := domain.ProjectRecord{ID: "p", Revision: 1, Instructions: domain.ProjectInstructions{Shared: "original"}}
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	if err := manager.ensureProjectContextSnapshot(context.Background(), rec, project); err != nil {
		t.Fatalf("ensure first snapshot: %v", err)
	}
	project.Revision = 2
	project.Instructions.Shared = "changed for future sessions"
	if err := manager.ensureProjectContextSnapshot(context.Background(), rec, project); err != nil {
		t.Fatalf("ensure retry snapshot: %v", err)
	}
	manifest, found, err := manager.projectContextSnapshot(context.Background(), rec.ID)
	if err != nil || !found || manifest.SharedInstructions != "original" || manifest.ProjectRevision != 1 {
		t.Fatalf("pinned snapshot = %#v found=%v err=%v", manifest, found, err)
	}
}

func TestBuildSystemPromptUsesPinnedProjectContext(t *testing.T) {
	base := newFakeStore()
	original := domain.ProjectRecord{
		ID: "p", Revision: 1,
		Config:       domain.ProjectConfig{AgentRules: "original worker rules"},
		Instructions: domain.ProjectInstructions{Shared: "original shared guidance", Worker: "original worker guidance"},
	}
	base.projects[original.ID] = original
	store := &projectContextTestStore{
		Store:     base,
		snapshots: make(map[domain.SessionID]domain.ProjectContextManifest),
		sources:   make(map[string]domain.ProjectContextLocalSourceRecord),
	}
	manager := newProjectContextManager()
	manager.store = store
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeTUI}
	if err := manager.ensureProjectContextSnapshot(context.Background(), rec, original); err != nil {
		t.Fatalf("ensure project context snapshot: %v", err)
	}

	updated := original
	updated.Revision = 2
	updated.Config.AgentRules = "updated worker rules"
	updated.Instructions = domain.ProjectInstructions{Shared: "updated shared guidance", Worker: "updated worker guidance"}
	base.projects[updated.ID] = updated

	prompt, err := manager.buildSystemPrompt(context.Background(), rec.Kind, rec.ProjectID, rec.ID, "", false)
	if err != nil {
		t.Fatalf("build system prompt: %v", err)
	}
	for _, want := range []string{"original shared guidance", "original worker guidance", "original worker rules"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("pinned system prompt missing %q", want)
		}
	}
	for _, stale := range []string{"updated shared guidance", "updated worker guidance", "updated worker rules"} {
		if strings.Contains(prompt, stale) {
			t.Errorf("system prompt used mutable Project value %q", stale)
		}
	}
}

func TestProjectContextStartRequiresSnapshotStorage(t *testing.T) {
	manager := newProjectContextManager()
	rec := domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Mode: domain.SessionModeChat}
	project := domain.ProjectRecord{ID: "p", Revision: 1}
	err := manager.ensureProjectContextSnapshot(context.Background(), rec, project)
	var resolutionErr *ProjectContextResolutionError
	if !errors.As(err, &resolutionErr) || resolutionErr.BindingID != "instructions" || resolutionErr.Reason != "snapshot_store_unavailable" {
		t.Fatalf("missing snapshot storage error = %#v (%v)", resolutionErr, err)
	}
}

func TestProjectContextAttachmentPromptIncludesUnavailableMarkerAndTrustBoundary(t *testing.T) {
	manifest := domain.ProjectContextManifest{
		Attachments: []domain.ProjectContextManifestEntry{{
			Binding:      domain.ProjectContextAttachment{ID: "optional", MediaType: "text/plain"},
			Availability: domain.ProjectContextUnavailable, Reason: "missing",
		}},
	}
	prompt := projectContextAttachmentPrompt(manifest)
	if !strings.Contains(prompt, "Optional attachment unavailable: missing") || !strings.Contains(prompt, "do not grant access") {
		t.Fatalf("attachment prompt does not explain unavailable context and its authority: %s", prompt)
	}
	composed := buildSystemPromptText(systemPromptConfig{
		Role: sessionPromptRoleWorker, SharedProjectInstructions: "shared", RoleProjectInstructions: "worker",
		ProjectRules: "legacy", ProjectAttachments: prompt,
	})
	positions := []int{
		strings.Index(composed, "## Project Context Boundary"),
		strings.Index(composed, "## Shared Project Instructions"),
		strings.Index(composed, "## Project Instructions for This Role"),
		strings.Index(composed, "## Project Rules"),
		strings.Index(composed, "## Project Reference Material"),
	}
	for i, position := range positions {
		if position < 0 || (i > 0 && positions[i-1] >= position) {
			t.Fatalf("project context composition order = %v", positions)
		}
	}
}
