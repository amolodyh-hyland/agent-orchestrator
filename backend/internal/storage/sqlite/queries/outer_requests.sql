-- name: InsertOuterRequest :exec
INSERT INTO outer_requests(id,document) VALUES(?,?);
-- name: GetOuterRequest :one
SELECT * FROM outer_requests WHERE id=?;
-- name: LinkOuterRequest :execrows
UPDATE outer_requests SET turn_id=sqlc.arg(turn_id) WHERE id=sqlc.arg(id) AND turn_id='' AND attempted_at IS NULL;
-- name: AttemptOuterRequest :execrows
UPDATE outer_requests SET attempted_at=sqlc.arg(attempted_at) WHERE id=sqlc.arg(id) AND attempted_at IS NULL AND turn_id<>'';
-- name: ListOuterRequests :many
SELECT * FROM outer_requests WHERE json_extract(document,'$.sessionId')=sqlc.arg(session_id) ORDER BY rowid DESC LIMIT 100;
-- name: SubmitOuterRequest :exec
UPDATE outer_requests SET submitted_at=sqlc.arg(submitted_at) WHERE turn_id=sqlc.arg(turn_id) AND attempted_at IS NOT NULL AND submitted_at IS NULL;
-- name: AcceptOuterRequest :exec
UPDATE outer_requests SET accepted_at=sqlc.arg(accepted_at),provider_turn_id=sqlc.arg(provider_turn_id)
WHERE attempted_at IS NOT NULL AND accepted_at IS NULL
AND json_extract(document,'$.conversationId')=sqlc.arg(conversation_id)
AND json_extract(document,'$.providerConversationId')=sqlc.arg(provider_conversation_id)
AND turn_id IN(SELECT id FROM conversation_turns WHERE conversation_id=sqlc.arg(conversation_id) AND provider_turn_id=sqlc.arg(provider_turn_id));
-- name: SettleOuterRequest :exec
UPDATE outer_requests SET settled_at=sqlc.arg(settled_at) WHERE accepted_at IS NOT NULL AND settled_at IS NULL AND provider_turn_id=sqlc.arg(provider_turn_id) AND json_extract(document,'$.conversationId')=sqlc.arg(conversation_id);
-- name: ReserveOuterCapacity :exec
INSERT INTO outer_capacity(request_id,session_id,generation,heavy,foreground,reserved_at) VALUES(?,?,?,?,?,?);
-- name: ListOuterCapacity :many
SELECT * FROM outer_capacity WHERE released_at IS NULL;
-- name: ReleaseOuterCapacity :execrows
UPDATE outer_capacity SET released_at=sqlc.arg(released_at),release_evidence=sqlc.arg(release_evidence) WHERE request_id=sqlc.arg(request_id) AND released_at IS NULL;
-- name: IssueOuterCaller :exec
INSERT INTO outer_callers(verifier,session_id,project_id,generation,outer_scope) VALUES(?,?,?,?,?);
-- name: GetOuterCaller :one
SELECT * FROM outer_callers WHERE verifier=?;
-- name: UpsertOuterSource :exec
INSERT INTO outer_sources(conversation_id,source_key,document) VALUES(?,?,?) ON CONFLICT(conversation_id,source_key) DO UPDATE SET document=excluded.document;
-- name: OuterPendingInteraction :one
SELECT count(*) FROM conversation_activities a JOIN conversation_turns t ON t.id=a.turn_id
JOIN outer_requests r ON r.turn_id=t.id
WHERE a.conversation_id=sqlc.arg(conversation_id) AND a.request_id=sqlc.arg(request_id) AND a.status='pending'
AND t.provider_turn_id=sqlc.arg(provider_turn_id) AND t.controller_generation=sqlc.arg(generation)
AND t.handled_by_session_id=sqlc.arg(session_id) AND r.attempted_at IS NOT NULL AND r.settled_at IS NULL;
-- name: ListOuterSources :many
SELECT document FROM outer_sources WHERE conversation_id=? ORDER BY source_key LIMIT 1000;
-- name: InsertOuterEvidence :exec
INSERT INTO outer_evidence(id,session_id,source_json,content,recorded_at) VALUES(?,?,?,?,?);
-- name: ListOuterEvidence :many
SELECT * FROM outer_evidence WHERE session_id=? ORDER BY recorded_at DESC LIMIT 100;

-- name: BindOuterReviewSession :execrows
UPDATE outer_callers SET generation=sqlc.arg(next_generation)
WHERE session_id=sqlc.arg(session_id) AND outer_scope=0
AND json_extract(CASE WHEN substr(generation,1,15)='review-session:' THEN substr(generation,16) ELSE '{}' END,'$.reviewId')=sqlc.arg(review_id)
AND json_extract(CASE WHEN substr(generation,1,15)='review-session:' THEN substr(generation,16) ELSE '{}' END,'$.generation')=sqlc.arg(generation);
-- name: ClearOuterReviewResultBinding :exec
UPDATE outer_callers SET generation='review-session:' || json_set(substr(generation,16),'$.runId','','$.headSha','')
WHERE outer_scope=0 AND substr(generation,1,15)='review-session:'
AND json_extract(substr(generation,16),'$.runId')=sqlc.arg(run_id);
-- name: OuterCallerGenerationExists :one
SELECT EXISTS(SELECT 1 FROM outer_callers WHERE session_id=sqlc.arg(session_id) AND generation=sqlc.arg(generation));

-- name: ClearCancelledOuterReviewBindings :exec
UPDATE outer_callers SET generation='review-session:' || json_set(substr(generation,16),'$.runId','','$.headSha','')
WHERE outer_scope=0 AND substr(generation,1,15)='review-session:'
AND json_extract(substr(generation,16),'$.runId') IN (SELECT id FROM review_run WHERE review_run.session_id=sqlc.arg(session_id) AND status='cancelled');

-- name: CountOuterReviewSessions :one
SELECT count(*) FROM outer_callers WHERE session_id=sqlc.arg(session_id) AND outer_scope=0
AND json_extract(CASE WHEN substr(generation,1,15)='review-session:' THEN substr(generation,16) ELSE '{}' END,'$.reviewId')=sqlc.arg(review_id)
AND json_extract(CASE WHEN substr(generation,1,15)='review-session:' THEN substr(generation,16) ELSE '{}' END,'$.generation')=sqlc.arg(generation);
