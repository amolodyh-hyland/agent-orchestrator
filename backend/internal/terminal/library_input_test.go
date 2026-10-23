package terminal

import (
	"context"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestTaskLibraryFenceDiscardsBufferedInputAndRejectsAttachedWrites(t *testing.T) {
	for _, attached := range []bool{false, true} {
		pty := newFakePTY()
		src := &fakeSource{alive: true}
		mgr := NewManager(src, nil, testLogger())
		defer mgr.Close()
		a := newAttachment("runtime", ports.RuntimeHandle{ID: "runtime"}, src, nil, nil, nil, testLogger())
		mgr.attachments[a] = struct{}{}
		if attached {
			a.pty = pty
			a.inputReady = true
		}
		released := 0
		mgr.writeInput("runtime", a, []byte("before"), func() { released++ })
		if !attached && released != 0 {
			t.Fatal("buffered lease released early")
		}
		_, releaseDrain := mgr.BeginInputDrain("runtime")
		if _, err := mgr.FenceLibraryInput(context.Background(), "runtime"); err != nil {
			t.Fatal(err)
		}
		releaseDrain()
		if released != 1 {
			t.Fatal("buffered lease not released on fence")
		}
		mgr.writeInput("runtime", a, []byte("after"), func() { released++ })
		if released != 2 {
			t.Fatal("refused write leaked lease")
		}
		want := ""
		if attached {
			want = "before"
		}
		if got := string(pty.writtenBytes()); got != want {
			t.Fatalf("writes after fence: %q", got)
		}
		if !attached && a.setPTY(pty) {
			t.Fatal("fenced attach published buffered input")
		}
		replacement := newAttachment("runtime", ports.RuntimeHandle{ID: "runtime"}, src, nil, nil, nil, testLogger())
		replacement.pty = pty
		replacement.inputReady = true
		mgr.writeInput("runtime", replacement, []byte("reconnect"), func() { released++ })
		if got := string(pty.writtenBytes()); got != want {
			t.Fatal("new attachment bypassed fence")
		}
	}
}

type blockedLibraryStream struct {
	*fakePTY
	started   chan struct{}
	unblock   chan struct{}
	once      sync.Once
	interrupt bool
}

func (p *blockedLibraryStream) Write([]byte) (int, error) {
	close(p.started)
	<-p.unblock
	return 0, io.ErrClosedPipe
}

func (p *blockedLibraryStream) Close() error {
	if p.interrupt {
		p.once.Do(func() { close(p.unblock) })
	}
	return p.fakePTY.Close()
}

func TestTaskLibraryFenceInterruptsBlockedWriteAndBoundsDrain(t *testing.T) {
	for _, interrupt := range []bool{true, false} {
		t.Run(map[bool]string{true: "interruptible", false: "uninterruptible"}[interrupt], func(t *testing.T) {
			p := &blockedLibraryStream{fakePTY: newFakePTY(), started: make(chan struct{}), unblock: make(chan struct{}), interrupt: interrupt}
			defer p.once.Do(func() { close(p.unblock) })
			src := &fakeSource{alive: true}
			mgr := NewManager(src, nil, testLogger())
			defer mgr.Close()
			a := newAttachment("runtime", ports.RuntimeHandle{ID: "runtime"}, src, nil, nil, nil, testLogger())
			a.pty, a.inputReady = p, true
			if err := mgr.track(a); err != nil {
				t.Fatal(err)
			}
			released := make(chan struct{})
			go mgr.writeInput("runtime", a, []byte("blocked"), func() { close(released) })
			select {
			case <-p.started:
			case <-time.After(time.Second):
				t.Fatal("write did not start")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				release, err := mgr.FenceLibraryInput(ctx, "runtime")
				if release != nil {
					defer release()
				}
				done <- err
			}()
			select {
			case err := <-done:
				if interrupt && err != nil {
					t.Fatal(err)
				}
				if !interrupt && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("unbounded drain: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("fence stuck behind PTY write")
			}
			if !a.isClosed() {
				t.Fatal("attachment remained open")
			}
			assertNoLibraryFenceWaiters(t)
			if !interrupt {
				for attempt := 0; attempt < 8; attempt++ {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
					release, err := mgr.FenceLibraryInput(ctx, "runtime")
					cancel()
					if release != nil {
						release()
					}
					if !errors.Is(err, context.DeadlineExceeded) {
						t.Fatalf("attempt %d: %v", attempt, err)
					}
					assertNoLibraryFenceWaiters(t)
				}
				select {
				case <-released:
					t.Fatal("uninterruptible writer stopped before waiter assertions")
				default:
				}
			}
			p.once.Do(func() { close(p.unblock) })
			select {
			case <-released:
			case <-time.After(time.Second):
				t.Fatal("input lease not released")
			}
		})
	}
}

func assertNoLibraryFenceWaiters(t *testing.T) {
	t.Helper()
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	if n == len(buf) {
		t.Fatal("goroutine snapshot truncated")
	}
	for _, stack := range strings.Split(string(buf[:n]), "\n\n") {
		if strings.Contains(stack, "(*Manager).FenceLibraryInput") {
			t.Fatalf("fence left a goroutine after returning while the writer is still blocked:\n%s", stack)
		}
	}
}
