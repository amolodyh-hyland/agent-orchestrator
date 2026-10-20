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
	if err := validateProjectContextLocalSource(&source); err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return upsertProjectContextLocalSource(ctx, s.qw, source)
}

// upsertProjectContextLocalSource writes one locator. The statement itself
// refuses to replace a source_ref owned by someone else, so ownership is
// enforced atomically with the write.
func upsertProjectContextLocalSource(ctx context.Context, q *gen.Queries, source domain.ProjectContextLocalSourceRecord) error {
	rows, err := q.UpsertProjectContextLocalSource(ctx, gen.UpsertProjectContextLocalSourceParams{
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
	if rows == 0 {
		return fmt.Errorf("project context local source %s: %w", source.SourceRef, domain.ErrProjectContextSourceOwned)
	}
	return nil
}

// UpsertProjectWithContextSources creates a Project and registers its local
// attachment sources in one transaction.
func (s *Store) UpsertProjectWithContextSources(ctx context.Context, r domain.ProjectRecord, sources []domain.ProjectContextLocalSourceRecord) error {
	config, err := marshalProjectConfig(r.Config)
	if err != nil {
		return err
	}
	instructions, err := marshalProjectInstructions(r.Instructions)
	if err != nil {
		return err
	}
	sources, err = normalizeProjectContextLocalSources(sources)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTx(ctx, "create project with context sources", func(q *gen.Queries) error {
		if err := upsertProjectContextLocalSources(ctx, q, sources); err != nil {
			return err
		}
		return upsertProject(ctx, q, r, config, instructions)
	})
}

// UpdateProjectSettingsWithContextSources applies the settings update and
// registers local attachment sources in one transaction. When the update does
// not apply (missing project or stale revision) nothing is registered and it
// reports false.
func (s *Store) UpdateProjectSettingsWithContextSources(ctx context.Context, id, displayName string, config domain.ProjectConfig, instructions *domain.ProjectInstructions, expectedRevision int64, sources []domain.ProjectContextLocalSourceRecord) (bool, error) {
	encodedConfig, err := marshalProjectConfig(config)
	if err != nil {
		return false, err
	}
	encodedInstructions := "{}"
	var setInstructions int64
	if instructions != nil {
		setInstructions = 1
		if encodedInstructions, err = marshalProjectInstructions(*instructions); err != nil {
			return false, err
		}
	}
	sources, err = normalizeProjectContextLocalSources(sources)
	if err != nil {
		return false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var applied bool
	err = s.inTx(ctx, "update project settings with context sources", func(q *gen.Queries) error {
		if err := upsertProjectContextLocalSources(ctx, q, sources); err != nil {
			return err
		}
		rows, err := q.UpdateProjectSettings(ctx, gen.UpdateProjectSettingsParams{
			DisplayName: displayName, Config: encodedConfig, SetInstructions: setInstructions,
			InstructionsJson: encodedInstructions, ID: domain.ProjectID(id), ExpectedRevision: expectedRevision,
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return errProjectSettingsNotApplied
		}
		applied = true
		return nil
	})
	if errors.Is(err, errProjectSettingsNotApplied) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return applied, nil
}

var errProjectSettingsNotApplied = errors.New("project settings update did not apply")

func upsertProjectContextLocalSources(ctx context.Context, q *gen.Queries, sources []domain.ProjectContextLocalSourceRecord) error {
	for _, source := range sources {
		if err := upsertProjectContextLocalSource(ctx, q, source); err != nil {
			return err
		}
	}
	return nil
}

func normalizeProjectContextLocalSources(sources []domain.ProjectContextLocalSourceRecord) ([]domain.ProjectContextLocalSourceRecord, error) {
	out := make([]domain.ProjectContextLocalSourceRecord, 0, len(sources))
	for _, source := range sources {
		if err := validateProjectContextLocalSource(&source); err != nil {
			return nil, err
		}
		out = append(out, source)
	}
	return out, nil
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

func validateProjectContextLocalSource(source *domain.ProjectContextLocalSourceRecord) error {
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
	return nil
}
