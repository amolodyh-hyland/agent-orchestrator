package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

func callerVerifier(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// IssueOuterCaller issues a credential for the session’s currently owned launch.
func (s *Store) IssueOuterCaller(ctx context.Context, id domain.SessionID) (string, error) {
	r, found, err := s.GetSession(ctx, id)
	if err != nil || !found {
		return "", domain.ErrOuterHeld
	}
	kind, generation := "runtime", r.Metadata.RuntimeLaunchID
	if r.Mode == domain.SessionModeChat {
		kind, generation = "chat", r.Metadata.ControllerGeneration
	}
	return s.IssueOuterCallerGeneration(ctx, id, kind, generation)
}

func (s *Store) callerGeneration(r domain.SessionRecord, kind, generation string) string {
	return kind + ":" + domain.OuterDigest([]any{s.outerTerminalEpoch, r.CleanupGeneration, generation})
}

// IssueOuterCallerGeneration prepares a verifier for one explicitly owned launch generation.
// Called only from an owned launch/bootstrap, with the generation selected by
// that launch. The verifier becomes usable only after that owner is published.
func (s *Store) IssueOuterCallerGeneration(ctx context.Context, id domain.SessionID, kind, generation string) (string, error) {
	if (kind != "chat" && kind != "runtime") || generation == "" {
		return "", domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return "", err
	}
	r, found, err := s.GetSession(ctx, id)
	if err != nil {
		return "", err
	}
	if !found || r.IsTerminated {
		return "", domain.ErrOuterHeld
	}
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes[:])
	if err := s.writeMu.LockContext(ctx); err != nil {
		return "", err
	}
	defer s.writeMu.Unlock()
	err = s.inTx(ctx, "issue scoped caller", func(q *gen.Queries) error {
		if err := appendOuterAudit(ctx, q, domain.OuterAudit{Operation: "caller.owned_launch", State: "issued", SessionID: id, ProjectID: string(r.ProjectID), Generation: generation}); err != nil {
			return err
		}
		return q.IssueOuterCaller(ctx, gen.IssueOuterCallerParams{Verifier: callerVerifier(token), SessionID: string(id), ProjectID: string(r.ProjectID), Generation: s.callerGeneration(r, kind, generation), OuterScope: boolInt(string(r.ProjectID) == b.AnchorProjectID)})
	})
	return token, err
}

// CheckOuterReadCaller admits only the current outer owner to cross-project read projections.
func (s *Store) CheckOuterReadCaller(ctx context.Context, caller domain.OuterCaller) error {
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found || !caller.Outer || b.HistoryHeld || b.SessionID != caller.SessionID {
		return domain.ErrOuterHeld
	}
	r, found, err := s.GetSession(ctx, caller.SessionID)
	if err != nil || !found || r.IsTerminated || r.ProjectID != caller.ProjectID || string(r.ProjectID) != b.AnchorProjectID {
		return domain.ErrOuterHeld
	}
	kind, generation := "runtime", r.Metadata.RuntimeLaunchID
	if r.Mode == domain.SessionModeChat {
		kind, generation = "chat", r.Metadata.ControllerGeneration
	}
	if s.callerGeneration(r, kind, generation) != caller.Generation {
		return domain.ErrOuterHeld
	}
	return nil
}

// AuthenticateOuterCaller rejects stale, purpose-mismatched or incorrectly owned credentials.
func (s *Store) AuthenticateOuterCaller(ctx context.Context, token string) (domain.OuterCaller, error) {
	if len(token) != 43 {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	row, err := s.qr.GetOuterCaller(ctx, callerVerifier(token))
	if err != nil {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	r, found, err := s.GetSession(ctx, domain.SessionID(row.SessionID))
	if err != nil {
		return domain.OuterCaller{}, err
	}
	kind, generation := "runtime", r.Metadata.RuntimeLaunchID
	if r.Mode == domain.SessionModeChat {
		kind, generation = "chat", r.Metadata.ControllerGeneration
	}
	if !found || r.IsTerminated || string(r.ProjectID) != row.ProjectID || !strings.HasPrefix(row.Generation, kind+":") || s.callerGeneration(r, kind, generation) != row.Generation {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	b, found, err := s.OuterBinding(ctx)
	if err != nil || !found {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	outer := string(r.ProjectID) == b.AnchorProjectID
	if outer != (row.OuterScope != 0) {
		return domain.OuterCaller{}, domain.ErrOuterHeld
	}
	return domain.OuterCaller{ProjectID: r.ProjectID, SessionID: r.ID, Generation: row.Generation, Outer: outer}, nil
}

// OuterCallerState reports whether project-local commands need an owned relaunch.
func (s *Store) OuterCallerState(ctx context.Context, id domain.SessionID) (string, error) {
	r, found, err := s.GetSession(ctx, id)
	if err != nil {
		return "", err
	}
	if !found {
		return "", domain.ErrOuterHeld
	}
	kind, generation := "runtime", r.Metadata.RuntimeLaunchID
	if r.Mode == domain.SessionModeChat {
		kind, generation = "chat", r.Metadata.ControllerGeneration
	}
	count, err := s.qr.CountOuterLiveCallers(ctx, gen.CountOuterLiveCallersParams{SessionID: string(id), Generation: s.callerGeneration(r, kind, generation)})
	if err != nil {
		return "", err
	}
	if count == 0 {
		return "owned_relaunch_required", nil
	}
	return "scoped", nil
}
