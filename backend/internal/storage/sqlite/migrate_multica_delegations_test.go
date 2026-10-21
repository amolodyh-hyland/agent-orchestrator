package sqlite

import "testing"

func TestMulticaDelegationMigrationUpgradeAndUniqueness(t *testing.T) {
	db := openMigratedDatabaseCopy(t, 217)
	upTo(t, db, 218)
	insert := `INSERT INTO multica_delegations(request_id,project_id,task_id,confirmation_id,is_current,version,document) VALUES(?,'project','task',?,1,0,'{}')`
	if _, err := db.Exec(insert, "r1", "c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(insert, "r2", "c2"); err == nil {
		t.Fatal("duplicate current task accepted")
	}
	if _, err := db.Exec(`UPDATE multica_delegations SET is_current=0 WHERE request_id='r1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(insert, "r2", "c1"); err == nil {
		t.Fatal("duplicate confirmation accepted")
	}
	if _, err := db.Exec(insert, "r2", "c2"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO multica_delegation_transitions(request_id,version,state,document) VALUES('r1',0,'submitting','{}')`); err != nil {
		t.Fatal(err)
	}
	var stamp string
	if err := db.QueryRow(`SELECT recorded_at FROM multica_delegation_transitions WHERE request_id='r1'`).Scan(&stamp); err != nil || stamp == "" {
		t.Fatalf("transition timestamp = %q, %v", stamp, err)
	}
	downTo(t, db, 217)
	upTo(t, db, 218)
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM multica_delegations`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("recreated journal = %d, %v", count, err)
	}
}
