package terminal

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestFactoryLiveReviewerMuxInputUsesPersistedWorker(t *testing.T) {
	for _, form := range []string{"reviewer", "wrapped_reviewer", "opaque_reviewer"} {
		t.Run(form, func(t *testing.T) {
			ctx := context.Background()
			st := sqlitetest.MustOpen(t)
			now := time.Now().UTC()
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: t.TempDir(), RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			worker, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessCodex, Mode: domain.SessionModeTUI, CreatedAt: now, UpdatedAt: now})
			if err != nil {
				t.Fatal(err)
			}
			handle := "review-" + string(worker.ID)
			if form == "wrapped_reviewer" {
				handle = "ptyhost-v1:" + handle
			}
			if form == "opaque_reviewer" {
				handle = "persisted-review-runtime"
			}
			if err := st.UpsertReview(ctx, domain.Review{ID: "review", SessionID: worker.ID, ProjectID: "p", Harness: domain.ReviewerCodex, ReviewerHandleID: handle, InterfaceMode: domain.ReviewerInterfaceTUI, CreatedAt: now, UpdatedAt: now}); err != nil {
				t.Fatal(err)
			}
			pty := newFakePTY()
			mgr := NewManager(&fakeSource{alive: true, spawner: &fakeSpawner{ptys: []*fakePTY{pty}}}, nil, testLogger(), WithHeartbeat(0))
			mgr.SetSessionInputLease(sessionmanager.New(sessionmanager.Deps{Store: st, DataDir: t.TempDir()}))
			defer mgr.Close()
			conn := newFakeConn()
			serveCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			go mgr.Serve(serveCtx, conn)
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgOpen}
			recv(t, conn, chTerminal, msgOpened, time.Second)
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgData, Data: base64.StdEncoding.EncodeToString([]byte("before enrollment\n"))}
			deadline := time.Now().Add(time.Second)
			for string(pty.writtenBytes()) != "before enrollment\n" {
				if time.Now().After(deadline) {
					t.Fatal("unrelated reviewer input did not reach its live pane")
				}
				time.Sleep(time.Millisecond)
			}
			run := domain.FactoryRun{ID: "factory", ProjectID: "p", SessionID: worker.ID, Stage: "implementation", CreatedAt: now}
			if err := st.SaveFactoryRun(ctx, run, domain.RunEvidence{ID: "approved", RunID: run.ID, Kind: "created", Confirmed: true, RecordedAt: now}, true); err != nil {
				t.Fatal(err)
			}
			conn.in <- clientMsg{Ch: chTerminal, ID: handle, Type: msgData, Data: base64.StdEncoding.EncodeToString([]byte("review findings\n"))}
			held := recv(t, conn, chTerminal, msgError, time.Second)
			if held.ID != handle {
				t.Fatalf("held wrong terminal: %+v", held)
			}
			if got := string(pty.writtenBytes()); got != "before enrollment\n" {
				t.Fatalf("enrolled reviewer submitted another turn: %q", got)
			}
		})
	}
}
