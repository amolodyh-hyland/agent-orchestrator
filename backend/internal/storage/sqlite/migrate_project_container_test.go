package sqlite

import (
	"strings"
	"testing"
	"time"
)

func TestMigrateProjectContainerMetadataDefaults(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 200)
	registeredAt := time.Unix(100, 0).UTC()
	for _, seed := range []struct {
		id, path, repo, name, config, kind string
	}{
		{"single", "/repos/single", "https://example.com/single.git", "Single", `{"agentRules":"worker rules"}`, "single_repo"},
		{"workspace", "/workspaces/team", "", "Workspace", "", "workspace"},
		{"scratch", "/ao/scratch/default", "", "Scratch", "", "scratch"},
	} {
		if _, err := db.Exec(`
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, config, kind)
VALUES (?, ?, ?, ?, ?, ?, ?);`, seed.id, seed.path, seed.repo, seed.name, registeredAt, seed.config, seed.kind); err != nil {
			t.Fatalf("seed pre-migration Project %q: %v", seed.id, err)
		}
	}
	if err := migrate(db); err != nil {
		t.Fatalf("migrate Project metadata: %v", err)
	}

	rows, err := db.Query(`SELECT id, path, repo_origin_url, display_name, config, kind, metadata_revision, instructions_json FROM projects ORDER BY id`)
	if err != nil {
		t.Fatalf("query migrated Projects: %v", err)
	}
	defer func() { _ = rows.Close() }()
	want := []struct {
		id, path, repo, name, config, kind string
	}{
		{"scratch", "/ao/scratch/default", "", "Scratch", "", "scratch"},
		{"single", "/repos/single", "https://example.com/single.git", "Single", `{"agentRules":"worker rules"}`, "single_repo"},
		{"workspace", "/workspaces/team", "", "Workspace", "", "workspace"},
	}
	for i, expected := range want {
		if !rows.Next() {
			t.Fatalf("missing migrated Project %q", expected.id)
		}
		var id, path, repo, name, config, kind, instructions string
		var revision int64
		if err := rows.Scan(&id, &path, &repo, &name, &config, &kind, &revision, &instructions); err != nil {
			t.Fatalf("scan migrated Project: %v", err)
		}
		if id != expected.id || path != expected.path || repo != expected.repo || name != expected.name || kind != expected.kind {
			t.Errorf("Project %d = %q %q %q %q %q, want %#v", i, id, path, repo, name, kind, expected)
		}
		if config != expected.config {
			t.Errorf("Project %q config = %q, want %q", id, config, expected.config)
		}
		if revision != 1 || instructions != "{}" {
			t.Errorf("Project %q metadata = revision %d instructions %q, want 1 and empty object", id, revision, instructions)
		}
	}
	if rows.Next() {
		t.Fatal("unexpected extra migrated Project")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate migrated Projects: %v", err)
	}

	var tableSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).Scan(&tableSQL); err != nil {
		t.Fatalf("read migrated Project schema: %v", err)
	}
	if !strings.Contains(tableSQL, "metadata_revision") || !strings.Contains(tableSQL, "instructions_json") {
		t.Fatalf("Project schema lacks container metadata columns: %s", tableSQL)
	}
}
