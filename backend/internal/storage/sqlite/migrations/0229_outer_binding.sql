-- +goose Up
CREATE TABLE outer_binding (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
);
CREATE TABLE outer_audit (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 document TEXT NOT NULL CHECK(json_valid(document) AND length(CAST(document AS BLOB)) <= 65536)
);
-- +goose StatementBegin
CREATE TRIGGER outer_audit_no_update BEFORE UPDATE ON outer_audit
BEGIN SELECT RAISE(ABORT,'outer audit is append only'); END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER outer_audit_no_delete BEFORE DELETE ON outer_audit
BEGIN SELECT RAISE(ABORT,'outer audit is retained'); END;
-- +goose StatementEnd
-- +goose Down
DROP TRIGGER outer_audit_no_delete;
DROP TRIGGER outer_audit_no_update;
DROP TABLE outer_audit;
DROP TABLE outer_binding;
