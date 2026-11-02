-- name: InsertOuterMailbox :exec
INSERT INTO outer_mailbox(id,project_id,coordinator_id,document) VALUES(?,?,?,?);
-- name: CountOuterMailbox :one
SELECT count(*) FROM outer_mailbox WHERE project_id=?;
-- name: GetOuterMailbox :one
SELECT m.*,r.recipient_id,r.recorded_at,r.action_id FROM outer_mailbox m LEFT JOIN outer_mailbox_receipts r ON r.message_id=m.id WHERE m.id=?;
-- name: PageOuterMailbox :many
SELECT m.*,r.recipient_id,r.recorded_at,r.action_id FROM outer_mailbox m LEFT JOIN outer_mailbox_receipts r ON r.message_id=m.id
WHERE m.project_id=sqlc.arg(project_id) AND (sqlc.arg(coordinator_id)='' OR m.coordinator_id=sqlc.arg(coordinator_id)) AND m.sequence>sqlc.arg(after_sequence) ORDER BY m.sequence LIMIT sqlc.arg(page_size);
-- name: ReceiptOuterMailbox :exec
INSERT INTO outer_mailbox_receipts(message_id,recipient_id,action_id,recorded_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO NOTHING;
