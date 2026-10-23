-- name: GetRunMonitor :one
SELECT document FROM factory_run_monitors WHERE run_id = ?;
-- name: SaveRunMonitor :exec
INSERT INTO factory_run_monitors(run_id, document) VALUES (?, ?)
ON CONFLICT(run_id) DO UPDATE SET document = excluded.document;
-- name: ApprovedActiveFactoryRuns :many
SELECT r.document FROM factory_runs r
WHERE EXISTS (SELECT 1 FROM factory_run_evidence e WHERE e.run_id=r.id
 AND json_extract(e.document,'$.kind')='created' AND json_extract(e.document,'$.confirmed')=1)
ORDER BY r.id;
-- name: FactoryFeedbackHeld :one
SELECT EXISTS (
 SELECT 1 FROM factory_runs r JOIN sessions s ON s.id=sqlc.arg(session_id)
 WHERE (r.session_id=s.id OR (r.project_id=s.project_id AND s.kind='orchestrator'))
 AND EXISTS (SELECT 1 FROM factory_run_evidence e WHERE e.run_id=r.id
 AND json_extract(e.document,'$.kind')='created' AND json_extract(e.document,'$.confirmed')=1)
);
