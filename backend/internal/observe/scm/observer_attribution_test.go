package scm

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

// Model real conditional requests: an acknowledged ETag returns 304, and an
// incremental cursor excludes PRs last updated before it.
type discoveryRecoveryProvider struct {
	*fakeProvider
	listedAfter []time.Time
	guardETags  []string
}

func (p *discoveryRecoveryProvider) RepoPRListGuard(_ context.Context, _ ports.SCMRepo, etag string) (ports.SCMGuardResult, error) {
	p.guardETags = append(p.guardETags, etag)
	return ports.SCMGuardResult{ETag: "v2", NotModified: etag == "v2"}, nil
}

func (p *discoveryRecoveryProvider) ListPRsByRepo(ctx context.Context, repo ports.SCMRepo, after time.Time) ([]ports.SCMPRObservation, error) {
	p.listedAfter = append(p.listedAfter, after)
	prs, err := p.fakeProvider.ListPRsByRepo(ctx, repo, after)
	var out []ports.SCMPRObservation
	for _, pr := range prs {
		if after.IsZero() || !pr.UpdatedAtProvider.Before(after) {
			out = append(out, pr)
		}
	}
	return out, err
}

func TestPoll_IdentityRecoveryRetriesMissedDiscoveries(t *testing.T) {
	for _, initialETag := range []string{"", "v1", "v2"} {
		t.Run("initial ETag="+initialETag, func(t *testing.T) {
			store := testStoreWithSession()
			store.prs["p-1"] = []domain.PullRequest{knownPR(1)}
			now := time.Unix(1_800_000_000, 0).UTC()
			existing := testObs(1)
			existing.PR.Merged, existing.PR.State = true, "merged"
			missed := testObs(2)
			missed.PR.Author, missed.PR.HeadRepo = "alice", "o/r"
			missed.PR.UpdatedAtProvider = now.Add(-2 * time.Hour)
			provider := &discoveryRecoveryProvider{fakeProvider: &fakeProvider{
				identityErr:  errors.New("identity temporarily unavailable"),
				openPRs:      map[string][]ports.SCMPRObservation{prKey(testRepo, 0): {missed.PR}},
				observations: map[string]ports.SCMObservation{prKey(testRepo, 1): existing, prKey(testRepo, 2): missed},
			}}
			obs := New(provider, store, &fakeLifecycle{}, Config{Logger: quietSlog(), Clock: func() time.Time { return now }, ScopedIdentityResolver: provider})
			key := prKey(testRepo, 0)
			if initialETag != "" {
				obs.cacheSetString(obs.Cache.RepoPRListETag, &obs.Cache.repoOrder, key, initialETag)
				obs.Cache.LastSyncCursor[key] = now.Add(-time.Hour)
			}
			if err := obs.Poll(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(store.writes) == 0 || !store.writes[0].pr.Merged {
				t.Fatal("existing PR did not refresh during identity outage")
			}
			if obs.Cache.RepoPRListETag[key] != "" || !obs.Cache.LastSyncCursor[key].IsZero() {
				t.Fatal("successful existing PR refresh acknowledged incomplete discovery")
			}
			now = now.Add(time.Hour) // beyond the five-minute overlap
			provider.identityErr = nil
			provider.identity = ports.SCMIdentity{Login: "alice", Human: true}
			if err := obs.Poll(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(provider.listedAfter) != 1 || !provider.listedAfter[0].IsZero() || provider.guardETags[1] != "" {
				t.Fatalf("recovery did not retry full listing: cursors=%v etags=%v", provider.listedAfter, provider.guardETags)
			}
			found := false
			for _, write := range store.writes {
				if write.pr.Number == 2 {
					found = true
				}
			}
			if !found {
				t.Fatal("missed PR was not discovered after identity recovered")
			}
			if obs.Cache.RepoPRListETag[key] != "v2" || !obs.Cache.LastSyncCursor[key].Equal(now) {
				t.Fatal("successful recovery did not advance discovery cache")
			}
		})
	}
}

func TestPoll_ExistingAndExplicitAttachmentsStayStable(t *testing.T) {
	ctx := context.Background()
	store := sqlitetest.MustOpen(t)
	now := time.Unix(1_800_000_000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: t.TempDir(), RepoOriginURL: "https://github.com/o/r.git", RegisteredAt: now}); err != nil {
		t.Fatal(err)
	}
	owner, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessFake,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{Branch: "feat/root", WorkspacePath: t.TempDir()},
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	// An older association no longer matches the owner's namespace. A second
	// session now exactly matches both branches; discovery must not take over.
	other := owner
	other.ID = ""
	other.Metadata.Branch = "renamed"
	other, err = store.CreateSession(ctx, other)
	if err != nil {
		t.Fatal(err)
	}
	pr := domain.PullRequest{URL: "https://github.com/o/r/pull/1", SessionID: owner.ID, Number: 1, Provider: "github", Host: "github.com", Repo: "o/r", SourceBranch: "feat/child", Author: "former-account", UpdatedAt: now}
	if err := store.WriteSCMObservation(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve); err != nil {
		t.Fatal(err)
	}
	pr.URL, pr.Number = "https://github.com/o/r/pull/2", 2
	pr.Author = "someone-else"
	if _, err := store.ClaimPR(ctx, pr, nil, nil, nil, nil, ports.ReviewWritePreserve, false); err != nil {
		t.Fatal(err)
	}
	for i, identity := range []ports.SCMIdentity{{Login: "original", Human: true}, {Login: "new-account", Human: true}, {}, {Login: "bot", Human: false}} {
		now = now.Add(time.Hour)
		provider := &fakeProvider{identity: identity, observations: map[string]ports.SCMObservation{}, openPRs: map[string][]ports.SCMPRObservation{}}
		for _, num := range []int{1, 2} {
			observed := testObs(num)
			observed.PR.SourceBranch, observed.PR.HeadRepo = "renamed", "o/r"
			observed.PR.Author = "new-account"
			observed.PR.Title = now.String()
			observed.Review.Decision = "approved"
			if i == 3 {
				observed.PR.Merged, observed.PR.State = true, "merged"
			}
			provider.observations[prKey(testRepo, num)] = observed
			if !observed.PR.Merged {
				provider.openPRs[prKey(testRepo, 0)] = append(provider.openPRs[prKey(testRepo, 0)], observed.PR)
			}
		}
		// Recreate the observer to prove ownership is durable, not cache state.
		obs := New(provider, store, nil, Config{Logger: quietSlog(), Clock: func() time.Time { return now }, ScopedIdentityResolver: provider})
		if err := obs.Poll(ctx); err != nil {
			t.Fatal(err)
		}
		got, err := store.ListPRsBySession(ctx, owner.ID)
		if err != nil || len(got) != 2 {
			t.Fatalf("attachments changed: %+v, %v", got, err)
		}
		for _, attached := range got {
			if attached.SourceBranch != "renamed" || attached.CI != domain.CIPassing || attached.Merged != (i == 3) || attached.Title != now.String() || attached.Review != domain.ReviewApproved {
				t.Fatalf("existing attachment failed to refresh: %+v", attached)
			}
		}
		if got, err := store.ListPRsBySession(ctx, other.ID); err != nil || len(got) != 0 {
			t.Fatalf("attachment reassigned to matching session: %+v, %v", got, err)
		}
	}
}

// racingProjectStore commits a competing write right after discovery reads the
// project, i.e. before the origin backfill's Git probe result is persisted.
type racingProjectStore struct {
	Store
	after func()
}

func (s *racingProjectStore) GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error) {
	row, ok, err := s.Store.GetProject(ctx, id)
	if s.after != nil {
		after := s.after
		s.after = nil
		after()
	}
	return row, ok, err
}

func TestDiscoverSubjects_OriginBackfillKeepsConcurrentInstructions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	if out, err := exec.Command("git", "-C", dir, "remote", "add", "origin", "https://github.com/o/r.git").CombinedOutput(); err != nil {
		t.Fatalf("git remote add: %v (%s)", err, out)
	}
	store := sqlitetest.MustOpen(t)
	now := time.Unix(1_800_000_000, 0).UTC()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: dir, RegisteredAt: now, Revision: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessFake,
		Activity:  domain.Activity{State: domain.ActivityActive, LastActivityAt: now},
		Metadata:  domain.SessionMetadata{Branch: "feat", WorkspacePath: t.TempDir()},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	newer := domain.ProjectInstructions{Shared: "newer"}
	racing := &racingProjectStore{Store: store}
	racing.after = func() {
		if ok, err := store.UpdateProjectSettings(ctx, "p", "p", domain.ProjectConfig{}, &newer, 1); err != nil || !ok {
			t.Errorf("concurrent instructions update ok=%v err=%v", ok, err)
		}
	}
	provider := &fakeProvider{}
	obs := New(provider, racing, nil, Config{Logger: quietSlog(), Clock: func() time.Time { return now }, ScopedIdentityResolver: provider})
	if _, _, err := obs.discoverSubjects(ctx); err != nil {
		t.Fatalf("discoverSubjects: %v", err)
	}
	got, ok, err := store.GetProject(ctx, "p")
	if err != nil || !ok {
		t.Fatalf("get project: ok=%v err=%v", ok, err)
	}
	if got.RepoOriginURL != "https://github.com/o/r.git" || !reflect.DeepEqual(got.Instructions, newer) || got.Revision != 3 {
		t.Fatalf("project after backfill = origin %q instructions %#v revision %d, want origin set, newer instructions, revision 3", got.RepoOriginURL, got.Instructions, got.Revision)
	}
}
