package domain

import (
	"context"
	"errors"
	"time"
)

// ErrFactoryFeedbackHeld preserves feedback as evidence without a continuation.
var ErrFactoryFeedbackHeld = errors.New("factory feedback is display-only; a separate human continuation is required")

// FactoryFeedbackPolicy identifies participants whose feedback must remain passive.
type FactoryFeedbackPolicy interface {
	FactoryFeedbackHeld(context.Context, SessionID) (bool, error)
}

// CheckFactoryFeedback checks the durable participant policy at delivery time.
func CheckFactoryFeedback(ctx context.Context, store any, id SessionID) error {
	if policy, ok := store.(FactoryFeedbackPolicy); ok {
		held, err := policy.FactoryFeedbackHeld(ctx, id)
		if err != nil {
			return err
		}
		if held {
			return ErrFactoryFeedbackHeld
		}
	}
	return nil
}

// RunMonitorConfig controls display deadlines without granting execution authority.
type RunMonitorConfig struct {
	SilenceSeconds int        `json:"silenceSeconds"`
	BuildSeconds   int        `json:"buildSeconds"`
	StageDeadline  *time.Time `json:"stageDeadline,omitempty"`
	NextOwner      string     `json:"nextOwner"`
	Heavy          bool       `json:"heavy"`
}

// RunParticipantSnapshot preserves effective feedback settings at enrollment.
type RunParticipantSnapshot struct {
	SessionID        SessionID `json:"sessionId"`
	AutoReview       bool      `json:"autoReview"`
	AutoInjectReview bool      `json:"autoInjectReview"`
	AutoInjectCI     bool      `json:"autoInjectCI"`
	FeedbackPolicies []string  `json:"feedbackPolicies"`
	ReportRoute      string    `json:"reportRoute"`
	CapturedAt       time.Time `json:"capturedAt"`
}

// RunAttention coalesces one condition and its deliberate display acknowledgement.
type RunAttention struct {
	Key            string     `json:"key"`
	Condition      string     `json:"condition"`
	FirstAt        time.Time  `json:"firstAt"`
	LastAt         time.Time  `json:"lastAt"`
	AcknowledgedAt *time.Time `json:"acknowledgedAt,omitempty"`
}

// RunMonitoring is a timestamped observation of an approved run reference.
type RunMonitoring struct {
	RunID          string                   `json:"runId"`
	ProjectID      string                   `json:"projectId"`
	TaskID         string                   `json:"taskId"`
	DelegationID   string                   `json:"delegationId,omitempty"`
	Stage          string                   `json:"stage"`
	StageVersion   int64                    `json:"stageVersion"`
	Config         RunMonitorConfig         `json:"config"`
	Participants   []RunParticipantSnapshot `json:"participants"`
	ObservedAt     time.Time                `json:"observedAt"`
	LastActivityAt time.Time                `json:"lastActivityAt"`
	Deadline       time.Time                `json:"deadline"`
	Freshness      string                   `json:"freshness"`
	Ownership      string                   `json:"ownership"`
	State          string                   `json:"state"`
	Reports        []RunReportObservation   `json:"reports"`
	Attention      *RunAttention            `json:"attention,omitempty"`
}

// RunReportObservation separates durable delivery from native acceptance.
type RunReportObservation struct {
	ID            string    `json:"id"`
	RecordedAt    time.Time `json:"recordedAt"`
	DeliveryState string    `json:"deliveryState"`
	NativeReceipt string    `json:"nativeReceipt"`
}
