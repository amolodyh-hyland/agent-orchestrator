package sessionmanager

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	browsersvc "github.com/aoagents/agent-orchestrator/backend/internal/service/browser"
)

type outerNativeLauncher struct {
	*recordingLauncher
	observed domain.OuterNativeAction
}

func (l *outerNativeLauncher) StartChat(ctx context.Context, cfg ChatStart) (ChatStarted, error) {
	action, ok := domain.OuterNativeActionFrom(ctx)
	if !ok || action.Operation != "spawn" || action.ProjectID != cfg.ProjectID {
		return ChatStarted{}, domain.ErrOuterHeld
	}
	l.observed = action
	return l.recordingLauncher.StartChat(ctx, cfg)
}

func TestOuterAsyncSetupKeepsExactNativeAuthorityWithoutOpeningPrompt(t *testing.T) {
	launcher := &outerNativeLauncher{recordingLauncher: &recordingLauncher{}}
	m, st, runtime := newChatManager(launcher)
	m.dataDir = t.TempDir()
	m.browserCapabilities = browsersvc.NewAuthority()
	deferred := deferredBackground(m)
	project := st.projects[string(chatTestProject)]
	project.Kind, project.Path = domain.ProjectKindScratch, ""
	st.projects[string(chatTestProject)] = project
	parent, cancel := context.WithCancel(context.Background())
	action := domain.OuterNativeAction{ActionID: "exact-native-setup", Operation: "spawn", ProjectID: chatTestProject}
	ctx := domain.WithOuterNativeAction(parent, action)
	cfg := asyncChatSpawnConfig("")
	cfg.Kind, cfg.OuterGeneration = domain.KindOrchestrator, 1
	record, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if len(*deferred) != 1 || len(launcher.started) != 0 {
		t.Fatal("unexpected eager start")
	}
	(*deferred)[0]()
	if launcher.observed != action || len(launcher.started) != 1 || st.sessions[record.ID].ProvisionState != domain.SessionProvisionReady {
		t.Fatal("native setup identity lost across owned background launch", launcher.observed, st.sessions[record.ID].ProvisionError)
	}
	if len(launcher.queued) != 0 || len(launcher.turns) != 0 || runtime.created != 0 {
		t.Fatal("setup submitted a prompt or started terminal input")
	}
}
