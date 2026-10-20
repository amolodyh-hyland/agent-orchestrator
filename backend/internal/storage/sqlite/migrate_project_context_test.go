package sqlite

import (
	"strings"
	"testing"
	"time"
)

func TestMigrateProjectContextSnapshotsFromInstalledSchema(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 201)
	now := time.Unix(100, 0).UTC()
	if _, err := db.Exec(`INSERT INTO projects (id, path, display_name, registered_at)
		VALUES ('p1', '/tmp/p1', 'proj', ?)`, now); err != nil {
		t.Fatalf("seed pre-migration Project: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, project_id, num, kind, activity_state, activity_last_at, is_terminated, created_at, updated_at)
		VALUES ('ao-1', 'p1', 1, 'worker', 'idle', ?, 0, ?, ?)`, now, now, now); err != nil {
		t.Fatalf("seed pre-migration session: %v", err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("migrate from 201: %v", err)
	}

	var sessions int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = 'ao-1'`).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("pre-existing session after migrate: count=%d err=%v", sessions, err)
	}
	if _, err := db.Exec(`INSERT INTO project_context_snapshots (session_id, project_id, project_revision, manifest_json, digest, created_at)
		VALUES ('ao-1', 'p1', 0, '{}', 'd', ?)`, now); err != nil {
		t.Fatalf("insert snapshot for pre-existing session: %v", err)
	}
	_, err := db.Exec(`UPDATE project_context_snapshots SET digest = 'x' WHERE session_id = 'ao-1'`)
	if err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("snapshot update error = %v, want immutable abort", err)
	}
	if _, err := db.Exec(`INSERT INTO project_context_local_sources (source_ref, machine_id, root_path, relative_path, media_type, registered_at, updated_at)
		VALUES ('r1', 'm1', '/root', 'a.md', 'text/markdown', ?, ?)`, now, now); err != nil {
		t.Fatalf("insert local source: %v", err)
	}
}

func TestMigrateProjectContextSnapshotsFreshDatabase(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, table := range []string{"project_context_snapshots", "project_context_local_sources"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n); err != nil || n != 1 {
			t.Fatalf("table %s on fresh database: count=%d err=%v", table, n, err)
		}
	}
}
