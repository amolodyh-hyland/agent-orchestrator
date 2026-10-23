-- +goose Up
CREATE TABLE factory_run_monitors (
 run_id TEXT PRIMARY KEY REFERENCES factory_runs(id),
 document TEXT NOT NULL CHECK (json_valid(document))
);
-- +goose Down
DROP TABLE factory_run_monitors;
