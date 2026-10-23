-- name: GetFactoryRun :one
SELECT document FROM factory_runs WHERE id = ?;
-- name: ListFactoryRuns :many
SELECT document FROM factory_runs WHERE project_id = ? ORDER BY id;
-- name: InsertFactoryRun :execrows
INSERT INTO factory_runs(id, project_id, session_id, version, document) VALUES (?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING;
-- name: UpdateFactoryRun :execrows
UPDATE factory_runs SET version = sqlc.arg(next_version), document = sqlc.arg(document)
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
AND json_remove(document, '$.stage', '$.version') = json_remove(sqlc.arg(document), '$.stage', '$.version');
-- name: InsertRunEvidence :exec
INSERT INTO factory_run_evidence(id, run_id, version, document) VALUES (?, ?, ?, ?);
-- name: ListRunEvidence :many
SELECT document FROM factory_run_evidence WHERE run_id = ? ORDER BY version;
