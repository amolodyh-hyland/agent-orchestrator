package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// SpecialistResult pins the exact bounded terminal text snapshot imported as untrusted data.
type SpecialistResult struct {
	Version          int    `json:"version"`
	Format           string `json:"format"`
	DelegationID     string `json:"delegation_id"`
	TaskID           string `json:"task_id"`
	WorkspaceID      string `json:"workspace_id"`
	AgentID          string `json:"agent_id"`
	RuntimeID        string `json:"runtime_id"`
	Status           string `json:"status"`
	TerminalRevision string `json:"terminal_revision"`
	CompletedAt      string `json:"completed_at"`
	Revision         string `json:"revision"`
	Digest           string `json:"digest"`
	ByteCount        int    `json:"byte_count"`
	Text             string `json:"text"`
}

// ResultConsent records one distinct native approval and its timestamp.
type ResultConsent struct {
	ID string `json:"id"`
	At string `json:"at"`
}

// RunResultReceipt binds untrusted text to its source and separate read/import approvals.
type RunResultReceipt struct {
	ServerOrigin  string           `json:"serverOrigin"`
	RequestID     string           `json:"requestId"`
	ReadConsent   ResultConsent    `json:"readConsent"`
	ImportConsent ResultConsent    `json:"importConsent"`
	Untrusted     bool             `json:"untrusted"`
	Result        SpecialistResult `json:"result"`
}

var unsafeSpecialistText = regexp.MustCompile(`(?i)(www\.|(?:https?|ftp|file|data|javascript|mailto|ssh|smb|tel):|(?:mul_|mat_|mcn_|mpi_|mpc_|gh[pousr]_|github_pat_|npm_|xox[baprs]-|sk-)[a-z0-9_-]+|-----BEGIN|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]+\.[a-z0-9_-]+|\b(?:bearer|password|passwd|secret|api[_ -]?key|access[_ -]?token|token|authorization|credential)\s*[:= ]\s*\S+)`)

// Validate verifies text bounds, the safe projection and both content hashes.
func (r SpecialistResult) Validate() error {
	invalid := errors.New("invalid specialist result")
	if r.Version != 1 || r.Format != "text/plain" || r.Status != "completed" && r.Status != "failed" && r.Status != "cancelled" || r.ByteCount != len(r.Text) || len(r.Text) > 32768 || strings.TrimSpace(r.Text) == "" || !utf8.ValidString(r.Text) || strings.ContainsAny(r.Text, "/\\") || unsafeSpecialistText.MatchString(r.Text) {
		return invalid
	}
	for _, ch := range r.Text {
		if unicode.IsControl(ch) && ch != '\n' && ch != '\r' && ch != '\t' {
			return invalid
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, r.CompletedAt); err != nil {
		return invalid
	}
	if !SHA256Digest(r.TerminalRevision) || !SHA256Digest(r.Digest) || !SHA256Digest(r.Revision) {
		return invalid
	}
	sum := sha256.Sum256([]byte(r.Text))
	if hex.EncodeToString(sum[:]) != r.Digest {
		return invalid
	}
	revision := r.Revision
	r.Revision = ""
	data, err := json.Marshal(r)
	if err != nil {
		return invalid
	}
	sum = sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != revision {
		return invalid
	}
	return nil
}
