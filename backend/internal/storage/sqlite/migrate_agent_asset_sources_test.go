package sqlite

import "testing"

func TestAgentAssetSourcesTimestampMigrationRoundTrip(t *testing.T) {
	const version int64 = 20261102160814608
	db := openMigratedDatabaseCopy(t, version-1)
	if _, err := db.Exec(`UPDATE app_settings SET default_session_mode = 'chat', computer_use = 1 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	upTo(t, db, version)
	var sources, mode string
	var computerUse int
	if err := db.QueryRow(`SELECT agent_asset_sources, default_session_mode, computer_use FROM app_settings WHERE id = 1`).Scan(&sources, &mode, &computerUse); err != nil {
		t.Fatal(err)
	}
	if sources != "[]" || mode != "chat" || computerUse != 1 {
		t.Fatalf("upgrade changed preferences: sources=%q mode=%q computerUse=%d", sources, mode, computerUse)
	}
	if _, err := db.Exec(`UPDATE app_settings SET agent_asset_sources = '{}' WHERE id = 1`); err == nil {
		t.Fatal("accepted a non-array source list")
	}
	if _, err := db.Exec(`UPDATE app_settings SET agent_asset_sources = '["/live/.agents"]' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	downTo(t, db, version-1)
	if _, err := db.Exec(`SELECT agent_asset_sources FROM app_settings`); err == nil {
		t.Fatal("asset column survived rollback")
	}
	upTo(t, db, version)
	if err := db.QueryRow(`SELECT agent_asset_sources, default_session_mode, computer_use FROM app_settings WHERE id = 1`).Scan(&sources, &mode, &computerUse); err != nil {
		t.Fatal(err)
	}
	if sources != "[]" || mode != "chat" || computerUse != 1 {
		t.Fatalf("rollback and reapply changed preferences: sources=%q mode=%q computerUse=%d", sources, mode, computerUse)
	}
}
