package claudeacp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestNativeCheckpointDuplicatePromptExemptionRequiresPreservedUserUUID(t *testing.T) {
	for _, preservedUser := range []bool{false, true} {
		name := "fresh UUID reusing compacted prompt ID is rejected"
		if preservedUser {
			name = "original preserved UUID is accepted"
		}
		t.Run(name, func(t *testing.T) {
			kept := []string{"assistant-0"}
			if preservedUser {
				kept = []string{"user-0", "submission-attachment-0", "assistant-0"}
			}
			records := compactionPrompt(0, "", "A")
			records = append(records,
				compactionAnswer("assistant-0", "submission-attachment-0", "answer A", "end_turn"),
				compactionBoundary("boundary", "assistant-0", keptMessages("summary", kept...)),
				compactionSummary("summary", "boundary", "prompt-0"))
			wantedUser, wantedAnswer := "user-0", "answer A"
			submit, stop := submitObservation(0, "A"), stopObservation(0, "answer A")
			if !preservedUser {
				fresh := compactionPrompt(1, "summary", "U")
				fresh[0]["promptId"] = "prompt-0"
				records = append(records, fresh...)
				records = append(records, compactionAnswer("assistant-1", "submission-attachment-1", "answer U", "end_turn"))
				wantedUser, wantedAnswer = "user-1", "answer U"
				submit, stop = submitObservation(1, "U"), stopObservation(1, "answer U")
				submit.PromptID, stop.PromptID = "prompt-0", "prompt-0"
			}
			path := filepath.Join(t.TempDir(), "native.jsonl")
			if err := os.WriteFile(path, []byte(compactionLines(t, records...)), 0600); err != nil {
				t.Fatal(err)
			}
			driver := &checkpointDriver{plugin: checkpointFilePlugin{path: path}}
			boundary, err := driver.VerifyNativeCheckpoint(context.Background(), ports.NativeCheckpointRequest{
				ProviderConversationID: "native", Evidence: checkpointEvidence(submit, stop),
			})
			if !preservedUser {
				if !errors.Is(err, ports.ErrChatHistoryUnsettled) || !strings.Contains(err.Error(), "ambiguous native prompt ID") {
					t.Fatalf("fresh non-preserved UUID bypassed duplicate prompt guard: boundary=%+v error=%v", boundary, err)
				}
				return
			}
			if err != nil || boundary.UserMessageID != wantedUser || boundary.AssistantText != wantedAnswer {
				t.Fatalf("legitimate preserved UUID rejected: boundary=%+v error=%v", boundary, err)
			}
		})
	}
}

func preservedIdentityMetadata(form, anchor string, ids ...string) map[string]any {
	if form == "segment" {
		return map[string]any{"preservedSegment": map[string]any{"anchorUuid": anchor, "headUuid": ids[0], "tailUuid": ids[len(ids)-1]}}
	}
	return keptMessages(anchor, ids...)
}

func TestNativeCheckpointPreservationMembershipAcrossRelinks(t *testing.T) {
	for _, form := range []string{"messages", "segment"} {
		for _, attachments := range []bool{false, true} {
			for _, summaryLast := range []bool{false, true} {
				for _, original := range []bool{false, true} {
					name := fmt.Sprintf("%s/attachments=%t/summary-last=%t/original=%t", form, attachments, summaryLast, original)
					t.Run(name, func(t *testing.T) {
						kept := []string{"assistant-0"}
						if original {
							kept = []string{"user-0", "submission-attachment-0", "assistant-0"}
						}
						records := compactionPrompt(0, "", "A")
						records = append(records,
							compactionAnswer("assistant-0", "submission-attachment-0", "answer A", "end_turn"),
							compactionBoundary("boundary-1", "assistant-0", preservedIdentityMetadata(form, "summary-1", kept...)))
						parent := "boundary-1"
						if attachments {
							records = append(records, compactionContext(parent)...)
							parent = "context-date"
						}
						records = append(records, compactionSummary("summary-1", parent, "prompt-0"))
						user, hook, answer, text := "user-0", "submission-attachment-0", "assistant-0", "A"
						submit, stop := submitObservation(0, "A"), stopObservation(0, "answer A")
						if !original {
							fresh := compactionPrompt(1, "summary-1", "U")
							fresh[0]["promptId"] = "prompt-0"
							records = append(records, fresh...)
							records = append(records, compactionAnswer("assistant-1", "submission-attachment-1", "answer U", "end_turn"))
							user, hook, answer, text = "user-1", "submission-attachment-1", "assistant-1", "U"
							submit, stop = submitObservation(1, "U"), stopObservation(1, "answer U")
							submit.PromptID, stop.PromptID = "prompt-0", "prompt-0"
						}
						if summaryLast {
							records = append(records,
								map[string]any{"uuid": "meta", "parentUuid": answer, "type": "user", "promptId": "meta-prompt", "isMeta": true, "message": map[string]any{"content": "internal context"}},
								compactionAnswer("meta-answer", "meta", "answer "+text, "end_turn"),
								compactionBoundary("boundary-2", "meta-answer", keptMessages("summary-2", user, hook, answer, "meta", "summary-1", "meta-answer")),
								compactionSummary("summary-2", "boundary-2", "other-prompt"))
						}
						path := filepath.Join(t.TempDir(), "native.jsonl")
						if err := os.WriteFile(path, []byte(compactionLines(t, records...)), 0600); err != nil {
							t.Fatal(err)
						}
						driver := &checkpointDriver{plugin: checkpointFilePlugin{path: path}}
						got, err := driver.VerifyNativeCheckpoint(context.Background(), ports.NativeCheckpointRequest{
							ProviderConversationID: "native", Evidence: checkpointEvidence(submit, stop),
						})
						if !original {
							if !errors.Is(err, ports.ErrChatHistoryUnsettled) || !strings.Contains(err.Error(), "ambiguous native prompt ID") {
								t.Fatalf("fresh UUID exemption: %+v %v", got, err)
							}
							return
						}
						if err != nil || got.UserMessageID != user || got.AssistantText != "answer "+text {
							t.Fatalf("preserved original: %+v %v", got, err)
						}
					})
				}
			}
		}
	}
}

func TestCheckpointPreservationProofRequiresCompleteExactMembership(t *testing.T) {
	for _, test := range []struct {
		name     string
		metadata map[string]any
		cycle    bool
		want     bool
	}{
		{name: "explicit original", metadata: keptMessages("summary", "user", "answer"), want: true},
		{name: "explicit wrong anchor", metadata: keptMessages("other-summary", "user", "answer")},
		{name: "explicit duplicate member", metadata: keptMessages("summary", "user", "user", "answer")},
		{name: "explicit missing member", metadata: keptMessages("summary", "user", "gone")},
		{name: "segment original", metadata: preservedIdentityMetadata("segment", "summary", "user", "answer"), want: true},
		{name: "segment single user", metadata: preservedIdentityMetadata("segment", "summary", "user"), want: true},
		{name: "segment wrong anchor", metadata: preservedIdentityMetadata("segment", "other-summary", "user", "answer")},
		{name: "segment never reaches head", metadata: preservedIdentityMetadata("segment", "summary", "gone", "answer")},
		{name: "segment missing tail", metadata: preservedIdentityMetadata("segment", "summary", "user", "gone")},
		{name: "segment cycle before head", metadata: preservedIdentityMetadata("segment", "summary", "user", "loop"), cycle: true},
		{name: "conflicting forms", metadata: map[string]any{"preservedMessages": map[string]any{"anchorUuid": "summary", "uuids": []string{"user"}}, "preservedSegment": map[string]any{"anchorUuid": "summary", "headUuid": "user", "tailUuid": "answer"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			records := map[string]checkpointRecord{
				"user":   {UUID: "user", Type: "user"},
				"answer": {UUID: "answer", ParentUUID: "user", Type: "assistant"},
			}
			if test.cycle {
				records["loop"] = checkpointRecord{UUID: "loop", ParentUUID: "loop", Type: "assistant"}
			}
			var boundary checkpointRecord
			if err := json.Unmarshal([]byte(compactionLines(t, compactionBoundary("boundary", "answer", test.metadata))), &boundary); err != nil {
				t.Fatal(err)
			}
			proofs := make(map[string]checkpointPreservation)
			_, err := compactNativeRecords(context.Background(), records, map[string]int64{}, nil,
				&compactedWitnesses{prompts: map[string]bool{}, submissions: map[string]bool{}}, proofs, boundary)
			if err != nil {
				t.Fatalf("malformed preservation proof expanded transcript policy: %v", err)
			}
			if got := proofs["boundary"].contains(checkpointTurn{userID: "summary"}, checkpointTurn{userID: "user"}); got != test.want {
				t.Fatalf("exemption=%t want=%t", got, test.want)
			}
		})
	}
}

func TestCheckpointPreservationProofSurvivesBoundaryRemovalThenPrunes(t *testing.T) {
	records := map[string]checkpointRecord{
		"user":    {UUID: "user", Type: "user"},
		"summary": {UUID: "summary", Type: "user", ParentUUID: "user", compactionBoundaryID: "original-boundary"},
		"answer":  {UUID: "answer", Type: "assistant", ParentUUID: "summary"},
	}
	proofs := map[string]checkpointPreservation{
		"original-boundary": {anchorUUID: "summary", users: map[string]bool{"user": true}},
		"unused-boundary":   {anchorUUID: "gone-summary", users: map[string]bool{"gone-user": true}},
	}
	compact := func(id string, kept ...string) {
		t.Helper()
		var boundary checkpointRecord
		if err := json.Unmarshal([]byte(compactionLines(t, compactionBoundary(id, "answer", keptMessages(id+"-summary", kept...)))), &boundary); err != nil {
			t.Fatal(err)
		}
		if _, err := compactNativeRecords(context.Background(), records, map[string]int64{}, nil,
			&compactedWitnesses{prompts: map[string]bool{}, submissions: map[string]bool{}}, proofs, boundary); err != nil {
			t.Fatal(err)
		}
	}
	compact("second-boundary", "user", "summary", "answer")
	if _, found := records["original-boundary"]; found {
		t.Fatal("fixture retained original boundary object")
	}
	if !proofs["original-boundary"].contains(checkpointTurn{userID: "summary"}, checkpointTurn{userID: "user"}) {
		t.Fatal("surviving summary lost original boundary proof")
	}
	if _, found := proofs["unused-boundary"]; found {
		t.Fatal("unused proof retained")
	}
	compact("third-boundary", "user", "answer")
	if _, found := proofs["original-boundary"]; found {
		t.Fatal("removed summary retained unused original proof")
	}
}
