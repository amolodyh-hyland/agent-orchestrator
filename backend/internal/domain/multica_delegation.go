package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrDelegationConflict rejects stale updates or changes to confirmed intent.
var ErrDelegationConflict = errors.New("delegation journal conflict")

// ErrDelegationInvalid rejects malformed or unverifiable journal records.
var ErrDelegationInvalid = errors.New("invalid delegation journal record")

// MulticaDelegationRecord retains one confirmed intent and its remote observations.
type MulticaDelegationRecord struct {
	RequestID      string          `json:"requestId"`
	ProjectID      string          `json:"projectId"`
	TaskID         string          `json:"taskId"`
	ConfirmationID string          `json:"confirmationId"`
	ConfirmedBy    string          `json:"confirmedBy"`
	ConfirmedAt    string          `json:"confirmedAt"`
	RerunOf        string          `json:"rerunOf"`
	Intent         json.RawMessage `json:"intent"`
	PayloadHash    string          `json:"payloadHash"`
	Version        int64           `json:"version"`
	State          string          `json:"state"`
	FailureCode    *string         `json:"failureCode"`
	Attempted      bool            `json:"attempted"`
	Remote         json.RawMessage `json:"remote"`
	Cancellation   json.RawMessage `json:"cancellation"`
}

var delegationSecret = regexp.MustCompile(`(?:mul_|mat_|mcn_|mpi_|mpc_)[A-Za-z0-9_-]+`)

// Validate verifies approval, payload integrity, and execution-state consistency.
func (r MulticaDelegationRecord) Validate() error {
	if r.RequestID == "" || r.ProjectID == "" || r.TaskID == "" || r.ConfirmationID == "" || r.ConfirmedBy == "" || r.Version < 0 {
		return ErrDelegationInvalid
	}
	if _, err := time.Parse(time.RFC3339Nano, r.ConfirmedAt); err != nil {
		return ErrDelegationInvalid
	}
	var intent MulticaDelegationIntent
	if StrictDelegationJSON(r.Intent, &intent) != nil {
		return ErrDelegationInvalid
	}
	p := intent.Payload
	if intent.Binding.ServerKey == "" || intent.Binding.Origin == "" || intent.Binding.WorkspaceID == "" || p.AgentID == "" || p.RuntimeID == "" || p.Source.System != "ao" || p.Source.ProjectID != r.ProjectID || p.Source.TaskID != r.TaskID || p.Task.Title == "" || p.Task.Instructions == "" {
		return ErrDelegationInvalid
	}
	var input strings.Builder
	for _, value := range []string{p.AgentID, p.RuntimeID, p.Source.System, p.Source.ProjectID, p.Source.TaskID, p.Task.Title, p.Task.Instructions} {
		input.WriteString(strconv.Itoa(len(value)))
		input.WriteByte(':')
		input.WriteString(value)
	}
	hash := sha256.Sum256([]byte(input.String()))
	if hex.EncodeToString(hash[:]) != r.PayloadHash {
		return ErrDelegationInvalid
	}
	data, err := json.Marshal(r)
	if err != nil || len(data) > 100000 || delegationHasSecret(data) {
		return ErrDelegationInvalid
	}

	var remote MulticaDelegationRemote
	hasRemote := len(r.Remote) > 0 && string(r.Remote) != "null"
	if hasRemote {
		if StrictDelegationJSON(r.Remote, &remote) != nil || remote.DelegationID == "" || remote.TaskID == "" || remote.WorkspaceID != intent.Binding.WorkspaceID || remote.AgentID != p.AgentID || remote.RuntimeID != p.RuntimeID || remote.Revision == "" {
			return ErrDelegationInvalid
		}
		if remote.CreatedAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, remote.CreatedAt); err != nil {
				return ErrDelegationInvalid
			}
		}
		switch remote.FailureReason {
		case "", "access_revoked", "target_unavailable", "timeout", "runtime_unavailable", "execution_failed", "execution_cancelled", "execution_unavailable":
		default:
			return ErrDelegationInvalid
		}
		terminal := remote.Status == "completed" || remote.Status == "failed" || remote.Status == "cancelled"
		if terminal != remote.Terminal {
			return ErrDelegationInvalid
		}
		switch remote.Status {
		case "queued", "deferred", "dispatched", "waiting_local_directory", "running", "completed", "failed", "cancelled", "unavailable":
		default:
			return ErrDelegationInvalid
		}
		if !r.Attempted || (r.State == "terminal") != terminal {
			return ErrDelegationInvalid
		}
	}
	hasCancellation := len(r.Cancellation) > 0 && string(r.Cancellation) != "null"
	if hasCancellation {
		var c MulticaDelegationApproval
		if StrictDelegationJSON(r.Cancellation, &c) != nil || c.ID == "" || c.UserID == "" {
			return ErrDelegationInvalid
		}
		if _, err := time.Parse(time.RFC3339Nano, c.At); err != nil {
			return ErrDelegationInvalid
		}
	}
	switch r.State {
	case "submitting":
		if r.Attempted || hasRemote || hasCancellation {
			return ErrDelegationInvalid
		}
	case "submission_unknown":
		if !r.Attempted || hasRemote || hasCancellation {
			return ErrDelegationInvalid
		}
	case "accepted":
		if !hasRemote || hasCancellation {
			return ErrDelegationInvalid
		}
	case "cancellation_requested":
		if !hasCancellation {
			return ErrDelegationInvalid
		}
	case "terminal":
		if !hasRemote || !remote.Terminal {
			return ErrDelegationInvalid
		}
	case "rejected":
		if hasRemote {
			return ErrDelegationInvalid
		}
	default:
		return ErrDelegationInvalid
	}
	return nil
}

// SameIntent compares the immutable user-approved fields.
func (r MulticaDelegationRecord) SameIntent(other MulticaDelegationRecord) bool {
	return r.RequestID == other.RequestID && r.ProjectID == other.ProjectID && r.TaskID == other.TaskID &&
		r.ConfirmationID == other.ConfirmationID && r.ConfirmedBy == other.ConfirmedBy && r.ConfirmedAt == other.ConfirmedAt &&
		r.RerunOf == other.RerunOf && DelegationJSONEqual(r.Intent, other.Intent) && r.PayloadHash == other.PayloadHash
}

// DelegationJSONEqual ignores JSON key ordering and escape spelling.
func DelegationJSONEqual(a, b json.RawMessage) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}

// MulticaDelegationIntent is the exact normalized handoff schema.
type MulticaDelegationIntent struct {
	Binding struct {
		ServerKey   string `json:"serverKey"`
		Origin      string `json:"origin"`
		WorkspaceID string `json:"workspaceId"`
	} `json:"binding"`
	Payload struct {
		AgentID   string `json:"agent_id"`
		RuntimeID string `json:"expected_runtime_id"`
		Source    struct {
			System    string `json:"system"`
			ProjectID string `json:"project_id"`
			TaskID    string `json:"task_id"`
		} `json:"source"`
		Task struct {
			Title        string `json:"title"`
			Instructions string `json:"instructions"`
		} `json:"task"`
	} `json:"payload"`
}

// MulticaDelegationRemote contains only the safe Public API status projection.
type MulticaDelegationRemote struct {
	DelegationID  string `json:"delegation_id"`
	TaskID        string `json:"task_id"`
	WorkspaceID   string `json:"workspace_id"`
	AgentID       string `json:"agent_id"`
	RuntimeID     string `json:"runtime_id"`
	Status        string `json:"status"`
	CreatedAt     string `json:"created_at"`
	Terminal      bool   `json:"terminal"`
	Revision      string `json:"revision"`
	FailureReason string `json:"failure_reason,omitempty"`
}

// MulticaDelegationApproval records the principal and explicit human action.
type MulticaDelegationApproval struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	At     string `json:"at"`
}

// StrictDelegationJSON rejects unknown fields and trailing documents at every typed boundary.
func StrictDelegationJSON(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return ErrDelegationInvalid
	}
	return nil
}

func delegationHasSecret(data []byte) bool {
	var decoded any
	if json.Unmarshal(data, &decoded) != nil {
		return true
	}
	var scan func(any) bool
	scan = func(value any) bool {
		switch v := value.(type) {
		case string:
			return delegationSecret.MatchString(v)
		case map[string]any:
			for key, item := range v {
				if delegationSecret.MatchString(key) || scan(item) {
					return true
				}
			}
		case []any:
			for _, item := range v {
				if scan(item) {
					return true
				}
			}
		}
		return false
	}
	return scan(decoded)
}

// Normalize verifies a record and rebuilds raw fields from strict typed schemas.
func (r MulticaDelegationRecord) Normalize() (MulticaDelegationRecord, error) {
	if err := r.Validate(); err != nil {
		return r, err
	}
	var intent MulticaDelegationIntent
	if err := StrictDelegationJSON(r.Intent, &intent); err != nil {
		return r, err
	}
	r.Intent, _ = json.Marshal(intent)
	if len(r.Remote) > 0 && string(r.Remote) != "null" {
		var remote MulticaDelegationRemote
		if err := StrictDelegationJSON(r.Remote, &remote); err != nil {
			return r, err
		}
		r.Remote, _ = json.Marshal(remote)
	} else {
		r.Remote = json.RawMessage(`null`)
	}
	if len(r.Cancellation) > 0 && string(r.Cancellation) != "null" {
		var c MulticaDelegationApproval
		if err := StrictDelegationJSON(r.Cancellation, &c); err != nil {
			return r, err
		}
		r.Cancellation, _ = json.Marshal(c)
	} else {
		r.Cancellation = json.RawMessage(`null`)
	}
	return r, nil
}
