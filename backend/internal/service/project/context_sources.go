package project

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// projectContextLocalSourceStore is the owning daemon's local resolver store.
// The Store used by Service implements it when local attachments are supported.
type projectContextLocalSourceStore interface {
	GetProjectContextLocalSource(ctx context.Context, sourceRef string) (domain.ProjectContextLocalSourceRecord, bool, error)
	UpsertProjectContextLocalSource(ctx context.Context, source domain.ProjectContextLocalSourceRecord) error
}

// SetProjectContextMachineID records the identity of the machine this daemon
// owns. Only attachments bound to that machine can have a local path registered.
func (m *Service) SetProjectContextMachineID(id string) {
	m.contextMachineMu.Lock()
	m.contextMachineID = strings.TrimSpace(id)
	m.contextMachineMu.Unlock()
}

func (m *Service) projectContextMachineIDValue() string {
	m.contextMachineMu.RLock()
	defer m.contextMachineMu.RUnlock()
	return m.contextMachineID
}

// registerProjectContextLocalSources registers the locator of every attachment
// that carries a write-only LocalPath on this machine, then returns the
// instructions with LocalPath removed so no path is stored or returned. Resending
// a LocalPath refreshes the registration; omitting it leaves the registered
// locator untouched.
func (m *Service) registerProjectContextLocalSources(ctx context.Context, projectID domain.ProjectID, projectPath string, in domain.ProjectInstructions) (domain.ProjectInstructions, error) {
	hasPath := false
	for _, a := range in.Attachments {
		if a.LocalPath != "" {
			hasPath = true
			break
		}
	}
	if !hasPath {
		return in, nil
	}
	store, ok := m.store.(projectContextLocalSourceStore)
	if !ok {
		return in, apierr.Invalid("PROJECT_CONTEXT_LOCAL_SOURCE_UNAVAILABLE", "Local attachments are not supported by this daemon", nil)
	}
	machineID := m.projectContextMachineIDValue()
	out := in
	out.Attachments = append([]domain.ProjectContextAttachment(nil), in.Attachments...)
	for i, a := range out.Attachments {
		if a.LocalPath == "" {
			continue
		}
		out.Attachments[i].LocalPath = ""
		if machineID == "" || a.MachineID != machineID {
			return in, apierr.Invalid("PROJECT_CONTEXT_LOCAL_SOURCE_WRONG_MACHINE", "A local path can only be registered on the machine that owns the attachment", nil)
		}
		root, rel, err := projectContextLocator(a, projectPath)
		if err != nil {
			return in, apierr.Invalid("PROJECT_CONTEXT_LOCAL_PATH_INVALID", err.Error(), nil)
		}
		ownerKind, ownerID := a.OwnerKind, a.OwnerID
		if ownerKind == "" {
			ownerKind = domain.ProjectContextOwnerProject
		}
		if ownerKind == domain.ProjectContextOwnerProject && ownerID == "" {
			ownerID = string(projectID)
		}
		existing, found, err := store.GetProjectContextLocalSource(ctx, a.SourceRef)
		if err != nil {
			return in, apierr.Internal("PROJECT_CONTEXT_LOCAL_SOURCE_FAILED", "Failed to register the local attachment source")
		}
		if found && (existing.OwnerKind != ownerKind || existing.OwnerID != ownerID) {
			return in, apierr.Conflict("PROJECT_CONTEXT_SOURCE_REF_IN_USE", "The source reference is already registered for another owner", nil)
		}
		now := m.clock().UTC()
		record := domain.ProjectContextLocalSourceRecord{
			SourceRef: a.SourceRef, MachineID: machineID, RootPath: root, RelativePath: rel,
			MediaType: a.MediaType, OwnerKind: ownerKind, OwnerID: ownerID, RegisteredAt: now, UpdatedAt: now,
		}
		if found {
			record.RegisteredAt = existing.RegisteredAt
		}
		if err := store.UpsertProjectContextLocalSource(ctx, record); err != nil {
			return in, apierr.Invalid("PROJECT_CONTEXT_LOCAL_PATH_INVALID", "The local path could not be registered", nil)
		}
	}
	return out, nil
}

func projectContextLocator(a domain.ProjectContextAttachment, projectPath string) (root, rel string, err error) {
	switch a.SourceKind {
	case domain.ProjectContextRepoRelativeFile:
		if !filepath.IsAbs(projectPath) {
			return "", "", errLocalPath("the Project has no local folder to resolve a relative path against")
		}
		if filepath.IsAbs(a.LocalPath) || strings.Contains(a.LocalPath, `\`) || !filepath.IsLocal(a.LocalPath) {
			return "", "", errLocalPath("a repo-relative local path must stay inside the Project folder")
		}
		return projectPath, filepath.ToSlash(filepath.Clean(a.LocalPath)), nil
	case domain.ProjectContextMachineLocalFile:
		clean := filepath.Clean(a.LocalPath)
		if !filepath.IsAbs(clean) {
			return "", "", errLocalPath("a machine-local path must be absolute")
		}
		return filepath.Dir(clean), filepath.Base(clean), nil
	}
	return "", "", errLocalPath("a local path is not valid for this source kind")
}

type errLocalPath string

func (e errLocalPath) Error() string { return string(e) }
