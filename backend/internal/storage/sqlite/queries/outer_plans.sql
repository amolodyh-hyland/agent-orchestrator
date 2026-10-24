-- name: InsertOuterPlan :exec
INSERT INTO outer_action_plans(id,request_id,document) VALUES(?,?,?);
-- name: GetOuterPlan :one
SELECT * FROM outer_action_plans WHERE id=?;
-- name: ListOuterPlans :many
SELECT * FROM outer_action_plans ORDER BY rowid DESC LIMIT 8;
-- name: ApproveOuterPlan :execrows
UPDATE outer_action_plans SET approved_at=sqlc.arg(approved_at),expires_at=sqlc.arg(expires_at) WHERE id=sqlc.arg(id) AND approved_at IS NULL;
-- name: InsertOuterPlanAction :exec
INSERT INTO outer_plan_actions(id,plan_id) VALUES(?,?);
-- name: ListOuterPlanActions :many
SELECT * FROM outer_plan_actions WHERE plan_id=? ORDER BY rowid;
-- name: GetOuterPlanAction :one
SELECT * FROM outer_plan_actions WHERE id=?;
-- name: AttemptOuterPlanAction :execrows
UPDATE outer_plan_actions SET attempted_at=sqlc.arg(attempted_at),state='unknown' WHERE id=sqlc.arg(id) AND attempted_at IS NULL;
-- name: BindOuterPlanAction :execrows
UPDATE outer_plan_actions SET session_id=sqlc.arg(session_id) WHERE id=sqlc.arg(id) AND session_id='';
-- name: CompleteOuterPlanAction :exec
UPDATE outer_plan_actions SET completed_at=sqlc.arg(completed_at),state=sqlc.arg(state) WHERE id=sqlc.arg(id) AND attempted_at IS NOT NULL AND completed_at IS NULL;
-- name: EnrollOuterParticipant :exec
INSERT INTO outer_participants(session_id,action_id,snapshot,enrolled_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO NOTHING;
-- name: IsOuterParticipant :one
SELECT EXISTS(
 SELECT 1 FROM outer_participants p JOIN sessions owner ON owner.id=p.session_id
 JOIN sessions target ON target.id=sqlc.arg(session_id)
 WHERE p.session_id=target.id OR (target.kind='orchestrator' AND owner.project_id=target.project_id)
);
-- name: AdoptOuterCapacity :execrows
UPDATE outer_capacity SET session_id=sqlc.arg(session_id),generation=sqlc.arg(generation) WHERE request_id=sqlc.arg(request_id) AND released_at IS NULL AND session_id='';
-- name: AcceptOuterPlanActions :exec
UPDATE outer_plan_actions SET state='completed',completed_at=sqlc.arg(accepted_at) WHERE completed_at IS NULL
AND id IN(SELECT id FROM outer_requests WHERE accepted_at IS NOT NULL AND json_extract(document,'$.conversationId')=sqlc.arg(conversation_id) AND provider_turn_id=sqlc.arg(provider_turn_id));
-- name: OuterProjectImportedSources :many
SELECT s.document FROM outer_sources s JOIN sessions t ON t.provider_conversation_id=s.conversation_id WHERE t.project_id=sqlc.arg(project_id) AND s.source_key LIKE 'export:%' ORDER BY s.rowid LIMIT 1000;

-- name: CancelOuterPlan :execrows
UPDATE outer_action_plans SET expires_at=sqlc.arg(expires_at) WHERE id=sqlc.arg(id) AND approved_at IS NULL AND expires_at IS NULL;
