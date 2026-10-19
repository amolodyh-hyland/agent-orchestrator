-- +goose Up
-- +goose StatementBegin
ALTER TABLE projects
    ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK (metadata_revision >= 1);
ALTER TABLE projects
    ADD COLUMN instructions_json TEXT NOT NULL DEFAULT '{}';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE projects DROP COLUMN instructions_json;
ALTER TABLE projects DROP COLUMN metadata_revision;
-- +goose StatementEnd
