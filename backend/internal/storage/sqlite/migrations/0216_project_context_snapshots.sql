-- +goose Up
CREATE TABLE project_context_snapshots (
    session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    project_id        TEXT REFERENCES projects(id),
    project_revision  INTEGER NOT NULL DEFAULT 0 CHECK (project_revision >= 0),
    manifest_json     TEXT NOT NULL,
    digest            TEXT NOT NULL,
    created_at        TIMESTAMP NOT NULL
);

-- +goose StatementBegin
CREATE TRIGGER project_context_snapshots_immutable_update
BEFORE UPDATE ON project_context_snapshots
BEGIN
    SELECT RAISE(ABORT, 'project context snapshots are immutable');
END;
-- +goose StatementEnd

CREATE TABLE project_context_local_sources (
    source_ref      TEXT PRIMARY KEY,
    machine_id      TEXT NOT NULL,
    root_path       TEXT NOT NULL,
    relative_path   TEXT NOT NULL,
    media_type      TEXT NOT NULL,
    owner_kind      TEXT NOT NULL DEFAULT 'user'
        CHECK (owner_kind IN ('project', 'user')),
    owner_id        TEXT NOT NULL DEFAULT '',
    registered_at   TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL
);

CREATE INDEX idx_project_context_local_sources_machine
    ON project_context_local_sources(machine_id);

-- +goose Down
DROP INDEX idx_project_context_local_sources_machine;
DROP TABLE project_context_local_sources;
DROP TRIGGER project_context_snapshots_immutable_update;
DROP TABLE project_context_snapshots;
