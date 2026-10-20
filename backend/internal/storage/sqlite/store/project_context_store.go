package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// CreateProjectContextSnapshot inserts a session's pinned context exactly once.
// It returns false when another launch path already wrote the immutable snapshot.
func (s *Store) CreateProjectContextSnapshot(ctx context.Context, manifest domain.ProjectContextManifest) (bool, error) {
	if manifest.SessionID == "" {
		return false, fmt.Errorf("project context snapshot requires a session id")
	}
	if manifest.ProjectRevision < 0 || manifest.CreatedAt.IsZero() {
		return false, fmt.Errorf("project context snapshot has invalid revision or creation time")
	}
	if err := manifest.VerifyDigest(); err != nil {
		return false, err
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return false, fmt.Errorf("marshal project context snapshot: %w", err)
	}
	var projectID sql.NullString
	if manifest.ProjectID != "" {
		projectID = sql.NullString{String: string(manifest.ProjectID), Valid: true}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.InsertProjectContextSnapshot(ctx, gen.InsertProjectContextSnapshotParams{
		SessionID:       string(manifest.SessionID),
		ProjectID:       projectID,
		ProjectRevision: manifest.ProjectRevision,
		ManifestJson:    string(data),
		Digest:          manifest.Digest,
		CreatedAt:       manifest.CreatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("create project context snapshot for session %s: %w", manifest.SessionID, err)
	}
	return rows == 1, nil
}

// GetProjectContextSnapshot reads and verifies the immutable per-session manifest.
func (s *Store) GetProjectContextSnapshot(ctx context.Context, id domain.SessionID) (domain.ProjectContextManifest, bool, error) {
	row, err := s.qr.GetProjectContextSnapshot(ctx, string(id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ProjectContextManifest{}, false, nil
	}
	if err != nil {
		return domain.ProjectContextManifest{}, false, fmt.Errorf("get project context snapshot for session %s: %w", id, err)
	}
	var manifest domain.ProjectContextManifest
	if err := json.Unmarshal([]byte(row.ManifestJson), &manifest); err != nil {
		return domain.ProjectContextManifest{}, false, fmt.Errorf("decode project context snapshot for session %s: %w", id, err)
	}
	if manifest.SessionID != id || manifest.Digest != row.Digest || manifest.ProjectRevision != row.ProjectRevision {
		return domain.ProjectContextManifest{}, false, fmt.Errorf("project context snapshot for session %s does not match its index", id)
	}
	if row.ProjectID.Valid && manifest.ProjectID != domain.ProjectID(row.ProjectID.String) {
		return domain.ProjectContextManifest{}, false, fmt.Errorf("project context snapshot for session %s has a different project id", id)
	}
	if err := manifest.VerifyDigest(); err != nil {
		return domain.ProjectContextManifest{}, false, fmt.Errorf("verify project context snapshot for session %s: %w", id, err)
	}
	return manifest, true, nil
}

// UpsertProjectContextLocalSource stores an opaque source reference and its
// machine-only locator. RootPath and RelativePath are never returned in project
// read models or manifests.
func (s *Store) UpsertProjectContextLocalSource(ctx context.Context, source domain.ProjectContextLocalSourceRecord) error {
	if !validLocalContextToken(source.SourceRef, domain.MaxProjectContextSourceReferenceBytes) || strings.TrimSpace(source.MachineID) == "" || len(source.MachineID) > domain.MaxProjectContextMachineIDBytes || !filepath.IsAbs(source.RootPath) || !validLocalContextRelativePath(source.RelativePath) {
		return fmt.Errorf("project context local source has an invalid reference, machine id, or path")
	}
	if source.OwnerKind == "" {
		source.OwnerKind = domain.ProjectContextOwnerUser
	}
	if source.OwnerKind != domain.ProjectContextOwnerUser && source.OwnerKind != domain.ProjectContextOwnerProject {
		return fmt.Errorf("project context local source has an unsupported owner kind")
	}
	if len(source.OwnerID) > 128 || (source.OwnerKind == domain.ProjectContextOwnerUser && strings.TrimSpace(source.OwnerID) == "") {
		return fmt.Errorf("project context local source has an invalid owner id")
	}
	if source.MediaType == "" || len(source.MediaType) > 128 {
		return fmt.Errorf("project context local source requires a valid media type")
	}
	if _, _, err := mime.ParseMediaType(source.MediaType); err != nil {
		return fmt.Errorf("project context local source has an invalid media type")
	}
	if source.RegisteredAt.IsZero() {
		source.RegisteredAt = time.Now().UTC()
	}
	if source.UpdatedAt.IsZero() {
		source.UpdatedAt = source.RegisteredAt
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := s.qw.UpsertProjectContextLocalSource(ctx, gen.UpsertProjectContextLocalSourceParams{
		SourceRef:    source.SourceRef,
		MachineID:    source.MachineID,
		RootPath:     source.RootPath,
		RelativePath: source.RelativePath,
		MediaType:    source.MediaType,
		OwnerKind:    string(source.OwnerKind),
		OwnerID:      source.OwnerID,
		RegisteredAt: source.RegisteredAt,
		UpdatedAt:    source.UpdatedAt,
	})
	if err != nil {
		return fmt.Errorf("upsert project context local source %s: %w", source.SourceRef, err)
	}
	return nil
}

// GetProjectContextLocalSource returns a locator only to the local resolver.
func (s *Store) GetProjectContextLocalSource(ctx context.Context, sourceRef string) (domain.ProjectContextLocalSourceRecord, bool, error) {
	row, err := s.qr.GetProjectContextLocalSource(ctx, sourceRef)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ProjectContextLocalSourceRecord{}, false, nil
	}
	if err != nil {
		return domain.ProjectContextLocalSourceRecord{}, false, fmt.Errorf("get project context local source %s: %w", sourceRef, err)
	}
	return domain.ProjectContextLocalSourceRecord{
		SourceRef:    row.SourceRef,
		MachineID:    row.MachineID,
		RootPath:     row.RootPath,
		RelativePath: row.RelativePath,
		MediaType:    row.MediaType,
		OwnerKind:    domain.ProjectContextOwnerKind(row.OwnerKind),
		OwnerID:      row.OwnerID,
		RegisteredAt: row.RegisteredAt,
		UpdatedAt:    row.UpdatedAt,
	}, true, nil
}

func validLocalContextRelativePath(value string) bool {
	if value == "" || len(value) > domain.MaxProjectContextSourceReferenceBytes || strings.TrimSpace(value) != value || filepath.IsAbs(value) || strings.Contains(value, `\`) {
		return false
	}
	clean := filepath.Clean(value)
	return clean != "." && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

func validLocalContextToken(value string, max int) bool {
	if value == "" || len(value) > max {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}
