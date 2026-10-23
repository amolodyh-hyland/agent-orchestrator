package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// ErrLibrarySelectionChanged requires preparing a fresh candidate after a concurrent change.
var ErrLibrarySelectionChanged = errors.New("library selection changed during preparation")

// CreateLibrarySessionSelection atomically inserts the immutable parent and child, or retains the winner.
func (s *Store) CreateLibrarySessionSelection(ctx context.Context, parent domain.ProjectContextManifest, child domain.LibrarySnapshot, expectedRegistryRevision int64) (bool, error) {
	if err := parent.VerifyDigest(); err != nil {
		return false, err
	}
	if err := child.VerifyDigest(); err != nil {
		return false, err
	}
	if child.SchemaVersion != 1 || child.SessionID != parent.SessionID || child.ProjectID != parent.ProjectID || child.ProjectRevision != parent.ProjectRevision || child.ProjectContextDigest != parent.Digest || child.Role != parent.Role || child.Channel != parent.Channel || !domain.ValidLibraryID(child.SnapshotID) || child.RegistryRevision != expectedRegistryRevision {
		return false, fmt.Errorf("invalid library child selection")
	}
	for _, entry := range child.Entries {
		if entry.ApprovalID != "" {
			if err := (domain.LibraryStagedEntry{Entry: entry.Entry, RootIdentity: entry.RootIdentity, Content: entry.Content}).Verify(); err != nil {
				return false, err
			}
		} else if len(entry.Content) > 0 {
			return false, fmt.Errorf("unapproved library bytes")
		}
	}
	parentJSON, err := json.Marshal(parent)
	if err != nil {
		return false, err
	}
	childJSON, err := json.Marshal(child)
	if err != nil {
		return false, err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return false, err
	}
	defer s.writeMu.Unlock()
	created := false
	err = s.inTxDB(ctx, "create library session selection", func(q *gen.Queries, db gen.DBTX) error {
		var exists int
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM library_session_snapshots WHERE session_id=?", string(parent.SessionID)).Scan(&exists); err != nil {
			return err
		}
		if exists != 0 {
			return nil
		}
		registry, err := readLibraryRegistry(ctx, db)
		if err != nil {
			return err
		}
		if registry.Revision != expectedRegistryRevision {
			return ErrLibrarySelectionChanged
		}

		sessionRow, err := q.GetSession(ctx, parent.SessionID)
		if err != nil {
			return err
		}
		session := getSessionRowToRecord(sessionRow)
		// Preparations own the project and session already, but their effective
		// mode/kind/issue are published only at promotion. Promotion validates the
		// pinned identity in its own transaction before making the row visible.
		if session.ProjectID != parent.ProjectID || (!session.IsTaskPreparation && !librarySelectionMatchesSession(parent, session)) {
			return fmt.Errorf("library selection session ownership mismatch")
		}

		var projectID sql.NullString
		if parent.ProjectID != "" {
			projectID = sql.NullString{String: string(parent.ProjectID), Valid: true}

			project, err := q.GetProject(ctx, parent.ProjectID)
			if err != nil {
				return err
			}
			if project.MetadataRevision != parent.ProjectRevision || project.ArchivedAt.Valid {
				return ErrLibrarySelectionChanged
			}
		}
		for _, entry := range child.Entries {
			if entry.ApprovalID == "" {
				continue
			}
			approval, ok := registry.Approvals[entry.ApprovalID]
			if !ok || approval.State != "approved" || approval.RootIdentity != entry.RootIdentity {
				return ErrLibrarySelectionChanged
			}
			matched := false
			for _, selected := range approval.Entries {
				matched = matched || selected.EntryID == entry.Entry.EntryID && selected.ContentHash == entry.Entry.ContentHash
			}
			if !matched {
				return ErrLibrarySelectionChanged
			}
		}
		_, err = q.InsertProjectContextSnapshot(ctx, gen.InsertProjectContextSnapshotParams{SessionID: string(parent.SessionID), ProjectID: projectID, ProjectRevision: parent.ProjectRevision, ManifestJson: string(parentJSON), Digest: parent.Digest, CreatedAt: parent.CreatedAt})
		if err != nil {
			return err
		}
		stored, err := q.GetProjectContextSnapshot(ctx, string(parent.SessionID))
		if err != nil {
			return err
		}
		if stored.Digest != parent.Digest {
			return ErrLibrarySelectionChanged
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO library_session_snapshots(session_id,snapshot_id,context_digest,manifest_json,digest) VALUES(?,?,?,?,?)", string(child.SessionID), child.SnapshotID, child.ProjectContextDigest, string(childJSON), child.SnapshotDigest); err != nil {
			return err
		}
		created = true
		return nil
	})
	return created, err
}

// GetLibrarySnapshot reads retained bytes and verifies both the digest and parent association.
func (s *Store) GetLibrarySnapshot(ctx context.Context, id domain.SessionID) (domain.LibrarySnapshot, bool, error) {
	var data, digest, parentDigest string
	err := s.readDB.QueryRowContext(ctx, "SELECT l.manifest_json,l.digest,p.digest FROM library_session_snapshots l JOIN project_context_snapshots p ON p.session_id=l.session_id WHERE l.session_id=?", string(id)).Scan(&data, &digest, &parentDigest)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.LibrarySnapshot{}, false, nil
	}
	if err != nil {
		return domain.LibrarySnapshot{}, false, err
	}
	var snapshot domain.LibrarySnapshot
	if err := json.Unmarshal([]byte(data), &snapshot); err != nil {
		return snapshot, false, err
	}
	if snapshot.SessionID != id || snapshot.ProjectContextDigest != parentDigest || snapshot.SnapshotDigest != digest {
		return snapshot, false, fmt.Errorf("library snapshot index mismatch")
	}
	if err := snapshot.VerifyDigest(); err != nil {
		return snapshot, false, err
	}
	for _, entry := range snapshot.Entries {
		if entry.ApprovalID != "" {
			if err := (domain.LibraryStagedEntry{Entry: entry.Entry, RootIdentity: entry.RootIdentity, Content: entry.Content}).Verify(); err != nil {
				return snapshot, false, err
			}
		}
	}
	return snapshot, true, nil
}

func librarySelectionMatchesSession(parent domain.ProjectContextManifest, session domain.SessionRecord) bool {
	role := domain.ProjectContextRoleWorker
	if session.Kind == domain.KindOrchestrator {
		role = domain.ProjectContextRoleCoordinator
	}
	return session.ProjectID == parent.ProjectID && parent.Role == role && parent.Channel == domain.NormalizeSessionMode(session.Mode) && parent.IssueTask == (strings.TrimSpace(string(session.IssueID)) != "")
}

// validatePreparedLibrarySelection runs in the promotion transaction so a hidden
// preparation cannot become visible with an effective identity unlike its pin.
func validatePreparedLibrarySelection(ctx context.Context, q *gen.Queries, db gen.DBTX, id domain.SessionID, rec domain.SessionRecord) error {
	var selected bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM library_session_snapshots WHERE session_id=?)", id).Scan(&selected); err != nil {
		return err
	}
	if !selected {
		return nil
	}
	row, err := q.GetSession(ctx, id)
	if err != nil {
		return err
	}
	if getSessionRowToRecord(row).ProjectID != rec.ProjectID {
		return fmt.Errorf("library selection session ownership mismatch")
	}
	stored, err := q.GetProjectContextSnapshot(ctx, string(id))
	if err != nil {
		return err
	}
	var parent domain.ProjectContextManifest
	if err := json.Unmarshal([]byte(stored.ManifestJson), &parent); err != nil {
		return err
	}
	if err := parent.VerifyDigest(); err != nil {
		return err
	}
	if parent.SessionID != id || !librarySelectionMatchesSession(parent, rec) {
		return fmt.Errorf("library selection promotion identity mismatch")
	}
	return nil
}
