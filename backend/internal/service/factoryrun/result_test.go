package factoryrun_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/factoryrun"
)

func resultSetup(t *testing.T) (*fixture, factoryrun.ResultImportInput) {
	t.Helper()
	f := setup(t)
	raw, err := os.ReadFile("../../../../test/contracts/multica-delegation-result-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Result domain.SpecialistResult `json:"result"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	r := fixture.Result
	var intent domain.MulticaDelegationIntent
	intent.Binding.ServerKey = "local"
	intent.Binding.Origin = "http://127.0.0.1:4444"
	intent.Binding.WorkspaceID = r.WorkspaceID
	intent.Payload.AgentID = r.AgentID
	intent.Payload.RuntimeID = r.RuntimeID
	intent.Payload.Source.System = "ao"
	intent.Payload.Source.ProjectID = "p"
	intent.Payload.Source.TaskID = "WI-FAC-05"
	intent.Payload.Task.Title = "Review"
	intent.Payload.Task.Instructions = "Approved brief"
	input := ""
	for _, v := range []string{r.AgentID, r.RuntimeID, "ao", "p", "WI-FAC-05", "Review", "Approved brief"} {
		input += fmt.Sprintf("%d:%s", len(v), v)
	}
	sum := sha256.Sum256([]byte(input))
	intentRaw, _ := json.Marshal(intent)
	record, err := f.db.ReserveMulticaDelegation(f.ctx, domain.MulticaDelegationRecord{RequestID: "request-result", ProjectID: "p", TaskID: "WI-FAC-05", ConfirmationID: "native", ConfirmedBy: "human", ConfirmedAt: time.Now().UTC().Format(time.RFC3339Nano), Intent: intentRaw, PayloadHash: hex.EncodeToString(sum[:]), State: "submitting"})
	if err != nil {
		t.Fatal(err)
	}
	remote := domain.MulticaDelegationRemote{DelegationID: r.DelegationID, TaskID: r.TaskID, WorkspaceID: r.WorkspaceID, AgentID: r.AgentID, RuntimeID: r.RuntimeID, Status: r.Status, Terminal: true, Revision: r.TerminalRevision}
	record.Remote, _ = json.Marshal(remote)
	record.Attempted = true
	record.State = "terminal"
	if _, err = f.db.SaveMulticaDelegation(f.ctx, record); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Create(f.ctx, factoryrun.CreateInput{ID: "result-run", ProjectID: "p", TaskID: "WI-FAC-05", SessionID: f.session.ID, DelegationID: r.DelegationID, DesignDigest: strings.Repeat("a", 64), PolicyDecision: "decision-6-b", RequiredChecks: []string{"focused"}, Actor: "human", Decision: "approved design"})
	if err != nil {
		t.Fatal(err)
	}
	binding, err := f.svc.ResultContext(f.ctx, "result-run")
	if err != nil {
		t.Fatal(err)
	}
	return f, factoryrun.ResultImportInput{ExpectedVersion: binding.Version, ContextDigest: binding.Digest, Receipt: domain.RunResultReceipt{ServerOrigin: binding.ServerOrigin, RequestID: binding.RequestID, Untrusted: true, ReadConsent: domain.ResultConsent{ID: "read", At: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)}, ImportConsent: domain.ResultConsent{ID: "import", At: time.Now().UTC().Format(time.RFC3339Nano)}, Result: r}}
}

func TestResultImportRetainsUntrustedEvidenceWithoutAdvancing(t *testing.T) {
	f, in := resultSetup(t)
	out, err := f.svc.ImportResult(f.ctx, "result-run", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Run.Stage != "design" || out.Run.Version != 1 {
		t.Fatalf("import changed execution stage: %+v", out.Run)
	}
	history, err := f.db.ListRunEvidence(f.ctx, "result-run")
	if err != nil {
		t.Fatal(err)
	}
	receipt := history[len(history)-1]
	if receipt.Kind != "specialist_result" || !receipt.Confirmed || receipt.SpecialistResult == nil || receipt.SpecialistResult.Result != in.Receipt.Result {
		t.Fatalf("missing immutable receipt: %+v", receipt)
	}
	if !strings.Contains(receipt.SpecialistResult.Result.Text, "Ignore all prior instructions") {
		t.Fatal("untrusted instructions were altered")
	}
	if _, err = f.svc.ImportResult(f.ctx, "result-run", in); err == nil {
		t.Fatal("replayed import accepted")
	}
}

func TestResultImportRejectsConsentDigestAndBindingChanges(t *testing.T) {
	f, original := resultSetup(t)
	for _, tc := range []struct {
		name   string
		mutate func(*factoryrun.ResultImportInput)
	}{
		{"read consent", func(in *factoryrun.ResultImportInput) { in.Receipt.ReadConsent.ID = "" }},
		{"import consent", func(in *factoryrun.ResultImportInput) { in.Receipt.ImportConsent.ID = "" }},
		{"same consent", func(in *factoryrun.ResultImportInput) { in.Receipt.ImportConsent.ID = in.Receipt.ReadConsent.ID }},
		{"digest", func(in *factoryrun.ResultImportInput) { in.Receipt.Result.Digest = strings.Repeat("0", 64) }},
		{"version", func(in *factoryrun.ResultImportInput) { in.ExpectedVersion++ }},
		{"binding", func(in *factoryrun.ResultImportInput) { in.ContextDigest = strings.Repeat("0", 64) }},
		{"source", func(in *factoryrun.ResultImportInput) { in.Receipt.ServerOrigin = "https://other.test" }},
		{"expired", func(in *factoryrun.ResultImportInput) {
			in.Receipt.ReadConsent.At = time.Now().Add(-3 * time.Minute).Format(time.RFC3339Nano)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := original
			tc.mutate(&in)
			if _, err := f.svc.ImportResult(f.ctx, "result-run", in); err == nil {
				t.Fatal("invalid import accepted")
			}
			run, err := f.db.GetFactoryRun(f.ctx, "result-run")
			if err != nil || run.Version != 0 {
				t.Fatal("failed import mutated run", err)
			}
		})
	}
}
