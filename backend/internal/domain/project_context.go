package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxProjectContextSourceReferenceBytes = 128
	MaxProjectContextMachineIDBytes       = 128
	MaxProjectContextBindings             = 64
	MaxProjectContextAttachmentBytes      = 1 << 20
	MaxProjectContextSessionBytes         = 8 << 20
	MaxProjectContextInstructionBytes     = 64 << 10
)

type ProjectContextSourceKind string

const (
	ProjectContextInlineText       ProjectContextSourceKind = "inline_text"
	ProjectContextRepoRelativeFile ProjectContextSourceKind = "repo_relative_file"
	ProjectContextMachineLocalFile ProjectContextSourceKind = "machine_local_file"
	ProjectContextImportedBundle   ProjectContextSourceKind = "explicitly_imported_bundle"
)

type ProjectContextRole string

const (
	ProjectContextRoleShared      ProjectContextRole = "shared"
	ProjectContextRoleWorker      ProjectContextRole = "worker"
	ProjectContextRoleCoordinator ProjectContextRole = "coordinator"
	ProjectContextRoleIssueTask   ProjectContextRole = "issue_task"
	ProjectContextRoleChat        ProjectContextRole = "chat"
)

func (ProjectContextRole) Enum() []interface{} {
	return []interface{}{
		ProjectContextRoleShared,
		ProjectContextRoleWorker,
		ProjectContextRoleCoordinator,
		ProjectContextRoleIssueTask,
		ProjectContextRoleChat,
	}
}

type ProjectContextOwnerKind string

const (
	ProjectContextOwnerProject ProjectContextOwnerKind = "project"
	ProjectContextOwnerUser    ProjectContextOwnerKind = "user"
)

// ProjectContextAttachment records a typed link from one Project revision to
// a source. Machine paths are represented by a machine-local opaque SourceRef;
// their locator stays in the owning daemon's local resolver store.
type ProjectContextAttachment struct {
	ID         string                   `json:"id" minLength:"1" maxLength:"128"`
	OwnerKind  ProjectContextOwnerKind  `json:"ownerKind,omitempty" enum:"project,user"`
	OwnerID    string                   `json:"ownerId,omitempty" maxLength:"128"`
	SourceKind ProjectContextSourceKind `json:"sourceKind" enum:"inline_text,repo_relative_file,machine_local_file,explicitly_imported_bundle"`
	SourceRef  string                   `json:"sourceRef,omitempty" maxLength:"128" description:"Opaque source reference; absolute local paths are resolved by the owning daemon."`
	MachineID  string                   `json:"machineId,omitempty" maxLength:"128" description:"Required for repo_relative_file and machine_local_file sources."`
	MediaType  string                   `json:"mediaType" minLength:"1" maxLength:"128"`
	Required   bool                     `json:"required"`
	Roles      []ProjectContextRole     `json:"roles" minItems:"1" uniqueItems:"true"`
	Position   int                      `json:"position" minimum:"0"`
	Enabled    bool                     `json:"enabled"`
	Text       string                   `json:"text,omitempty" maxLength:"1048576"`
}

// Validate rejects malformed references before they can be persisted as a
// Project revision.
func (a ProjectContextAttachment) Validate() error {
	if !validContextToken(a.ID, 128) {
		return fmt.Errorf("project context attachment id must be 1-128 ASCII letters, digits, '_' or '-'")
	}
	if a.Position < 0 {
		return fmt.Errorf("project context attachment %q position must be non-negative", a.ID)
	}
	if a.OwnerKind != "" && a.OwnerKind != ProjectContextOwnerProject && a.OwnerKind != ProjectContextOwnerUser {
		return fmt.Errorf("project context attachment %q has an unsupported owner kind", a.ID)
	}
	if a.OwnerKind == ProjectContextOwnerUser && strings.TrimSpace(a.OwnerID) == "" {
		return fmt.Errorf("project context attachment %q requires an owner id for user-owned sources", a.ID)
	}
	if len(a.OwnerID) > 128 {
		return fmt.Errorf("project context attachment %q owner id is too long", a.ID)
	}
	if len(a.SourceRef) > MaxProjectContextSourceReferenceBytes {
		return fmt.Errorf("project context attachment %q source reference is too long", a.ID)
	}
	if len(a.MachineID) > MaxProjectContextMachineIDBytes {
		return fmt.Errorf("project context attachment %q machine id is too long", a.ID)
	}
	if a.MediaType == "" || len(a.MediaType) > 128 {
		return fmt.Errorf("project context attachment %q requires a media type", a.ID)
	}
	mediaType, _, mediaTypeErr := mime.ParseMediaType(a.MediaType)
	mediaTypeParts := strings.SplitN(mediaType, "/", 2)
	if mediaTypeErr != nil || len(mediaTypeParts) != 2 || mediaTypeParts[0] == "" || mediaTypeParts[1] == "" {
		return fmt.Errorf("project context attachment %q has an invalid media type", a.ID)
	}
	if len(a.Roles) == 0 {
		return fmt.Errorf("project context attachment %q requires at least one role scope", a.ID)
	}
	seenRoles := make(map[ProjectContextRole]struct{}, len(a.Roles))
	for _, role := range a.Roles {
		switch role {
		case ProjectContextRoleShared, ProjectContextRoleWorker, ProjectContextRoleCoordinator, ProjectContextRoleIssueTask, ProjectContextRoleChat:
		default:
			return fmt.Errorf("project context attachment %q has unsupported role %q", a.ID, role)
		}
		if _, ok := seenRoles[role]; ok {
			return fmt.Errorf("project context attachment %q repeats role %q", a.ID, role)
		}
		seenRoles[role] = struct{}{}
	}

	switch a.SourceKind {
	case ProjectContextInlineText:
		if a.SourceRef != "" || a.MachineID != "" {
			return fmt.Errorf("inline project context attachment %q cannot have a source reference or machine id", a.ID)
		}
		if !utf8.ValidString(a.Text) {
			return fmt.Errorf("project context attachment %q must contain valid UTF-8", a.ID)
		}
		if len(a.Text) > MaxProjectContextAttachmentBytes {
			return fmt.Errorf("project context attachment %q exceeds the %d MiB limit", a.ID, MaxProjectContextAttachmentBytes/(1<<20))
		}
	case ProjectContextRepoRelativeFile:
		if !validContextToken(a.SourceRef, MaxProjectContextSourceReferenceBytes) || strings.TrimSpace(a.MachineID) == "" || a.Text != "" {
			return fmt.Errorf("repo-relative project context attachment %q requires an opaque source reference and machine id", a.ID)
		}
	case ProjectContextMachineLocalFile:
		if !validContextToken(a.SourceRef, MaxProjectContextSourceReferenceBytes) || strings.TrimSpace(a.MachineID) == "" || a.Text != "" {
			return fmt.Errorf("machine-local project context attachment %q requires an opaque source reference and machine id", a.ID)
		}
	case ProjectContextImportedBundle:
		if !validContextToken(a.SourceRef, MaxProjectContextSourceReferenceBytes) || a.MachineID != "" || a.Text != "" {
			return fmt.Errorf("imported project context attachment %q requires an opaque source reference", a.ID)
		}
	default:
		return fmt.Errorf("project context attachment %q has unsupported source kind %q", a.ID, a.SourceKind)
	}
	return nil
}

func validContextToken(value string, max int) bool {
	if len(value) == 0 || len(value) > max {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

type ProjectContextAvailability string

const (
	ProjectContextAvailable     ProjectContextAvailability = "available"
	ProjectContextReferenceOnly ProjectContextAvailability = "reference_only"
	ProjectContextUnavailable   ProjectContextAvailability = "unavailable"
)

// ProjectContextManifest is the immutable per-session view of the selected
// Project context. Materialized content belongs to the session snapshot.
type ProjectContextManifest struct {
	SessionID          SessionID                     `json:"sessionId"`
	ProjectID          ProjectID                     `json:"projectId,omitempty"`
	ProjectRevision    int64                         `json:"projectRevision"`
	Role               ProjectContextRole            `json:"role"`
	Channel            SessionMode                   `json:"channel"`
	IssueTask          bool                          `json:"issueTask"`
	CreatedAt          time.Time                     `json:"createdAt"`
	SharedInstructions string                        `json:"sharedInstructions,omitempty"`
	RoleInstructions   string                        `json:"roleInstructions,omitempty"`
	RoleRules          string                        `json:"roleRules,omitempty"`
	Attachments        []ProjectContextManifestEntry `json:"attachments,omitempty"`
	Digest             string                        `json:"digest"`
}

type ProjectContextManifestEntry struct {
	Binding      ProjectContextAttachment   `json:"binding"`
	SourceDigest string                     `json:"sourceDigest,omitempty"`
	ByteCount    int64                      `json:"byteCount"`
	Availability ProjectContextAvailability `json:"availability" enum:"available,reference_only,unavailable"`
	Reason       string                     `json:"reason,omitempty"`
	SnapshotRef  string                     `json:"snapshotRef"`
	Content      string                     `json:"content,omitempty"`
}

// ProjectContextLocalSourceRecord is local resolver state. RootPath and
// RelativePath are never returned through the Project API.
type ProjectContextLocalSourceRecord struct {
	SourceRef    string
	MachineID    string
	RootPath     string
	RelativePath string
	MediaType    string
	OwnerKind    ProjectContextOwnerKind
	OwnerID      string
	RegisteredAt time.Time
	UpdatedAt    time.Time
}

// ComputeDigest returns the stable digest of a manifest, excluding its Digest
// field. Entry ordering is significant and is fixed by the resolver.
func (m ProjectContextManifest) ComputeDigest() (string, error) {
	m.Digest = ""
	data, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("marshal project context manifest: %w", err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// VerifyDigest reports whether the stored digest matches the manifest content.
func (m ProjectContextManifest) VerifyDigest() error {
	got, err := m.ComputeDigest()
	if err != nil {
		return err
	}
	if m.Digest == "" || m.Digest != got {
		return fmt.Errorf("project context manifest digest mismatch")
	}
	return nil
}
