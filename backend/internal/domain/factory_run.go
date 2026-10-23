package domain

import (
	"errors"
	"regexp"
	"time"
)

// ErrRunConflict reports a stale version or changed immutable run intent.
var ErrRunConflict = errors.New("run version conflict")

// ErrRunNotFound reports an unknown run identity.
var ErrRunNotFound = errors.New("run not found")
var fullCommit = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
var sha256Digest = regexp.MustCompile(`^[0-9a-f]{64}$`)

// FullCommit accepts only complete SHA-1 or SHA-256 commit identities.
func FullCommit(value string) bool { return fullCommit.MatchString(value) }

// SHA256Digest validates a lowercase content digest.
func SHA256Digest(value string) bool { return sha256Digest.MatchString(value) }

// RunSource identifies the accepted external source revision.
type RunSource struct {
	Server      string `json:"server,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	IssueID     string `json:"issueId,omitempty"`
	Revision    string `json:"revision,omitempty"`
}

// RunRepoBinding pins a registered owned repository at run creation.
type RunRepoBinding struct {
	RepoName     string `json:"repoName"`
	RepoPath     string `json:"repoPath"`
	WorktreePath string `json:"worktreePath"`
	BaseSHA      string `json:"baseSha"`
	Branch       string `json:"branch"`
}

// FactoryRun records human stage decisions around an existing implementation session.
type FactoryRun struct {
	ID             string           `json:"id"`
	ProjectID      string           `json:"projectId"`
	TaskID         string           `json:"taskId"`
	SessionID      SessionID        `json:"sessionId"`
	Source         RunSource        `json:"source"`
	DesignDigest   string           `json:"designDigest"`
	PolicyDecision string           `json:"policyDecision"`
	DelegationID   string           `json:"delegationId,omitempty"`
	RequiredChecks []string         `json:"requiredChecks"`
	Repositories   []RunRepoBinding `json:"repositories"`
	Stage          string           `json:"stage" enum:"design,implementation,review,handoff"`
	Version        int64            `json:"version"`
	CreatedAt      time.Time        `json:"createdAt"`
}

// RunArtifact names a hashed file inside an existing owned root.
type RunArtifact struct {
	Root   string `json:"root" enum:"worktree,artifacts"`
	Path   string `json:"path"`
	Digest string `json:"digest"`
}

// RunRepoFacts captures independently observed source identity and working-tree facts.
type RunRepoFacts struct {
	RepoPath     string   `json:"repoPath"`
	WorktreePath string   `json:"worktreePath"`
	BaseSHA      string   `json:"baseSha"`
	HeadSHA      string   `json:"headSha"`
	Branch       string   `json:"branch"`
	ChangedFiles []string `json:"changedFiles"`
	Staged       []string `json:"staged"`
	Unstaged     []string `json:"unstaged"`
	Untracked    []string `json:"untracked"`
	Fingerprint  string   `json:"fingerprint"`
}

// RunCheckReceipt records a human-verified execution result for one exact commit.
type RunCheckReceipt struct {
	Name        string      `json:"name"`
	SHA         string      `json:"sha"`
	Environment string      `json:"environment"`
	ExitCode    int         `json:"exitCode"`
	VerifiedBy  string      `json:"verifiedBy"`
	Output      RunArtifact `json:"output"`
}

// RunCompletion links an owned completion claim to report, artifact and check evidence.
type RunCompletion struct {
	RepoName string            `json:"repoName"`
	ReportID string            `json:"reportId"`
	Attempt  int               `json:"attempt"`
	Facts    RunRepoFacts      `json:"facts"`
	Inputs   []RunArtifact     `json:"inputs"`
	Outputs  []RunArtifact     `json:"outputs"`
	Checks   []RunCheckReceipt `json:"checks"`
}

// RunFinding preserves an exact finding identity and severity.
type RunFinding struct {
	ID          string `json:"id"`
	Description string `json:"description,omitempty"`
	Severity    string `json:"severity" enum:"P0,P1,P2,P3,P4"`
}

// RunReviewReceipt records an independently attributed review of one immutable candidate.
type RunReviewReceipt struct {
	RepoName          string       `json:"repoName"`
	ReviewRunID       string       `json:"reviewRunId,omitempty"`
	ReviewerID        string       `json:"reviewerId"`
	Independent       bool         `json:"independent"`
	ReadOnly          bool         `json:"readOnly"`
	SHA               string       `json:"sha"`
	BeforeFingerprint string       `json:"beforeFingerprint"`
	AfterFingerprint  string       `json:"afterFingerprint"`
	Verdict           string       `json:"verdict" enum:"approved,changes_requested"`
	Findings          []RunFinding `json:"findings"`
	Round             int          `json:"round"`
	Artifact          RunArtifact  `json:"artifact"`
}

// RunEvidence is one immutable receipt or human stage decision.
type RunEvidence struct {
	ID                 string            `json:"id"`
	RunID              string            `json:"runId"`
	Version            int64             `json:"version"`
	Kind               string            `json:"kind" enum:"created,completion,review,advance,hold"`
	Actor              string            `json:"actor"`
	Decision           string            `json:"decision"`
	Stage              string            `json:"stage"`
	Confirmed          bool              `json:"confirmed"`
	ConfirmationDigest string            `json:"confirmationDigest,omitempty"`
	RecordedAt         time.Time         `json:"recordedAt"`
	Completion         *RunCompletion    `json:"completion,omitempty"`
	Review             *RunReviewReceipt `json:"review,omitempty"`
	Observed           []RunRepoFacts    `json:"observed"`
	Blockers           []string          `json:"blockers"`
}

// RunDetail combines durable history with freshly derived evidence blockers.
type RunDetail struct {
	Run              FactoryRun           `json:"run"`
	Evidence         []RunEvidence        `json:"evidence"`
	Observed         []RunRepoFacts       `json:"observed"`
	FeedbackPaused   bool                 `json:"feedbackPaused"`
	FeedbackRevision int64                `json:"feedbackRevision"`
	Feedback         []RunFeedbackReceipt `json:"feedback"`
	NextAction       string               `json:"nextAction"`
	Blockers         []string             `json:"blockers"`
}

// RunFeedbackBinding seals one native-confirmed next turn; it never authorizes a station start.
type RunFeedbackBinding struct {
	ID               string               `json:"id"`
	RunID            string               `json:"runId"`
	RunVersion       int64                `json:"runVersion"`
	ControlRevision  int64                `json:"controlRevision"`
	RepoName         string               `json:"repoName"`
	ReviewEvidenceID string               `json:"reviewEvidenceId"`
	Round            int                  `json:"round"`
	SHA              string               `json:"sha"`
	SessionID        SessionID            `json:"sessionId"`
	TargetDigest     string               `json:"targetDigest"`
	ConversationID   string               `json:"conversationId"`
	Settings         ConversationSettings `json:"settings"`
	Payload          string               `json:"payload"`
	Source           []RunRepoFacts       `json:"source"`
	Epoch            string               `json:"epoch"`
	ExpiresAt        time.Time            `json:"expiresAt"`
}

// RunFeedbackReceipt retains uncertain submissions and native acceptance independently of display.
type RunFeedbackReceipt struct {
	Active                 bool               `json:"active"`
	Binding                RunFeedbackBinding `json:"binding"`
	HoldReason             string             `json:"holdReason,omitempty"`
	State                  string             `json:"state"`
	TurnID                 string             `json:"turnId,omitempty"`
	AttemptedAt            time.Time          `json:"attemptedAt,omitempty"`
	SubmittedAt            time.Time          `json:"submittedAt,omitempty"`
	AcceptedAt             time.Time          `json:"acceptedAt,omitempty"`
	ProviderTurnID         string             `json:"providerTurnId,omitempty"`
	ProviderConversationID string             `json:"providerConversationId,omitempty"`
}
