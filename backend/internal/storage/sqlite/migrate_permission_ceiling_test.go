package sqlite

import "testing"

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
