-- +goose Up
CREATE INDEX factory_runs_session ON factory_runs(session_id);
CREATE TABLE factory_review_feedback (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES factory_runs(id),
 repo_name TEXT NOT NULL,
 round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 2),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB)) <= 65536),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 delivery_error TEXT NOT NULL DEFAULT '',
 attempted_at TIMESTAMP,
 submitted_at TIMESTAMP,
 accepted_at TIMESTAMP,
 provider_turn_id TEXT NOT NULL DEFAULT '',
 provider_conversation_id TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX factory_feedback_current ON factory_review_feedback(run_id,round) WHERE active=1;
CREATE TABLE factory_feedback_controls (
 run_id TEXT PRIMARY KEY REFERENCES factory_runs(id),
 revision INTEGER NOT NULL,
 paused INTEGER NOT NULL CHECK(paused IN(0,1))
);
-- +goose StatementBegin
CREATE TRIGGER factory_feedback_binding_immutable BEFORE UPDATE OF id,run_id,repo_name,round,document ON factory_review_feedback
BEGIN SELECT RAISE(ABORT, 'review feedback binding is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER factory_feedback_no_delete BEFORE DELETE ON factory_review_feedback
BEGIN SELECT RAISE(ABORT, 'review feedback is retained'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER factory_feedback_no_delete;
DROP TRIGGER factory_feedback_binding_immutable;
DROP TABLE factory_feedback_controls;
DROP TABLE factory_review_feedback;
DROP INDEX factory_runs_session;
