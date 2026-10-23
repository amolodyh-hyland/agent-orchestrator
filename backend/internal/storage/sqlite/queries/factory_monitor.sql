-- name: GetRunMonitor :one
SELECT document FROM factory_run_monitors WHERE run_id = ?;
-- name: SaveRunMonitor :exec
INSERT INTO factory_run_monitors(run_id, document) VALUES (?, ?)
ON CONFLICT(run_id) DO UPDATE SET document = excluded.document;
-- name: FactoryFeedbackHeld :one
SELECT EXISTS (
 SELECT 1 FROM factory_runs r JOIN sessions s ON s.id=sqlc.arg(session_id)
 WHERE (r.session_id=s.id OR (r.project_id=s.project_id AND s.kind='orchestrator'))
 AND EXISTS (SELECT 1 FROM factory_run_evidence e WHERE e.run_id=r.id
 AND json_extract(e.document,'$.kind')='created' AND json_extract(e.document,'$.confirmed')=1)
);
-- name: ApprovedFactoryRunPage :many
SELECT r.document FROM factory_runs r
WHERE r.id > sqlc.arg(after_id)
 AND (sqlc.arg(project_id) = '' OR r.project_id = sqlc.arg(project_id))
 AND EXISTS (SELECT 1 FROM factory_run_evidence e WHERE e.run_id=r.id
 AND json_extract(e.document,'$.kind')='created' AND json_extract(e.document,'$.confirmed')=1)
ORDER BY r.id LIMIT sqlc.arg(page_size);
-- name: GetFactoryMonitorCursor :one
SELECT after_id FROM factory_monitor_cursors WHERE scope = ?;
-- name: SaveFactoryMonitorCursor :exec
INSERT INTO factory_monitor_cursors(scope,after_id) VALUES (?,?)
ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id;
-- name: FactoryMonitorParticipants :many
SELECT id FROM sessions WHERE project_id = sqlc.arg(project_id)
 AND (id=sqlc.arg(worker_id) OR (kind='orchestrator' AND is_terminated=0))
ORDER BY kind DESC, created_at DESC, id LIMIT 100;
-- name: FactoryMonitorReports :many
SELECT id, project_id, created_at, delivery_state, delivery_batch_id FROM reports
WHERE session_id=sqlc.arg(session_id) AND created_at>=sqlc.arg(stage_at)
ORDER BY created_at DESC,id DESC LIMIT 100;
-- name: FactoryMonitorPolicies :many
SELECT CAST(policy AS TEXT) AS policy FROM (
 SELECT 'pr:' || own_pr.url || ':ci=' || own_pr.auto_inject_ci AS policy FROM pr own_pr WHERE own_pr.session_id=sqlc.arg(owner_id)
 UNION ALL
 SELECT 'comment:' || c.comment_id || ':review=' || c.auto_inject_review FROM pr_comment c JOIN pr p ON p.url=c.pr_url WHERE p.session_id=sqlc.arg(owner_id)
 UNION ALL
 SELECT 'review:' || r.review_id || ':review=' || r.auto_inject_review FROM pr_reviews r JOIN pr p ON p.url=r.pr_url WHERE p.session_id=sqlc.arg(owner_id)
) ORDER BY policy LIMIT 1001;
