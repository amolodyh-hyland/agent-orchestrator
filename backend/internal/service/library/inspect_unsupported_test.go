//go:build !darwin && !linux

package library

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestLibraryInspectionExplicitlyRefusesUnsupportedPlatform(t *testing.T) {
	_, err := inspectRoot(context.Background(), domain.LibraryLocalSource{RootPath: t.TempDir()}, nil, "authority")
	if reason(err) != "inspection_unsupported_platform" {
		t.Fatalf("unexpected refusal: %v", err)
	}
}
