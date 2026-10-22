package library

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

type policyFunc func(context.Context, PolicyRequest) (PolicyDecision, error)

func (f policyFunc) CheckLibrary(c context.Context, r PolicyRequest) (PolicyDecision, error) {
	return f(c, r)
}

type fixture struct {
	svc    *Service
	store  *sqlitestore.Store
	root   string
	t      *testing.T
	result Result
}

func newFixture(t *testing.T, kind string) *fixture {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{svc: New(store, "local_user", "authority", "resolver", nil), store: store, root: root, t: t}
	f.apply(Operation{Operation: "register", SourceID: "source", Scope: "personal", RootKind: kind, LocalPath: root})
	return f
}
func (f *fixture) apply(in Operation) Result {
	f.t.Helper()
	in.ExpectedRevision = f.result.Revision
	r, err := f.svc.Operate(context.Background(), in)
	if err != nil {
		f.t.Fatalf("%s: %v", in.Operation, err)
	}
	f.result = r
	return r
}
func (f *fixture) write(name, text string) {
	f.t.Helper()
	p := filepath.Join(f.root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(text), 0600); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) inspect() Result {
	root := f.result.Sources[0].LibraryRootIdentity
	f.apply(Operation{Operation: "allow_inspection", SourceID: "source", RootIdentity: &root})
	return f.apply(Operation{Operation: "inspect", SourceID: "source"})
}
func (f *fixture) approve() Result {
	f.t.Helper()
	entries := []domain.LibrarySelectedEntry{}
	purposes := []string{}
	seen := map[string]bool{}
	for _, e := range f.result.Entries {
		entries = append(entries, domain.LibrarySelectedEntry{EntryID: e.EntryID, ContentHash: e.ContentHash})
		p := entryPurpose(e.Kind)
		if !seen[p] {
			purposes = append(purposes, p)
			seen[p] = true
		}
	}
	root := f.result.Sources[0].LibraryRootIdentity
	return f.apply(Operation{Operation: "approve", SourceID: "source", RootIdentity: &root, Entries: entries, Purposes: purposes})
}
func TestLibraryInspectionConsentOwnershipAndSanitization(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "Guidance\n")
	if _, err := f.svc.Operate(context.Background(), Operation{Operation: "inspect", SourceID: "source", ExpectedRevision: f.result.Revision}); reason(err) != "inspection_required" {
		t.Fatalf("err=%v", err)
	}
	f.inspect()
	if len(f.result.Entries) != 1 || f.result.Entries[0].Status != "unsupported_provider" {
		t.Fatalf("catalog=%+v", f.result)
	}
	listing, err := f.svc.Operate(context.Background(), Operation{Operation: "list"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(listing)
	if strings.Contains(string(encoded), f.root) || strings.Contains(string(encoded), "Guidance") {
		t.Fatal("catalog leaked locator or content")
	}
	foreign := New(f.store, "other", "authority", "resolver", nil)
	if _, err := foreign.Operate(context.Background(), Operation{Operation: "inspect", SourceID: "source", ExpectedRevision: f.result.Revision}); reason(err) != "owner_mismatch" {
		t.Fatalf("foreign inspection=%v", err)
	}
	f.approve()
	if f.result.Approvals[0].State != "approved" {
		t.Fatal("not approved")
	}
	a := f.result.Approvals[0]
	f.apply(Operation{Operation: "revoke", ApprovalID: a.ApprovalID})
	if f.result.TrustEpoch != 1 || f.result.Approvals[0].State != "revoked" {
		t.Fatal("trust epoch not advanced")
	}
}
func TestLibraryIdentitySurvivesEditsAndNamesDoNotMerge(t *testing.T) {
	f := newFixture(t, "claude-skills")
	f.write("one/SKILL.md", "---\nname: review\ndescription: first\n---\nInstructions\n")
	f.write("two/SKILL.md", "---\nname: review\n---\nOther\n")
	f.inspect()
	ids := map[string]string{}
	hashes := map[string]string{}
	for _, e := range f.result.Entries {
		ids[e.EntryPoint] = e.EntryID
		hashes[e.EntryPoint] = e.ContentHash
	}
	if len(ids) != 2 {
		t.Fatal("names deduplicated")
	}
	f.approve()
	f.write("one/SKILL.md", "---\nname: renamed\n---\nChanged\n")
	f.apply(Operation{Operation: "inspect", SourceID: "source"})
	for _, e := range f.result.Entries {
		if e.EntryID != ids[e.EntryPoint] {
			t.Fatal("identity changed")
		}
		if e.EntryPoint == "one/SKILL.md" && e.ContentHash == hashes[e.EntryPoint] {
			t.Fatal("content unchanged")
		}
	}
	state, _ := f.store.ReadLibraryRegistry(context.Background())
	for _, e := range f.result.Entries {
		if e.EntryPoint == "one/SKILL.md" {
			if _, err := f.svc.approvalFor(state, state.Entries[e.EntryID], PolicyDecision{}); err == nil {
				t.Fatal("old approval accepted")
			}
		}
	}
}
func TestLibraryPolicyAbsentOptionalRequiredAndManaged(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	for _, tc := range []struct{ state, mode, want string }{{"absent", "", ""}, {"unverifiable", "optional", ""}, {"unverifiable", "required", "policy_unavailable"}, {"verified", "required", "policy_denied"}} {
		f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
			return PolicyDecision{State: tc.state, Mode: tc.mode, Denied: tc.state == "verified"}, nil
		})
		result, err := f.svc.Operate(context.Background(), Operation{Operation: "list"})
		if tc.want != "" {
			if reason(err) != tc.want {
				t.Fatalf("err=%v", err)
			}
		} else if err != nil {
			t.Fatal(err)
		} else if tc.mode == "optional" && len(result.Warnings) != 1 {
			t.Fatal("optional warning missing")
		}
	}
	f.svc.policy = nil
	if _, err := f.svc.Operate(context.Background(), Operation{Operation: "register", SourceID: "managed", Scope: "managed", RootKind: "rules", LocalPath: t.TempDir(), ExpectedRevision: f.result.Revision}); reason(err) != "managed_lock" {
		t.Fatalf("managed=%v", err)
	}
}
func TestLibraryExpiredApprovalRootGenerationAndNoRepoBinding(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "text")
	f.inspect()
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	f.svc.clock = func() time.Time { return now }
	root := f.result.Sources[0].LibraryRootIdentity
	e := f.result.Entries[0]
	f.apply(Operation{Operation: "approve", SourceID: "source", RootIdentity: &root, Entries: []domain.LibrarySelectedEntry{{EntryID: e.EntryID, ContentHash: e.ContentHash}}, Purposes: []string{"load_context"}, ExpiresAt: domain.LibraryTimestamp(now.Add(time.Minute))})
	project := domain.ProjectRecord{ID: "planning", Kind: domain.ProjectKindScratch, RegisteredAt: now}
	if err := f.store.UpsertProject(context.Background(), project); err != nil {
		f.t.Fatal(err)
	}
	b := domain.LibraryBinding{BindingID: "binding", OwnerID: "local_user", ProjectID: "planning", SourceID: "source", EntryID: e.EntryID, ApprovedContentHash: e.ContentHash, Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true, Required: true}
	f.apply(Operation{Operation: "bind", Binding: &b})
	now = now.Add(2 * time.Minute)
	if _, err := f.svc.Operate(context.Background(), Operation{Operation: "bind", Binding: &b, ExpectedRevision: f.result.Revision}); err == nil {
		t.Fatal("expired approval accepted")
	}
	f.apply(Operation{Operation: "rebind", SourceID: "source", LocalPath: f.root})
	if f.result.Sources[0].RootGeneration != 2 || f.result.Sources[0].InspectionState != "registered" {
		t.Fatal("root generation unchanged")
	}
}
func TestLibraryUnsupportedFeaturesStayInventory(t *testing.T) {
	for _, tc := range []struct{ kind, path, text, entryKind string }{{"claude-commands", "run.md", "!`uname`", "executable_command"}, {"claude-personas", "role.md", "Role text", "persona"}, {"hooks", "hook.json", "{}", "hook"}, {"claude-skills", "one/SKILL.md", "---\nname: one\nallowed-tools: Bash\n---\nDo work", "skill"}} {
		t.Run(tc.kind, func(t *testing.T) {
			f := newFixture(t, tc.kind)
			f.write(tc.path, tc.text)
			f.inspect()
			e := f.result.Entries[0]
			if e.Kind != tc.entryKind || e.Status != "unsupported_format" {
				t.Fatalf("entry=%+v", e)
			}
			root := f.result.Sources[0].LibraryRootIdentity
			if _, err := f.svc.Operate(context.Background(), Operation{Operation: "approve", SourceID: "source", ExpectedRevision: f.result.Revision, RootIdentity: &root, Entries: []domain.LibrarySelectedEntry{{EntryID: e.EntryID, ContentHash: e.ContentHash}}, Purposes: []string{entryPurpose(e.Kind)}}); err == nil {
				t.Fatal("unsupported approval accepted")
			}
		})
	}
}
