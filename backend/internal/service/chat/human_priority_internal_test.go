package chat

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"testing"
	"testing/synctest"
	"time"
)

func TestHumanAdmissionBoundAndPermitCleanup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := &Controller{orchestrator: true, conversation: domain.ConversationRecord{Scope: domain.ConversationScopeProject}}
		c.sendMu.Lock()
		start := time.Now()
		_, _, err := c.lockInput(context.Background(), ports.ChatUserMessage{Origin: domain.MessageOriginHuman}, false)
		if !errors.Is(err, ErrOrchestratorInputWaiting) {
			t.Fatalf("waiting=%v", err)
		}
		if elapsed := time.Since(start); elapsed != 5*time.Second {
			t.Fatalf("fake-clock admission wait=%s", elapsed)
		}
		if len(c.humanWaiters) != 0 {
			t.Fatal("expired admission leaked priority permit")
		}
		c.sendMu.Unlock()
		_, release, err := c.lockInput(context.Background(), ports.ChatUserMessage{Origin: domain.MessageOriginAutomation}, false)
		if err != nil {
			t.Fatal(err)
		}
		release()
	})
}
func TestHumanAdmissionFIFOAgainstContinuousAutomation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := &Controller{orchestrator: true, conversation: domain.ConversationRecord{Scope: domain.ConversationScopeProject}}
		c.sendMu.Lock()
		got := make(chan string, 20)
		for _, name := range []string{"first human", "second human"} {
			go func() {
				_, release, err := c.lockInput(context.Background(), ports.ChatUserMessage{Origin: domain.MessageOriginHuman}, false)
				if err != nil {
					t.Error(err)
					return
				}
				got <- name
				release()
			}()
			synctest.Wait()
		}
		for i := 0; i < 10; i++ {
			go func() {
				_, release, err := c.lockInput(context.Background(), ports.ChatUserMessage{Origin: domain.MessageOriginAutomation}, false)
				if err != nil {
					t.Error(err)
					return
				}
				got <- "report"
				release()
			}()
		}
		synctest.Wait()
		start := time.Now()
		c.sendMu.Unlock()
		for _, want := range []string{"first human", "second human"} {
			if actual := <-got; actual != want {
				t.Fatalf("admission=%q want %q", actual, want)
			}
		}
		if elapsed := time.Since(start); elapsed > 10*time.Millisecond {
			t.Fatalf("human scheduler delay=%s", elapsed)
		}
		for i := 0; i < 10; i++ {
			<-got
		}
	})
}
