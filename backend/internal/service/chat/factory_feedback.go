package chat

import (
	"context"
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// FeedbackAdmission validates authority at the native submission boundary.
type FeedbackAdmission interface {
	HoldUnapprovedContinuation(context.Context, domain.SessionID) error
	AcquireFeedbackInput(context.Context, domain.SessionID, ports.ChatUserMessage, string) (func(), error)
}

// SetFeedbackAdmission installs the participant-scoped continuation guard.
func (s *Service) SetFeedbackAdmission(a FeedbackAdmission) {
	s.mu.Lock()
	s.feedbackAdmission = a
	s.mu.Unlock()
}
func (s *Service) holdUnapprovedContinuation(ctx context.Context, id domain.SessionID) error {
	s.mu.RLock()
	a := s.feedbackAdmission
	s.mu.RUnlock()
	if a == nil {
		return nil
	}
	return a.HoldUnapprovedContinuation(ctx, id)
}
func (s *Service) acquireFeedbackInput(ctx context.Context, id domain.SessionID, msg ports.ChatUserMessage, action string) (func(), error) {
	s.mu.RLock()
	a := s.feedbackAdmission
	s.mu.RUnlock()
	if a == nil {
		return func() {}, nil
	}
	return a.AcquireFeedbackInput(ctx, id, msg, action)
}
func (c *Controller) acquireFeedbackInput(ctx context.Context, msg ports.ChatUserMessage, action string) (func(), error) {
	if c.feedbackInput == nil || c.reviewID != "" {
		return func() {}, nil
	}
	msg.FeedbackControllerGeneration = c.generation
	msg.FeedbackConversationID = c.conversation.ID
	return c.feedbackInput(ctx, c.sessionID, msg, action)
}

// DeliverFactoryFeedback queues exact findings without waking or replacing a controller.
func (s *Service) DeliverFactoryFeedback(ctx context.Context, id domain.SessionID, text, key string) error {
	// Delivery cannot wake, restore, provision or replace an execution.
	s.mu.RLock()
	controller := s.controllers[id]
	s.mu.RUnlock()
	if controller == nil {
		return errors.New("existing review feedback target unavailable")
	}
	_, err := controller.Send(ctx, ports.ChatUserMessage{Text: text, ClientMessageID: key, Origin: domain.MessageOriginAutomation})
	return err
}
