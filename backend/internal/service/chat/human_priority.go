package chat

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const humanInputAdmissionWait = 5 * time.Second

// ErrOrchestratorInputWaiting means no message was accepted before admission expired.
var ErrOrchestratorInputWaiting = errors.New("the provider is still finishing an earlier delivery; your message has not been accepted, retry with the same message id")

type automatedSteerWait struct{ cancel context.CancelFunc }

func (c *Controller) priorityHuman(msg ports.ChatUserMessage) bool {
	return c.orchestrator && trustedHumanInput(msg)
}
func trustedHumanInput(msg ports.ChatUserMessage) bool {
	return msg.SenderSessionID == "" && msg.ReportBatchID == "" && !msg.SpawnOpeningPrompt &&
		(msg.Origin == domain.MessageOriginHuman || msg.AuthoredByUser)
}
func automatedInput(msg ports.ChatUserMessage) bool {
	return msg.SenderSessionID != "" || msg.ReportBatchID != "" ||
		(msg.Origin == domain.MessageOriginAutomation || msg.Origin == domain.MessageOriginDaemon) && !msg.AuthoredByUser
}

func (c *Controller) lockInput(ctx context.Context, msg ports.ChatUserMessage, steering bool) (context.Context, func(), error) {
	if !c.orchestrator {
		c.sendMu.Lock()
		return ctx, c.sendMu.Unlock, nil
	}
	human := c.priorityHuman(msg)
	var ticket chan struct{}
	var timeout <-chan time.Time
	if human {
		ticket = make(chan struct{})
		timer := time.NewTimer(humanInputAdmissionWait)
		defer timer.Stop()
		timeout = timer.C
		c.priorityMu.Lock()
		c.humanWaiters = append(c.humanWaiters, ticket)
		if pending := c.automatedSteer; pending != nil {
			pending.cancel()
		}
		c.priorityMu.Unlock()
	}
	remove := func() {
		if ticket != nil {
			i := slices.Index(c.humanWaiters, ticket)
			if i >= 0 {
				c.humanWaiters = slices.Delete(c.humanWaiters, i, i+1)
			}
		}
	}
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			c.priorityMu.Lock()
			remove()
			c.priorityMu.Unlock()
			return ctx, nil, err
		}
		c.priorityMu.Lock()
		first := len(c.humanWaiters) == 0 || (human && c.humanWaiters[0] == ticket)
		if first && c.sendMu.TryLock() {
			remove()
			var pending *automatedSteerWait
			if steering && automatedInput(msg) {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				pending = &automatedSteerWait{cancel: cancel}
				c.automatedSteer = pending
			}
			c.priorityMu.Unlock()
			return ctx, func() {
				c.priorityMu.Lock()
				if pending != nil {
					pending.cancel()
					c.automatedSteer = nil
				}
				c.sendMu.Unlock()
				c.priorityMu.Unlock()
			}, nil
		}
		c.priorityMu.Unlock()
		var err error
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case <-timeout:
			err = ErrOrchestratorInputWaiting
		case <-ticker.C:
			continue
		}
		c.priorityMu.Lock()
		remove()
		c.priorityMu.Unlock()
		return ctx, nil, err
	}
}

func (c *Controller) claimSteerQueue(ctx context.Context) ([]domain.QueuedTurn, error) {
	if c.orchestrator {
		return nil, domain.ErrNoQueuedTurn
	}
	return c.store.ClaimQueuedBatch(ctx, c.conversation.ID, false, 0, c.now())
}
