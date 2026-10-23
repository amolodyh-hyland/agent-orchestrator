package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func taskEntry(t *testing.T, id, kind, format, entry string, content map[string]string) domain.LibrarySnapshotEntry {
	t.Helper()
	e := domain.LibraryEntry{SchemaVersion: 1, EntryID: id, SourceID: "source", Kind: kind, Format: format, EntryPoint: entry, Requirements: []string{}}
	for name, text := range content {
		e.Files = append(e.Files, domain.LibraryFile{Path: name, SHA256: domain.LibraryBytesHash([]byte(text)), SizeBytes: int64(len(text)), Mode: "text"})
	}
	var err error
	e.ContentHash, err = e.ComputeContentHash()
	if err != nil {
		t.Fatal(err)
	}
	return domain.LibrarySnapshotEntry{Entry: e, ApprovalID: "approval", Content: content, Status: "unsupported_provider", ReasonCode: "version_evidence_required"}
}
func taskSnapshot(t *testing.T, entries ...domain.LibrarySnapshotEntry) domain.LibrarySnapshot {
	t.Helper()
	s := domain.LibrarySnapshot{SchemaVersion: 1, SnapshotID: "snapshot", SessionID: "task", ProviderID: "claude-code", Channel: domain.SessionModeTUI, Role: domain.ProjectContextRoleWorker, Entries: entries}
	var err error
	s.SnapshotDigest, err = s.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func fixtureTaskEvidence() *taskLibraryEvidence {
	return &taskLibraryEvidence{providerVersion: "fixture-only", resolutionVerified: true, maxBytes: 8 << 20, maxGuidance: 64 << 10}
}
func skillFixture(t *testing.T) domain.LibrarySnapshotEntry {
	return taskEntry(t, "skill", "skill", "native-skill-v1", "review/SKILL.md", map[string]string{"review/SKILL.md": "---\nname: review\ndescription: Review\n---\nRead notes.txt\n", "review/notes.txt": "exact\r\n"})
}
func TestTaskLibraryProductionEvidenceGate(t *testing.T) {
	cfg := ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skillFixture(t)), WorkspacePath: t.TempDir()}
	p, err := New().PrepareTaskLibrary(context.Background(), cfg)
	if err != nil || len(p.Bindings) != 1 || p.Bindings[0].Status != "unsupported_provider" || p.Bindings[0].ReasonCode != "version_evidence_required" || p.Cleanup != nil || p.Rules != "" {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := os.Stat(filepath.Join(cfg.WorkspacePath, ".claude")); !os.IsNotExist(err) {
		t.Fatal("unproved materialization")
	}
	for _, provider := range []string{"codex", "unknown"} {
		cfg.Snapshot.ProviderID = provider
		cfg.Snapshot.SnapshotDigest, _ = cfg.Snapshot.ComputeDigest()
		if _, err := New().PrepareTaskLibrary(context.Background(), cfg); err == nil {
			t.Fatal("unsupported provider admitted")
		}
	}
}
func TestTaskLibraryExactBytesBindingsAndCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("projection unsupported")
	}
	skill := skillFixture(t)
	command := taskEntry(t, "command", "prompt_command", "claude-command-v1", "team/check.md", map[string]string{"team/check.md": "Check $ARGUMENTS and $1\n"})
	rule := taskEntry(t, "rule", "rule", "plain-rule-v1", "guide.md", map[string]string{"guide.md": "Role guidance.\n"})
	cfg := ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skill, command, rule), WorkspacePath: t.TempDir()}
	p, err := prepareTaskLibrary(context.Background(), cfg, fixtureTaskEvidence())
	if err != nil {
		t.Fatal(err)
	}
	if p.Bindings[0].NativeName != "review" || p.Bindings[0].ContentHash != skill.Entry.ContentHash || p.Bindings[1].NativeName != "team:check" || p.Rules != "Role guidance.\n\n" {
		t.Fatalf("%+v", p)
	}
	for _, file := range []struct{ path, text string }{{".claude/skills/review/SKILL.md", skill.Content["review/SKILL.md"]}, {".claude/skills/review/notes.txt", "exact\r\n"}, {".claude/commands/team/check.md", command.Content["team/check.md"]}} {
		data, err := os.ReadFile(filepath.Join(cfg.WorkspacePath, file.path))
		if err != nil || string(data) != file.text {
			t.Fatalf("%s: %q %v", file.path, data, err)
		}
	}
	if err := p.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cfg.WorkspacePath, ".claude")); !os.IsNotExist(err) {
		t.Fatal("owned directories retained")
	}
}
func TestTaskLibraryNativeCollisionsAndBudgets(t *testing.T) {
	skill := skillFixture(t)
	command := taskEntry(t, "command", "prompt_command", "claude-command-v1", "review.md", map[string]string{"review.md": "Review"})
	p, err := prepareTaskLibrary(context.Background(), ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skill, command), WorkspacePath: t.TempDir()}, fixtureTaskEvidence())
	if err != nil || p.Bindings[0].Status != "conflict" || p.Bindings[1].Status != "conflict" {
		t.Fatalf("%+v %v", p, err)
	}
	evidence := fixtureTaskEvidence()
	evidence.externalNames = []string{"review"}
	p, err = prepareTaskLibrary(context.Background(), ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skill), WorkspacePath: t.TempDir()}, evidence)
	if err != nil || p.Bindings[0].Status != "conflict" {
		t.Fatalf("%+v %v", p, err)
	}
	evidence = fixtureTaskEvidence()
	evidence.maxBytes = 1
	if _, err = prepareTaskLibrary(context.Background(), ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skill), WorkspacePath: t.TempDir()}, evidence); err == nil || !strings.Contains(err.Error(), "runtime_limit") {
		t.Fatal(err)
	}
}
func TestTaskLibraryDigestAndUnsupportedBehavior(t *testing.T) {
	skill := skillFixture(t)
	s := taskSnapshot(t, skill)
	s.Entries[0].Content["review/notes.txt"] = "changed"
	if _, err := New().PrepareTaskLibrary(context.Background(), ports.TaskLibraryConfig{Snapshot: s}); err == nil {
		t.Fatal("mutated snapshot admitted")
	}
	for _, test := range []struct{ kind, format, text string }{{"hook", "hook-inventory-v1", "run"}, {"skill", "native-skill-v1", "---\nname: review\nhooks: run\n---\nText"}, {"rule", "plain-rule-v1", "---\npaths: src/*\n---\nRule"}} {
		e := taskEntry(t, "entry", test.kind, test.format, "review/SKILL.md", map[string]string{"review/SKILL.md": test.text})
		p, err := New().PrepareTaskLibrary(context.Background(), ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, e), WorkspacePath: t.TempDir()})
		if err != nil || p.Bindings[0].Status != "unsupported_format" {
			t.Fatalf("%+v %v", p, err)
		}
	}
}
func TestTaskLibraryRollbackAndCleanupPreservesEdits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("projection unsupported")
	}
	workspace := t.TempDir()
	native := filepath.Join(workspace, ".claude/skills/review/SKILL.md")
	if err := os.MkdirAll(filepath.Dir(native), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(native, []byte("user owned"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := materializeTaskLibrary(context.Background(), workspace, []taskLibraryFile{{".claude/commands/check.md", "text"}, {".claude/skills/review/SKILL.md", "overwrite"}})
	if err == nil {
		t.Fatal("existing native file overwritten")
	}
	if _, err := os.Stat(filepath.Join(workspace, ".claude/commands")); !os.IsNotExist(err) {
		t.Fatal("partial projection retained")
	}
	data, _ := os.ReadFile(native)
	if string(data) != "user owned" {
		t.Fatal("user bytes changed")
	}
	cfg := ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skillFixture(t)), WorkspacePath: t.TempDir()}
	p, err := prepareTaskLibrary(context.Background(), cfg, fixtureTaskEvidence())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(cfg.WorkspacePath, ".claude/skills/review/notes.txt")
	if err := os.Chmod(target, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("user edit"), 0600); err != nil {
		t.Fatal(err)
	}
	addition := filepath.Join(filepath.Dir(target), "added.md")
	if err := os.WriteFile(addition, []byte("added"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.Cleanup(); err == nil {
		t.Fatal("cleanup conflict hidden")
	}
	for _, name := range []string{target, addition} {
		if _, err := os.Stat(name); err != nil {
			t.Fatal("user changes removed")
		}
	}
}

func TestTaskLibrarySymlinkAndReplacementCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("projection unsupported")
	}
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(workspace, ".claude")); err != nil {
		t.Fatal(err)
	}
	if _, err := materializeTaskLibrary(context.Background(), workspace, []taskLibraryFile{{".claude/commands/check.md", "text"}}); err == nil {
		t.Fatal("native lookup symlink followed")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("outside path changed")
	}
	cfg := ports.TaskLibraryConfig{Snapshot: taskSnapshot(t, skillFixture(t)), WorkspacePath: t.TempDir()}
	p, err := prepareTaskLibrary(context.Background(), cfg, fixtureTaskEvidence())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(cfg.WorkspacePath, ".claude/skills/review/notes.txt")
	if err := os.Rename(target, target+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("exact\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := p.Cleanup(); err == nil {
		t.Fatal("replacement with identical bytes removed")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("replacement removed")
	}
}

func TestTaskLibraryCapabilitiesStayUnsupported(t *testing.T) {
	c := New().TaskLibraryCapabilities()
	if c.Surface != "task" || c.ProviderID != "claude-code" || c.Status != "unsupported_provider" || c.ReasonCode != "version_evidence_required" || c.CanList || c.CanInvoke || c.CanBindExactEntry || c.CanMaterialize || c.CanReloadSameSnapshot {
		t.Fatalf("unproved capability: %+v", c)
	}
}
