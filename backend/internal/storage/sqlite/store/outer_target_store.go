package store

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ResolveOuterTarget resolves supported resources through their retained ownership.
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
	case "pr", "pr_url":
		r, found, err := s.GetPR(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found && kind == "pr" {
			if num, e := strconv.Atoi(id); e == nil {
				count, err := s.CountActivePRsByNumber(ctx, num)
				if err != nil {
					return "", "", err
				}
				if count > 1 {
					return "", "", domain.ErrOuterHeld
				}
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
	case "automation":
		r, found, err := s.GetAutomation(ctx, domain.AutomationID(id))
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return r.ProjectID, "", nil
	case "cue":
		r, found, err := s.SelectCueByID(ctx, domain.CueID(id))
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return r.ProjectID, "", nil
	case "report":
		r, found, err := s.GetReport(ctx, id)
		if err != nil {
			return "", "", err
		}
		if !found {
			return "", "", domain.ErrOuterHeld
		}
		return r.ProjectID, r.SessionID, nil
	case "awake":
		document, err := s.LoadAwake(ctx)
		if err != nil {
			return "", "", err
		}
		var state domain.AwakeDocument
		if json.Unmarshal([]byte(document), &state) != nil {
			return "", "", domain.ErrOuterHeld
		}
		for _, awake := range state.Sessions {
			if awake.ID == id {
				if awake.Scope == "session" {
					return s.ResolveOuterTarget(ctx, "session", awake.SessionID)
				}
				return "", "", nil
			}
		}
		return "", "", domain.ErrOuterHeld
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
