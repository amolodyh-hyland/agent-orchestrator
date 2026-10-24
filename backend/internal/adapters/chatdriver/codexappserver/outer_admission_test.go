package codexappserver

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestOuterDeadlineExpiresBehindFinalTransportWriteBarrier(t *testing.T) {
	c, server := newFakeAppServer(t, nil)
	conversation := &conversation{conn: c, threadID: "outer-thread"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.writeMu.Lock()
	var unlocked atomic.Bool
	unlock := func() {
		if unlocked.CompareAndSwap(false, true) {
			c.writeMu.Unlock()
		}
	}
	defer unlock()
	issuedAt := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(2 * time.Minute)
	var now atomic.Int64
	now.Store(issuedAt.UnixNano())
	var checks, attempts atomic.Int32
	result := make(chan error, 1)
	go func() {
		_, err := conversation.SendTurnWithAdmission(ctx, ports.ChatUserMessage{Text: "Exact human request", ClientMessageID: "human-request"}, func(context.Context) (func(), error) {
			checks.Add(1)
			if !time.Unix(0, now.Load()).Before(expiresAt) {
				return nil, domain.ErrOuterHeld
			}
			attempts.Add(1)
			return func() {}, nil
		})
		result <- err
	}()
	deadline := time.After(time.Second)
	for {
		c.mu.Lock()
		pending := len(c.pending)
		c.mu.Unlock()
		if pending == 1 {
			break // Past the conversation send lock, waiting for the RPC write lock.
		}
		select {
		case <-deadline:
			t.Fatal("request did not reach the RPC write wait")
		case <-time.After(time.Millisecond):
		}
	}
	if checks.Load() != 0 {
		t.Fatal("request authority was consumed before the transport write barrier")
	}
	now.Store(expiresAt.UnixNano())
	unlock()
	select {
	case err := <-result:
		if !errors.Is(err, domain.ErrOuterHeld) {
			t.Fatal("request did not expire at the final write", err)
		}
	case <-time.After(time.Second):
		t.Fatal("expired transport request did not return")
	}
	if checks.Load() != 1 || attempts.Load() != 0 {
		t.Fatal("expired request consumed submission authority", checks.Load(), attempts.Load())
	}
	select {
	case frame := <-server.requests:
		t.Fatal("expired request wrote provider bytes", frame)
	default:
	}
	c.mu.Lock()
	pending := len(c.pending)
	c.mu.Unlock()
	if pending != 0 {
		t.Fatal("expired request left a live RPC handle")
	}
}

func TestOuterAdmissionRunsAfterRPCWriteWaitAndBeforeAnyBytes(t *testing.T) {
	c, server := newFakeAppServer(t, nil)
	c.writeMu.Lock()
	var revoked atomic.Bool
	result := make(chan error, 1)
	go func() {
		result <- c.requestWithAdmission(context.Background(), "turn/start", map[string]string{"text": "exact human request"}, nil, func(context.Context) (func(), error) {
			if revoked.Load() {
				return nil, domain.ErrOuterHeld
			}
			t.Error("admission ran before the final write wait")
			return func() {}, nil
		})
	}()
	revoked.Store(true)
	c.writeMu.Unlock()
	select {
	case err := <-result:
		if !errors.Is(err, domain.ErrOuterHeld) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("final admission did not return")
	}
	select {
	case frame := <-server.requests:
		t.Fatal("held request wrote provider bytes", frame)
	default:
	}
	c.mu.Lock()
	pending := len(c.pending)
	c.mu.Unlock()
	if pending != 0 {
		t.Fatal("held request left a live RPC handle")
	}
}

func TestOuterAdmissionLeaseEndsAtWriteNotProviderResponse(t *testing.T) {
	c, server := newFakeAppServer(t, nil)
	var acquired, released atomic.Int32
	result := make(chan error, 1)
	go func() {
		result <- c.requestWithAdmission(context.Background(), "turn/start", map[string]string{"text": "exact"}, nil, func(context.Context) (func(), error) { acquired.Add(1); return func() { released.Add(1) }, nil })
	}()
	frame := server.nextRequest()
	deadline := time.After(time.Second)
	for released.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("lease retained while waiting for response")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if acquired.Load() != 1 || released.Load() != 1 {
		t.Fatal("admission lease reused")
	}
	server.push(fmt.Sprintf(`{"id":%s,"result":{}}`, *frame.ID))
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}
