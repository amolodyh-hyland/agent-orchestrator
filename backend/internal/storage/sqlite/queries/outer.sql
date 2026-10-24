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
-- name: PageOuterProjectAudit :many
SELECT sequence,document FROM outer_audit
WHERE sequence > sqlc.arg(after_sequence) AND (
  json_extract(document,'$.projectId')=sqlc.arg(project_id)
  OR EXISTS (SELECT 1 FROM json_each(document,'$.projectIds') WHERE value=sqlc.arg(project_id))
  OR EXISTS (SELECT 1 FROM json_each(document,'$.sources') AS source
    WHERE json_extract(source.value,'$.projectId')=sqlc.arg(project_id)
    OR EXISTS (SELECT 1 FROM json_each(source.value,'$.sources') WHERE value=sqlc.arg(project_id)))
)
ORDER BY sequence LIMIT sqlc.arg(page_size);
