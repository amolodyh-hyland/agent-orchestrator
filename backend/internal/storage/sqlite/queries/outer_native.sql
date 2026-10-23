-- name: RecordOuterNativeAction :exec
INSERT INTO outer_native_actions(id,document) VALUES(?,?);

-- name: CountOuterLiveCallers :one
SELECT count(*) FROM outer_callers WHERE session_id=? AND generation=?;

-- name: GetOuterSessionGeneration :one
SELECT generation FROM outer_session_generations WHERE session_id=?;

-- name: RecordOuterSessionGeneration :exec
INSERT INTO outer_session_generations(session_id,project_id,generation) VALUES(?,?,?);

-- name: ListOuterHostRequests :many
SELECT * FROM outer_requests ORDER BY rowid DESC LIMIT 100;
