-- +goose Up
ALTER TABLE sessions ADD COLUMN permission_ceiling TEXT NOT NULL DEFAULT '';
UPDATE sessions SET permission_ceiling = session_permissions;

-- +goose Down
ALTER TABLE sessions DROP COLUMN permission_ceiling;
