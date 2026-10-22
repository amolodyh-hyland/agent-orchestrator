-- +goose Up
CREATE TABLE library_registry (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    registry_json TEXT NOT NULL
);
CREATE TABLE library_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_json TEXT NOT NULL
);
-- +goose Down
DROP TABLE library_audit;
DROP TABLE library_registry;
