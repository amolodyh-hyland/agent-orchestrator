package terminal

import (
	"testing"

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
		mgr.FenceLibraryInput("runtime")
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
