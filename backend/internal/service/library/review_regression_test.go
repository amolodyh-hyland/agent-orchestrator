package library

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

func TestLibraryMutationPolicyUsesAuthoritativeResourceAtBothChecks(t *testing.T) {
	for _, operation := range []string{"bind", "detach_binding", "revoke"} {
		t.Run(operation, func(t *testing.T) {
			f := newFixture(t, "rules")
			f.write("guide.md", "protected")
			f.inspect()
			f.approve()
			f.session("protected")
			f.bindEntry("protected", "", false, domain.ProjectContextRoleShared)
			binding := f.result.Bindings[0]
			for _, envelope := range []string{"omitted", "unrelated"} {
				for _, denial := range []string{"denial", "lock"} {
					for _, phase := range []string{"initial", "commit"} {
						t.Run(envelope+"/"+denial+"/"+phase, func(t *testing.T) {
							in := Operation{Operation: operation, Binding: &binding, BindingID: binding.BindingID, ApprovalID: f.result.Approvals[0].ApprovalID, ExpectedRevision: f.result.Revision}
							if envelope == "unrelated" {
								in.SourceID, in.ProjectID = "unrelated-source", "unrelated-project"
							}
							var requests []PolicyRequest
							f.svc.policy = policyFunc(func(_ context.Context, r PolicyRequest) (PolicyDecision, error) {
								requests = append(requests, r)
								p := PolicyDecision{State: "verified"}
								// Only the actual resource has a managed restriction. An envelope
								// supplied by the caller must never select another policy scope.
								if r.SourceID == binding.SourceID && r.EntryID == binding.EntryID && (operation == "revoke" || r.ProjectID == binding.ProjectID) && (phase == "initial" || len(requests) > 1) {
									if denial == "denial" {
										p.Denied = true
									} else {
										p.Locks = []domain.LibraryBinding{binding}
									}
								}
								return p, nil
							})
							_, err := f.svc.Operate(context.Background(), in)
							want := "policy_denied"
							if denial == "lock" {
								want = "managed_lock"
							}
							if reason(err) != want {
								t.Fatalf("restriction bypassed: %v requests=%+v", err, requests)
							}
							for _, request := range requests {
								if request.SourceID != binding.SourceID || request.EntryID != binding.EntryID || (operation != "revoke" && request.ProjectID != binding.ProjectID) {
									t.Fatalf("wrong policy resource: %+v", request)
								}
							}
							if phase == "commit" && len(requests) != 2 {
								t.Fatalf("policy not rechecked at commit: %+v", requests)
							}
							state, err := f.store.ReadLibraryRegistry(context.Background())
							if err != nil || state.Revision != f.result.Revision || len(state.Bindings) != 1 || state.Approvals[in.ApprovalID].State != "approved" {
								t.Fatalf("denied mutation changed registry: %+v %v", state, err)
							}
						})
					}
				}
			}
		})
	}
}

type libraryAuditCapture struct {
	*sqlitestore.Store
	audits []domain.LibraryAudit
}

func (s *libraryAuditCapture) RecordLibraryAudit(ctx context.Context, audit domain.LibraryAudit) error {
	s.audits = append(s.audits, audit)
	return s.Store.RecordLibraryAudit(ctx, audit)
}

func TestLibraryLaunchPolicyDenialAndUnavailabilityAreAudited(t *testing.T) {
	f := newFixture(t, "rules")
	f.write("guide.md", "optional context")
	f.inspect()
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	capture := &libraryAuditCapture{Store: f.store}
	f.svc.store = capture
	for _, denial := range []string{"policy_denied", "policy_unavailable"} {
		t.Run(denial, func(t *testing.T) {
			capture.audits = nil
			f.svc.policy = policyFunc(func(_ context.Context, request PolicyRequest) (PolicyDecision, error) {
				p := PolicyDecision{State: "verified"}
				if request.Operation == "launch" {
					p.Revision = "launch-policy-v2"
					if denial == "policy_denied" {
						p.Denied = true
					} else {
						p.State, p.Mode = "unverifiable", "required"
					}
				}
				return p, nil
			})
			if err := f.svc.CheckLaunch(context.Background(), rec.ID); reason(err) != denial {
				t.Fatalf("launch restriction bypassed: %v", err)
			}
			if len(capture.audits) != 1 {
				t.Fatalf("missing launch audit: %+v", capture.audits)
			}
			audit := capture.audits[0]
			if audit.Purpose != "launch_or_resume" || audit.Outcome != "denied" || audit.ReasonCode != denial || audit.PolicyRevision != "launch-policy-v2" {
				t.Fatalf("incorrect denial audit: %+v", audit)
			}
		})
	}
}

func TestLibraryReinspectionDropsObsoletePayloadsAndRetainsSnapshot(t *testing.T) {
	f := newFixture(t, "rules")
	content := strings.Repeat("owned content\n", 4096)
	name := "original.md"
	f.write(name, content)
	f.inspect()
	originalID := f.result.Entries[0].EntryID
	f.approve()
	rec, parent, project := f.session("planning")
	f.bindEntry("planning", "", false, domain.ProjectContextRoleShared)
	if err := f.svc.Pin(context.Background(), parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 16; index++ {
		next := fmt.Sprintf("renamed-%d.md", index)
		if err := os.Rename(filepath.Join(f.root, name), filepath.Join(f.root, next)); err != nil {
			t.Fatal(err)
		}
		name = next
		f.apply(Operation{Operation: "inspect", SourceID: "source"})
		state, err := f.store.ReadLibraryRegistry(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		bytes, current := 0, 0
		for _, entry := range state.Entries {
			if entry.Present {
				current++
			} else if len(entry.Content) != 0 || len(entry.Entry.Files) != 0 || len(entry.Entry.Requirements) != 0 {
				t.Fatal("retired entry retained staging payload")
			}
			for _, text := range entry.Content {
				bytes += len(text)
			}
		}
		encoded, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		if current != 1 || bytes != len(content) || len(encoded) > len(content)+32768 {
			t.Fatalf("staging grew with obsolete bytes: entries=%d bytes=%d record=%d", len(state.Entries), bytes, len(encoded))
		}
	}
	if err := os.Rename(filepath.Join(f.root, name), filepath.Join(f.root, "original.md")); err != nil {
		t.Fatal(err)
	}
	f.apply(Operation{Operation: "inspect", SourceID: "source"})
	if f.result.Entries[0].EntryID != originalID {
		t.Fatal("lightweight tombstone lost stable path identity")
	}
	snapshot, found, err := f.store.GetLibrarySnapshot(context.Background(), rec.ID)
	if err != nil || !found || snapshot.Entries[0].Content["original.md"] != content {
		t.Fatalf("referenced snapshot lost bytes: %v %v", found, err)
	}
}

func TestLibraryPreparedSelectionRequiresMatchingPromotionAndOwner(t *testing.T) {
	f := newFixture(t, "rules")
	ctx := context.Background()
	record, parent, project := f.session("planning")
	record.ID = ""
	record.IsTaskPreparation = true
	preparation, err := f.store.CreateSession(ctx, record)
	if err != nil {
		t.Fatal(err)
	}
	parent.SessionID, parent.Channel, parent.IssueTask = preparation.ID, domain.SessionModeChat, true
	parent.Digest, err = parent.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	// Effective identity can change at promotion; ownership cannot change.
	wrongOwner := parent
	wrongOwner.ProjectID = "unrelated"
	wrongOwner.Digest, err = wrongOwner.ComputeDigest()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Pin(ctx, wrongOwner, project, "claude-code"); err == nil {
		t.Fatal("preparation accepted another project's selection")
	}
	if err := f.svc.Pin(ctx, parent, project, "claude-code"); err != nil {
		t.Fatal(err)
	}
	effective := preparation
	effective.IsTaskPreparation, effective.Mode, effective.IssueID = false, domain.SessionModeChat, "ISSUE-1"
	for _, field := range []string{"project", "kind", "mode", "issue"} {
		t.Run(field, func(t *testing.T) {
			mismatch := effective
			switch field {
			case "project":
				mismatch.ProjectID = "unrelated"
			case "kind":
				mismatch.Kind = domain.KindOrchestrator
			case "mode":
				mismatch.Mode = domain.SessionModeTUI
			case "issue":
				mismatch.IssueID = ""
			}
			if ok, err := f.store.PromoteTaskPreparation(ctx, preparation.ID, mismatch); err == nil || ok {
				t.Fatalf("mismatching promotion accepted: %v %v", ok, err)
			}
			stored, found, err := f.store.GetSession(ctx, preparation.ID)
			if err != nil || !found || !stored.IsTaskPreparation || stored.Mode != preparation.Mode || stored.IssueID != preparation.IssueID {
				t.Fatalf("mismatch made preparation visible: %+v %v", stored, err)
			}
		})
	}
	if ok, err := f.store.PromoteTaskPreparation(ctx, preparation.ID, effective); err != nil || !ok {
		t.Fatalf("matching promotion failed: %v %v", ok, err)
	}
}
