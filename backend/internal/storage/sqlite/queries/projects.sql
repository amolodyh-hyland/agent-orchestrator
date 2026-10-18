-- name: UpsertProject :exec
INSERT INTO projects (id, path, repo_origin_url, display_name, registered_at, archived_at, config, kind, metadata_revision, instructions_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    path = excluded.path,
    repo_origin_url = excluded.repo_origin_url,
    display_name = excluded.display_name,
    archived_at = excluded.archived_at,
    config = excluded.config,
    kind = excluded.kind,
    metadata_revision = MAX(projects.metadata_revision, excluded.metadata_revision),
    instructions_json = excluded.instructions_json;

-- name: UpsertImportedProject :exec
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
    metadata_revision = MAX(projects.metadata_revision, excluded.metadata_revision),
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
UPDATE projects
SET display_name = ?, config = ?, instructions_json = ?, metadata_revision = metadata_revision + 1
WHERE id = ? AND archived_at IS NULL;

-- name: ArchiveProject :execrows
UPDATE projects SET archived_at = ?, metadata_revision = metadata_revision + 1 WHERE id = ? AND archived_at IS NULL;

-- name: PinProjectSessionPermissions :exec
UPDATE sessions SET session_permissions = sqlc.arg(permissions)
WHERE project_id = sqlc.arg(project_id) AND kind = sqlc.arg(kind)
  AND LENGTH(session_permissions) = 0;
