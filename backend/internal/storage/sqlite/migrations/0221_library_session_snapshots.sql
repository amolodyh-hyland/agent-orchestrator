-- +goose Up
CREATE TABLE library_session_snapshots (
    session_id TEXT PRIMARY KEY REFERENCES project_context_snapshots(session_id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL UNIQUE,
    context_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    digest TEXT NOT NULL
);
-- +goose StatementBegin
CREATE TRIGGER library_session_snapshots_immutable_update
BEFORE UPDATE ON library_session_snapshots
BEGIN
    SELECT RAISE(ABORT, 'library snapshots are immutable');
END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER library_session_snapshots_immutable_update;
DROP TABLE library_session_snapshots;
