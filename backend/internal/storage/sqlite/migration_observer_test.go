package sqlite

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pressly/goose/v3"
)

func TestMigrationObserverAndCleanRestart(t *testing.T) {
	dir := t.TempDir()
	started := map[string]bool{}
	completed := map[string]bool{}
	observe := func(id string, done bool, duration time.Duration, err error) {
		if err != nil {
			t.Fatal(err)
		}
		if !done {
			started[id] = true
			return
		}
		if !started[id] || duration < 0 {
			t.Fatalf("completion without start: %s", id)
		}
		completed[id] = true
	}
	store, err := OpenWithMigrationObserver(dir, observe)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if len(started) == 0 || len(started) != len(completed) {
		t.Fatalf("unpaired migrations: %d/%d", len(started), len(completed))
	}
	store, err = OpenWithMigrationObserver(dir, func(id string, done bool, duration time.Duration, err error) {
		t.Errorf("restart reran migration %s", id)
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
}

func TestMigrationObserverReportsFailure(t *testing.T) {
	gooseMu.Lock()
	defer gooseMu.Unlock()
	goose.SetBaseFS(fstest.MapFS{"migrations/20261102160814608_failure.sql": &fstest.MapFile{Data: []byte("-- +goose Up\nTHIS IS INVALID SQL;\n-- +goose Down\nSELECT 1;")}})
	defer goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	events := 0
	err = applyObservedMigrations(db, func(id string, completed bool, duration time.Duration, migrationErr error) {
		events++
		if id != "20261102160814608" {
			t.Errorf("rounded migration: %s", id)
		}
		if completed && migrationErr == nil {
			t.Error("missing migration failure")
		}
	})
	if err == nil || events != 2 {
		t.Fatalf("failure not reported: events=%d error=%v", events, err)
	}
}

func TestWritableOpenRefusesRestoreFence(t *testing.T) {
	for name, open := range map[string]func(string) (*Store, error){"open": Open, "premigrated": OpenPreMigrated} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "RESTORE_IN_PROGRESS"), []byte(`{"journal":"rollback-journal.json"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			store, err := open(dir)
			if store != nil || err == nil || !strings.Contains(err.Error(), "restore requires recovery") {
				t.Fatalf("open = %v, %v; want fence refusal", store, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "ao.db")); !os.IsNotExist(err) {
				t.Fatalf("writable open touched SQLite through fence: %v", err)
			}
		})
	}
}
