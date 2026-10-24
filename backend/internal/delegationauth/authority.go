// Package delegationauth verifies the private desktop-to-daemon delegation boundary.
package delegationauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Authority holds a boot-scoped key received only through the inherited desktop pipe.
type Authority struct {
	key       []byte
	runMu     sync.Mutex
	runNonces map[string]int64
}

// New constructs a verifier without retaining the caller's mutable key buffer.
func New(key []byte) (*Authority, error) {
	if len(key) != 32 {
		return nil, errors.New("invalid delegation authority")
	}
	return &Authority{key: append([]byte(nil), key...)}, nil
}

func (a *Authority) matches(subject []byte, proof string) bool {
	if a == nil {
		return false
	}
	provided, err := hex.DecodeString(proof)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, a.key)
	_, _ = mac.Write(subject)
	return hmac.Equal(mac.Sum(nil), provided)
}

// Authorize verifies an exact serialized request, including operation and version.
func (a *Authority) Authorize(body []byte, proof string) bool {
	return a.matches(append([]byte("journal-v1:"), body...), proof)
}

// ResponseMAC binds the exact response bytes to an authenticated request nonce.
func (a *Authority) ResponseMAC(body []byte, requestMAC string) string {
	if a == nil {
		return ""
	}
	mac := hmac.New(sha256.New, a.key)
	_, _ = mac.Write([]byte("journal-response-v1:" + requestMAC + ":"))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Confirm verifies a per-intent proof minted by the trusted main-process human flow.
func (a *Authority) Confirm(record domain.MulticaDelegationRecord, proof string) bool {
	if record.Validate() != nil {
		return false
	}
	var intent domain.MulticaDelegationIntent
	if domain.StrictDelegationJSON(record.Intent, &intent) != nil {
		return false
	}
	values := []string{record.RequestID, record.ProjectID, record.TaskID, record.ConfirmationID, record.ConfirmedBy, record.ConfirmedAt, record.RerunOf,
		intent.Binding.ServerKey, intent.Binding.Origin, intent.Binding.WorkspaceID, intent.Payload.AgentID, intent.Payload.RuntimeID, record.PayloadHash}
	var subject strings.Builder
	subject.WriteString("confirmation-v1:")
	for _, value := range values {
		subject.WriteString(strconv.Itoa(len(value)))
		subject.WriteByte(':')
		subject.WriteString(value)
	}
	return a.matches([]byte(subject.String()), proof)
}

// ReadDesktopHandoff extends the existing private stdin bootstrap; legacy launches have no authority.
func ReadDesktopHandoff(r io.Reader) (string, *Authority, error) {
	line, err := browserruntime.ReadRuntimeToken(r)
	if err != nil {
		return "", nil, err
	}
	if !strings.HasPrefix(line, "{") {
		return line, nil, nil
	}
	var handoff struct {
		BrowserToken  string `json:"browserToken"`
		DelegationKey string `json:"delegationKey"`
	}
	if domain.StrictDelegationJSON([]byte(line), &handoff) != nil || handoff.BrowserToken == "" {
		return "", nil, errors.New("invalid desktop handoff")
	}
	key, err := base64.RawURLEncoding.DecodeString(handoff.DelegationKey)
	if err != nil {
		return "", nil, errors.New("invalid desktop handoff")
	}
	authority, err := New(key)
	return handoff.BrowserToken, authority, err
}

// AuthorizeRun authenticates a distinct, exact run confirmation request namespace.
func (a *Authority) AuthorizeRun(body []byte, proof string) bool {
	return a.matches(append([]byte("factory-run-v1:"), body...), proof)
}

// AuthorizeOuter verifies the purpose-separated private native request MAC.
func (a *Authority) AuthorizeOuter(body []byte, proof string) bool {
	return a.matches(append([]byte("outer-native-v1:"), body...), proof)
}

// AuthorizeOuterRead verifies purpose-separated passive desktop projection access.
func (a *Authority) AuthorizeOuterRead(body []byte, proof string) bool {
	return a.matches(append([]byte("outer-read-v1:"), body...), proof)
}

// ConsumeRun rejects replay, expiry and excessive outstanding desktop requests.
// The caller must first authenticate the exact body containing nonce and expiry.
func (a *Authority) ConsumeRun(nonce string, expires int64) bool {
	if a == nil || len(nonce) < 16 || len(nonce) > 128 {
		return false
	}
	now := time.Now().UnixMilli()
	if expires <= now || expires > now+10000 {
		return false
	}
	a.runMu.Lock()
	defer a.runMu.Unlock()
	if a.runNonces == nil {
		a.runNonces = map[string]int64{}
	}
	for n, e := range a.runNonces {
		if e <= now {
			delete(a.runNonces, n)
		}
	}
	if _, used := a.runNonces[nonce]; used || len(a.runNonces) >= 1024 {
		return false
	}
	a.runNonces[nonce] = expires
	return true
}
