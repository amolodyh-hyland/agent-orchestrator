package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type notificationFixture struct {
	orgID, userID, projectID, sessionID, workerID string
	epoch                                         int64
}

func TestNotificationAcceptIsIdempotentAndFencesWorkerEpoch(t *testing.T) {
	store, admin, fixture := openNotificationTestStore(t)
	ctx := context.Background()
	event := domain.AgentNotificationEvent{
		EventID:    "evt_01KNOTIFICATION",
		Type:       domain.NotificationTypeNeedsInput,
		OccurredAt: time.Now().UTC().Truncate(time.Second),
		Payload:    json.RawMessage(`{"activityId":"tool-1"}`),
	}

	accepted, err := store.AcceptNotificationEvent(ctx, fixture.orgID, fixture.sessionID, fixture.workerID, fixture.epoch, event)
	if err != nil {
		t.Fatalf("first accept: %v", err)
	}
	if accepted.Duplicate {
		t.Fatal("first accept reported a duplicate")
	}

	duplicate, err := store.AcceptNotificationEvent(ctx, fixture.orgID, fixture.sessionID, fixture.workerID, fixture.epoch, event)
	if err != nil {
		t.Fatalf("duplicate accept: %v", err)
	}
	if !duplicate.Duplicate || duplicate.IngressID != accepted.IngressID {
		t.Fatalf("duplicate accept = %+v, first = %+v", duplicate, accepted)
	}

	mismatched := event
	mismatched.Payload = json.RawMessage(`{"activityId":"tool-2"}`)
	if _, err := store.AcceptNotificationEvent(ctx, fixture.orgID, fixture.sessionID, fixture.workerID, fixture.epoch, mismatched); !errors.Is(err, ErrIdempotencyMismatch) {
		t.Fatalf("mismatched duplicate error = %v, want ErrIdempotencyMismatch", err)
	}

	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.org_id', $1, true)`, fixture.orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE ao_worker_connections SET disconnected_at = now() WHERE session_id = $1 AND epoch = $2`, fixture.sessionID, fixture.epoch); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	stale := event
	stale.EventID = "evt_01KSTALE"
	if _, err := store.AcceptNotificationEvent(ctx, fixture.orgID, fixture.sessionID, fixture.workerID, fixture.epoch, stale); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("stale worker error = %v, want ErrStaleWorker", err)
	}
}

func TestNotificationInboxIsRecipientScopedAndCursorOrdered(t *testing.T) {
	store, admin, fixture := openNotificationTestStore(t)
	ctx := context.Background()
	principal := domain.Principal{UserID: fixture.userID, Provider: "local"}
	for index, eventID := range []string{"evt_01KFIRST", "evt_01KSECOND"} {
		ingress, err := store.AcceptNotificationEvent(ctx, fixture.orgID, fixture.sessionID, fixture.workerID, fixture.epoch, domain.AgentNotificationEvent{
			EventID: eventID, Type: domain.NotificationTypeNeedsInput,
			OccurredAt: time.Now().UTC(), Payload: json.RawMessage(`{"activityId":"activity-` + eventID + `"}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('ao.service', 'control-plane', true)`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ao_notification_ingress
			SET status = 'claimed', lease_owner = 'test', lease_until = now() + interval '1 minute'
			WHERE id = $1`, ingress.IngressID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		_, changed, err := store.CreateNotificationFromIngress(ctx, domain.NotificationIngress{
			ID: ingress.IngressID, OrgID: fixture.orgID, ProjectID: fixture.projectID,
			SessionID: fixture.sessionID, RecipientUserID: fixture.userID, WorkerID: fixture.workerID,
			WorkerEpoch: fixture.epoch, Event: domain.AgentNotificationEvent{EventID: eventID}, LeaseOwner: "test",
		}, domain.Notification{
			OrgID: fixture.orgID, RecipientUserID: fixture.userID, ProjectID: fixture.projectID,
			SessionID: fixture.sessionID, Source: "cloud", Type: "needs_input",
			Title: "Agent needs input", Body: "", DedupeKey: "needs-input:" + eventID,
			Status: string(domain.NotificationStatusUnread), EventID: eventID, Metadata: json.RawMessage(`{}`),
		})
		if err != nil || !changed {
			t.Fatalf("create notification %d: changed=%v err=%v", index, changed, err)
		}
	}

	page, err := store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Status: domain.NotificationStatusUnread, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.HasMore || page.NextCursor == nil || page.UnreadCount != 2 {
		t.Fatalf("first page = %+v", page)
	}
	second, err := store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Status: domain.NotificationStatusUnread, Cursor: page.NextCursor, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].ID == page.Items[0].ID {
		t.Fatalf("second page = %+v, first page = %+v", second, page)
	}

	otherPrincipal := domain.Principal{UserID: uuid.NewString(), Provider: "local"}
	if _, err := store.ListNotifications(ctx, otherPrincipal, fixture.orgID, domain.NotificationFilter{Limit: 20}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("other recipient error = %v, want ErrForbidden", err)
	}
}

func openNotificationTestStore(t *testing.T) (*Store, *pgxpool.Pool, notificationFixture) {
	t.Helper()
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set; skipping PostgreSQL notification integration test")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	t.Cleanup(admin.Close)

	fixture := notificationFixture{
		orgID: uuid.NewString(), userID: uuid.NewString(), projectID: uuid.NewString(),
		sessionID: uuid.NewString(), workerID: "worker-" + uuid.NewString(), epoch: 41,
	}
	if _, err := admin.Exec(ctx, `INSERT INTO ao_users (
		id, auth_provider, external_user_id, email, display_name, password_hash
	) VALUES ($1::uuid, 'local', $1::uuid::text, $1::uuid::text || '@example.test',
		'Notification Test', 'hash')`, fixture.userID); err != nil {
		t.Fatalf("seed notification user: %v", err)
	}
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO ao_organizations (id, auth_provider, slug, display_name, kind, owner_user_id, created_by_user_id)
			VALUES ($1, 'local', $2, 'Notification Test', 'personal', $3, $3)`, []any{fixture.orgID, "notif-" + uuid.NewString(), fixture.userID}},
		{`INSERT INTO ao_org_memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, []any{fixture.orgID, fixture.userID}},
		{`INSERT INTO ao_projects (id, org_id, display_name, repository_url) VALUES ($1, $2, 'Project', $3)`, []any{fixture.projectID, fixture.orgID, "https://example.test/" + fixture.projectID}},
		{`INSERT INTO ao_sessions (id, org_id, project_id, kind, harness, display_name, branch, created_by_user_id)
			VALUES ($1, $2, $3, 'worker', 'codex', 'Session', 'main', $4)`, []any{fixture.sessionID, fixture.orgID, fixture.projectID, fixture.userID}},
		{`INSERT INTO ao_sandboxes (session_id, org_id, provider) VALUES ($1, $2, 'docker')`, []any{fixture.sessionID, fixture.orgID}},
		{`INSERT INTO ao_worker_connections (session_id, org_id, sandbox_id, epoch, worker_id, version)
			VALUES ($1, $2, $1, $3, $4, 'test')`, []any{fixture.sessionID, fixture.orgID, fixture.epoch, fixture.workerID}},
	}
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`, fixture.userID, fixture.orgID); err != nil {
		t.Fatal(err)
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed notification fixture statement %d: %v", index, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit notification fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		cleanupTx, err := admin.Begin(cleanupCtx)
		if err == nil {
			_, _ = cleanupTx.Exec(cleanupCtx, `SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`, fixture.userID, fixture.orgID)
			_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM ao_organizations WHERE id = $1`, fixture.orgID)
			_ = cleanupTx.Commit(cleanupCtx)
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM ao_users WHERE id = $1`, fixture.userID)
	})
	return store, admin, fixture
}

func TestNotificationReadEventsAndPagedBoundaries(t *testing.T) {
	store, admin, fixture := openNotificationTestStore(t)
	ctx := context.Background()
	principal := domain.Principal{UserID: fixture.userID, Provider: "local"}
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	seed := func(i int) string {
		t.Helper()
		id := uuid.NewString()
		_, err := admin.Exec(ctx, `INSERT INTO ao_notifications
   (id, org_id, recipient_user_id, project_id, session_id, type, title, dedupe_key, source_event_id, created_at, updated_at)
   VALUES ($1::uuid, $2, $3, $4, $5, 'needs_input', 'Needs input', $1::uuid::text, $1::uuid::text, $6, $6)`,
			id, fixture.orgID, fixture.userID, fixture.projectID, fixture.sessionID, base.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	var boundary domain.NotificationCursor
	for i := 0; i < 150; i++ {
		id := seed(i)
		if i == 99 {
			boundary = domain.NotificationCursor{ID: id, CreatedAt: base.Add(99 * time.Second)}
		}
	}
	page, err := store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Limit: 100})
	if err != nil || len(page.Items) != 100 || page.UnreadCount != 150 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	// A new arrival after the row's menu opens is newer than the captured boundary.
	watermarkID := seed(150)
	changed, err := store.MarkNotificationsRead(ctx, principal, fixture.orgID, nil, boundary)
	if err != nil || changed.Updated != 100 {
		t.Fatalf("changed=%+v err=%v", changed, err)
	}
	events, more, err := store.ListNotificationEvents(ctx, principal, fixture.orgID, 0, 200)
	if err != nil || more || len(events) != 100 {
		t.Fatalf("events=%d more=%v err=%v", len(events), more, err)
	}
	for _, event := range events {
		if event.RecipientUserID != fixture.userID || event.Kind != domain.NotificationEventUpdated || event.Notification.Status != "read" {
			t.Fatalf("event=%+v", event)
		}
		if event.Notification.CreatedAt.After(boundary.CreatedAt) {
			t.Fatalf("newer row read: %+v", event)
		}
	}
	// One recipient's durable stream must never leak to another recipient.
	outsider, _, err := store.ListNotificationEvents(ctx, domain.Principal{UserID: uuid.NewString()}, fixture.orgID, 0, 200)
	if err == nil && len(outsider) != 0 {
		t.Fatalf("recipient isolation failed: %+v", outsider)
	}
	watermark := base.Add(150 * time.Second)
	for i := 151; i <= 300; i++ {
		seed(i)
	}
	page, err = store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Limit: 100, SeenAt: watermark})
	// The watermark row is unread too; passing its id below excludes that tie.
	if err != nil || page.UnreadCount != 151 {
		t.Fatalf("unseen=%d err=%v", page.UnreadCount, err)
	}
	page, err = store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Limit: 1, SeenAt: watermark, SeenIDs: []string{watermarkID}})
	if err != nil || len(page.Items) != 1 || page.UnreadCount != 150 {
		t.Fatalf("unseen=%d rows=%d err=%v", page.UnreadCount, len(page.Items), err)
	}
}

func TestNotificationReadBoundaryKeepsEqualItemOnNewerHost(t *testing.T) {
	store, admin, fixture := openNotificationTestStore(t)
	ctx := context.Background()
	principal := domain.Principal{UserID: fixture.userID, Provider: "local"}
	at := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	ids := []string{uuid.NewString(), uuid.NewString()}
	if ids[0] > ids[1] {
		ids[0], ids[1] = ids[1], ids[0]
	}
	for _, id := range ids {
		_, err := admin.Exec(ctx, `INSERT INTO ao_notifications
   (id, org_id, recipient_user_id, project_id, session_id, type, title, dedupe_key, source_event_id, created_at, updated_at)
   VALUES ($1::uuid, $2, $3, $4, $5, 'needs_input', 'Needs input', $1::uuid::text, $1::uuid::text, $6, $6)`, id, fixture.orgID, fixture.userID, fixture.projectID, fixture.sessionID, at)
		if err != nil {
			t.Fatal(err)
		}
	}
	changed, err := store.MarkNotificationsRead(ctx, principal, fixture.orgID, nil, domain.NotificationCursor{ID: ids[1], CreatedAt: at, ExcludeEqual: true})
	if err != nil || changed.Updated != 1 {
		t.Fatalf("changed=%+v err=%v", changed, err)
	}
	page, err := store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{Status: domain.NotificationStatusUnread, Limit: 100})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != ids[1] {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}

// The re-raising transaction starts before the clear but writes after its
// commit, before a caller has received/processed the clear response. now() is
// consequently older than the clear; only the row revision orders this race.
func TestNotificationClearRevisionSurvivesInterleavedReraise(t *testing.T) {
	for _, initialStatus := range []string{"unread", "read"} {
		t.Run(initialStatus, func(t *testing.T) {
			store, admin, fixture := openNotificationTestStore(t)
			ctx := context.Background()
			principal := domain.Principal{UserID: fixture.userID, Provider: "local"}
			at := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
			id := uuid.NewString()
			if _, err := admin.Exec(ctx, `INSERT INTO ao_notifications
    (id, org_id, recipient_user_id, project_id, session_id, type, title, dedupe_key, source_event_id, status, created_at, updated_at)
    VALUES ($1::uuid, $2, $3, $4, $5, 'needs_input', 'Needs input', $1::uuid::text, $1::uuid::text, $7, $6, $6)`,
				id, fixture.orgID, fixture.userID, fixture.projectID, fixture.sessionID, at, initialStatus); err != nil {
				t.Fatal(err)
			}
			reraising, err := admin.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer reraising.Rollback(ctx)
			// Establish the old transaction's timestamp before the read transaction.
			var started time.Time
			if err := reraising.QueryRow(ctx, `SELECT now()`).Scan(&started); err != nil {
				t.Fatal(err)
			}
			result, err := store.MarkNotificationsRead(ctx, principal, fixture.orgID, nil, domain.NotificationCursor{ID: id, CreatedAt: at})
			wantUpdated := int64(1)
			if initialStatus == "read" {
				wantUpdated = 0
			}
			if err != nil || result.Updated != wantUpdated || result.ClearedRevision == 0 {
				t.Fatalf("clear result=%+v err=%v", result, err)
			}
			var revision int64
			var updatedAt time.Time
			if err := reraising.QueryRow(ctx, `UPDATE ao_notifications SET status = 'unread', updated_at = now()
    WHERE id = $1 RETURNING revision, updated_at`, id).Scan(&revision, &updatedAt); err != nil {
				t.Fatal(err)
			}
			if err := reraising.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if !updatedAt.Equal(started) || revision <= result.ClearedRevision {
				t.Fatalf("re-raise revision=%d clear=%d updated=%s started=%s", revision, result.ClearedRevision, updatedAt, started)
			}
			page, err := store.ListNotifications(ctx, principal, fixture.orgID, domain.NotificationFilter{})
			if err != nil || len(page.Items) != 1 || page.Items[0].Status != "unread" || page.Items[0].Revision != revision {
				t.Fatalf("page=%+v err=%v", page, err)
			}
			// A second range clear must dismiss the new generation too.
			second, err := store.MarkNotificationsRead(ctx, principal, fixture.orgID, nil, domain.NotificationCursor{ID: id, CreatedAt: at})
			if err != nil || second.Updated != 1 || second.ClearedRevision <= revision {
				t.Fatalf("second clear=%+v err=%v", second, err)
			}
			events, _, err := store.ListNotificationEvents(ctx, principal, fixture.orgID, 0, 100)
			if err != nil || len(events) != int(wantUpdated)+1 || events[len(events)-1].Notification.Revision != second.ClearedRevision {
				t.Fatalf("read event must carry its revision: events=%+v err=%v", events, err)
			}
		})
	}
}
