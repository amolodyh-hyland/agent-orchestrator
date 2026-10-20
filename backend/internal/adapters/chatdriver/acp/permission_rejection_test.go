package acp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestPermissionModeRejection(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"managed policy", acpsdk.NewInternalError(map[string]any{"details": "Bypass permissions mode is disabled by managed policy"}), true},
		{"managed setting", acpsdk.NewInternalError("Cannot enable bypass permissions because disableBypassPermissionsMode is set to disable"), true},
		{"unsupported", acpsdk.NewInvalidParams("Permission mode bypassPermissions is not supported"), true},
		{"unavailable", acpsdk.NewInternalError("Mode bypassPermissions is not available in this session"), true},
		{"unknown", acpsdk.NewInvalidParams("Unknown mode bypassPermissions"), true},
		{"transport", errors.New("bypassPermissions is disabled"), false},
		{"auth", acpsdk.NewAuthRequired("sign in required"), false},
		{"unrelated", acpsdk.NewInternalError("Model haiku is not available"), false},
		{"timeout", context.DeadlineExceeded, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := permissionModeRejection(ports.PermissionModeBypassPermissions, "bypassPermissions", tc.err)
			if errors.Is(got, ports.ErrPermissionRejected) != tc.want {
				t.Fatalf("classification = %v, want rejected=%t", got, tc.want)
			}
			if !errors.Is(got, tc.err) {
				t.Fatalf("lost original error: %v", got)
			}
		})
	}
}

type permissionTestRegistry struct{ driver ports.ChatDriver }

func (r permissionTestRegistry) Driver(domain.AgentHarness) (ports.ChatDriver, error) {
	return r.driver, nil
}
func (r permissionTestRegistry) SupportsChat(domain.AgentHarness) bool { return true }

func TestClaudeACPPermissionFallbackPersistsRuntimeMode(t *testing.T) {
	const bypass = ports.PermissionModeBypassPermissions
	const auto = ports.PermissionModeAuto
	const accept = ports.PermissionModeAcceptEdits
	for _, tc := range []struct {
		name     string
		policy   bool
		choices  []string
		want     ports.PermissionMode
		attempts []ports.PermissionMode
	}{
		{"policy forbidden bypass uses auto", true, []string{"default", "bypassPermissions", "auto", "acceptEdits"}, auto, []ports.PermissionMode{bypass, auto}},
		{"auto unavailable uses accept edits", true, []string{"default", "bypassPermissions", "acceptEdits"}, accept, []ports.PermissionMode{bypass, auto, accept}},
		{"nothing allowed requires manual approvals", true, []string{"default", "bypassPermissions"}, "", []ports.PermissionMode{bypass, auto, accept}},
		{"personal subscription honours chosen bypass", false, []string{"default", "bypassPermissions", "auto", "acceptEdits"}, bypass, []ports.PermissionMode{bypass}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			st := sqlitetest.MustOpen(t)
			workspace := t.TempDir()
			now := time.Now()
			if err := st.UpsertProject(ctx, domain.ProjectRecord{ID: "p", Path: workspace, RegisteredAt: now}); err != nil {
				t.Fatal(err)
			}
			if _, err := st.CreateSession(ctx, domain.SessionRecord{ID: "p-1", ProjectID: "p", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode, Mode: domain.SessionModeChat, CreatedAt: now, UpdatedAt: now, Metadata: domain.SessionMetadata{Permissions: bypass}}); err != nil {
				t.Fatal(err)
			}
			agent := &fakeAgent{newConfig: []acpsdk.SessionConfigOption{selectConfigOption("mode", "Mode", "mode", "default", tc.choices...), selectConfigOption("model", "Model", "model", "sonnet", "sonnet", "haiku")}}
			if tc.policy {
				agent.modeErrors = map[string]error{"bypassPermissions": acpsdk.NewInternalError(map[string]any{"details": "Bypass permissions mode is disabled by managed policy"})}
			}
			var attempts []ports.PermissionMode
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			driver := New(Config{Harness: domain.HarnessClaudeCode, Capabilities: ports.ChatCapabilities{ports.ChatCapabilityApprovals: true, ports.ChatCapabilityStreaming: true, ports.ChatCapabilityInterrupt: true, ports.ChatCapabilityResume: true}, Probe: func(context.Context) error { return nil },
				Launch: func(_ context.Context, cfg LaunchConfig) (Launch, error) {
					attempts = append(attempts, cfg.Permissions)
					return Launch{Command: "fake"}, nil
				},
				SessionMode: func(mode ports.PermissionMode) string {
					switch mode {
					case bypass:
						return "bypassPermissions"
					case auto:
						return "auto"
					case accept:
						return "acceptEdits"
					}
					return ""
				},
			}, log)
			driver.useTestProcess(fakeSpawn(agent))
			svc := chatsvc.New(chatsvc.Options{Store: st, Sessions: st, NewID: uuid.NewString, Drivers: permissionTestRegistry{driver}, Log: log,
				OnPermissionsChanged: func(id domain.SessionID, mode domain.PermissionMode) {
					if _, err := st.UpdateSessionPermissions(ctx, id, mode); err != nil {
						t.Error(err)
					}
				},
			})
			defer svc.StopAll(ctx)
			ctrl, err := svc.Start(ctx, chatsvc.StartConfig{SessionID: "p-1", ProjectID: "p", Harness: domain.HarnessClaudeCode, WorkspacePath: workspace, Permissions: bypass})
			if !reflect.DeepEqual(attempts, tc.attempts) {
				t.Fatalf("attempts=%v want %v; start error: %v", attempts, tc.attempts, err)
			}
			if tc.want == "" {
				if !errors.Is(err, ports.ErrPermissionRejected) || !strings.Contains(err.Error(), "manual approvals required") {
					t.Fatalf("Start=%v", err)
				}
				if ctrl != nil {
					t.Fatal("published a controller although all modes were rejected")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if ctrl.Settings().ApprovalMode != tc.want {
					t.Fatalf("controller mode=%q want %q", ctrl.Settings().ApprovalMode, tc.want)
				}
				options, err := svc.ConfigOptions(ctx, "p-1")
				if err != nil {
					t.Fatal(err)
				}
				agent.mu.Lock()
				runtimeMode := agent.mode
				agent.mu.Unlock()
				if options[0].Current.Select != runtimeMode {
					t.Fatalf("catalog=%v runtime=%q", options, runtimeMode)
				}
			}
			conversation, err := st.ConversationForSession(ctx, "p-1")
			if err != nil {
				t.Fatal(err)
			}
			rows, err := st.LoadConversationSnapshot(ctx, conversation.ID)
			if err != nil {
				t.Fatal(err)
			}
			session, _, err := st.GetSession(ctx, "p-1")
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == "" && session.Metadata.Permissions != "" {
				t.Fatalf("reported rejected mode as effective: %q", session.Metadata.Permissions)
			}
			if tc.want != "" && (conversation.Settings.ApprovalMode != tc.want || session.Metadata.Permissions != tc.want) {
				t.Fatalf("persisted conversation=%q session=%q want %q", conversation.Settings.ApprovalMode, session.Metadata.Permissions, tc.want)
			}
			notices := 0
			for _, activity := range rows.Activities {
				var detail struct {
					Event                   string
					Effective               string
					ManualApprovalsRequired bool
					Rejected                []json.RawMessage
				}
				if json.Unmarshal(activity.Detail, &detail) != nil || detail.Event != "permission.fallback" {
					continue
				}
				notices++
				if detail.Effective != string(tc.want) || detail.ManualApprovalsRequired != (tc.want == "") {
					t.Fatalf("notice=%s", activity.Detail)
				}
				if len(detail.Rejected) != len(tc.attempts)-1 && tc.want != "" {
					t.Fatalf("notice=%s", activity.Detail)
				}
				if tc.want == "" && (!strings.Contains(activity.Summary, "Manual approvals required") || len(detail.Rejected) != 3) {
					t.Fatalf("manual notice=%+v", activity)
				}
			}
			wantNotices := 1
			if !tc.policy {
				wantNotices = 0
			}
			if notices != wantNotices {
				t.Fatalf("notices=%d want %d", notices, wantNotices)
			}
			agent.mu.Lock()
			mode := agent.mode
			agent.mu.Unlock()
			if mode == "default" {
				t.Fatal("silently substituted default")
			}
			if tc.want == auto {
				agent.mu.Lock()
				agent.setConfig = []acpsdk.SessionConfigOption{
					selectConfigOption("mode", "Mode", "mode", "default", "default", "acceptEdits"),
					selectConfigOption("model", "Model", "model", "haiku", "sonnet", "haiku"),
				}
				agent.mu.Unlock()
				if _, err := svc.SetConfigOption(ctx, "p-1", "model", ports.ChatConfigOptionValue{Select: "haiku"}); err != nil {
					t.Fatal(err)
				}
				if ctrl.Settings().ApprovalMode != auto {
					t.Fatalf("model picker silently replaced requested Auto with %q", ctrl.Settings().ApprovalMode)
				}
				idle, _, err := st.GetSession(ctx, "p-1")
				if err != nil {
					t.Fatal(err)
				}
				if idle.Metadata.Permissions != ports.PermissionModeDefault {
					t.Fatalf("idle provider mode=%q", idle.Metadata.Permissions)
				}
				if _, err := svc.Send(ctx, "p-1", ports.ChatUserMessage{Text: "use the selected model"}); err != nil {
					t.Fatal(err)
				}
				active, _, err := st.GetSession(ctx, "p-1")
				if err != nil {
					t.Fatal(err)
				}
				if active.Metadata.Permissions != accept || ctrl.Settings().ApprovalMode != accept {
					t.Fatalf("next turn did not walk the ladder: runtime=%q settings=%q", active.Metadata.Permissions, ctrl.Settings().ApprovalMode)
				}
			}
			if !tc.policy {
				if _, err := svc.SetConfigOption(ctx, "p-1", "mode", ports.ChatConfigOptionValue{Select: "auto"}); err != nil {
					t.Fatal(err)
				}
				updated, _, err := st.GetSession(ctx, "p-1")
				if err != nil {
					t.Fatal(err)
				}
				if updated.Metadata.Permissions != auto {
					t.Fatalf("provider picker left runtime mode at %q", updated.Metadata.Permissions)
				}
			}
		})
	}
}
