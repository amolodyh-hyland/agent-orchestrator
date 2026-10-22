package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func readLibraryRegistry(ctx context.Context, db gen.DBTX) (domain.LibraryRegistry, error) {
	var data string
	err := db.QueryRowContext(ctx, "SELECT registry_json FROM library_registry WHERE id=1").Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.NewLibraryRegistry(), nil
	}
	if err != nil {
		return domain.LibraryRegistry{}, err
	}
	var state domain.LibraryRegistry
	if err := json.Unmarshal([]byte(data), &state); err != nil {
		return state, fmt.Errorf("decode library registry: %w", err)
	}
	return state, nil
}

func (s *Store) ReadLibraryRegistry(ctx context.Context) (domain.LibraryRegistry, error) {
	return readLibraryRegistry(ctx, s.readDB)
}

func (s *Store) UpdateLibraryRegistry(ctx context.Context, change func(*domain.LibraryRegistry) (domain.LibraryAudit, error)) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	return s.inTxDB(ctx, "update library registry", func(_ *gen.Queries, db gen.DBTX) error {
		state, err := readLibraryRegistry(ctx, db)
		if err != nil {
			return err
		}
		audit, err := change(&state)
		if err != nil {
			return err
		}
		state.Revision++
		data, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO library_registry(id,revision,registry_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,registry_json=excluded.registry_json", state.Revision, string(data)); err != nil {
			return err
		}
		audit.Revision = state.Revision
		audit.TrustEpoch = state.TrustEpoch
		encoded, err := json.Marshal(audit)
		if err != nil {
			return err
		}
		_, err = db.ExecContext(ctx, "INSERT INTO library_audit(event_json) VALUES(?)", string(encoded))
		return err
	})
}

func (s *Store) RecordLibraryAudit(ctx context.Context, audit domain.LibraryAudit) error {
	data, err := json.Marshal(audit)
	if err != nil {
		return err
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	_, err = s.writeDB.ExecContext(ctx, "INSERT INTO library_audit(event_json) VALUES(?)", string(data))
	return err
}
