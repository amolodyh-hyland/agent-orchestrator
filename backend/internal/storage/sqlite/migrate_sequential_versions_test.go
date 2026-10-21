package sqlite

import (
	"regexp"
	"sort"
	"strconv"
	"testing"
)

var sequentialMigrationName = regexp.MustCompile(`^(\d{4})_[a-z0-9_]+\.sql$`)

// skippedMigrationVersions are the numbers inside the sequence that no file
// uses. They were burned or never claimed in a release, so they stay empty.
// New migrations take the next number after the highest file; never add to
// this set to make a gap pass.
var skippedMigrationVersions = map[int64]bool{
	22: true, 45: true, 46: true, 50: true, 51: true,
	55: true, 56: true, 57: true, 58: true, 59: true, 60: true,
	61: true, 62: true, 63: true, 64: true, 65: true,
	182: true, 183: true, 184: true,
	203: true, 204: true, 205: true,
	207: true, 208: true, 209: true,
}

// TestMigrationVersionsAreSequential keeps every migration on the NNNN_ scheme
// with no jump in the sequence. A timestamp-style version (for example
// 20261020213549770) becomes the highest version a database records, so every
// later sequential migration would sort below it and goose would skip or
// reject it as out of order.
func TestMigrationVersionsAreSequential(t *testing.T) {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}

	seen := map[int64]string{}
	var versions []int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		match := sequentialMigrationName.FindStringSubmatch(e.Name())
		if match == nil {
			t.Errorf("migration %q does not match the sequential NNNN_name.sql pattern; timestamp-style versions break ordering of later migrations", e.Name())
			continue
		}
		version, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil {
			t.Errorf("migration %q: parse version: %v", e.Name(), err)
			continue
		}
		if other, dup := seen[version]; dup {
			t.Errorf("duplicate migration version %d: %s vs %s", version, other, e.Name())
			continue
		}
		seen[version] = e.Name()
		versions = append(versions, version)
	}

	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for i := 1; i < len(versions); i++ {
		for missing := versions[i-1] + 1; missing < versions[i]; missing++ {
			if !skippedMigrationVersions[missing] {
				t.Errorf("migration versions are not contiguous: %d is missing between %s and %s", missing, seen[versions[i-1]], seen[versions[i]])
			}
		}
	}
	for skipped := range skippedMigrationVersions {
		if name, used := seen[skipped]; used {
			t.Errorf("migration %q uses version %d, which is listed as skipped", name, skipped)
		}
	}
}
