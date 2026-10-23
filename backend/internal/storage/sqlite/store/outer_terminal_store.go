package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// A terminal grant shares credential storage, but its purpose-bound generation
// cannot authenticate as a CLI caller. It names one actual runtime launch and
// is invalidated by scope changes and daemon restart.
func (s *Store) terminalGrantGeneration(r domain.SessionRecord, b domain.OuterBinding, handle string) string {
	return "terminal:" + domain.OuterDigest([]any{s.outerTerminalEpoch, handle, r.Metadata.RuntimeLaunchID, r.CleanupGeneration, b.ScopeRevision})
}

func (s *Store) outerTerminalOwner(ctx context.Context, handle string) (domain.SessionRecord, domain.OuterBinding, error) {
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return domain.SessionRecord{}, b, domain.ErrOuterHeld
	}
	id, found, err := s.ResolveSessionInput(ctx, handle)
	if err != nil || !found {
		return domain.SessionRecord{}, b, domain.ErrOuterHeld
	}
	r, found, err := s.GetSession(ctx, id)
	if err != nil || !found || r.IsTerminated || string(r.ProjectID) == b.AnchorProjectID || r.Metadata.RuntimeHandleID != handle || r.Metadata.RuntimeLaunchID == "" {
		return r, b, domain.ErrOuterHeld
	}
	if err := domain.CheckFactoryFeedback(ctx, s, id); err != nil {
		return r, b, err
	}
	p, found, err := s.GetProject(ctx, string(r.ProjectID))
	if err != nil || !found || !p.ArchivedAt.IsZero() {
		return r, b, domain.ErrOuterHeld
	}
	return r, b, nil
}

func (s *Store) IssueOuterTerminal(ctx context.Context, handle string) (string, error) {
	a, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || a.Operation != "terminal.bind" {
		return "", domain.ErrOuterHeld
	}
	r, b, err := s.outerTerminalOwner(ctx, handle)
	if err != nil || a.SessionID != r.ID || a.ProjectID != r.ProjectID {
		return "", domain.ErrOuterHeld
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	if err := s.writeMu.LockContext(ctx); err != nil {
		return "", err
	}
	defer s.writeMu.Unlock()
	err = s.inTx(ctx, "bind native terminal", func(q *gen.Queries) error {
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "terminal.bind", State: "issued", SessionID: r.ID, ProjectID: string(r.ProjectID), Generation: r.Metadata.RuntimeLaunchID}); err != nil {
			return err
		}
		return q.IssueOuterCaller(ctx, gen.IssueOuterCallerParams{Verifier: callerVerifier(token), SessionID: string(r.ID), ProjectID: string(r.ProjectID), Generation: s.terminalGrantGeneration(r, b, handle)})
	})
	return token, err
}

func (s *Store) AuthenticateOuterTerminal(ctx context.Context, handle, token string) (domain.OuterNativeAction, error) {
	if len(token) != 43 {
		return domain.OuterNativeAction{}, domain.ErrOuterHeld
	}
	r, b, err := s.outerTerminalOwner(ctx, handle)
	if err != nil {
		return domain.OuterNativeAction{}, err
	}
	grant, err := s.qr.GetOuterCaller(ctx, callerVerifier(token))
	if err != nil || grant.SessionID != string(r.ID) || grant.ProjectID != string(r.ProjectID) || grant.OuterScope != 0 || grant.Generation != s.terminalGrantGeneration(r, b, handle) {
		return domain.OuterNativeAction{}, domain.ErrOuterHeld
	}
	return domain.OuterNativeAction{Operation: "terminal.write", ProjectID: r.ProjectID, SessionID: r.ID, Generation: r.Metadata.RuntimeLaunchID}, nil
}
