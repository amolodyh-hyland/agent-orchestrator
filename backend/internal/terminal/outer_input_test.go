package terminal

import (
	"context"
	"encoding/base64"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type pendingWriterLibrary struct {
	sessionmanager.LibrarySelection
	admission    sync.RWMutex
	acquisitions atomic.Int32
}

func (l *pendingWriterLibrary) AcquireTaskInput(domain.SessionID) (func(), bool) {
	l.acquisitions.Add(1)
	l.admission.RLock()
	var once sync.Once
	return func() { once.Do(l.admission.RUnlock) }, true
}

func TestOuterTerminalFinalCheckDoesNotReacquireLibraryAdmission(t *testing.T) {
	ctx := context.Background()
	st := sqlitetest.MustOpen(t)
	now := time.Now()
	if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "ordinary", Kind: domain.ProjectKindScratch, RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	rec, err := st.CreateSession(ctx, domain.SessionRecord{ProjectID: "ordinary", Kind: domain.KindWorker, Mode: domain.SessionModeTUI, Harness: domain.HarnessCodex, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	sessions := sessionmanager.New(sessionmanager.Deps{Store: st, DataDir: t.TempDir()})
	library := &pendingWriterLibrary{}
	sessions.SetLibrarySelection(library)
	mgr := NewManager(nil, nil, testLogger())
	defer mgr.Close()
	mgr.SetSessionInputLease(sessions)
	release, ok := mgr.acquireTerminalInput(string(rec.ID), "")
	if !ok {
		t.Fatal("ordinary session input was held")
	}
	defer release()
	writerAcquired := make(chan struct{})
	writerRelease := make(chan struct{})
	var writerOnce sync.Once
	unblockWriter := func() { writerOnce.Do(func() { close(writerRelease) }) }
	defer unblockWriter()
	go func() {
		library.admission.Lock()
		close(writerAcquired)
		<-writerRelease
		library.admission.Unlock()
	}()
	// TryRLock fails only after the writer is waiting, since the first lease
	// prevents it from acquiring the lock. This makes the deadlock deterministic.
	eventually(t, time.Second, func() bool {
		if library.admission.TryRLock() {
			library.admission.RUnlock()
			return false
		}
		return true
	})
	pty := newFakePTY()
	a := newAttachment(string(rec.ID), ports.RuntimeHandle{ID: string(rec.ID)}, nil, nil, nil, nil, testLogger())
	a.pty, a.inputReady = pty, true
	a.inputAllowed = func() bool { return mgr.revalidateTerminalInput(string(rec.ID), "") }
	done := make(chan struct{})
	go func() {
		mgr.writeInput(string(rec.ID), a, []byte("ordinary input\r"), release)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		// Free both locks before failing, including on the old recursive path.
		release()
		unblockWriter()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("terminal write remained blocked after releasing admission")
		}
		t.Fatal("final authorization recursively acquired library admission")
	}
	if got := string(pty.writtenBytes()); got != "ordinary input\r" || library.acquisitions.Load() != 1 {
		t.Fatal("ordinary write did not use its single original lease", got, library.acquisitions.Load())
	}
	select {
	case <-writerAcquired:
	case <-time.After(time.Second):
		t.Fatal("completed write did not release the original lease")
	}
}

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
