-- +goose Up
CREATE TABLE report_chat_deliveries (
    batch_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    client_message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL UNIQUE,
    provider_turn_id TEXT NOT NULL DEFAULT '',
    provider_conversation_id TEXT NOT NULL DEFAULT '',
    submitted_at TIMESTAMP,
    accepted_at TIMESTAMP
);

-- +goose Down
DROP TABLE report_chat_deliveries;
