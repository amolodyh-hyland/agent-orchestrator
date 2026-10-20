-- name: InsertProjectContextSnapshot :execrows
INSERT OR IGNORE INTO project_context_snapshots (
    session_id, project_id, project_revision, manifest_json, digest, created_at
) VALUES (?, ?, ?, ?, ?, ?);

-- name: GetProjectContextSnapshot :one
SELECT session_id, project_id, project_revision, manifest_json, digest, created_at
FROM project_context_snapshots
WHERE session_id = ?;

-- name: UpsertProjectContextLocalSource :exec
INSERT INTO project_context_local_sources (
    source_ref, machine_id, root_path, relative_path, media_type,
    owner_kind, owner_id, registered_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source_ref) DO UPDATE SET
    machine_id = excluded.machine_id,
    root_path = excluded.root_path,
    relative_path = excluded.relative_path,
    media_type = excluded.media_type,
    owner_kind = excluded.owner_kind,
    owner_id = excluded.owner_id,
    updated_at = excluded.updated_at;

-- name: GetProjectContextLocalSource :one
SELECT source_ref, machine_id, root_path, relative_path, media_type,
       owner_kind, owner_id, registered_at, updated_at
FROM project_context_local_sources
WHERE source_ref = ?;
