-- +goose Up
ALTER TABLE multica_delegations ADD COLUMN confirmation_verified INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_verified IN (0, 1));

-- +goose Down
ALTER TABLE multica_delegations DROP COLUMN confirmation_verified;
