-- name: GetOuterBinding :one
SELECT document FROM outer_binding WHERE singleton=1;
-- name: SaveOuterBinding :execrows
INSERT INTO outer_binding(singleton,revision,document) VALUES(1,sqlc.arg(expected_revision)+1,sqlc.arg(document))
ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,document=excluded.document
WHERE outer_binding.revision=excluded.revision-1;
-- name: AppendOuterAudit :exec
INSERT INTO outer_audit(id,document) VALUES(?,?);
-- name: PageOuterAudit :many
SELECT sequence,document FROM outer_audit WHERE sequence > sqlc.arg(after_sequence) ORDER BY sequence LIMIT sqlc.arg(page_size);
