package factoryrun

import (
	"encoding/json"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// A stage decision binds the imported snapshot by digest, never by displaying its
// untrusted body again. The full receipt remains in the immutable run ledger.
type confirmationResultMetadata struct {
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
}

type confirmationResultReceipt struct {
	ServerOrigin  string                     `json:"serverOrigin"`
	RequestID     string                     `json:"requestId"`
	ReadConsent   domain.ResultConsent       `json:"readConsent"`
	ImportConsent domain.ResultConsent       `json:"importConsent"`
	Untrusted     bool                       `json:"untrusted"`
	Result        confirmationResultMetadata `json:"result"`
}

// MarshalJSON projects specialist receipts to bounded metadata for both the
// private desktop preview and its confirmation digest. Internal decisions still
// use the original detail; serializing a preview never mutates ledger evidence.
func (p ConfirmationPreview) MarshalJSON() ([]byte, error) {
	type evidence struct {
		domain.RunEvidence
		SpecialistResult *confirmationResultReceipt `json:"specialistResult,omitempty"`
	}
	type detail struct {
		domain.RunDetail
		Evidence []evidence `json:"evidence"`
	}
	type preview ConfirmationPreview
	projected := make([]evidence, 0, len(p.Detail.Evidence))
	for _, e := range p.Detail.Evidence {
		item := evidence{RunEvidence: e}
		if receipt := e.SpecialistResult; receipt != nil {
			r := receipt.Result
			item.SpecialistResult = &confirmationResultReceipt{
				ServerOrigin: receipt.ServerOrigin, RequestID: receipt.RequestID,
				ReadConsent: receipt.ReadConsent, ImportConsent: receipt.ImportConsent, Untrusted: receipt.Untrusted,
				Result: confirmationResultMetadata{
					Version: r.Version, Format: r.Format, DelegationID: r.DelegationID, TaskID: r.TaskID,
					WorkspaceID: r.WorkspaceID, AgentID: r.AgentID, RuntimeID: r.RuntimeID, Status: r.Status,
					TerminalRevision: r.TerminalRevision, CompletedAt: r.CompletedAt, Revision: r.Revision,
					Digest: r.Digest, ByteCount: r.ByteCount,
				},
			}
		}
		projected = append(projected, item)
	}
	return json.Marshal(struct {
		preview
		Detail detail `json:"detail"`
	}{preview: preview(p), Detail: detail{RunDetail: p.Detail, Evidence: projected}})
}
