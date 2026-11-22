package sessionmanager

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	claudeagent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/claudeacp"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type claudeCheckpointTransitionDriver struct {
	integrationChatDriver
	ports.NativeCheckpointVerifier
}

type claudeCheckpointTransitionHistory struct{ *integrationChatConversation }

func (c *claudeCheckpointTransitionHistory) ReadHistory(context.Context) ([]ports.ChatEvent, error) {
	return []ports.ChatEvent{
		{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "turn", ProviderEventID: "start"},
		{Kind: ports.ChatEventUserMessageCompleted, ProviderTurnID: "turn", ProviderItemID: "user", ProviderEventID: "user", NativeUserMessageID: "user", Text: "human question"},
		{Kind: ports.ChatEventMessageCompleted, ProviderTurnID: "turn", ProviderItemID: "answer", ProviderEventID: "answer", Text: "human answer"},
		{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "turn", ProviderEventID: "end"},
	}, nil
}

func TestInterfaceTransitionClaudeCompactionCheckpoint(t *testing.T) {
	for _, missing := range []bool{false, true} {
		name := "preserved latest user turn"
		if missing {
			name = "two uncertain coordination submissions"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			workspace, configDir := filepath.Join(dir, "workspace"), filepath.Join(dir, "claude")
			transcriptDir := filepath.Join(configDir, "projects", "scratch")
			binDir := filepath.Join(dir, "bin")
			for _, path := range []string{workspace, transcriptDir, binDir} {
				if err := os.MkdirAll(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			// ResolveBinary may inspect this file; no test may execute it.
			if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte("execution forbidden"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("CLAUDE_CONFIG_DIR", configDir)
			const nativeID = "bb786e64-3b86-44cb-8d34-eafae933d8e4"
			path := filepath.Join(transcriptDir, nativeID+".jsonl")
			var transcript strings.Builder
			encoder := json.NewEncoder(&transcript)
			for _, record := range []map[string]any{
				{"uuid": "user", "type": "user", "promptId": "prompt", "message": map[string]any{"content": "human question"}},
				{"uuid": "hook", "parentUuid": "user", "type": "attachment", "attachment": map[string]any{"type": "hook_additional_context", "hookEvent": "UserPromptSubmit", "content": []string{domain.NativeSubmissionContext("human-submission")}}},
				{"uuid": "answer", "parentUuid": "hook", "type": "assistant", "message": map[string]any{"content": "human answer", "stop_reason": "end_turn"}},
				{"uuid": "boundary", "type": "system", "subtype": "compact_boundary", "logicalParentUuid": "answer", "compactMetadata": map[string]any{"preservedMessages": map[string]any{"anchorUuid": "summary", "uuids": []string{"user", "hook", "answer"}}}},
				{"uuid": "summary", "type": "user", "parentUuid": "boundary", "promptId": "prompt", "isCompactSummary": true, "message": map[string]any{"content": "This session is being continued from a previous conversation that ran out of context."}},
			} {
				record["sessionId"] = nativeID
				if err := encoder.Encode(record); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(path, []byte(transcript.String()), 0600); err != nil {
				t.Fatal(err)
			}
			st := sqlitetest.MustOpenAt(t, dir)
			project := domain.ProjectRecord{ID: "checkpoint", Path: workspace, RegisteredAt: time.Now(), Config: testRoleAgents()}
			project.Config.Orchestrator.Harness = domain.HarnessClaudeCode
			project.Config.Env = map[string]string{"CLAUDE_CONFIG_DIR": configDir}
			if err := st.UpsertProject(ctx, project); err != nil {
				t.Fatal(err)
			}
			sess, err := st.CreateSession(ctx, domain.SessionRecord{
				ProjectID: domain.ProjectID(project.ID), Kind: domain.KindOrchestrator, Harness: domain.HarnessClaudeCode,
				Mode: domain.SessionModeChat, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
				Metadata:  domain.SessionMetadata{WorkspacePath: workspace, Branch: "main", ProviderConversationID: nativeID},
				CreatedAt: time.Now(), UpdatedAt: time.Now(),
			})
			if err != nil {
				t.Fatal(err)
			}
			conv, err := st.CreateConversation(ctx, "checkpoint-conversation", domain.ConversationScopeProject, domain.ProjectID(project.ID), sess.ID, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			var resumes atomic.Int32
			provider := &claudeCheckpointTransitionHistory{newIntegrationChatConversation(nativeID)}
			driver := claudeCheckpointTransitionDriver{
				integrationChatDriver: integrationChatDriver{harness: domain.HarnessClaudeCode,
					start: func() ports.ChatConversation { t.Error("fresh conversation forbidden"); return nil },
					resume: func() ports.ChatConversation {
						resumes.Add(1)
						provider = &claudeCheckpointTransitionHistory{newIntegrationChatConversation(nativeID)}
						return provider
					}},
				NativeCheckpointVerifier: claudeacp.New(claudeagent.New(), slog.New(slog.DiscardHandler), nil).(ports.NativeCheckpointVerifier),
			}
			svc := chatsvc.New(chatsvc.Options{Store: st, Sessions: st, Log: slog.New(slog.DiscardHandler), NewID: uuid.NewString,
				Reader: chatsvc.SnapshotReaderFunc(func(ctx context.Context, id string) (chatsvc.ConversationRows, error) {
					r, err := st.LoadConversationSnapshot(ctx, id)
					return chatsvc.ConversationRows{Conversation: r.Conversation, Turns: r.Turns, Messages: r.Messages, Activities: r.Activities}, err
				}), Drivers: integrationChatRegistry{domain.HarnessClaudeCode: driver}})
			t.Cleanup(func() { svc.StopAll(context.Background()) })
			runtime := &transitionRuntime{fakeRuntime: &fakeRuntime{}, log: &[]string{}}
			lcm := lifecycle.New(st, nil)
			m := New(Deps{Store: st, Lifecycle: lcm, Chat: integrationChatLauncher{svc}, Agents: singleAgent{agent: claudeagent.New()},
				Runtime: runtime, Workspace: &fakeWorkspace{path: workspace}, Messenger: &fakeMessenger{}, DataDir: dir,
				LookPath: func(string) (string, error) { return "/bin/true", nil }, Executable: func() (string, error) { return filepath.Join(binDir, "ao"), nil }, Logger: slog.New(slog.DiscardHandler)})
			useFastInterfaceTransitionTimings(m)
			if _, err := m.resumeChatController(ctx, "initial", sess, project, ports.WorkspaceInfo{Path: workspace, Branch: "main"}, false, false, "", domain.SessionInterfaceTransitionHistoryStrict); err != nil {
				t.Fatal(err)
			}
			wait := func(id string) domain.SessionInterfaceTransition {
				t.Helper()
				for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
					tr, found, err := st.GetSessionInterfaceTransition(ctx, id)
					if err != nil || !found {
						t.Fatalf("read transition: %v %v", found, err)
					}
					if tr.Phase.Terminal() {
						return tr
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatal("transition timeout")
				return domain.SessionInterfaceTransition{}
			}
			toTerminal, err := m.StartInterfaceTransition(ctx, sess.ID, domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt, domain.SessionInterfaceTransitionHistoryStrict)
			if err != nil {
				t.Fatal(err)
			}
			if tr := wait(toTerminal.ID); tr.Phase != domain.SessionInterfaceTransitionCompleted {
				t.Fatalf("to Terminal: %+v", tr)
			}
			rec, _, err := st.GetSession(ctx, sess.ID)
			if err != nil {
				t.Fatal(err)
			}
			evidence := domain.AppendNativeCheckpoint("", nativeID, domain.NativeCheckpointObservation{Generation: rec.Metadata.RuntimeLaunchID, PromptID: "prompt", Submission: true, SubmissionID: "human-submission", Text: "human question"})
			evidence = domain.AppendNativeCheckpoint(evidence, nativeID, domain.NativeCheckpointObservation{Generation: rec.Metadata.RuntimeLaunchID, PromptID: "prompt", Text: "human answer"})
			if missing {
				for _, id := range []string{"uncertain-one", "uncertain-two"} {
					evidence = domain.AppendNativeCheckpoint(evidence, nativeID, domain.NativeCheckpointObservation{Generation: rec.Metadata.RuntimeLaunchID, PromptID: "prompt", Submission: true, SubmissionID: id, Coordination: true})
				}
			}
			rec.Metadata.NativeCheckpointEvidence = evidence
			rec.Metadata.ConversationCheckpointState = domain.ConversationCheckpointComplete
			rec.Metadata.ConversationCheckpointGeneration = rec.Metadata.RuntimeLaunchID
			rec.Metadata.ConversationCheckpointNativeID = nativeID
			rec.Metadata.AgentSessionID, rec.Metadata.AgentSessionIDLaunchID = nativeID, rec.Metadata.RuntimeLaunchID
			rec.FirstSignalAt = time.Now()
			rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()}
			if err := st.UpdateSession(ctx, rec); err != nil {
				t.Fatal(err)
			}
			before, err := st.LoadConversationSnapshot(ctx, conv.ID)
			if err != nil || len(before.Messages) != 2 {
				t.Fatalf("prior history: %+v %v", before, err)
			}
			toChat, err := m.StartInterfaceTransition(ctx, sess.ID, domain.SessionModeChat, domain.SessionInterfaceTransitionInterrupt, domain.SessionInterfaceTransitionHistoryStrict)
			if err != nil {
				t.Fatal(err)
			}
			tr := wait(toChat.ID)
			wantPhase, wantMode, wantResumes := domain.SessionInterfaceTransitionCompleted, domain.SessionModeChat, int32(2)
			if missing {
				wantPhase, wantMode, wantResumes = domain.SessionInterfaceTransitionFailed, domain.SessionModeTUI, 1
			}
			if tr.Phase != wantPhase {
				t.Fatalf("switch: %+v", tr)
			}
			after, _, err := st.GetSession(ctx, sess.ID)
			if err != nil || after.ID != sess.ID || after.Mode != wantMode || after.Metadata.AgentSessionID != nativeID || after.Metadata.NativeCheckpointEvidence != evidence || resumes.Load() != wantResumes {
				t.Fatalf("identity/evidence/mode: session=%+v resumes=%d err=%v", after.ControllerOwner(), resumes.Load(), err)
			}
			rows, err := st.LoadConversationSnapshot(ctx, conv.ID)
			if err != nil || !reflect.DeepEqual(before.Messages, rows.Messages) || len(before.Turns) != len(rows.Turns) {
				t.Fatalf("history changed: %v", err)
			}
			provider.mu.Lock()
			sent := len(provider.sent)
			provider.mu.Unlock()
			if sent != 0 {
				t.Fatalf("replayed %d work prompts", sent)
			}
			if missing {
				if !strings.Contains(tr.ErrorDetail, "native submission attachment not flushed") ||
					!strings.Contains(tr.ErrorDetail, "uncertain-one") || !strings.Contains(tr.ErrorDetail, "uncertain-two") || after.Metadata.RuntimeHandleID == "" {
					t.Fatalf("Terminal rollback failed: %+v", tr)
				}
				resumedNative := false
				for i, arg := range runtime.lastCfg.Argv {
					if arg == "--resume" && i+1 < len(runtime.lastCfg.Argv) && runtime.lastCfg.Argv[i+1] == nativeID {
						resumedNative = true
					}
					if arg == "--session-id" {
						t.Fatalf("rollback forked native history: %v", runtime.lastCfg.Argv)
					}
				}
				if !resumedNative {
					t.Fatalf("rollback lost native resume: %v", runtime.lastCfg.Argv)
				}
			}
			contents, err := os.ReadFile(path)
			if err != nil || string(contents) != transcript.String() {
				t.Fatalf("native transcript changed: %v", err)
			}
		})
	}
}
