package cli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/datadirlock"
	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func writeLegacyProject(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	if err := os.MkdirAll(filepath.Join(root, "projects", "alpha", "sessions"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.yaml"),
		[]byte("projects:\n  alpha:\n    path: /repos/alpha\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestImportCommand_NoLegacyData(t *testing.T) {
	setConfigEnv(t)
	empty := filepath.Join(t.TempDir(), "nope")
	out, _, err := executeCLI(t, Deps{}, "import", "--from", empty, "--yes")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if !strings.Contains(out, "Nothing to import") {
		t.Fatalf("out = %q, want 'Nothing to import'", out)
	}
}

func TestImportCommand_ImportsProjectJSON(t *testing.T) {
	setConfigEnv(t)
	root := writeLegacyProject(t)

	out, _, err := executeCLI(t, Deps{}, "import", "--from", root, "--yes", "--json")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	var rep legacyimport.Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatalf("parse report %q: %v", out, err)
	}
	if rep.ProjectsImported != 1 {
		t.Fatalf("projectsImported = %d, want 1", rep.ProjectsImported)
	}
}

func TestImportCommand_SurfacesParseErrorOnce(t *testing.T) {
	setConfigEnv(t)
	// A tab-indented line is a YAML syntax error (not a *yaml.TypeError), so
	// loadLegacyConfig surfaces it exactly like issue #2186 describes.
	root := filepath.Join(t.TempDir(), ".agent-orchestrator")
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.yaml"),
		[]byte("projects:\n\talpha:\n  path: /repos/alpha\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, stderr, err := executeCLI(t, Deps{}, "import", "--from", root, "--yes")
	if err == nil {
		t.Fatal("import: want non-nil error for a config.yaml that fails to parse")
	}
	if got := ExitCode(err); got != 1 {
		t.Fatalf("ExitCode = %d, want 1 (runtime failure)", got)
	}
	// The parse error must reach the user exactly once. main.go prints the
	// returned error, so the command itself must not also Fprintf it; that
	// doubled the output before this fix.
	count := strings.Count(stderr, "parse legacy config.yaml") + strings.Count(err.Error(), "parse legacy config.yaml")
	if count != 1 {
		t.Fatalf("parse error appeared %d time(s) (stderr=%q, err=%q), want exactly 1", count, stderr, err)
	}
}

func TestImportCommand_RefusesWhenDaemonRunning(t *testing.T) {
	cfg := setConfigEnv(t)
	root := writeLegacyProject(t)

	// A run-file owned by this (alive) process makes the daemon look live.
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 3001, StartedAt: time.Now()}); err != nil {
		t.Fatalf("write run-file: %v", err)
	}

	_, _, err := executeCLI(t, Deps{}, "import", "--from", root, "--yes")
	if err == nil || !strings.Contains(err.Error(), "daemon is running") {
		t.Fatalf("err = %v, want refusal because daemon is running", err)
	}
}

// A daemon with its own run-file (or one still starting, before it writes the
// run-file) passes the PID check above, but it holds the data-dir lock, so
// import must refuse before opening or migrating ao.db.
func TestImportCommand_RefusesWhenDataDirLocked(t *testing.T) {
	cfg := setConfigEnv(t)
	root := writeLegacyProject(t)
	held, err := datadirlock.Acquire(context.Background(), cfg.dataDir, 0)
	if err != nil {
		t.Fatalf("hold data dir lock: %v", err)
	}
	t.Cleanup(func() { _ = held.Release() })

	_, _, err = executeCLI(t, Deps{}, "import", "--from", root, "--yes")
	if !errors.Is(err, datadirlock.ErrLocked) || ExitCode(err) != 2 {
		t.Fatalf("err = %v (exit %d), want a data-dir-locked usage error", err, ExitCode(err))
	}
	// `ao stop` only reaches the daemon in this AO_RUN_FILE; point at the holder's PID instead.
	if msg := err.Error(); !strings.Contains(msg, "pid "+strconv.Itoa(os.Getpid())) || strings.Contains(msg, "ao stop") {
		t.Fatalf("refusal should name the holder pid %d and not suggest ao stop: %v", os.Getpid(), err)
	}
	if _, statErr := os.Stat(filepath.Join(cfg.dataDir, "ao.db")); !os.IsNotExist(statErr) {
		t.Fatalf("import touched ao.db under a locked data dir: %v", statErr)
	}
}

func TestImportCommand_RefusesInterruptedRestoreBeforeOpeningSQLite(t *testing.T) {
	for _, dryRun := range []bool{false, true} {
		t.Run(strconv.FormatBool(dryRun), func(t *testing.T) {
			cfg := setConfigEnv(t)
			root := writeLegacyProject(t)
			held, err := datadirlock.Acquire(context.Background(), cfg.dataDir, 0)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = held.Release() })
			store, err := sqlite.Open(cfg.dataDir)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", filepath.Join(cfg.dataDir, "ao.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			db.SetMaxOpenConns(1)
			if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
				CREATE TABLE restore_content (value TEXT);
				INSERT INTO restore_content VALUES ('retained until recovery');`); err != nil {
				t.Fatal(err)
			}
			journal := filepath.Join(t.TempDir(), "rollback-journal.json")
			if err := os.WriteFile(journal, []byte(`{"completed":false,"phase":"promoting-database"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			fence, _ := json.Marshal(map[string]string{"journal": journal})
			if err := os.WriteFile(filepath.Join(cfg.dataDir, "RESTORE_IN_PROGRESS"), fence, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := held.Release(); err != nil {
				t.Fatal(err)
			}
			before := map[string][]byte{}
			for _, name := range []string{"ao.db", "ao.db-wal", "ao.db-shm", "RESTORE_IN_PROGRESS"} {
				contents, err := os.ReadFile(filepath.Join(cfg.dataDir, name))
				if err != nil {
					t.Fatal(err)
				}
				before[name] = contents
			}
			args := []string{"import", "--from", root, "--yes"}
			if dryRun {
				args = append(args, "--dry-run")
			}
			_, _, err = executeCLI(t, Deps{}, args...)
			if err == nil || !strings.Contains(err.Error(), "RESTORE_IN_PROGRESS and retry the recorded rollback") {
				t.Fatalf("err = %v, want restore recovery instruction", err)
			}
			for name, want := range before {
				got, err := os.ReadFile(filepath.Join(cfg.dataDir, name))
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("import changed %s through restore fence: %v", name, err)
				}
			}
		})
	}
}
