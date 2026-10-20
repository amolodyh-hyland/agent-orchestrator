-- name: UpsertProject :exec
-- A conflicting row is a reactivation or re-registration: durable instructions
-- survive an empty incoming value and the revision always advances.
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    path = excluded.path,
    repo_origin_url = excluded.repo_origin_url,
    display_name = excluded.display_name,
    archived_at = excluded.archived_at,
    config = excluded.config,
    kind = excluded.kind,
    metadata_revision = MAX(projects.metadata_revision, excluded.metadata_revision) + 1,
    instructions_json = CASE WHEN excluded.instructions_json = '{}' THEN projects.instructions_json ELSE excluded.instructions_json END;

-- name: InsertProjectIfAbsent :execrows
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO NOTHING;

-- name: UpsertImportedProject :exec
-- The import is an authoritative replacement of an existing row, so the
-- revision advances past both the target and the source.
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    path = excluded.path,
    repo_origin_url = excluded.repo_origin_url,
    display_name = excluded.display_name,
    registered_at = excluded.registered_at,
    archived_at = excluded.archived_at,
    config = excluded.config,
    kind = excluded.kind,
    metadata_revision = MAX(projects.metadata_revision, excluded.metadata_revision) + 1,
    instructions_json = excluded.instructions_json;

-- name: GetProject :one
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json
FROM projects WHERE id = ?;

-- name: ListProjects :many
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json
FROM projects WHERE archived_at IS NULL ORDER BY id;

-- name: CountProjectsIncludingArchived :one
SELECT COUNT(*) FROM projects;

-- name: FindProjectByPath :one
SELECT id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json
FROM projects WHERE path = ? AND archived_at IS NULL;

-- name: UpdateProjectSettings :execrows
-- Instructions are written only when set_instructions is true, and then only if
-- the stored revision still equals expected_revision (compare-and-swap).
UPDATE projects
SET display_name = sqlc.arg(display_name),
    config = sqlc.arg(config),
    instructions_json = CASE WHEN CAST(sqlc.arg(set_instructions) AS INTEGER) <> 0 THEN sqlc.arg(instructions_json) ELSE instructions_json END,
    metadata_revision = metadata_revision + 1
WHERE id = sqlc.arg(id) AND archived_at IS NULL
  AND (CAST(sqlc.arg(set_instructions) AS INTEGER) = 0 OR MAX(metadata_revision, 1) = sqlc.arg(expected_revision));

-- name: UpdateProjectConfig :execrows
UPDATE projects
SET config = ?, metadata_revision = metadata_revision + 1
WHERE id = ? AND archived_at IS NULL;

-- name: BackfillProjectOriginURL :execrows
UPDATE projects
SET repo_origin_url = ?, metadata_revision = metadata_revision + 1
WHERE id = ? AND archived_at IS NULL AND repo_origin_url = '';

-- name: ArchiveProject :execrows
UPDATE projects SET archived_at = ?, metadata_revision = metadata_revision + 1 WHERE id = ? AND archived_at IS NULL;

-- name: PinProjectSessionPermissions :exec
UPDATE sessions SET session_permissions = sqlc.arg(permissions),
    permission_ceiling = CASE WHEN permission_ceiling = '' THEN sqlc.arg(permissions) ELSE permission_ceiling END
WHERE project_id = sqlc.arg(project_id) AND kind = sqlc.arg(kind)
  AND LENGTH(session_permissions) = 0 AND LENGTH(permission_ceiling) = 0;
