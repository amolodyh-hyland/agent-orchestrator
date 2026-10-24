package domain

import (
	"context"
	"time"
)

// OuterExecution identifies one daemon-owned action attempt and grants no new turn.
type OuterExecution struct{ PlanID, ActionID string }
type outerExecutionKey struct{}

// WithOuterExecution carries the exact attempted action through its existing services.
func WithOuterExecution(ctx context.Context, a OuterExecution) context.Context {
	return context.WithValue(ctx, outerExecutionKey{}, a)
}

// OuterExecutionFrom reads private execution context, never public authorship fields.
func OuterExecutionFrom(ctx context.Context) (OuterExecution, bool) {
	a, ok := ctx.Value(outerExecutionKey{}).(OuterExecution)
	return a, ok
}

// IsOuterControlledSession includes the outer and every enrolled participant.
func IsOuterControlledSession(ctx context.Context, store any, id SessionID) (bool, error) {
	bound, err := IsOuter(ctx, store, id)
	if err != nil || bound {
		return bound, err
	}
	return IsOuterParticipant(ctx, store, id)
}

// IsOuterParticipant resolves retained execution enrollment.
func IsOuterParticipant(ctx context.Context, store any, id SessionID) (bool, error) {
	if p, ok := store.(interface {
		IsOuterParticipant(context.Context, SessionID) (bool, error)
	}); ok {
		return p.IsOuterParticipant(ctx, id)
	}
	return false, nil
}

// OuterActionSpec describes one finite operation and earlier manifest dependencies.
type OuterActionSpec struct {
	Operation string      `json:"operation"`
	ProjectID string      `json:"projectId"`
	SessionID SessionID   `json:"sessionId,omitempty"`
	Text      string      `json:"text,omitempty"`
	Branch    string      `json:"branch,omitempty"`
	Config    AgentConfig `json:"config"`
	DependsOn []int       `json:"dependsOn"`
}

// OuterPlanProposal links proposed instances to one original human request.
type OuterPlanProposal struct {
	RequestID      string            `json:"requestId"`
	SourceProjects []string          `json:"sourceProjects"`
	Actions        []OuterActionSpec `json:"actions"`
}

// OuterPlannedAction freezes one concrete target and its effective identity.
type OuterPlannedAction struct {
	ID                     string          `json:"id"`
	Spec                   OuterActionSpec `json:"spec"`
	ProjectLabel           string          `json:"projectLabel"`
	ProjectRevision        int64           `json:"projectRevision"`
	TargetDigest           string          `json:"targetDigest"`
	ControllerGeneration   string          `json:"controllerGeneration"`
	ProviderConversationID string          `json:"providerConversationId"`
	ConversationID         string          `json:"conversationId"`
}

// OuterActionPlan seals the complete original request, sources and action set.
type OuterActionPlan struct {
	ID        string               `json:"id"`
	Request   OuterRequest         `json:"request"`
	Epoch     string               `json:"epoch"`
	CreatedAt time.Time            `json:"createdAt"`
	Sources   []OuterSource        `json:"sources"`
	Actions   []OuterPlannedAction `json:"actions"`
}

// OuterPlanReceipt separates native approval from individual action outcomes.
type OuterPlanReceipt struct {
	Plan       OuterActionPlan      `json:"plan"`
	Digest     string               `json:"digest"`
	ApprovedAt time.Time            `json:"approvedAt"`
	ExpiresAt  time.Time            `json:"expiresAt"`
	Actions    []OuterActionReceipt `json:"actions"`
}

// OuterActionReceipt retains the original attempt without authorizing replay.
type OuterActionReceipt struct {
	ID          string    `json:"id"`
	SessionID   SessionID `json:"sessionId"`
	AttemptedAt time.Time `json:"attemptedAt"`
	CompletedAt time.Time `json:"completedAt"`
	State       string    `json:"state"`
}
