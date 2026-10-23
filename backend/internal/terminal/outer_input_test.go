package terminal

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestOuterMuxRejectsInputOnPreexistingAndReconnectedAttachments(t *testing.T) {
	for _, handle := range []string{"p-1", "opaque-runtime", "ptyhost-v1:opaque-runtime"} {
		t.Run(handle, func(t *testing.T) {
			ctx := context.Background()
			st := sqlitetest.MustOpen(t)
			now := time.Now()
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Kind: domain.ProjectKindScratch, RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			r, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeTUI, Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{RuntimeHandleID: "opaque-runtime"}, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			pty := newFakePTY()
			mgr := NewManager(&fakeSource{alive: true, spawner: &fakeSpawner{ptys: []*fakePTY{pty}}}, nil, testLogger(), WithHeartbeat(0))
			defer mgr.Close()
			mgr.SetSessionInputLease(sessionmanager.New(sessionmanager.Deps{Store: st, DataDir: t.TempDir()}))
			serveCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			conn := newFakeConn()
			go mgr.Serve(serveCtx, conn)
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgOpen}
			recv(t, conn, chTerminal, msgOpened, time.Second)
			if err := st.SaveOuterBinding(ctx, domain.OuterBinding{AnchorProjectID: "p", SessionID: r.ID, Revision: 1}, 0, domain.OuterAudit{Operation: "setup", State: "recorded"}); err != nil {
				t.Fatal(err)
			}
			for _, raw := range []string{"human approved\r", "\x1b[200~paste\x1b[201~\r"} {
				conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgData, Data: base64.StdEncoding.EncodeToString([]byte(raw))}
				recv(t, conn, chTerminal, msgError, time.Second)
			}
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgClose}
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgOpen}
			recv(t, conn, chTerminal, msgOpened, time.Second)
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgData, Data: base64.StdEncoding.EncodeToString([]byte("reconnected\r"))}
			recv(t, conn, chTerminal, msgError, time.Second)
			if len(pty.writtenBytes()) != 0 {
				t.Fatalf("outer received runtime bytes: %q", pty.writtenBytes())
			}
		})
	}
}

func TestOuterFinalAttachmentWriteRechecksBufferedInput(t *testing.T) {
	pty := newFakePTY()
	a := newAttachment("runtime", ports.RuntimeHandle{ID: "runtime"}, nil, nil, nil, nil, testLogger())
	allowed := true
	a.inputAllowed = func() bool { return allowed }
	released := false
	if err := a.writeLeased([]byte("buffered\r"), func() { released = true }); err != nil {
		t.Fatal(err)
	}
	allowed = false
	a.setPTY(pty)
	if !released || len(pty.writtenBytes()) != 0 {
		t.Fatal("buffered input crossed final ownership barrier")
	}
}

func TestOuterScopedNativeTerminalWritesAndRevokesExistingAttachment(t *testing.T) {
	ctx := context.Background()
	st := sqlitetest.MustOpen(t)
	now := time.Now()
	for _, id := range []string{"anchor", "selected"} {
		if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: id, Kind: domain.ProjectKindScratch, RegisteredAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	r, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "selected", Kind: domain.KindWorker, Mode: domain.SessionModeTUI, Harness: domain.HarnessCodex, Activity: domain.Activity{State: domain.ActivityIdle}, Metadata: domain.SessionMetadata{RuntimeHandleID: "owned-runtime", RuntimeLaunchID: "launch-1"}, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	b := domain.OuterBinding{AnchorProjectID: "anchor", ProjectIDs: []string{"selected"}, Revision: 1, ScopeRevision: 1}
	if err := st.SaveOuterBinding(ctx, b, 0, domain.OuterAudit{Operation: "setup"}); err != nil {
		t.Fatal(err)
	}
	token, err := st.IssueOuterTerminal(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "terminal.bind", ProjectID: r.ProjectID, SessionID: r.ID}), r.Metadata.RuntimeHandleID)
	if err != nil {
		t.Fatal(err)
	}
	pty := newFakePTY()
	mgr := NewManager(&fakeSource{alive: true, spawner: &fakeSpawner{ptys: []*fakePTY{pty}}}, nil, testLogger(), WithHeartbeat(0))
	defer mgr.Close()
	mgr.SetSessionInputLease(sessionmanager.New(sessionmanager.Deps{Store: st, DataDir: t.TempDir()}))
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn := newFakeConn()
	go mgr.Serve(serveCtx, conn)
	conn.in <- clientMsg{Ch: chTerminal, ID: "owned-runtime", Type: msgOpen, Authority: token}
	recv(t, conn, chTerminal, msgOpened, time.Second)
	conn.in <- clientMsg{Ch: chTerminal, ID: "owned-runtime", Type: msgData, Authority: token, Data: base64.StdEncoding.EncodeToString([]byte("allowed\r"))}
	eventually(t, time.Second, func() bool { return string(pty.writtenBytes()) == "allowed\r" })
	b.Revision++
	b.ScopeRevision++
	if err := st.SaveOuterBinding(ctx, b, 1, domain.OuterAudit{Operation: "scope"}); err != nil {
		t.Fatal(err)
	}
	conn.in <- clientMsg{Ch: chTerminal, ID: "owned-runtime", Type: msgData, Authority: token, Data: base64.StdEncoding.EncodeToString([]byte("revoked\r"))}
	recv(t, conn, chTerminal, msgError, time.Second)
	if got := string(pty.writtenBytes()); got != "allowed\r" {
		t.Fatal("revoked terminal wrote bytes", got)
	}
}
