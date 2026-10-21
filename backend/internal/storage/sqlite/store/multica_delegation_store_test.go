package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func delegationRecord() domain.MulticaDelegationRecord {
	values := []string{"agent", "runtime", "ao", "project", "task", "Review", "Review A & B, 日本語\u2028"}
	input := ""
	for _, v := range values {
		input += fmt.Sprintf("%d:%s", len(v), v)
	}
	hash := sha256.Sum256([]byte(input))
	intent, _ := json.Marshal(map[string]any{
		"binding": map[string]string{"serverKey": "local", "origin": "http://127.0.0.1:4444", "workspaceId": "workspace"},
		"payload": map[string]any{"agent_id": "agent", "expected_runtime_id": "runtime", "source": map[string]string{"system": "ao", "project_id": "project", "task_id": "task"}, "task": map[string]string{"title": values[5], "instructions": values[6]}},
	})
	return domain.MulticaDelegationRecord{RequestID: "request-1", ProjectID: "project", TaskID: "task", ConfirmationID: "approval-1", ConfirmedBy: "user-1", ConfirmedAt: "2026-10-21T12:00:00Z", Intent: intent, PayloadHash: hex.EncodeToString(hash[:]), State: "submitting", Remote: json.RawMessage(`null`), Cancellation: json.RawMessage(`null`)}
}

func TestMulticaDelegationIntentRestartCASAndReruns(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	record, err := s.ReserveMulticaDelegation(ctx, delegationRecord())
	if err != nil {
		t.Fatal(err)
	}
	repeated := delegationRecord()
	repeated.RequestID = "another-request"
	again, err := s.ReserveMulticaDelegation(ctx, repeated)
	if err != nil || again.RequestID != record.RequestID {
		t.Fatalf("duplicate = %+v, %v", again, err)
	}
	repeated.ConfirmationID = "another-approval"
	again, err = s.ReserveMulticaDelegation(ctx, repeated)
	if err != nil || again.RequestID != record.RequestID {
		t.Fatalf("same task = %+v, %v", again, err)
	}
	record.Attempted = true
	record.State = "submission_unknown"
	saved, err := s.SaveMulticaDelegation(ctx, record)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveMulticaDelegation(ctx, record); !errors.Is(err, domain.ErrDelegationConflict) {
		t.Fatalf("stale save = %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	recovered, err := s.GetMulticaDelegation(ctx, record.RequestID)
	if err != nil || recovered.Version != saved.Version || recovered.State != "submission_unknown" {
		t.Fatalf("recovery = %+v, %v", recovered, err)
	}
	changed := recovered
	changed.PayloadHash = "changed"
	if _, err := s.SaveMulticaDelegation(ctx, changed); !errors.Is(err, domain.ErrDelegationInvalid) {
		t.Fatalf("hash mutation = %v", err)
	}
	changed = recovered
	changed.ConfirmedBy = "someone-else"
	if _, err := s.SaveMulticaDelegation(ctx, changed); !errors.Is(err, domain.ErrDelegationConflict) {
		t.Fatalf("confirmation mutation = %v", err)
	}

	changed = recovered
	var intent map[string]any
	if err := json.Unmarshal(changed.Intent, &intent); err != nil {
		t.Fatal(err)
	}
	intent["binding"].(map[string]any)["origin"] = "https://other.example"
	changed.Intent, err = json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveMulticaDelegation(ctx, changed); !errors.Is(err, domain.ErrDelegationConflict) {
		t.Fatalf("binding mutation = %v", err)
	}
	rerun := delegationRecord()
	rerun.RequestID = "rerun-1"
	rerun.ConfirmationID = "rerun-approval"
	rerun.RerunOf = record.RequestID
	if _, err := s.ReserveMulticaDelegation(ctx, rerun); err != nil {
		t.Fatal(err)
	}
	again, err = s.ReserveMulticaDelegation(ctx, rerun)
	if err != nil || again.RequestID != rerun.RequestID {
		t.Fatalf("repeat rerun = %+v, %v", again, err)
	}
	stale := rerun
	stale.RequestID = "rerun-2"
	stale.ConfirmationID = "stale-rerun"
	if _, err := s.ReserveMulticaDelegation(ctx, stale); !errors.Is(err, domain.ErrDelegationConflict) {
		t.Fatalf("stale rerun = %v", err)
	}
	current, err := s.FindMulticaDelegation(ctx, "project", "task")
	if err != nil || current.RequestID != rerun.RequestID {
		t.Fatalf("current = %+v, %v", current, err)
	}
	if _, err := s.GetMulticaDelegation(ctx, record.RequestID); err != nil {
		t.Fatal("old request lost", err)
	}
}

func TestMulticaDelegationConcurrentReservationAndCancellation(t *testing.T) {
	ctx := context.Background()
	s, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	ids := make(chan string, 10)
	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		wg.Go(func() {
			r, err := s.ReserveMulticaDelegation(ctx, delegationRecord())
			if err != nil {
				errs <- err
			}
			ids <- r.RequestID
		})
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	for id := range ids {
		if id != "request-1" {
			t.Fatal(id)
		}
	}
	r, err := s.GetMulticaDelegation(ctx, "request-1")
	if err != nil {
		t.Fatal(err)
	}
	r.Attempted = true
	r.State = "submission_unknown"
	r, err = s.SaveMulticaDelegation(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Remote = json.RawMessage(`{"delegation_id":"remote-1","task_id":"task-remote","workspace_id":"workspace","agent_id":"agent","runtime_id":"runtime","status":"queued","terminal":false,"revision":"v1"}`)
	r.State = "accepted"
	r, err = s.SaveMulticaDelegation(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Cancellation = json.RawMessage(`{"id":"cancel-1","userId":"user-1","at":"2026-10-21T13:00:00Z"}`)
	r.State = "cancellation_requested"
	r, err = s.SaveMulticaDelegation(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Remote = json.RawMessage(`{"delegation_id":"remote-1","task_id":"task-remote","workspace_id":"workspace","agent_id":"agent","runtime_id":"runtime","status":"cancelled","terminal":true,"revision":"v2"}`)
	r.State = "terminal"
	r, err = s.SaveMulticaDelegation(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	r.State = "cancellation_requested"
	r.Remote = json.RawMessage(`{"delegation_id":"remote-1","task_id":"task-remote","workspace_id":"workspace","agent_id":"agent","runtime_id":"runtime","status":"queued","terminal":false,"revision":"stale"}`)
	if _, err := s.SaveMulticaDelegation(ctx, r); !errors.Is(err, domain.ErrDelegationConflict) {
		t.Fatalf("terminal regression = %v", err)
	}
}
