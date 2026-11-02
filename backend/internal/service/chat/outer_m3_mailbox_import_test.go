package chat_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

func TestOuterM3MailboxCoordinatorImportsRespectRemovedSources(t *testing.T) {
	for _, firstImport := range []string{"get", "receipt"} {
		t.Run(firstImport, func(t *testing.T) {
			f, coordinator, caller := m3MailboxFixture(t)
			ctx := context.Background()
			if err := f.st.UpsertProject(ctx, domain.ProjectRecord{ID: "b", DisplayName: "Project B", Kind: domain.ProjectKindSingleRepo, Path: t.TempDir(), RegisteredAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			b, _, _ := f.outer.Binding(ctx)
			scope := domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.scope"})
			if _, err := f.outer.SetScope(scope, b.Revision, []string{"a", "b"}, false, true); err != nil {
				t.Fatal(err)
			}
			secret := "retained B-derived coordination content"
			for _, id := range []string{"first-import", "still-unread"} {
				plan, err := f.outer.ProposePlan(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.read"}), domain.OuterPlanProposal{RequestID: f.request(), SourceProjects: []string{"a", "b"}, Actions: []domain.OuterActionSpec{{Operation: "mailbox.append", ProjectID: "a", SessionID: coordinator.ID, Mailbox: &domain.OuterMailboxSpec{ID: id, Text: secret}}}})
				if err != nil {
					t.Fatal(id, err)
				}
				if receipt, err := f.outer.ApprovePlan(domain.WithOuterNativeAction(ctx, domain.OuterNativeAction{Operation: "outer.plan.approve", RequestID: plan.Plan.ID}), plan.Plan.ID, plan.Digest); err != nil || receipt.Actions[0].State != "completed" {
					t.Fatal("exact A/B mailbox append", id, receipt.Actions, err)
				}
				stored, err := f.st.GetOuterMailbox(ctx, id)
				if err != nil || !slices.Contains(domain.OuterMailboxFact(stored).Source.Sources, "b") {
					t.Fatal("fixture did not seal B provenance", stored, err)
				}
			}
			prior, err := f.st.OuterSources(ctx, coordinator.Metadata.ProviderConversationID)
			if err != nil || len(prior) != 0 {
				t.Fatal("coordinator imported before an explicit content read", prior, err)
			}
			router := httpd.NewRouterWithControl(config.Config{}, slog.New(slog.DiscardHandler), nil, httpd.APIDeps{Outer: f.outer}, httpd.ControlDeps{})
			token, err := f.st.IssueOuterCaller(ctx, coordinator.ID)
			if err != nil {
				t.Fatal(err)
			}
			base := "/api/v1/sessions/" + string(coordinator.ID) + "/mailbox"
			call := func(method, path string, body any) *httptest.ResponseRecorder {
				data, _ := json.Marshal(body)
				r := httptest.NewRequest(method, "http://127.0.0.1"+path, bytes.NewReader(data))
				r.RemoteAddr = "127.0.0.1:23456"
				r.Header.Set("X-AO-Scope-Credential", token)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				return w
			}
			method, path := http.MethodGet, base
			if firstImport == "receipt" {
				method, path = http.MethodPost, base+"/first-import/receipt"
			}
			if w := call(method, path, nil); w.Code != 200 || !strings.Contains(w.Body.String(), secret) {
				t.Fatal("legitimate explicit import", w.Code, w.Body.String())
			}
			imported, err := f.st.OuterSources(ctx, coordinator.Metadata.ProviderConversationID)
			if err != nil || !slices.ContainsFunc(imported, func(source domain.OuterSource) bool {
				return source.ID == "first-import" && slices.Contains(source.Sources, "b")
			}) {
				t.Fatal("recipient import history omitted B", imported, err)
			}
			freshFact := func(id string) []domain.OuterFact {
				return []domain.OuterFact{{Source: domain.OuterSource{ProjectID: "a", Kind: "derived_statement", ID: id, Sources: []string{"a"}}, Summary: "fresh A statement"}}
			}
			b, _, _ = f.outer.Binding(ctx)
			exported, err := f.st.LabelOuterFacts(ctx, b, "fresh-before-removal", freshFact("before-removal"))
			if err != nil || !slices.Contains(exported[0].Source.Sources, "b") {
				t.Fatal("fresh A export omitted coordinator import lineage", exported, err)
			}
			if _, err := f.outer.AppendMailbox(caller, coordinator.ID, domain.OuterMailboxSpec{ID: "retained-reply", Text: secret}); err != nil {
				t.Fatal(err)
			}
			b, _, _ = f.outer.Binding(ctx)
			if _, err := f.outer.SetScope(scope, b.Revision, []string{"a"}, false, true); err != nil {
				t.Fatal(err)
			}
			if _, err := f.st.AuthenticateOuterCaller(ctx, token); err != nil {
				t.Fatal("removal test lost its live A credential", err)
			}
			if err := f.outer.CheckMailboxCaller(caller, coordinator.ID); err != nil {
				t.Fatal("A itself was removed", err)
			}
			for _, request := range []struct {
				method, path string
				body         any
			}{
				{http.MethodGet, base, nil},
				{http.MethodPost, base + "/first-import/receipt", nil},
				{http.MethodPost, base + "/still-unread/receipt", nil},
				{http.MethodPost, base, domain.OuterMailboxSpec{ID: "retained-reply", Text: secret}},
				{http.MethodPost, base, domain.OuterMailboxSpec{ID: "new-export", Text: "A-derived statement from the retained conversation"}},
			} {
				if w := call(request.method, request.path, request.body); w.Code != 409 || strings.Contains(w.Body.String(), secret) {
					t.Fatal("removed B content reimported", request.path, w.Code, w.Body.String())
				}
			}
			retained, err := f.st.GetOuterMailbox(ctx, "still-unread")
			if err != nil || retained.Text != secret || !retained.AcknowledgedAt.IsZero() || !slices.Contains(domain.OuterMailboxFact(retained).Source.Sources, "b") {
				t.Fatal("denied receipt changed historical evidence", retained, err)
			}
			if _, err := f.st.GetOuterMailbox(ctx, "new-export"); err == nil {
				t.Fatal("removed-source re-export was stored")
			}
			b, _, _ = f.outer.Binding(ctx)
			if _, err := f.st.LabelOuterFacts(ctx, b, "fresh-after-removal", freshFact("after-removal")); err == nil {
				t.Fatal("fresh A export laundered the coordinator's B import")
			}
			if f.providers[coordinator.ID].sendCalls != 0 || f.spawned != 0 {
				t.Fatal("mailbox import launched work")
			}
		})
	}
}

func TestOuterM3MailboxImportAndReceiptAuditAreAtomic(t *testing.T) {
	f, coordinator, caller := m3MailboxFixture(t)
	ctx := context.Background()
	approveM3(t, f, domain.OuterActionSpec{Operation: "mailbox.append", ProjectID: "a", SessionID: coordinator.ID, Mailbox: &domain.OuterMailboxSpec{ID: "audit-import", Text: "retained record"}})
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "ao.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TRIGGER reject_m3_import_audit BEFORE INSERT ON outer_audit WHEN json_extract(NEW.document,'$.operation')='mailbox.import' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"); err != nil {
		t.Fatal(err)
	}
	if rows, err := f.outer.Mailbox(caller, "", coordinator.ID, 0, 20); err == nil || len(rows) != 0 {
		t.Fatal("unaudited page returned", rows, err)
	}
	if receipt, err := f.outer.ReceiptMailbox(caller, coordinator.ID, "audit-import"); err == nil || receipt.Text != "" {
		t.Fatal("unaudited receipt returned", receipt, err)
	}
	stored, err := f.st.GetOuterMailbox(ctx, "audit-import")
	if err != nil || !stored.AcknowledgedAt.IsZero() {
		t.Fatal("receipt survived import rollback", stored, err)
	}
	if sources, err := f.st.OuterSources(ctx, coordinator.Metadata.ProviderConversationID); err != nil || len(sources) != 0 {
		t.Fatal("unaudited import history survived", sources, err)
	}
}
