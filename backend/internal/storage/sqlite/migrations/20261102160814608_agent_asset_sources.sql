-- +goose Up
ALTER TABLE app_settings ADD COLUMN agent_asset_sources TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(agent_asset_sources) AND json_type(agent_asset_sources) = 'array');

-- +goose Down
ALTER TABLE app_settings DROP COLUMN agent_asset_sources;
