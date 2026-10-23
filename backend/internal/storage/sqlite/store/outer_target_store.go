package store

import (
	"context"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ResolveOuterTarget resolves sessions, Projects, runs, reviews, PRs and runtime aliases durably.
func (s *Store) ResolveOuterTarget(ctx context.Context, kind, id string) (domain.ProjectID, domain.SessionID, error) {
	switch kind {
	case "project":
		p, found, err := s.GetProject(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return domain.ProjectID(p.ID), "", nil
	case "session":
		r, found, err := s.GetSession(ctx, domain.SessionID(id))
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return r.ProjectID, r.ID, nil
	case "run":
		r, err := s.GetFactoryRun(ctx, id)
		if err != nil {
			return "", "", err
		}
		return domain.ProjectID(r.ProjectID), r.SessionID, nil
	case "review":
		r, found, err := s.GetReviewByID(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return r.ProjectID, r.SessionID, nil
	case "pr":
		r, found, err := s.GetPR(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found {
			if num, e := strconv.Atoi(id); e == nil {
				r, found, err = s.GetPRByNumber(ctx, num)
			}
		}
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return s.ResolveOuterTarget(ctx, "session", string(r.SessionID))
	case "terminal":
		owner, found, err := s.ResolveSessionInput(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found || owner == "" {
			return "", "", domain.ErrOuterHeld
		}
		return s.ResolveOuterTarget(ctx, "session", string(owner))
	default:
		return "", "", domain.ErrOuterHeld
	}
}
