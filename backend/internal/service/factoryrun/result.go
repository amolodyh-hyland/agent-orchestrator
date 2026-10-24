package factoryrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ResultContext selects a run-bound delegation without reading its result body.
type ResultContext struct {
	RunID        string                         `json:"runId"`
	ProjectID    string                         `json:"projectId"`
	TaskID       string                         `json:"taskId"`
	SessionID    domain.SessionID               `json:"sessionId"`
	Version      int64                          `json:"version"`
	RequestID    string                         `json:"requestId"`
	ServerKey    string                         `json:"serverKey"`
	ServerOrigin string                         `json:"serverOrigin"`
	WorkspaceID  string                         `json:"workspaceId"`
	Remote       domain.MulticaDelegationRemote `json:"remote"`
	Digest       string                         `json:"digest"`
}

// ResultImportInput binds an exact consented receipt to the previewed run version.
type ResultImportInput struct {
	ExpectedVersion int64                   `json:"expectedVersion"`
	ContextDigest   string                  `json:"contextDigest"`
	Receipt         domain.RunResultReceipt `json:"receipt"`
}

// ResultContext resolves the durable source binding for a result scope preview.
func (s *Service) ResultContext(ctx context.Context, id string) (ResultContext, error) {
	run, err := s.store.GetFactoryRun(ctx, id)
	if err != nil {
		return ResultContext{}, failure(err)
	}
	if run.Version >= 511 {
		return ResultContext{}, invalid("Run evidence limit reached")
	}
	journal, ok := s.store.(interface {
		FindMulticaDelegation(context.Context, string, string) (domain.MulticaDelegationRecord, error)
	})
	if !ok {
		return ResultContext{}, invalid("Delegation journal unavailable")
	}
	record, err := journal.FindMulticaDelegation(ctx, run.ProjectID, run.TaskID)
	if err != nil || record.Validate() != nil {
		return ResultContext{}, invalid("Delegation unavailable")
	}
	var intent domain.MulticaDelegationIntent
	var remote domain.MulticaDelegationRemote
	if json.Unmarshal(record.Intent, &intent) != nil || json.Unmarshal(record.Remote, &remote) != nil || !remote.Terminal || run.DelegationID == "" || run.DelegationID != record.RequestID && run.DelegationID != remote.DelegationID || run.Source.Server != "" && run.Source.Server != intent.Binding.Origin || run.Source.WorkspaceID != "" && run.Source.WorkspaceID != intent.Binding.WorkspaceID {
		return ResultContext{}, invalid("Run delegation binding changed or is not terminal")
	}
	out := ResultContext{RunID: run.ID, ProjectID: run.ProjectID, TaskID: run.TaskID, SessionID: run.SessionID, Version: run.Version, RequestID: record.RequestID, ServerKey: intent.Binding.ServerKey, ServerOrigin: intent.Binding.Origin, WorkspaceID: intent.Binding.WorkspaceID, Remote: remote}
	data, _ := json.Marshal(out)
	sum := sha256.Sum256(data)
	out.Digest = hex.EncodeToString(sum[:])
	return out, nil
}

// ImportResult appends native-approved untrusted text without advancing or continuing execution.
func (s *Service) ImportResult(ctx context.Context, id string, in ResultImportInput) (domain.RunDetail, error) {
	binding, err := s.ResultContext(ctx, id)
	if err != nil {
		return domain.RunDetail{}, err
	}
	if err := domain.CheckOuterOperation(ctx, s.store, "run.confirm", domain.ProjectID(binding.ProjectID), binding.SessionID); err != nil {
		return domain.RunDetail{}, err
	}
	r := in.Receipt.Result
	receipt := in.Receipt
	if binding.Version != in.ExpectedVersion || binding.Digest != in.ContextDigest {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	data, marshalErr := json.Marshal(in)
	if marshalErr != nil || len(data) > 256<<10 || r.Validate() != nil || !receipt.Untrusted || receipt.ServerOrigin != binding.ServerOrigin || receipt.RequestID != binding.RequestID || r.DelegationID != binding.Remote.DelegationID || r.TaskID != binding.Remote.TaskID || r.WorkspaceID != binding.WorkspaceID || r.AgentID != binding.Remote.AgentID || r.RuntimeID != binding.Remote.RuntimeID || r.Status != binding.Remote.Status || r.TerminalRevision != binding.Remote.Revision {
		return domain.RunDetail{}, invalid("Result binding or digest mismatch")
	}
	readAt, e1 := time.Parse(time.RFC3339Nano, receipt.ReadConsent.At)
	importAt, e2 := time.Parse(time.RFC3339Nano, receipt.ImportConsent.At)
	now := s.now()
	if e1 != nil || e2 != nil || receipt.ReadConsent.ID == "" || len(receipt.ReadConsent.ID) > 128 || receipt.ImportConsent.ID == "" || len(receipt.ImportConsent.ID) > 128 || receipt.ReadConsent.ID == receipt.ImportConsent.ID || importAt.Before(readAt) || readAt.After(now) || importAt.After(now) || now.Sub(readAt) > 2*time.Minute {
		return domain.RunDetail{}, invalid("Fresh separate native consent required")
	}
	run, err := s.store.GetFactoryRun(ctx, id)
	if err != nil {
		return domain.RunDetail{}, failure(err)
	}
	if run.Version != binding.Version {
		return domain.RunDetail{}, failure(domain.ErrRunConflict)
	}
	run.Version++
	evidence := event(run, "specialist_result", "human", "Imported bounded untrusted specialist text; no continuation authorized")
	evidence.Confirmed = true
	evidence.ConfirmationDigest = r.Revision
	evidence.SpecialistResult = &receipt
	if err = s.store.SaveFactoryRun(ctx, run, evidence, false); err != nil {
		return domain.RunDetail{}, failure(err)
	}
	return s.Get(ctx, id)
}
