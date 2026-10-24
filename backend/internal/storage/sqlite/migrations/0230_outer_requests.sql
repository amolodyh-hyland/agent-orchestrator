-- +goose Up
CREATE TABLE outer_requests (
 id TEXT PRIMARY KEY,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB))<=262144),
 turn_id TEXT NOT NULL DEFAULT '',
 attempted_at TIMESTAMP,
 submitted_at TIMESTAMP,
 accepted_at TIMESTAMP,
 settled_at TIMESTAMP,
 provider_turn_id TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX outer_request_turn ON outer_requests(turn_id) WHERE turn_id<>'';
CREATE TABLE outer_capacity (
 request_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 generation TEXT NOT NULL,
 heavy INTEGER NOT NULL CHECK(heavy IN(0,1)),
 foreground INTEGER NOT NULL CHECK(foreground IN(0,1)),
 reserved_at TIMESTAMP NOT NULL,
 released_at TIMESTAMP,
 release_evidence TEXT NOT NULL DEFAULT ''
);
CREATE TABLE outer_callers (
 verifier TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 generation TEXT NOT NULL,
 outer_scope INTEGER NOT NULL CHECK(outer_scope IN(0,1))
);
CREATE TABLE outer_sources (
 conversation_id TEXT NOT NULL,
 source_key TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 PRIMARY KEY(conversation_id,source_key)
);
CREATE TABLE outer_evidence (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 content TEXT NOT NULL CHECK(length(CAST(content AS BLOB))<=65536),
 recorded_at TIMESTAMP NOT NULL
);
-- +goose StatementBegin
CREATE TRIGGER outer_request_immutable BEFORE UPDATE OF id,document ON outer_requests
BEGIN SELECT RAISE(ABORT,'outer request is immutable'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_request_retained BEFORE DELETE ON outer_requests
BEGIN SELECT RAISE(ABORT,'outer requests are retained'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_capacity_retained BEFORE DELETE ON outer_capacity
BEGIN SELECT RAISE(ABORT,'outer reservations are retained'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER outer_capacity_retained;
DROP TRIGGER outer_request_retained;
DROP TRIGGER outer_request_immutable;
DROP TABLE outer_evidence;
DROP TABLE outer_sources;
DROP TABLE outer_callers;
DROP TABLE outer_capacity;
DROP TABLE outer_requests;
