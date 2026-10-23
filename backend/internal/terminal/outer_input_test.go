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
