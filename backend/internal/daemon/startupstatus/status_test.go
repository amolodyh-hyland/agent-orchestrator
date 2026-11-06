package startupstatus

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestLaunchRecordsAndMigrationIdentity(t *testing.T) {
	run := filepath.Join(t.TempDir(), "running.json")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	first, err := New(run, logger)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New(run, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close(nil)
	if first.file == second.file {
		t.Fatal("launches must not overwrite each other")
	}
	first.Set("migrating", "migration", "20261102160814608")
	data, err := os.ReadFile(first.file)
	if err != nil {
		t.Fatal(err)
	}
	var record Record
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.PID != os.Getpid() || record.LaunchID == "" || record.Executable == "" || record.HeartbeatAt == 0 || record.MigrationID != "20261102160814608" || record.Phase != "migrating" {
		t.Fatalf("incomplete status: %+v", record)
	}
	first.Close(io.EOF)
	data, _ = os.ReadFile(first.file)
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.Phase != "failed" {
		t.Fatalf("failure not retained: %+v", record)
	}
	if _, err := os.Stat(first.file + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("atomic write temporary file remains")
	}
}

func TestWindowsProcessStartPreservesFiletimePrecision(t *testing.T) {
	for _, test := range []struct {
		high, low uint32
		want      string
	}{
		{1, 2, "windows-filetime:4294967298"},
		{0xffffffff, 0xffffffff, "windows-filetime:18446744073709551615"},
	} {
		if got := windowsProcessStart(test.high, test.low); got != test.want {
			t.Fatalf("creation FILETIME = %q, want %q", got, test.want)
		}
	}
}
