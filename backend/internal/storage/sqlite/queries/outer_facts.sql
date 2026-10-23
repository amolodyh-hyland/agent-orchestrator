-- name: OuterReportFacts :many
SELECT id,session_id,state,substr(note,1,8000) AS note,created_at,delivery_state,delivery_batch_id
FROM reports WHERE project_id=sqlc.arg(project_id) ORDER BY created_at DESC,id LIMIT sqlc.arg(page_size);
-- name: OuterSessionFacts :many
SELECT id,display_name,harness,session_mode,activity_state,is_terminated,updated_at,revision
FROM sessions WHERE project_id=sqlc.arg(project_id) ORDER BY updated_at DESC,id LIMIT sqlc.arg(page_size);
-- name: OuterRunFacts :many
SELECT id,version,json_extract(document,'$.taskId') AS task_id,json_extract(document,'$.stage') AS stage,
json_extract(document,'$.sessionId') AS session_id,json_extract(document,'$.createdAt') AS created_at
FROM factory_runs WHERE project_id=sqlc.arg(project_id) ORDER BY id DESC LIMIT sqlc.arg(page_size);
-- name: OuterSourceLineage :many
SELECT document FROM outer_sources WHERE source_key=? ORDER BY rowid DESC LIMIT 100;
-- name: OuterRequestForProvider :one
SELECT r.* FROM outer_requests r JOIN conversation_turns t ON t.id=r.turn_id
WHERE t.conversation_id=sqlc.arg(conversation_id) AND t.provider_turn_id=sqlc.arg(provider_turn_id)
AND t.controller_generation=sqlc.arg(generation) LIMIT 1;
-- name: OuterObservedReviewActivity :many
SELECT session_id, reviewer_activity_state, is_archived, reviewer_handle_id, provider_conversation_id FROM review;

-- name: OuterRequestAuditLink :one
SELECT r.id FROM outer_requests r JOIN conversation_turns t ON t.id=r.turn_id
WHERE t.conversation_id=sqlc.arg(conversation_id) AND t.provider_turn_id=sqlc.arg(provider_turn_id)
AND t.controller_generation=sqlc.arg(generation);
