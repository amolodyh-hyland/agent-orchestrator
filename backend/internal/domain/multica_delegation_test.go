package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func delegationFixture(t *testing.T) MulticaDelegationRecord {
	t.Helper()
	raw, err := os.ReadFile("../delegationauth/testdata/record.json")
	if err != nil {
		t.Fatal(err)
	}
	var r MulticaDelegationRecord
	if err := StrictDelegationJSON(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

const validDelegationRemote = `{"delegation_id":"d","task_id":"remote-task","workspace_id":"10000000-0000-4000-8000-000000000001","agent_id":"20000000-0000-4000-8000-000000000002","runtime_id":"30000000-0000-4000-8000-000000000003","status":"queued","created_at":"2026-10-21T12:00:00Z","terminal":false,"revision":"revision-1"}`

func TestDelegationRejectsEscapedSecretsAndUnknownFields(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*MulticaDelegationRecord)
	}{
		{"escaped binding secret", func(r *MulticaDelegationRecord) {
			r.Intent = bytes.Replace(r.Intent, []byte(`"local"`), []byte(`"\u006dul_hidden"`), 1)
		}},
		{"unknown intent field", func(r *MulticaDelegationRecord) { r.Intent = append([]byte(`{"extra":true,`), r.Intent[1:]...) }},
		{"unknown binding field", func(r *MulticaDelegationRecord) {
			r.Intent = bytes.Replace(r.Intent, []byte(`"serverKey":`), []byte(`"extra":true,"serverKey":`), 1)
		}},
		{"unknown task field", func(r *MulticaDelegationRecord) {
			r.Intent = bytes.Replace(r.Intent, []byte(`"title":`), []byte(`"extra":true,"title":`), 1)
		}},
		{"unknown remote field", func(r *MulticaDelegationRecord) {
			r.Remote = json.RawMessage(`{"extra":true,` + validDelegationRemote[1:])
			r.Attempted = true
			r.State = "accepted"
		}},
		{"escaped remote secret", func(r *MulticaDelegationRecord) {
			r.Remote = bytes.Replace([]byte(validDelegationRemote), []byte(`"revision-1"`), []byte(`"\u006dul_hidden"`), 1)
			r.Attempted = true
			r.State = "accepted"
		}},
		{"unknown cancellation field", func(r *MulticaDelegationRecord) {
			r.Cancellation = json.RawMessage(`{"id":"c","userId":"u","at":"2026-10-21T12:00:00Z","extra":true}`)
			r.State = "cancellation_requested"
		}},
		{"escaped cancellation secret", func(r *MulticaDelegationRecord) {
			r.Cancellation = json.RawMessage(`{"id":"c","userId":"\u006dul_hidden","at":"2026-10-21T12:00:00Z"}`)
			r.State = "cancellation_requested"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := delegationFixture(t)
			tc.change(&r)
			if _, err := r.Normalize(); err == nil {
				t.Fatal("unsafe record accepted")
			}
		})
	}
	r := delegationFixture(t)
	normalized, err := r.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if err := normalized.Validate(); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	raw = append([]byte(`{"unknown":true,`), raw[1:]...)
	if err := StrictDelegationJSON(raw, &r); err == nil {
		t.Fatal("unknown top-level field accepted")
	}
}
