-- name: GetMulticaDelegation :one
SELECT document FROM multica_delegations WHERE request_id = ?;

-- name: FindMulticaDelegation :one
SELECT document FROM multica_delegations WHERE project_id = ? AND task_id = ? AND is_current = 1;

-- name: FindMulticaDelegationConfirmation :one
SELECT document FROM multica_delegations WHERE confirmation_id = ?;

-- name: RetireMulticaDelegation :execrows
UPDATE multica_delegations SET is_current = 0 WHERE request_id = ? AND project_id = ? AND task_id = ? AND is_current = 1;

-- name: InsertMulticaDelegation :exec
INSERT INTO multica_delegations(request_id, project_id, task_id, confirmation_id, is_current, version, document) VALUES (?, ?, ?, ?, 1, 0, ?);

-- name: UpdateMulticaDelegation :execrows
UPDATE multica_delegations SET version = ?, document = ? WHERE request_id = ? AND version = ?;

-- name: InsertMulticaDelegationTransition :exec
INSERT INTO multica_delegation_transitions(request_id, version, state, document) VALUES (?, ?, ?, ?);
