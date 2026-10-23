-- name: CreateReport :one
INSERT INTO reports (
    id, session_id, project_id, state, note, message, created_at, available_at,
    settlement_deadline, repeat_count
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: CreateReportOutput :exec
INSERT INTO report_outputs (report_id, position, kind, reference, label)
VALUES (?, ?, ?, ?, ?);

-- name: GetReport :one
SELECT * FROM reports WHERE id = ?;

-- name: ListReportOutputs :many
SELECT * FROM report_outputs WHERE report_id = ? ORDER BY position;

-- name: ListReportsBySession :many
SELECT * FROM reports WHERE session_id = ? ORDER BY created_at, id;

-- name: ListReportedPRURLs :many
SELECT o.reference FROM report_outputs o
JOIN reports r ON r.id = o.report_id
WHERE r.session_id = ? AND o.kind = 'pr_created'
ORDER BY r.created_at, r.id, o.position;

-- name: ListReportsByProject :many
SELECT * FROM reports WHERE project_id = ? ORDER BY created_at, id;

-- name: ListPendingReportSchedule :many
SELECT * FROM reports
WHERE delivery_state = 'pending'
ORDER BY available_at, created_at, id
LIMIT ?;

-- name: ListPendingReportsByProjectSchedule :many
SELECT * FROM reports
WHERE project_id = ? AND delivery_state = 'pending'
ORDER BY available_at, created_at, id
LIMIT ?;

-- name: AssignPendingReportsToBatch :exec
UPDATE reports
SET delivery_batch_id = sqlc.arg(delivery_batch_id)
WHERE project_id = sqlc.arg(project_id) AND delivery_state = 'pending'
  AND delivery_batch_id = '';

-- name: ClaimPendingReportsByBatch :many
UPDATE reports
SET delivery_state = 'claimed', claim_token = sqlc.arg(claim_token),
    claimed_at = sqlc.arg(claimed_at), delivery_attempts = delivery_attempts + 1,
    last_error = ''
WHERE project_id = sqlc.arg(project_id) AND delivery_state = 'pending'
  AND delivery_batch_id = sqlc.arg(delivery_batch_id)
RETURNING *;

-- name: AcknowledgeReportBatch :many
UPDATE reports
SET delivery_state = 'acknowledged', acknowledged_at = sqlc.arg(acknowledged_at)
WHERE project_id = sqlc.arg(project_id) AND delivery_state = 'claimed'
  AND claim_token = sqlc.arg(claim_token)
RETURNING *;

-- name: ReleaseReportBatch :many
UPDATE reports
SET delivery_state = 'pending', available_at = min(available_at, sqlc.arg(available_at)),
    claim_token = '', claimed_at = NULL, last_error = sqlc.arg(last_error)
WHERE project_id = sqlc.arg(project_id) AND delivery_state = 'claimed'
  AND claim_token = sqlc.arg(claim_token)
RETURNING *;

-- name: DeferReportBatch :many
UPDATE reports
SET delivery_state = 'pending', available_at = CASE
        WHEN EXISTS (SELECT 1 FROM report_chat_deliveries d WHERE d.batch_id = reports.delivery_batch_id)
        THEN sqlc.arg(available_at) ELSE max(available_at, sqlc.arg(available_at)) END,
    claim_token = '', claimed_at = NULL, last_error = sqlc.arg(last_error)
WHERE project_id = sqlc.arg(project_id) AND delivery_state = 'claimed'
  AND claim_token = sqlc.arg(claim_token)
RETURNING *;

-- name: GetReportInterrupt :one
SELECT last_interrupted_at FROM report_worker_interrupts WHERE session_id = ?;

-- name: PutReportInterrupt :exec
INSERT INTO report_worker_interrupts (session_id, last_interrupted_at)
VALUES (?, ?)
ON CONFLICT(session_id) DO UPDATE SET last_interrupted_at = excluded.last_interrupted_at;

-- name: ListPendingReports :many
SELECT * FROM reports
WHERE delivery_state = 'pending' AND available_at <= ?
ORDER BY created_at, id
LIMIT ?;

-- name: ClaimReport :one
UPDATE reports
SET delivery_state = 'claimed', claim_token = sqlc.arg(claim_token),
    claimed_at = sqlc.arg(claimed_at), delivery_attempts = delivery_attempts + 1,
    last_error = ''
WHERE id = sqlc.arg(id) AND delivery_state = 'pending' AND available_at <= sqlc.arg(claimed_at)
RETURNING *;

-- name: AcknowledgeReport :one
UPDATE reports
SET delivery_state = 'acknowledged', acknowledged_at = sqlc.arg(acknowledged_at)
WHERE id = sqlc.arg(id) AND delivery_state = 'claimed' AND claim_token = sqlc.arg(claim_token)
RETURNING *;

-- name: ReleaseReport :one
UPDATE reports
SET delivery_state = 'pending', available_at = sqlc.arg(available_at),
    claim_token = '', claimed_at = NULL, last_error = sqlc.arg(last_error)
WHERE id = sqlc.arg(id) AND delivery_state = 'claimed' AND claim_token = sqlc.arg(claim_token)
RETURNING *;

-- name: RequeueClaimedReports :execrows
UPDATE reports
SET delivery_state = 'pending', claim_token = '', claimed_at = NULL,
    last_error = 'delivery claim recovered after daemon restart'
WHERE delivery_state = 'claimed';

-- name: LinkReportChatDelivery :execrows
INSERT INTO report_chat_deliveries(batch_id, message_id, client_message_id, conversation_id, turn_id)
SELECT sqlc.arg(batch_id), sqlc.arg(message_id), sqlc.arg(client_message_id), sqlc.arg(conversation_id), sqlc.arg(turn_id)
WHERE EXISTS (
    SELECT 1 FROM reports r JOIN sessions s ON s.project_id = r.project_id
    WHERE r.delivery_batch_id = sqlc.arg(batch_id)
      AND r.delivery_state = 'claimed' AND r.claim_token = sqlc.arg(claim_token)
      AND s.id = sqlc.arg(session_id) AND s.kind = 'orchestrator'
);

-- name: ReportChatReceipt :one
SELECT d.message_id, d.client_message_id, d.turn_id,
       CAST(coalesce(t.provider_turn_id, d.provider_turn_id) AS TEXT) AS provider_turn_id,
       CAST(coalesce(t.state, '') AS TEXT) AS state, d.provider_conversation_id, d.submitted_at, d.accepted_at
FROM report_chat_deliveries d
LEFT JOIN conversation_turns t ON t.id = d.turn_id
WHERE d.batch_id = ?;

-- name: RecordReportChatAcceptance :exec
UPDATE report_chat_deliveries SET accepted_at = sqlc.arg(accepted_at), submitted_at = coalesce(submitted_at, sqlc.arg(accepted_at)), provider_turn_id = sqlc.arg(provider_turn_id),
    provider_conversation_id = sqlc.arg(provider_conversation_id)
WHERE accepted_at IS NULL AND turn_id IN (
    SELECT t.id FROM conversation_turns t
    WHERE t.conversation_id = sqlc.arg(conversation_id)
      AND t.provider_turn_id = sqlc.arg(provider_turn_id)
);

-- name: RecordReportChatSubmission :exec
UPDATE report_chat_deliveries SET submitted_at = sqlc.arg(submitted_at)
WHERE turn_id = sqlc.arg(turn_id) AND submitted_at IS NULL;
