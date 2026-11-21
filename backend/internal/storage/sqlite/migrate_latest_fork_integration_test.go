package sqlite

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pressly/goose/v3"
)

const forkContextRepairVersion int64 = 20261120041743565

var postFork33280Migrations = strings.Fields(`20261022081903875_review_run_worker_notice.sql
20261022084559932_review_run_worker_notice_attempts.sql
20261028180000000_pr_details.sql
20261028224250364_usage_event_service_tier.sql
20261028233910979_agent_limit_readings.sql
20261030230920365_chat_account_handoff.sql
20261030234657125_app_settings_limit_history.sql
20261031173315209_usage_event_provider_message_id.sql
20261031173316629_usage_long_context_reprice.sql
20261101102149555_pr_details_conversation.sql
20261102133300897_session_delete_cascade_indexes.sql
20261103000000000_session_import.sql
20261103030401452_open_usage_source_kinds.sql
20261105105237146_usage_repricing.sql
20261109094334974_session_artifacts.sql
20261109120000000_conversation_turn_batch_delivery.sql
20261109153109361_session_forks.sql
20261110172911382_conversation_turn_artifacts.sql
20261111020206870_shell_terminal_ended.sql
20261111145612313_pr_details_provider_updated_at.sql
20261113111818788_clear_switched_model_reroutes.sql
20261113173435236_session_search.sql
20261114072016988_drop_session_account_pins.sql
20261114182101000_session_accepted_delivery.sql
20261115050423095_allow_stakpak_harness.sql
20261115071147951_allow_docker_agent_harness.sql
20261115072651599_allow_minimax_code_harness.sql
20261115072835107_review_run_state_machine.sql
20261116063923032_index_pr_source_branch.sql
20261116070040471_kept_artifacts.sql
20261116101450009_report_delivery_terminal_state.sql
20261116113334512_pr_head_stack_facts.sql
20261116125847855_allow_open_interpreter_harness.sql
20261116173733857_timestamp_repair_progress.sql
20261116231134450_shell_terminal_agent_conversation.sql
20261117090000000_allow_tau_harness.sql
20261118180603285_report_unacknowledged_attempts.sql
20261119061500000_review_requester.sql`)
var fork33280OnlyMigrations = strings.Fields(`0201_project_container_metadata.sql
0216_project_context_snapshots.sql
0217_session_permission_ceiling.sql
0218_multica_delegations.sql
0219_multica_confirmation_verification.sql
0220_library_registry.sql
0221_library_session_snapshots.sql
0222_factory_run_evidence.sql
0223_factory_run_evidence_bounds.sql
0224_report_chat_acceptance.sql
0225_report_delivery_recovery.sql
0226_factory_run_monitoring.sql
0227_factory_monitor_cursor.sql
0228_factory_review_feedback.sql
0229_outer_binding.sql
0230_outer_requests.sql
0231_outer_native_actions.sql
0232_outer_session_generations.sql
0233_outer_action_plans.sql
0234_outer_mailbox.sql
20261102160814608_agent_asset_sources.sql`)

func openIntegrationPredecessor(t *testing.T, dir string, fork bool) *sql.DB {
	t.Helper()
	excluded := map[string]bool{"20261120041743565_fork_project_context_schema_repair.sql": true}
	names := fork33280OnlyMigrations
	if fork {
		names = postFork33280Migrations
	}
	for _, n := range names {
		excluded[n] = true
	}
	fs := fstest.MapFS{}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() || excluded[e.Name()] {
			continue
		}
		if !fork {
			var version int64
			if _, err := fmt.Sscanf(e.Name(), "%d_", &version); err != nil {
				t.Fatal(err)
			}
			if version >= openInterpreterMigrationVersion {
				continue
			}
		}
		content, err := migrationsFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		fs["migrations/"+e.Name()] = &fstest.MapFile{Data: content}
	}
	db, err := sql.Open("ao-sqlite", databaseURI(dir)+pragmas)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	gooseMu.Lock()
	goose.SetBaseFS(fs)
	err = goose.SetDialect("sqlite3")
	if err == nil {
		err = goose.Up(db, "migrations", goose.WithAllowMissing())
	}
	goose.SetBaseFS(migrationsFS)
	gooseMu.Unlock()
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	return db
}

func TestMigrationLatestOpensInstalledForkAndForeignDraftTwice(t *testing.T) {
	for _, fork := range []bool{true, false} {
		t.Run(fmt.Sprintf("fork_%v", fork), func(t *testing.T) {
			dir := t.TempDir()
			db := openIntegrationPredecessor(t, dir, fork)
			mustExec(t, db, `INSERT INTO projects (id,path,registered_at) VALUES ('integration','/tmp/integration','2026-11-18 00:00:00 +0000 UTC')`)
			mustExec(t, db, `INSERT INTO sessions (id,project_id,num,harness,activity_last_at,created_at,updated_at,session_permissions) VALUES ('integration-1','integration',1,'aider','2026-11-18 00:00:00 +0000 UTC','2026-11-18 00:00:00 +0000 UTC','2026-11-18 00:00:00 +0000 UTC','accept-edits')`)
			var ceiling, contextTable int
			if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('sessions') WHERE name='permission_ceiling'`).Scan(&ceiling); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='project_context_snapshots'`).Scan(&contextTable); err != nil {
				t.Fatal(err)
			}
			if fork {
				if ceiling != 1 || contextTable != 1 {
					t.Fatal("fork predecessor missing shipped schema", ceiling, contextTable)
				}
				mustExec(t, db, `UPDATE sessions SET permission_ceiling='bypass-permissions' WHERE id='integration-1'`)
				mustExec(t, db, `INSERT INTO project_context_snapshots(session_id,project_id,project_revision,manifest_json,digest,created_at) VALUES ('integration-1','integration',7,'{}','preserved-context','2026-11-18 00:00:00 +0000 UTC')`)
				mustExec(t, db, `INSERT INTO project_context_local_sources(source_ref,machine_id,root_path,relative_path,media_type,registered_at,updated_at) VALUES ('preserved-source','machine','/tmp','source','text/plain','2026-11-18 00:00:00 +0000 UTC','2026-11-18 00:00:00 +0000 UTC')`)
			} else {
				if ceiling != 0 || contextTable != 0 {
					t.Fatal("foreign predecessor contains fork schema", ceiling, contextTable)
				}
				mustExec(t, db, `PRAGMA writable_schema=ON`)
				mustExec(t, db, `UPDATE sqlite_master SET sql=replace(sql,'''fake''))','''open-interpreter'', ''fake''))') WHERE type='table' AND name='sessions'`)
				mustExec(t, db, `PRAGMA writable_schema=RESET`)
				mustExec(t, db, `INSERT INTO goose_db_version(version_id,is_applied) VALUES (216,1)`)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			for pass := 0; pass < 2; pass++ {
				s, err := Open(dir)
				if err != nil {
					t.Fatalf("production Open pass%d: %v", pass, err)
				}
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
				db, err = sql.Open("ao-sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "ao.db"))+pragmas)
				if err != nil {
					t.Fatal(err)
				}
				var runtime, limit string
				if err := db.QueryRow(`SELECT session_permissions,permission_ceiling FROM sessions WHERE id='integration-1'`).Scan(&runtime, &limit); err != nil {
					t.Fatal(err)
				}
				wantLimit := "accept-edits"
				if fork {
					wantLimit = "bypass-permissions"
				}
				if runtime != "accept-edits" || limit != wantLimit {
					t.Fatalf("policy overwritten: runtime=%q ceiling=%q", runtime, limit)
				}
				for _, v := range []int64{201, 216, 217, forkContextRepairVersion} {
					if !fork && v == 201 {
						continue
					}
					var count int
					if err := db.QueryRow(`SELECT count(*) FROM goose_db_version WHERE version_id=? AND is_applied=1`, v).Scan(&count); err != nil || count != 1 {
						t.Fatalf("receipt%d count=%d err=%v", v, count, err)
					}
				}
				if fork {
					var digest, source string
					if err := db.QueryRow(`SELECT digest FROM project_context_snapshots WHERE session_id='integration-1'`).Scan(&digest); err != nil || digest != "preserved-context" {
						t.Fatal(digest, err)
					}
					if err := db.QueryRow(`SELECT source_ref FROM project_context_local_sources WHERE machine_id='machine'`).Scan(&source); err != nil || source != "preserved-source" {
						t.Fatal(source, err)
					}
				} else {
					mustExec(t, db, `INSERT OR IGNORE INTO project_context_snapshots(session_id,project_id,manifest_json,digest,created_at) VALUES ('integration-1','integration','{}','repaired-context','2026-11-18 00:00:00 +0000 UTC')`)
				}
				if _, err := db.Exec(`UPDATE project_context_snapshots SET digest='forbidden' WHERE session_id='integration-1'`); err == nil || !strings.Contains(err.Error(), "immutable") {
					t.Fatalf("snapshot trigger lost: %v", err)
				}
				var machineIndex int
				if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_project_context_local_sources_machine'`).Scan(&machineIndex); err != nil || machineIndex != 1 {
					t.Fatal("machine source index missing", err)
				}
				db.Close()
			}
		})
	}
}
