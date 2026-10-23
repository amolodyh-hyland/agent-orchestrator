-- name: FactoryRunsForSession :many
SELECT r.document FROM factory_runs r WHERE r.session_id = ?
AND EXISTS(SELECT 1 FROM factory_run_evidence e WHERE e.run_id=r.id AND json_extract(e.document,'$.kind')='created' AND json_extract(e.document,'$.confirmed')=1)
ORDER BY r.id LIMIT 1000;
-- name: ReserveFactoryFeedback :execrows
INSERT INTO factory_review_feedback(id,run_id,repo_name,round,document)
SELECT sqlc.arg(id),sqlc.arg(run_id),sqlc.arg(repo_name),sqlc.arg(round),sqlc.arg(document)
WHERE EXISTS(SELECT 1 FROM factory_runs WHERE id=sqlc.arg(run_id) AND version=sqlc.arg(expected_version))
AND NOT EXISTS(SELECT 1 FROM factory_review_feedback f WHERE f.run_id=sqlc.arg(run_id) AND f.round=sqlc.arg(round) AND f.attempted_at IS NOT NULL)
AND (SELECT count(*) FROM factory_review_feedback f WHERE f.run_id=sqlc.arg(run_id)) < 16
ON CONFLICT DO NOTHING;
-- name: ListFactoryFeedback :many
SELECT * FROM factory_review_feedback WHERE run_id = ? ORDER BY repo_name,round;
-- name: GetFactoryFeedback :one
SELECT * FROM factory_review_feedback WHERE id = ?;
-- name: AttemptFactoryFeedback :execrows
UPDATE factory_review_feedback SET attempted_at = sqlc.arg(attempted_at)
WHERE factory_review_feedback.id = sqlc.arg(id) AND factory_review_feedback.attempted_at IS NULL AND factory_review_feedback.active=1
 AND julianday(json_extract(factory_review_feedback.document,'$.expiresAt')) > julianday(sqlc.arg(now_rfc3339))
 AND EXISTS(SELECT 1 FROM factory_runs r WHERE r.id=factory_review_feedback.run_id AND r.version=json_extract(factory_review_feedback.document,'$.runVersion'))
 AND coalesce((SELECT paused FROM factory_feedback_controls c WHERE c.run_id=factory_review_feedback.run_id),0)=0
 AND coalesce((SELECT revision FROM factory_feedback_controls c WHERE c.run_id=factory_review_feedback.run_id),0)=json_extract(factory_review_feedback.document,'$.controlRevision');
-- name: AcceptFactoryFeedback :exec
UPDATE factory_review_feedback SET accepted_at=sqlc.arg(accepted_at),provider_turn_id=sqlc.arg(provider_turn_id),provider_conversation_id=sqlc.arg(provider_conversation_id)
WHERE accepted_at IS NULL AND attempted_at IS NOT NULL AND id IN (
 SELECT m.client_message_id FROM conversation_messages m JOIN conversation_turns t ON t.id=m.turn_id
 WHERE t.conversation_id=sqlc.arg(conversation_id) AND t.provider_turn_id=sqlc.arg(provider_turn_id) AND m.role='user' AND m.origin='automation'
 AND t.handled_by_session_id=json_extract(factory_review_feedback.document,'$.sessionId')
 AND t.conversation_id=json_extract(factory_review_feedback.document,'$.conversationId')
);
-- name: SubmitFactoryFeedback :exec
UPDATE factory_review_feedback SET submitted_at=sqlc.arg(submitted_at)
WHERE attempted_at IS NOT NULL AND submitted_at IS NULL AND id IN (
 SELECT m.client_message_id FROM conversation_messages m JOIN conversation_turns t ON t.id=m.turn_id
 WHERE m.turn_id=sqlc.arg(turn_id) AND m.role='user' AND m.origin='automation'
 AND t.handled_by_session_id=json_extract(factory_review_feedback.document,'$.sessionId')
 AND t.conversation_id=json_extract(factory_review_feedback.document,'$.conversationId')
);
-- name: FactoryFeedbackTurn :one
SELECT t.id,t.state FROM conversation_turns t JOIN conversation_messages m ON m.turn_id=t.id JOIN factory_review_feedback f ON f.id=m.client_message_id
WHERE f.id=? AND t.handled_by_session_id=json_extract(f.document,'$.sessionId') AND t.conversation_id=json_extract(f.document,'$.conversationId') ORDER BY t.requested_at LIMIT 1;

-- name: FactoryFeedbackControl :one
SELECT revision,paused FROM factory_feedback_controls WHERE run_id = ?;
-- name: SetFactoryFeedbackControl :execrows
INSERT INTO factory_feedback_controls(run_id,revision,paused)
VALUES(sqlc.arg(run_id),sqlc.arg(expected_revision)+1,sqlc.arg(paused))
ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,paused=excluded.paused
WHERE factory_feedback_controls.revision=excluded.revision-1;

-- name: HoldFactoryFeedback :exec
UPDATE factory_review_feedback SET delivery_error='delivery_return_unknown' WHERE id=? AND accepted_at IS NULL;

-- name: SupersedeFactoryFeedback :exec
UPDATE factory_review_feedback SET active=0 WHERE run_id=? AND round=? AND attempted_at IS NULL AND active=1;
