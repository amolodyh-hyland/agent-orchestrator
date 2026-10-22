package library

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func (f *fixture) session(projectID domain.ProjectID) (domain.SessionRecord, domain.ProjectContextManifest, domain.ProjectRecord) {
	f.t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	var project domain.ProjectRecord
	if projectID != "" {
		if p, found, err := f.store.GetProject(ctx, string(projectID)); err != nil {
			f.t.Fatal(err)
		} else if found {
			project = p
		} else {
			project = domain.ProjectRecord{ID: string(projectID), Kind: domain.ProjectKindScratch, Path: f.root, RegisteredAt: now}
			if err := f.store.UpsertProject(ctx, project); err != nil {
				f.t.Fatal(err)
			}
			project, _, _ = f.store.GetProject(ctx, string(projectID))
		}
	}
	rec, err := f.store.CreateSession(ctx, domain.SessionRecord{ProjectID: projectID, Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode, Mode: domain.SessionModeTUI, Activity: domain.Activity{State: domain.ActivityActive, LastActivityAt: now}, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		f.t.Fatal(err)
	}
	parent := domain.ProjectContextManifest{SessionID: rec.ID, ProjectID: projectID, ProjectRevision: project.Revision, Role: domain.ProjectContextRoleWorker, Channel: domain.SessionModeTUI, CreatedAt: now, Attachments: []domain.ProjectContextManifestEntry{}}
	parent.Digest, err = parent.ComputeDigest()
	if err != nil {
		f.t.Fatal(err)
	}
	return rec, parent, project
}
func (f *fixture) bindEntry(projectID domain.ProjectID, sessionID domain.SessionID, required bool, role domain.ProjectContextRole) {
	f.t.Helper()
	e := f.result.Entries[0]
	f.apply(Operation{Operation: "bind", Binding: &domain.LibraryBinding{BindingID: "binding", OwnerID: "local_user", ProjectID: projectID, SessionID: sessionID, SourceID: "source", EntryID: e.EntryID, ApprovedContentHash: e.ContentHash, Roles: []domain.ProjectContextRole{role}, Required: required, Enabled: true}})
}
func TestLibraryAtomicSnapshotRetainsBytesAcrossEditsDetachAndArchive(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "original guidance")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	pinned, found, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || !found || len(pinned.Entries) != 1 || pinned.Entries[0].Content["guide.md"] != "original guidance" {
		t.Fatalf("snapshot=%+v err=%v", pinned, err)
	}
	contextSnapshot, found, err := f.store.GetProjectContextSnapshot(context.Background(), rec.ID)
	if err != nil || !found || pinned.ProjectContextDigest != contextSnapshot.Digest {
		t.Fatal("selection not linked")
	}
	f.write("guide.md", "changed outside")
	f.apply(Operation{Operation: "detach_binding", BindingID: "binding"})
	f.apply(Operation{Operation: "detach_source", SourceID: "source"})
	if _, err := f.store.ArchiveProject(context.Background(), "planning", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); err != nil {
		t.Fatal(err)
	}
	retained, _, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || retained.SnapshotDigest != pinned.SnapshotDigest || retained.ProviderID != "claude-code" || retained.Entries[0].Content["guide.md"] != "original guidance" {
		t.Fatal("snapshot changed")
	}
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(filepath.Join(f.root, "guide.md"))
	if err != nil || string(source) != "changed outside" {
		t.Fatal("source modified or deleted")
	}
	result, err := f.svc.Operate(context.Background(), Operation{Operation: "session", SessionID: rec.ID})
	if err != nil || result.RuntimeBindings[0].CanInvoke || result.RuntimeBindings[0].Status != "unsupported_provider" {
		t.Fatalf("runtime=%+v err=%v", result, err)
	}
}
func TestLibraryConcurrentSnapshotRetryUsesOneAtomicWinner(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			svc := New(f.store, "local_user", "authority", "resolver", nil)
			errs <- svc.Pin(context.Background(), parent, project, "claude-code")
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	pinned, found, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	parent.SharedInstructions = "changed retry"
	parent.Digest, _ = parent.ComputeDigest()
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	retained, _, _ := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if retained.SnapshotDigest != pinned.SnapshotDigest {
		t.Fatal("retry replaced winner")
	}
}
func TestLibraryChangedRequiredSourceAndAtomicFailure(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", true, domain.ProjectContextRoleShared)
	f.write("guide.md", "changed")
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); reason(err) != "changed_content" {
		t.Fatalf("err=%v", err)
	}
	if _, found, _ := f.store.GetProjectContextSnapshot(context.Background(), rec.ID); found {
		t.Fatal("partial parent published")
	}
	f.write("guide.md", "text")
	parent.ProjectRevision++
	parent.Digest, _ = parent.ComputeDigest()
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err == nil {
		t.Fatal("stale project revision accepted")
	}
	if _, found, _ := f.store.GetProjectContextSnapshot(context.Background(), rec.ID); found {
		t.Fatal("failed transaction left parent")
	}
	parent.ProjectRevision--
	parent.Digest, _ = parent.ComputeDigest()
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); reason(err) != "version_evidence_required" {
		t.Fatalf("required launch=%v", err)
	}
}
func TestLibraryOptionalOmissionRolesAndStandaloneOwnership(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	_, parent, project := f.session("")
	f.bindEntry("", parent.SessionID, false, domain.ProjectContextRoleChat)
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); err != nil {
		t.Fatal(err)
	}
	snapshot, _, _ := f.store.GetLibrarySnapshot(context.Background(), parent.SessionID)
	if len(snapshot.Entries) != 0 {
		t.Fatal("chat binding leaked into task")
	}
	_, next, _ := f.session("")
	f.bindEntry("", parent.SessionID, false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), next, project, "codex"); err != nil {
		t.Fatal(err)
	}
	snapshot, _, _ = f.store.GetLibrarySnapshot(context.Background(), next.SessionID)
	if len(snapshot.Entries) != 0 {
		t.Fatal("standalone binding leaked into another session")
	}
	f.apply(Operation{Operation: "detach_binding", BindingID: "binding"})
	f.bindEntry("", next.SessionID, false, domain.ProjectContextRoleShared)
	f.write("guide.md", "different")
	thirdRec, third, _ := f.session("")
	_ = thirdRec
	f.apply(Operation{Operation: "detach_binding", BindingID: "binding"})
	f.bindEntry("", third.SessionID, false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), third, project, "codex"); err != nil {
		t.Fatal(err)
	}
	snapshot, _, _ = f.store.GetLibrarySnapshot(context.Background(), third.SessionID)
	if len(snapshot.Entries) != 1 || snapshot.Entries[0].Status != "changed_content" || len(snapshot.Entries[0].Content) != 0 {
		t.Fatalf("optional=%+v", snapshot)
	}
}
func TestLibraryAggregateContextAndLowerBudgets(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", strings.Repeat("g", 1024))
	f.inspect()
	f.approve()
	_, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	parent.SharedInstructions = strings.Repeat("x", domain.MaxProjectContextInstructionBytes)
	parent.Digest, _ = parent.ComputeDigest()
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); reason(err) != "runtime_limit" {
		t.Fatalf("guidance limit=%v", err)
	}
	parent.SharedInstructions = ""
	parent.Attachments = []domain.ProjectContextManifestEntry{{Availability: domain.ProjectContextAvailable, ByteCount: domain.MaxProjectContextSessionBytes - 512}}
	parent.Digest, _ = parent.ComputeDigest()
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); reason(err) != "runtime_limit" {
		t.Fatalf("shared byte limit=%v", err)
	}
	parent.Attachments = nil
	parent.Digest, _ = parent.ComputeDigest()
	f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
		return PolicyDecision{State: "verified", MaxSessionBytes: 100}, nil
	})
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); reason(err) != "runtime_limit" {
		t.Fatalf("lower limit=%v", err)
	}
}
func TestLibraryRevocationClosesDirectTerminalImplicitAndControlledChat(t *testing.T) {
	f := newFixture(t, "claude-skills")
	f.write("review/SKILL.md", "---\nname: review\n---\nReview selected changes\n")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	release, ok := f.svc.AcquireTaskInput(rec.ID)
	if !ok {
		t.Fatal("initial input denied")
	}
	release()
	if release, err := f.svc.AcquireChatInput(context.Background(), rec.ID, "/review"); err == nil {
		release()
		t.Fatal("inert explicit invocation accepted")
	}
	for _, text := range []string{"please review the changes", "/unrelated-built-in"} {
		release, err := f.svc.AcquireChatInput(context.Background(), rec.ID, text)
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	approvalID := f.result.Approvals[0].ApprovalID
	f.apply(Operation{Operation: "revoke", ApprovalID: approvalID})
	if release, ok := f.svc.AcquireTaskInput(rec.ID); ok {
		release()
		t.Fatal("raw terminal write admitted after revoke")
	}
	for _, text := range []string{"/review", "$review", "please review the changes", "continue"} {
		if release, err := f.svc.AcquireChatInput(context.Background(), rec.ID, text); err == nil {
			release()
			t.Fatalf("revoked input admitted: %q", text)
		}
	}
	result, err := f.svc.Operate(context.Background(), Operation{Operation: "session", SessionID: rec.ID})
	if err != nil || result.Admission.InputAllowed || !result.Admission.StopRequired || !result.Admission.ReplacementRequired || result.Admission.MidTurnBoundary != "not_enforceable" {
		t.Fatalf("admission=%+v err=%v", result.Admission, err)
	}
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); reason(err) != "revoked" {
		t.Fatalf("resume=%v", err)
	}
	rec.IsTerminated = true
	if err := f.store.UpdateSession(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	result, err = f.svc.Operate(context.Background(), Operation{Operation: "session", SessionID: rec.ID})
	if err != nil || result.Admission.State != "stopped_replacement_required" || result.Admission.StopRequired {
		t.Fatalf("stopped admission=%+v err=%v", result.Admission, err)
	}
	retained, found, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || !found || len(retained.Entries[0].Content) == 0 {
		t.Fatal("revocation erased retained bytes")
	}
}
func TestLibraryRevocationWaitsForAdmittedWriteAndNeverReopensOldSession(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); err != nil {
		t.Fatal(err)
	}
	release, ok := f.svc.AcquireTaskInput(rec.ID)
	if !ok {
		t.Fatal("initial admission denied")
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	operation := Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision}
	go func() { close(started); _, err := f.svc.Operate(context.Background(), operation); done <- err }()
	<-started
	select {
	case err := <-done:
		t.Fatalf("revocation bypassed outstanding write: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation did not drain")
	}
	f.result, _ = f.svc.Operate(context.Background(), Operation{Operation: "list"})
	f.approve()
	if release, ok := f.svc.AcquireTaskInput(rec.ID); ok {
		release()
		t.Fatal("new approval reopened revoked snapshot")
	}
}

func TestLibraryManagedLocksCannotDetachRevokeRebindOrShadow(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	_, _, _ = f.session("planning")
	e := f.result.Entries[0]
	lock := domain.LibraryBinding{BindingID: "managed_required", OwnerID: "policy_authority", ProjectID: "planning", SourceID: "source", EntryID: e.EntryID, ApprovedContentHash: e.ContentHash, Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true, Required: true}
	f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
		return PolicyDecision{State: "verified", Locks: []domain.LibraryBinding{lock}}, nil
	})
	for _, operation := range []Operation{
		{Operation: "detach_source", SourceID: "source"},
		{Operation: "rebind", SourceID: "source", LocalPath: f.root},
		{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID},
		{Operation: "bind", Binding: &domain.LibraryBinding{BindingID: "shadow", OwnerID: "local_user", ProjectID: "planning", SourceID: "source", EntryID: e.EntryID, ApprovedContentHash: e.ContentHash, Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true}},
	} {
		operation.ExpectedRevision = f.result.Revision
		if _, err := f.svc.Operate(context.Background(), operation); reason(err) != "managed_lock" {
			t.Fatalf("%s err=%v", operation.Operation, err)
		}
	}
}
func TestLibraryEmptySelectionPreservesUnrelatedSessionsAndExpiredRetainedApproval(t *testing.T) {
	f := newFixture(t, "rules")
	rec, parent, project := f.session("empty")
	f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
		return PolicyDecision{State: "unverifiable", Mode: "required"}, nil
	})
	if err := f.svc.Pin(context.Background(), parent, project, "unknown"); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); err != nil {
		t.Fatal(err)
	}
	f.svc.policy = nil
	f.write("guide.md", "text")
	f.inspect()
	now := time.Now().UTC()
	f.svc.clock = func() time.Time { return now }
	root := f.result.Sources[0].LibraryRootIdentity
	e := f.result.Entries[0]
	f.apply(Operation{Operation: "approve", SourceID: "source", RootIdentity: &root, Entries: []domain.LibrarySelectedEntry{{EntryID: e.EntryID, ContentHash: e.ContentHash}}, Purposes: []string{"load_context"}, ExpiresAt: domain.LibraryTimestamp(now.Add(time.Minute))})
	rec, parent, project = f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	if release, ok := f.svc.AcquireTaskInput(rec.ID); ok {
		release()
		t.Fatal("expired retained approval admitted input")
	}
}

func TestLibrarySnapshotTransactionRollsBackParentOnChildConflictAndChecksOwnership(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	_, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); err != nil {
		t.Fatal(err)
	}
	child, _, err := f.store.GetLibrarySnapshot(context.Background(), parent.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	_, next, _ := f.session("planning")
	child.SessionID = next.SessionID
	child.ProjectContextDigest = next.Digest
	child.SnapshotDigest, _ = child.ComputeDigest()
	if _, err := f.store.CreateLibrarySessionSelection(context.Background(), next, child, f.result.Revision); err == nil {
		t.Fatal("duplicate snapshot ID accepted")
	}
	if _, found, _ := f.store.GetProjectContextSnapshot(context.Background(), next.SessionID); found {
		t.Fatal("child failure left parent snapshot")
	}
	_, foreign, _ := f.session("other")
	child.SessionID = foreign.SessionID
	foreign.ProjectID = parent.ProjectID
	foreign.ProjectRevision = parent.ProjectRevision
	foreign.Digest, _ = foreign.ComputeDigest()
	child.SnapshotID = "snap_foreign"
	child.ProjectContextDigest = foreign.Digest
	child.SnapshotDigest, _ = child.ComputeDigest()
	if _, err := f.store.CreateLibrarySessionSelection(context.Background(), foreign, child, f.result.Revision); err == nil {
		t.Fatal("cross-Project context attachment accepted")
	}
	if _, found, _ := f.store.GetProjectContextSnapshot(context.Background(), foreign.SessionID); found {
		t.Fatal("ownership failure left parent")
	}
}

func TestLibraryRetainedSnapshotAndRevocationSurviveStoreRestart(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "codex"); err != nil {
		t.Fatal(err)
	}
	pinned, _, _ := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := sqlite.OpenPreMigrated(f.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	f.store = reopened
	f.svc = New(reopened, "local_user", "authority", "resolver", nil)
	if err := os.RemoveAll(f.root); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); err != nil {
		t.Fatal(err)
	}
	got, found, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || !found || got.SnapshotDigest != pinned.SnapshotDigest {
		t.Fatal("retained snapshot lost")
	}
	f.apply(Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID})
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := sqlite.OpenPreMigrated(f.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	restored := New(again, "local_user", "authority", "resolver", nil)
	if release, ok := restored.AcquireTaskInput(rec.ID); ok {
		release()
		t.Fatal("restart reopened revoked input")
	}
}
