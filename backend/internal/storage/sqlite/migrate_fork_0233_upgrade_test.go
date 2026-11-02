package sqlite

import (
	"reflect"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestMigrateFork0233AppliesUpstreamTimestampsExactlyOnce(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 233)
	ledger := func() map[int64]int {
		t.Helper()
		rows, err := db.Query(`SELECT version_id, COUNT(*) FROM goose_db_version WHERE is_applied = 1 GROUP BY version_id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		counts := map[int64]int{}
		for rows.Next() {
			var version int64
			var count int
			if err := rows.Scan(&version, &count); err != nil {
				t.Fatal(err)
			}
			counts[version] = count
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return counts
	}
	before := ledger()
	for version := int64(216); version <= 233; version++ {
		if before[version] != 1 {
			t.Fatalf("legacy version %d applied %d times, want once", version, before[version])
		}
	}
	for version := range before {
		if version > 233 {
			t.Fatalf("fixture contains post-fork version %d", version)
		}
	}
	if _, err := db.Exec(`INSERT INTO projects(id,path,registered_at) VALUES('fork-upgrade','/fork-upgrade',CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db); err != nil {
		t.Fatalf("upgrade fork 0233: %v", err)
	}
	after := ledger()
	for version, count := range before {
		if after[version] != count {
			t.Errorf("legacy version %d changed from %d to %d applications", version, count, after[version])
		}
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	timestamps := 0
	for _, entry := range entries {
		version, err := goose.NumericComponent(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		if version <= 234 {
			continue
		}
		timestamps++
		if after[version] != 1 {
			t.Errorf("upstream version %d applied %d times, want once", version, after[version])
		}
	}
	if timestamps == 0 {
		t.Fatal("no upstream timestamps exercised")
	}
	if err := migrate(db); err != nil {
		t.Fatalf("repeat upgrade: %v", err)
	}
	if repeated := ledger(); !reflect.DeepEqual(after, repeated) {
		t.Fatalf("repeated upgrade changed ledger: before=%v after=%v", after, repeated)
	}
	var retained string
	if err := db.QueryRow(`SELECT path FROM projects WHERE id='fork-upgrade'`).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != "/fork-upgrade" {
		t.Fatalf("existing project changed: %q", retained)
	}
	var present int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name IN ('permission_ceiling','launch_options')`).Scan(&present); err != nil {
		t.Fatal(err)
	}
	if present != 2 {
		t.Fatalf("fork/upstream session columns: got %d, want both", present)
	}
}
