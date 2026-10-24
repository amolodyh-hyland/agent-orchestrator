-- +goose Up
CREATE TABLE outer_session_generations (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    generation INTEGER NOT NULL CHECK(generation > 0),
    UNIQUE(project_id, generation)
);
-- +goose StatementBegin
CREATE TRIGGER outer_session_generations_no_update BEFORE UPDATE ON outer_session_generations
BEGIN SELECT RAISE(ABORT, 'outer session generation is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_session_generations_no_delete BEFORE DELETE ON outer_session_generations
BEGIN SELECT RAISE(ABORT, 'outer session generations are retained'); END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER outer_session_generations_no_delete;
DROP TRIGGER outer_session_generations_no_update;
DROP TABLE outer_session_generations;
