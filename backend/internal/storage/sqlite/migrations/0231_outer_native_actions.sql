-- +goose Up
CREATE TABLE outer_native_actions (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL CHECK(json_valid(document)),
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- +goose StatementBegin
CREATE TRIGGER outer_native_actions_no_update BEFORE UPDATE ON outer_native_actions
BEGIN SELECT RAISE(ABORT, 'outer native actions are immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_native_actions_no_delete BEFORE DELETE ON outer_native_actions
BEGIN SELECT RAISE(ABORT, 'outer native actions are retained'); END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER outer_native_actions_no_delete;
DROP TRIGGER outer_native_actions_no_update;
DROP TABLE outer_native_actions;
