package delegationauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func signTest(key []byte, value string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestAuthorityRejectsForgedOrChangedProof(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	authority, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	body := `{"operation":"get","requestId":"request-1"}`
	proof := signTest(key, "journal-v1:"+body)
	if !authority.Authorize([]byte(body), proof) || authority.Authorize([]byte(body+" "), proof) || authority.Authorize([]byte(body), strings.Repeat("0", 64)) {
		t.Fatal("request MAC not bound to exact bytes")
	}
	raw, err := os.ReadFile("testdata/record.json")
	if err != nil {
		t.Fatal(err)
	}
	var r domain.MulticaDelegationRecord
	if err := domain.StrictDelegationJSON(raw, &r); err != nil {
		t.Fatal(err)
	}
	var intent domain.MulticaDelegationIntent
	if err := json.Unmarshal(r.Intent, &intent); err != nil {
		t.Fatal(err)
	}
	values := []string{r.RequestID, r.ProjectID, r.TaskID, r.ConfirmationID, r.ConfirmedBy, r.ConfirmedAt, r.RerunOf, intent.Binding.ServerKey, intent.Binding.Origin, intent.Binding.WorkspaceID, intent.Payload.AgentID, intent.Payload.RuntimeID, r.PayloadHash}
	subject := "confirmation-v1:"
	for _, v := range values {
		subject += strconv.Itoa(len(v)) + ":" + v
	}
	proof = signTest(key, subject)
	if !authority.Confirm(r, proof) {
		t.Fatal("valid confirmation refused")
	}
	r.RequestID = "another-request"
	if authority.Confirm(r, proof) {
		t.Fatal("nonce mutation accepted")
	}
	r.RequestID = "request-1"
	intent.Binding.Origin = "https://other.example"
	r.Intent, err = json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	if authority.Confirm(r, proof) {
		t.Fatal("target mutation accepted")
	}
}

func TestDesktopHandoffIsPrivateAndLegacyLaunchesHaveNoAuthority(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	handoff := `{"browserToken":"browser-test-token","delegationKey":"` + base64.RawURLEncoding.EncodeToString(key) + `"}`
	browser, authority, err := ReadDesktopHandoff(strings.NewReader(handoff + "\n"))
	if err != nil || browser != "browser-test-token" || authority == nil {
		t.Fatalf("handoff: %q %v", browser, err)
	}
	_, authority, err = ReadDesktopHandoff(strings.NewReader("legacy-browser-token\n"))
	if err != nil || authority != nil {
		t.Fatalf("legacy authority: %v", err)
	}
	for _, input := range []string{`{"browserToken":"x","delegationKey":"bad"}`, `{"browserToken":"x","delegationKey":"` + base64.RawURLEncoding.EncodeToString(key) + `","extra":"no"}`} {
		if _, _, err := ReadDesktopHandoff(strings.NewReader(input + "\n")); err == nil {
			t.Fatal("invalid handoff accepted")
		}
	}
	var absent *Authority
	if absent.Authorize([]byte("x"), "0") {
		t.Fatal("missing authority accepted")
	}
}
