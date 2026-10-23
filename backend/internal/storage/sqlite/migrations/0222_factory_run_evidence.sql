-- +goose Up
CREATE TABLE factory_runs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 session_id TEXT NOT NULL REFERENCES sessions(id),
 version INTEGER NOT NULL CHECK (version >= 0),
 document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE INDEX factory_runs_project ON factory_runs(project_id, id);
CREATE TABLE factory_run_evidence (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES factory_runs(id),
 version INTEGER NOT NULL CHECK (version >= 0),
 document TEXT NOT NULL CHECK (json_valid(document)),
 UNIQUE(run_id, version)
);
-- +goose StatementBegin
CREATE TRIGGER factory_run_evidence_no_update BEFORE UPDATE ON factory_run_evidence
BEGIN SELECT RAISE(ABORT, 'run evidence is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER factory_run_evidence_no_delete BEFORE DELETE ON factory_run_evidence
BEGIN SELECT RAISE(ABORT, 'run evidence is immutable'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER factory_run_evidence_no_delete;
DROP TRIGGER factory_run_evidence_no_update;
DROP TABLE factory_run_evidence;
DROP TABLE factory_runs;
