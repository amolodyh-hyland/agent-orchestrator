package library

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type taskLaunchLeaseKey struct{}
type taskLaunchLease struct {
	service  *Service
	snapshot domain.LibrarySnapshot
	active   atomic.Bool
}

func (s *Service) activeTaskLease(ctx context.Context, id domain.SessionID) (domain.LibrarySnapshot, bool) {
	lease, ok := ctx.Value(taskLaunchLeaseKey{}).(*taskLaunchLease)
	if !ok || lease.service != s || lease.snapshot.SessionID != id || !lease.active.Load() {
		return domain.LibrarySnapshot{}, false
	}
	return lease.snapshot, true
}

func (s *Service) AcquireTaskLaunch(ctx context.Context, id domain.SessionID) (context.Context, domain.LibrarySnapshot, func(), error) {
	if snapshot, ok := s.activeTaskLease(ctx, id); ok {
		return ctx, snapshot, func() {}, nil
	}
	if s.sessionRevoking(ctx, id) {
		return ctx, domain.LibrarySnapshot{}, nil, fail("revocation_in_progress")
	}
	s.admission.RLock()
	snapshot, admission, err := s.retained(ctx, id)
	if err == nil && !admission.InputAllowed {
		err = fail(admission.ReasonCode)
	}
	if err == nil && s.selectionRevoking(snapshot) {
		err = fail("revocation_in_progress")
	}
	if err != nil {
		s.admission.RUnlock()
		return ctx, snapshot, nil, err
	}
	snapshot.SessionID = id
	lease := &taskLaunchLease{service: s, snapshot: snapshot}
	lease.active.Store(true)
	var once sync.Once
	return context.WithValue(ctx, taskLaunchLeaseKey{}, lease), snapshot, func() { once.Do(func() { lease.active.Store(false); s.admission.RUnlock() }) }, nil
}
