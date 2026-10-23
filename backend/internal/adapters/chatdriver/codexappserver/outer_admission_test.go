package codexappserver

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

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
