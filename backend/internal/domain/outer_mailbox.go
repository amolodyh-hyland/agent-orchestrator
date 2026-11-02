package domain

import (
	"encoding/json"
	"time"
)

type OuterMailboxSpec struct {
	ID   string `json:"id"`
	Text string `json:"text,omitempty"`
}

type OuterMailboxMessage struct {
	Sequence        int64         `json:"sequence"`
	ID              string        `json:"id"`
	ProjectID       string        `json:"projectId"`
	CoordinatorID   SessionID     `json:"coordinatorId"`
	SenderID        SessionID     `json:"senderId"`
	RecipientID     SessionID     `json:"recipientId"`
	Direction       string        `json:"direction"`
	Text            string        `json:"text"`
	RequestID       string        `json:"requestId,omitempty"`
	PlanID          string        `json:"planId,omitempty"`
	ActionID        string        `json:"actionId,omitempty"`
	Sources         []OuterSource `json:"sources"`
	RecordedAt      time.Time     `json:"recordedAt"`
	ReceiptActionID string        `json:"receiptActionId,omitempty"`
	AcknowledgedBy  SessionID     `json:"acknowledgedBy,omitempty"`
	AcknowledgedAt  time.Time     `json:"acknowledgedAt"`
}

func OuterMailboxFact(m OuterMailboxMessage) OuterFact {
	sources := []string{m.ProjectID}
	unknown := false
	for _, s := range m.Sources {
		sources = append(sources, s.Sources...)
		if s.ProjectID != "" {
			sources = append(sources, s.ProjectID)
		}
		unknown = unknown || s.Unknown
	}
	data, _ := json.Marshal(m)
	return OuterFact{Source: OuterSource{ProjectID: m.ProjectID, Kind: "mailbox", ID: m.ID, Revision: m.Sequence, SourceAt: m.RecordedAt, Sources: sources, Unknown: unknown}, Summary: string(data), State: "inert", Receipt: string(m.AcknowledgedBy)}
}
