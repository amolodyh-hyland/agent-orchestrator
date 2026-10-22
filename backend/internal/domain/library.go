package domain

import (
	"fmt"
	"strings"
	"time"
)

const (
	LibrarySchemaVersion   = 1
	MaxLibrarySources      = 64
	MaxLibraryNodes        = 4096
	MaxLibraryEntries      = 256
	MaxLibraryDepth        = 4
	MaxLibraryFiles        = 256
	MaxLibraryFileBytes    = 1 << 20
	MaxLibraryEntryBytes   = 8 << 20
	MaxLibrarySessionFiles = 1024
)

type LibraryRootIdentity struct {
	ResolverID     string `json:"resolverId"`
	RootRef        string `json:"rootRef"`
	RootGeneration int64  `json:"rootGeneration"`
}

type LibrarySource struct {
	SourceID   string `json:"sourceId"`
	OwnerID    string `json:"ownerId"`
	Scope      string `json:"scope"`
	OriginKind string `json:"originKind"`
	LibraryRootIdentity
	Revision        int64  `json:"revision"`
	InspectionState string `json:"inspectionState"`
	Detached        bool   `json:"detached"`
}

type LibraryProvenance struct {
	OriginAuthorityID string `json:"originAuthorityId"`
	OriginSourceID    string `json:"originSourceId"`
	OriginEntryID     string `json:"originEntryId"`
	OriginKind        string `json:"originKind"`
	ResolverID        string `json:"resolverId"`
	SourceRevision    int64  `json:"sourceRevision"`
	AdapterVersion    string `json:"adapterVersion"`
	Verification      string `json:"verification"`
}

type LibraryFile struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	Mode      string `json:"mode"`
}

type LibraryEntry struct {
	SchemaVersion int               `json:"schemaVersion"`
	EntryID       string            `json:"entryId"`
	SourceID      string            `json:"sourceId"`
	Kind          string            `json:"kind"`
	DisplayName   string            `json:"displayName"`
	Format        string            `json:"format"`
	EntryPoint    string            `json:"entryPoint"`
	Files         []LibraryFile     `json:"files"`
	Requirements  []string          `json:"requirements"`
	ContentHash   string            `json:"contentHash"`
	Provenance    LibraryProvenance `json:"provenance"`
	Status        string            `json:"status"`
	ReasonCode    string            `json:"reasonCode"`
}

type LibrarySelectedEntry struct {
	EntryID     string `json:"entryId"`
	ContentHash string `json:"contentHash"`
}

type LibraryApproval struct {
	ApprovalID      string                 `json:"approvalId"`
	AuthorityID     string                 `json:"authorityId"`
	ActorID         string                 `json:"actorId"`
	SourceID        string                 `json:"sourceId"`
	RootIdentity    LibraryRootIdentity    `json:"rootIdentity"`
	Entries         []LibrarySelectedEntry `json:"entries"`
	Purposes        []string               `json:"purposes"`
	PolicyRevision  string                 `json:"policyRevision"`
	ApprovedAt      string                 `json:"approvedAt"`
	ExpiresAt       string                 `json:"expiresAt,omitempty"`
	State           string                 `json:"state"`
	TrustEpoch      int64                  `json:"trustEpoch"`
	SelectionDigest string                 `json:"selectionDigest"`
}

type LibraryBinding struct {
	BindingID           string               `json:"bindingId"`
	OwnerID             string               `json:"ownerId"`
	ProjectID           ProjectID            `json:"projectId"`
	SessionID           SessionID            `json:"sessionId,omitempty"`
	SourceID            string               `json:"sourceId"`
	EntryID             string               `json:"entryId"`
	ApprovedContentHash string               `json:"approvedContentHash"`
	Roles               []ProjectContextRole `json:"roles"`
	Position            int                  `json:"position"`
	Required            bool                 `json:"required"`
	Enabled             bool                 `json:"enabled"`
	Revision            int64                `json:"revision"`
}

type LibraryLocalSource struct {
	Source         LibrarySource `json:"source"`
	RootPath       string        `json:"rootPath"`
	RootKind       string        `json:"rootKind"`
	TargetIdentity string        `json:"targetIdentity"`
}

type LibraryStagedEntry struct {
	Entry        LibraryEntry        `json:"entry"`
	RootIdentity LibraryRootIdentity `json:"rootIdentity"`
	Content      map[string]string   `json:"content"`
	Present      bool                `json:"present"`
}

type LibraryRegistry struct {
	Revision   int64                         `json:"revision"`
	TrustEpoch int64                         `json:"trustEpoch"`
	Sources    map[string]LibraryLocalSource `json:"sources"`
	Entries    map[string]LibraryStagedEntry `json:"entries"`
	Approvals  map[string]LibraryApproval    `json:"approvals"`
	Bindings   map[string]LibraryBinding     `json:"bindings"`
}

func NewLibraryRegistry() LibraryRegistry {
	return LibraryRegistry{Sources: map[string]LibraryLocalSource{}, Entries: map[string]LibraryStagedEntry{}, Approvals: map[string]LibraryApproval{}, Bindings: map[string]LibraryBinding{}}
}

type LibraryAudit struct {
	ActorID       string `json:"actorId"`
	SourceID      string `json:"sourceId,omitempty"`
	EntryID       string `json:"entryId,omitempty"`
	Purpose       string `json:"purpose"`
	Outcome       string `json:"outcome"`
	ReasonCode    string `json:"reasonCode"`
	CorrelationID string `json:"correlationId"`
	Revision      int64  `json:"revision"`
	TrustEpoch    int64  `json:"trustEpoch"`
}

type LibraryRuntimeBinding struct {
	SessionID            SessionID `json:"sessionId"`
	SnapshotID           string    `json:"snapshotId"`
	EntryID              string    `json:"entryId"`
	ContentHash          string    `json:"contentHash"`
	ProviderID           string    `json:"providerId"`
	AdapterID            string    `json:"adapterId"`
	AdapterVersion       string    `json:"adapterVersion"`
	ProviderVersion      string    `json:"providerVersion"`
	ControllerGeneration int64     `json:"controllerGeneration"`
	CatalogRevision      int64     `json:"catalogRevision"`
	TrustEpoch           int64     `json:"trustEpoch"`
	Status               string    `json:"status"`
	ReasonCode           string    `json:"reasonCode"`
	CanInvoke            bool      `json:"canInvoke"`
}

type LibrarySnapshotEntry struct {
	Entry            LibraryEntry        `json:"entry"`
	RootIdentity     LibraryRootIdentity `json:"rootIdentity"`
	SourceRevision   int64               `json:"sourceRevision"`
	BindingIDs       []string            `json:"bindingIds"`
	BindingRevisions []int64             `json:"bindingRevisions"`
	ApprovalID       string              `json:"approvalId,omitempty"`
	Content          map[string]string   `json:"content"`
	Status           string              `json:"status"`
	ReasonCode       string              `json:"reasonCode"`
}

type LibrarySnapshot struct {
	SchemaVersion        int                    `json:"schemaVersion"`
	SnapshotID           string                 `json:"snapshotId"`
	SessionID            SessionID              `json:"sessionId"`
	ProjectID            ProjectID              `json:"projectId"`
	ProjectRevision      int64                  `json:"projectRevision"`
	ProjectContextDigest string                 `json:"projectContextDigest"`
	Role                 ProjectContextRole     `json:"role"`
	Channel              SessionMode            `json:"channel"`
	RegistryRevision     int64                  `json:"registryRevision"`
	TrustEpoch           int64                  `json:"trustEpoch"`
	OwnedSnapshotRef     string                 `json:"ownedSnapshotRef"`
	ProviderID           string                 `json:"providerId"`
	AdapterID            string                 `json:"adapterId"`
	AdapterVersion       string                 `json:"adapterVersion"`
	CreatedAt            string                 `json:"createdAt"`
	Entries              []LibrarySnapshotEntry `json:"entries"`
	Warnings             []string               `json:"warnings"`
	SnapshotDigest       string                 `json:"snapshotDigest,omitempty"`
}

func (s LibrarySnapshot) ComputeDigest() (string, error) {
	s.SnapshotDigest = ""
	return LibraryRecordDigest("shared-library-session-v1", s)
}

func (s LibrarySnapshot) VerifyDigest() error {
	hash, err := s.ComputeDigest()
	if err != nil {
		return err
	}
	if hash != s.SnapshotDigest {
		return fmt.Errorf("library snapshot digest mismatch")
	}
	return nil
}

func LibraryTimestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func ValidLibraryID(s string) bool        { return validContextToken(s, 128) }
func ValidLibraryHash(s string) bool {
	if len(s) != 71 || !strings.HasPrefix(s, "sha256:") {
		return false
	}
	for _, r := range s[7:] {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
