package sqlite

import "testing"

func TestPermissionCeilingMigrationIsVersion217(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 216)
	upTo(t, db, 217)
	var version int64
	if err := db.QueryRow(`SELECT MAX(version_id) FROM goose_db_version WHERE is_applied = 1`).Scan(&version); err != nil || version != 217 {
		t.Fatalf("fresh database version = %d err=%v, want 217", version, err)
	}
}

func TestPermissionCeilingMigrationDownAndUpAgain(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 216)
	upTo(t, db, 217)
	downTo(t, db, 216)
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'permission_ceiling'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("permission_ceiling survived down: count=%d err=%v", n, err)
	}
	upTo(t, db, 217)
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'permission_ceiling'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("permission_ceiling after re-up: count=%d err=%v", n, err)
	}
}

func TestPermissionCeilingMigrationBackfillsExistingSessionPolicy(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 216)
	if _, err := db.Exec(`INSERT INTO projects(id,path,registered_at) VALUES('p','/repo',CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	for i, mode := range []string{"accept-edits", "auto", "bypass-permissions", "default", ""} {
		if _, err := db.Exec(`INSERT INTO sessions(id,project_id,num,harness,session_permissions,created_at,updated_at,activity_last_at) VALUES(?,'p',?,'claude-code',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, mode+"-session", i+1, mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(db); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT session_permissions,permission_ceiling FROM sessions`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var runtime, ceiling string
		if err := rows.Scan(&runtime, &ceiling); err != nil {
			t.Fatal(err)
		}
		if runtime != ceiling {
			t.Fatalf("migration changed policy %q to ceiling %q", runtime, ceiling)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != 5 {
		t.Fatalf("backfilled %d sessions, want 5", count)
	}
}
