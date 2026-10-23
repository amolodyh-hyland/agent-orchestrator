package acp

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

// The SDK's Prompt waits for the whole turn. Its writer is the submission
// boundary: acquire after the SDK's write lock, release once the frame is sent.
// Never keep admission while awaiting a provider response or an event consumer.
type promptSubmission struct {
	ctx     context.Context
	acquire func(context.Context) (func(), error)
	refused atomic.Bool
}

func (s *promptSubmission) write(writer io.WriteCloser, data []byte) (int, error) {
	release, err := s.acquire(s.ctx)
	if err != nil {
		s.refused.Store(true)
		return 0, err
	}
	defer release()
	if err := s.ctx.Err(); err != nil {
		s.refused.Store(true)
		return 0, err
	}
	// Close the pipe/socket to interrupt a stalled write. This callback uses the
	// underlying closer directly, without waiting on lockedWriteCloser.mu, so a
	// stalled peer cannot keep revocation waiting indefinitely on admission.
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = writer.Close() })
	defer stop()
	return writer.Write(data)
}

func (c *conversation) submitPrompt(ctx context.Context, turn preparedTurn, request acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	if turn.acquire == nil {
		return c.conn.Prompt(ctx, request)
	}
	if c.promptWriter == nil {
		return acpsdk.PromptResponse{}, errors.New("ACP prompt admission transport unavailable")
	}
	submission := &promptSubmission{ctx: ctx, acquire: turn.acquire}
	c.promptWriter.prompt.Store(submission)
	// There is only one active prompt per conversation. Clear before publishing
	// completion/readiness so the next turn cannot inherit an earlier guard.
	defer c.promptWriter.prompt.CompareAndSwap(submission, nil)
	response, err := c.conn.Prompt(ctx, request)
	if submission.refused.Load() && turn.spentPreamble {
		c.mu.Lock()
		c.preambleSpent = false
		c.mu.Unlock()
	}
	return response, err
}
