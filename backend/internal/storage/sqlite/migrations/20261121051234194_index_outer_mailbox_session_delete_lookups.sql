-- +goose Up
-- Session deletes look up the children of every foreign key into sessions by the
-- child column. outer_mailbox(coordinator_id) and outer_mailbox_receipts(recipient_id)
-- were added without an index, so each lookup scanned the whole table. Migration
-- 0234 is already shipped, so the indexes are added here instead.
CREATE INDEX IF NOT EXISTS outer_mailbox_coordinator ON outer_mailbox(coordinator_id);
CREATE INDEX IF NOT EXISTS outer_mailbox_receipts_recipient ON outer_mailbox_receipts(recipient_id);

-- +goose Down
DROP INDEX IF EXISTS outer_mailbox_receipts_recipient;
DROP INDEX IF EXISTS outer_mailbox_coordinator;
