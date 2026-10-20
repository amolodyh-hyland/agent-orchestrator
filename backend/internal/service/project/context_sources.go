package project

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// projectContextSourceWriter is implemented by the durable store when it can
// commit local attachment sources atomically with the Project write.
type projectContextSourceWriter interface {
	UpsertProjectWithContextSources(ctx context.Context, row domain.ProjectRecord, sources []domain.ProjectContextLocalSourceRecord) error
	UpdateProjectSettingsWithContextSources(ctx context.Context, id, displayName string, config domain.ProjectConfig, instructions *domain.ProjectInstructions, expectedRevision int64, sources []domain.ProjectContextLocalSourceRecord) (bool, error)
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

// prepareProjectContextLocalSources validates the attachments of one Project,
// builds the machine-local locator for every attachment that carries a
// write-only LocalPath, and returns the instructions with LocalPath removed so
// no path is stored or returned. It writes nothing: the records are committed
// in the same transaction as the Project itself. Ownership always comes from
// the target Project; a caller-supplied owner that names another owner is
// rejected. Resending a LocalPath refreshes the locator; omitting it leaves the
// registered locator untouched.
func (m *Service) prepareProjectContextLocalSources(projectID domain.ProjectID, projectPath string, in domain.ProjectInstructions) (domain.ProjectInstructions, []domain.ProjectContextLocalSourceRecord, error) {
	machineID := m.projectContextMachineIDValue()
	out := in
	out.Attachments = append([]domain.ProjectContextAttachment(nil), in.Attachments...)
	var records []domain.ProjectContextLocalSourceRecord
	for i, a := range out.Attachments {
		isFile := a.SourceKind == domain.ProjectContextRepoRelativeFile || a.SourceKind == domain.ProjectContextMachineLocalFile
		if isFile && a.OwnerKind != domain.ProjectContextOwnerUser && a.OwnerID != "" && a.OwnerID != string(projectID) {
			return in, nil, apierr.Invalid("PROJECT_CONTEXT_OWNER_MISMATCH", "A project attachment cannot claim another owner", nil)
		}
		if a.LocalPath == "" {
			continue
		}
		out.Attachments[i].LocalPath = ""
		if a.OwnerKind == domain.ProjectContextOwnerUser {
			return in, nil, apierr.Invalid("PROJECT_CONTEXT_OWNER_MISMATCH", "A local path can only be registered for a project-owned attachment", nil)
		}
		if machineID == "" || a.MachineID != machineID {
			return in, nil, apierr.Invalid("PROJECT_CONTEXT_LOCAL_SOURCE_WRONG_MACHINE", "A local path can only be registered on the machine that owns the attachment", nil)
		}
		root, rel, err := projectContextLocator(a, projectPath)
		if err != nil {
			return in, nil, apierr.Invalid("PROJECT_CONTEXT_LOCAL_PATH_INVALID", err.Error(), nil)
		}
		now := m.clock().UTC()
		records = append(records, domain.ProjectContextLocalSourceRecord{
			SourceRef: a.SourceRef, MachineID: machineID, RootPath: root, RelativePath: rel, MediaType: a.MediaType,
			OwnerKind: domain.ProjectContextOwnerProject, OwnerID: string(projectID), RegisteredAt: now, UpdatedAt: now,
		})
	}
	return out, records, nil
}

func contextSourceStoreError(err error, fallbackCode, fallbackMessage string) error {
	if errors.Is(err, domain.ErrProjectContextSourceOwned) {
		return apierr.Conflict("PROJECT_CONTEXT_SOURCE_REF_IN_USE", "The source reference is already registered for another owner", nil)
	}
	return apierr.Internal(fallbackCode, fallbackMessage)
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
