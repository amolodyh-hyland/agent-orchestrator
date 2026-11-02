package controllers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	settingssvc "github.com/aoagents/agent-orchestrator/backend/internal/service/settings"
)

type assetSettingsService struct {
	hibernationSettingsService
	err error
}

func (s *assetSettingsService) SetAgentAssetSources(_ context.Context, sources []string) (settingssvc.Snapshot, error) {
	s.calls++
	return settingssvc.Snapshot{AgentAssetSources: sources}, s.err
}

func TestSettingsAssetSourcesValidationAndPersistenceErrors(t *testing.T) {
	for _, tc := range []struct {
		body   string
		err    error
		status int
	}{
		{`{}`, nil, 400},
		{`{"agentAssetSources":null}`, nil, 400},
		{`{"agentAssetSources":["../escape"]}`, nil, 400},
		{`{"agentAssetSources":[""]}`, nil, 400},
		{`{"agentAssetSources":["/live"]}`, nil, 200},
		{`{"agentAssetSources":[]}`, nil, 200},
		{`{"agentAssetSources":[]}`, errors.New("store unavailable"), 500},
	} {
		svc := &assetSettingsService{err: tc.err}
		controller := &SettingsController{Svc: svc}
		response := httptest.NewRecorder()
		controller.setAgentAssetSources(response, httptest.NewRequest(http.MethodPatch, "/api/v1/settings/agent-asset-sources", strings.NewReader(tc.body)))
		if response.Code != tc.status || tc.status == 400 && svc.calls != 0 {
			t.Fatalf("%s: status=%d body=%s calls=%d", tc.body, response.Code, response.Body.String(), svc.calls)
		}
	}
}
