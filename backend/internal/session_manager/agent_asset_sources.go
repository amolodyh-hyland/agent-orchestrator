package sessionmanager

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/agentassets"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (m *Manager) agentAssetEnv(ctx context.Context, projectID domain.ProjectID, env map[string]string) error {
	var project domain.ProjectRecord
	if m.store != nil {
		var err error
		project, err = m.loadProject(ctx, projectID)
		if err != nil {
			return err
		}
	}
	var defaults []string
	if provider, ok := m.defaults.(interface {
		AgentAssetSources(context.Context) ([]string, error)
	}); ok && project.Config.AgentAssetSources == nil {
		var err error
		defaults, err = provider.AgentAssetSources(ctx)
		if err != nil {
			return err
		}
	}
	sources, err := agentassets.Resolve(ctx, project.Path, project.Config.ResolveAgentAssetSources(defaults), func(message string) {
		m.logger.Warn(message, "project", projectID)
	})
	if err != nil {
		return err
	}
	agentassets.SetEnv(env, sources)
	return nil
}
