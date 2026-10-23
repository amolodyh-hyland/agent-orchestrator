-- name: GetFactoryRun :one
SELECT document FROM factory_runs WHERE id = ?;
-- name: ListFactoryRuns :many
SELECT document FROM factory_runs WHERE project_id = ? ORDER BY id LIMIT 1000;
-- name: InsertFactoryRun :execrows
INSERT INTO factory_runs(id, project_id, session_id, version, document) VALUES (?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING;
-- name: UpdateFactoryRun :execrows
UPDATE factory_runs SET version = sqlc.arg(next_version), document = sqlc.arg(document)
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
AND json_remove(document, '$.stage', '$.version') = json_remove(sqlc.arg(document), '$.stage', '$.version');
-- name: InsertRunEvidence :exec
INSERT INTO factory_run_evidence(id, run_id, version, document) VALUES (?, ?, ?, ?);
-- name: ListRunEvidence :many
SELECT document FROM factory_run_evidence WHERE run_id = ? ORDER BY version DESC LIMIT 100;
-- name: PageRunEvidence :many
SELECT document FROM factory_run_evidence WHERE run_id = sqlc.arg(run_id) AND version > sqlc.arg(after_version) ORDER BY version LIMIT sqlc.arg(page_size);
-- name: CurrentRunEvidence :many
SELECT outer_e.document FROM factory_run_evidence AS outer_e WHERE outer_e.run_id = sqlc.arg(run_id) AND outer_e.version IN (
 SELECT MAX(inner_e.version) FROM factory_run_evidence AS inner_e
 WHERE inner_e.run_id = sqlc.arg(run_id) AND inner_e.version <= sqlc.arg(at_version)
 GROUP BY CASE
 WHEN json_extract(inner_e.document, '$.completion.repoName') IS NOT NULL THEN 'completion:' || json_extract(inner_e.document, '$.completion.repoName')
 WHEN json_extract(inner_e.document, '$.review.repoName') IS NOT NULL THEN 'review:' || json_extract(inner_e.document, '$.review.repoName')
 WHEN json_extract(inner_e.document, '$.kind') = 'created' THEN 'created'
 WHEN json_extract(inner_e.document, '$.kind') = 'advance' THEN 'advance'
 ELSE 'decision' END
) ORDER BY outer_e.version LIMIT 19;
