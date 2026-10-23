-- +goose Up
CREATE TABLE factory_monitor_cursors (
 scope TEXT PRIMARY KEY,
 after_id TEXT NOT NULL
);
-- +goose Down
DROP TABLE factory_monitor_cursors;
