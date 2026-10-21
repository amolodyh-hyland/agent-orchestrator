-- +goose Up
CREATE TABLE multica_delegations (
 request_id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 confirmation_id TEXT NOT NULL UNIQUE,
 is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
 version INTEGER NOT NULL,
 document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE UNIQUE INDEX multica_delegations_current_task ON multica_delegations(project_id, task_id) WHERE is_current = 1;
CREATE TABLE multica_delegation_transitions (
 request_id TEXT NOT NULL REFERENCES multica_delegations(request_id),
 version INTEGER NOT NULL,
 state TEXT NOT NULL,
 recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
 document TEXT NOT NULL CHECK (json_valid(document)),
 PRIMARY KEY (request_id, version)
);

-- +goose Down
DROP TABLE multica_delegation_transitions;
DROP TABLE multica_delegations;
