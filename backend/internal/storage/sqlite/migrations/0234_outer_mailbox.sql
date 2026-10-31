-- +goose Up
CREATE TABLE outer_mailbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES projects(id),
 coordinator_id TEXT NOT NULL REFERENCES sessions(id),
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=65536)
);
CREATE INDEX outer_mailbox_project_sequence ON outer_mailbox(project_id,sequence);
CREATE TABLE outer_mailbox_receipts (
 message_id TEXT PRIMARY KEY REFERENCES outer_mailbox(id),
 recipient_id TEXT NOT NULL REFERENCES sessions(id),
 action_id TEXT NOT NULL,
 recorded_at TIMESTAMP NOT NULL
);
-- +goose StatementBegin
CREATE TRIGGER outer_mailbox_immutable BEFORE UPDATE ON outer_mailbox
BEGIN SELECT RAISE(ABORT,'mailbox message is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_mailbox_retained BEFORE DELETE ON outer_mailbox
BEGIN SELECT RAISE(ABORT,'mailbox message is retained'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_mailbox_receipt_immutable BEFORE UPDATE ON outer_mailbox_receipts
BEGIN SELECT RAISE(ABORT,'mailbox receipt is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_mailbox_receipt_retained BEFORE DELETE ON outer_mailbox_receipts
BEGIN SELECT RAISE(ABORT,'mailbox receipt is retained'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER outer_mailbox_receipt_retained;
DROP TRIGGER outer_mailbox_receipt_immutable;
DROP TRIGGER outer_mailbox_retained;
DROP TRIGGER outer_mailbox_immutable;
DROP TABLE outer_mailbox_receipts;
DROP TABLE outer_mailbox;
