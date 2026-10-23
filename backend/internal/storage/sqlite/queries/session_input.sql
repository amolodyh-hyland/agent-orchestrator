-- name: SessionInputOwners :many
SELECT s.id AS owner_id, s.project_id FROM sessions s
WHERE s.id = sqlc.arg(handle_id) OR s.runtime_handle_id = sqlc.arg(handle_id)
UNION
SELECT r.session_id AS owner_id, r.project_id FROM review r
WHERE r.reviewer_handle_id = sqlc.arg(handle_id) AND r.reviewer_handle_id <> ''
UNION
SELECT CAST(COALESCE(t.session_id, '') AS TEXT) AS owner_id,
       CAST(COALESCE(t.project_id, '') AS TEXT) AS project_id
FROM shell_terminals t WHERE t.handle_id = sqlc.arg(handle_id);
