-- +goose Up
CREATE TABLE outer_action_plans (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE REFERENCES outer_requests(id),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=262144),
 approved_at TIMESTAMP,
 expires_at TIMESTAMP
);
CREATE TABLE outer_plan_actions (
 id TEXT PRIMARY KEY,
 plan_id TEXT NOT NULL REFERENCES outer_action_plans(id),
 session_id TEXT NOT NULL DEFAULT '',
 attempted_at TIMESTAMP,
 completed_at TIMESTAMP,
 state TEXT NOT NULL DEFAULT 'proposed'
);
CREATE TABLE outer_participants (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id),
 action_id TEXT NOT NULL REFERENCES outer_plan_actions(id),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 enrolled_at TIMESTAMP NOT NULL
);
-- +goose StatementBegin
CREATE TRIGGER outer_plan_immutable BEFORE UPDATE OF id,request_id,document ON outer_action_plans
BEGIN SELECT RAISE(ABORT,'outer plan is sealed'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_plan_retained BEFORE DELETE ON outer_action_plans
BEGIN SELECT RAISE(ABORT,'outer plan is retained'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_plan_action_retained BEFORE DELETE ON outer_plan_actions
BEGIN SELECT RAISE(ABORT,'outer action is retained'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_participant_retained BEFORE DELETE ON outer_participants
BEGIN SELECT RAISE(ABORT,'outer participant is retained'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER outer_participant_retained;
DROP TRIGGER outer_plan_action_retained;
DROP TRIGGER outer_plan_retained;
DROP TRIGGER outer_plan_immutable;
DROP TABLE outer_participants;
DROP TABLE outer_plan_actions;
DROP TABLE outer_action_plans;
