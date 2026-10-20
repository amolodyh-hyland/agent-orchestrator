//go:build !windows

package sessionmanager

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestProjectContextFIFOSourceIsRejectedWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pipe.md"), 0o600); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}
	binding := domain.ProjectContextAttachment{
		ID: "pipe", SourceKind: domain.ProjectContextRepoRelativeFile, SourceRef: "pipe-source", MachineID: "machine-a",
		MediaType: "text/markdown", Roles: []domain.ProjectContextRole{domain.ProjectContextRoleShared}, Enabled: true,
	}
	manager := newProjectContextManager()
	manager.store = &projectContextTestStore{sources: map[string]domain.ProjectContextLocalSourceRecord{
		"pipe-source": {SourceRef: "pipe-source", MachineID: "machine-a", RootPath: root, RelativePath: "pipe.md", MediaType: "text/markdown", OwnerKind: domain.ProjectContextOwnerProject, OwnerID: "p"},
	}}
	manager.SetProjectContextMachineID("machine-a")
	project := domain.ProjectRecord{ID: "p", Revision: 1}

	done := make(chan struct{})
	var entry domain.ProjectContextManifestEntry
	var err error
	go func() {
		defer close(done)
		entry, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("resolving a FIFO source blocked")
	}
	if err != nil {
		t.Fatalf("optional FIFO source: %v", err)
	}
	if entry.Availability != domain.ProjectContextUnavailable || entry.Reason != "not_regular" {
		t.Fatalf("FIFO entry = %#v, want unavailable/not_regular", entry)
	}

	binding.Required = true
	_, _, err = manager.resolveProjectContextAttachment(context.Background(), project, domain.ProjectContextRoleWorker, "p-1", binding)
	if err == nil {
		t.Fatal("required FIFO source resolved")
	}
}

func TestProjectContextOpenHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := openProjectContextFile(ctx, t.TempDir(), "a.md", 10); err != context.Canceled {
		t.Fatalf("open with cancelled context = %v, want context.Canceled", err)
	}
}
