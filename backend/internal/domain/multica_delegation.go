package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	var intent struct {
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
	if json.Unmarshal(r.Intent, &intent) != nil {
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
	if err != nil || len(data) > 100000 || delegationSecret.Match(data) {
		return ErrDelegationInvalid
	}

	var remote struct {
		DelegationID string `json:"delegation_id"`
		TaskID       string `json:"task_id"`
		WorkspaceID  string `json:"workspace_id"`
		AgentID      string `json:"agent_id"`
		RuntimeID    string `json:"runtime_id"`
		Status       string `json:"status"`
		Terminal     bool   `json:"terminal"`
		Revision     string `json:"revision"`
	}
	hasRemote := len(r.Remote) > 0 && string(r.Remote) != "null"
	if hasRemote {
		if json.Unmarshal(r.Remote, &remote) != nil || remote.DelegationID == "" || remote.TaskID == "" || remote.WorkspaceID != intent.Binding.WorkspaceID || remote.AgentID != p.AgentID || remote.RuntimeID != p.RuntimeID || remote.Revision == "" {
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
		var c struct {
			ID     string `json:"id"`
			UserID string `json:"userId"`
			At     string `json:"at"`
		}
		if json.Unmarshal(r.Cancellation, &c) != nil || c.ID == "" || c.UserID == "" {
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
