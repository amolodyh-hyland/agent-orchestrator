package library

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

type libraryTerminalStream struct {
	net.Conn
	blocked bool
	started chan struct{}
	written chan string
}

func (s *libraryTerminalStream) Resize(uint16, uint16) error { return nil }
func (s *libraryTerminalStream) Write(p []byte) (int, error) {
	if s.blocked {
		close(s.started)
		return s.Conn.Write(p)
	}
	s.written <- string(p)
	return len(p), nil
}

type libraryTerminalSource struct {
	blocked bool
	opened  chan *libraryTerminalStream
	t       *testing.T
}

func (s *libraryTerminalSource) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return true, nil
}
func (s *libraryTerminalSource) Attach(context.Context, ports.RuntimeHandle, uint16, uint16) (ports.Stream, error) {
	local, remote := net.Pipe()
	s.t.Cleanup(func() { _ = remote.Close() })
	stream := &libraryTerminalStream{Conn: local, blocked: s.blocked, started: make(chan struct{}), written: make(chan string, 4)}
	s.opened <- stream
	return stream, nil
}

type libraryTerminalConn struct {
	in  chan []byte
	out chan []byte
}

func (c *libraryTerminalConn) ReadJSON(ctx context.Context, v any) error {
	select {
	case data := <-c.in:
		return json.Unmarshal(data, v)
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *libraryTerminalConn) WriteJSON(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	select {
	case c.out <- data:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (*libraryTerminalConn) Ping(context.Context) error { return nil }
func (*libraryTerminalConn) Close(string) error         { return nil }
func (c *libraryTerminalConn) send(t *testing.T, id, kind, data string) {
	t.Helper()
	msg, err := json.Marshal(map[string]string{"ch": "terminal", "id": id, "type": kind, "data": base64.StdEncoding.EncodeToString([]byte(data))})
	if err != nil {
		t.Fatal(err)
	}
	c.in <- msg
}
func (c *libraryTerminalConn) receive(t *testing.T, kind string) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case data := <-c.out:
			var msg struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &msg); err != nil {
				t.Fatal(err)
			}
			if msg.Type == kind {
				return
			}
		case <-deadline.C:
			t.Fatalf("terminal did not send %s", kind)
		}
	}
}

type libraryTerminalInput struct {
	service *Service
	id      domain.SessionID
}

func (l libraryTerminalInput) AcquireSessionInput(domain.SessionID) (func(), bool) {
	return l.service.AcquireTaskInput(l.id)
}

type libraryTerminalLifecycle struct {
	terminal  *terminal.Manager
	runtimeID string
	stop      func(context.Context, domain.SessionID) error
}

func (l libraryTerminalLifecycle) FenceLibraryInput(ctx context.Context, _ domain.SessionID) (func(), error) {
	return l.terminal.FenceLibraryInput(ctx, l.runtimeID)
}
func (l libraryTerminalLifecycle) StopLibraryRuntime(ctx context.Context, id domain.SessionID) error {
	return l.stop(ctx, id)
}

func newLibraryTerminal(t *testing.T, f *fixture, rec domain.SessionRecord, blocked bool) (*terminal.Manager, *libraryTerminalConn, *libraryTerminalStream, *libraryTerminalSource) {
	t.Helper()
	src := &libraryTerminalSource{t: t, blocked: blocked, opened: make(chan *libraryTerminalStream, 4)}
	mgr := terminal.NewManager(src, nil, nil, terminal.WithHeartbeat(0))
	mgr.SetSessionInputLease(libraryTerminalInput{service: f.svc, id: rec.ID})
	ctx, cancel := context.WithCancel(context.Background())
	conn := &libraryTerminalConn{in: make(chan []byte, 8), out: make(chan []byte, 16)}
	done := make(chan struct{})
	go func() { defer close(done); mgr.Serve(ctx, conn) }()
	t.Cleanup(func() {
		cancel()
		mgr.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("terminal connection did not stop")
		}
	})
	conn.send(t, rec.Metadata.RuntimeHandleID, "open", "")
	conn.receive(t, "opened")
	select {
	case stream := <-src.opened:
		return mgr, conn, stream, src
	case <-time.After(time.Second):
		t.Fatal("stream did not open")
		return nil, nil, nil, nil
	}
}

func TestTaskLibraryRevocationInterruptsBlockedTerminalWrite(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	mgr, conn, stream, _ := newLibraryTerminal(t, f, rec, true)
	stopped := false
	f.svc.SetTaskLibraryLifecycle(libraryTerminalLifecycle{terminal: mgr, runtimeID: rec.Metadata.RuntimeHandleID, stop: func(ctx context.Context, id domain.SessionID) error {
		state, err := f.store.ReadLibraryRegistry(ctx)
		if err != nil {
			return err
		}
		if state.Approvals[f.result.Approvals[0].ApprovalID].State != "revoked" {
			return errors.New("runtime stop overtook ledger commit")
		}
		stopped = true
		rec.IsTerminated = true
		return f.store.UpdateSession(ctx, rec)
	}})
	conn.send(t, rec.Metadata.RuntimeHandleID, "data", "blocked input")
	select {
	case <-stream.started:
	case <-time.After(time.Second):
		t.Fatal("PTY write did not block")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := f.svc.Operate(ctx, Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation stuck behind PTY write")
	}
	if !stopped {
		t.Fatal("runtime was not stopped")
	}
	conn.receive(t, "exited")
	if err := f.svc.CheckLaunch(context.Background(), rec.ID); reason(err) != "revoked" {
		t.Fatalf("revoked launch admitted: %v", err)
	}
}

func TestTaskLibraryDeniedRevocationReopensSameTerminalConnection(t *testing.T) {
	f, rec := pinnedTaskFixture(t)
	mgr, conn, _, src := newLibraryTerminal(t, f, rec, false)
	f.svc.SetTaskLibraryLifecycle(libraryTerminalLifecycle{terminal: mgr, runtimeID: rec.Metadata.RuntimeHandleID, stop: func(context.Context, domain.SessionID) error {
		t.Error("denied revocation stopped runtime")
		return nil
	}})
	checks := 0
	f.svc.policy = policyFunc(func(context.Context, PolicyRequest) (PolicyDecision, error) {
		checks++
		return PolicyDecision{State: "verified", Denied: checks > 1}, nil
	})
	_, err := f.svc.Operate(context.Background(), Operation{Operation: "revoke", ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision})
	if reason(err) != "policy_denied" {
		t.Fatal(err)
	}
	f.svc.policy = nil
	conn.receive(t, "exited")
	conn.send(t, rec.Metadata.RuntimeHandleID, "open", "")
	conn.receive(t, "opened")
	var reopened *libraryTerminalStream
	select {
	case reopened = <-src.opened:
	case <-time.After(time.Second):
		t.Fatal("replacement stream did not open")
	}
	conn.send(t, rec.Metadata.RuntimeHandleID, "data", "input after denial")
	select {
	case got := <-reopened.written:
		if got != "input after denial" {
			t.Fatalf("reopened input=%q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("reopened connection did not accept input")
	}
	// A live reopened input lease must drain for the next mutation, too.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	release, err := mgr.FenceLibraryInput(ctx, rec.Metadata.RuntimeHandleID)
	if release != nil {
		defer release()
	}
	if err != nil {
		t.Fatal(err)
	}
	state, err := f.store.ReadLibraryRegistry(context.Background())
	if err != nil || state.Approvals[f.result.Approvals[0].ApprovalID].State != "approved" {
		t.Fatalf("denied mutation changed approval: %v", err)
	}
}
