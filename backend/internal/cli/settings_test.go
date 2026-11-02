package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestSettingsAssetSourcesCLI(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want []string
	}{
		{[]string{"--source", "/live/.claude", "--source", ".agents"}, []string{"/live/.claude", ".agents"}},
		{[]string{"--clear"}, []string{}},
	} {
		cfg := setConfigEnv(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/internal/telemetry/cli-invoked" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			var body struct {
				AgentAssetSources []string `json:"agentAssetSources"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if r.Method != http.MethodPatch || r.URL.Path != "/api/v1/settings/agent-asset-sources" || !reflect.DeepEqual(body.AgentAssetSources, tc.want) {
				t.Errorf("request=%s %s sources=%v", r.Method, r.URL.Path, body.AgentAssetSources)
			}
			_, _ = w.Write([]byte(`{"agentAssetSources":[]}`))
		}))
		writeRunFileFor(t, cfg, server)
		_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, append([]string{"settings", "agent-asset-sources"}, tc.args...)...)
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestProjectAssetSourcesJSONPreservesEmptyOverride(t *testing.T) {
	var cfg projectConfig
	if err := json.Unmarshal([]byte(`{"agentAssetSources":[]}`), &cfg); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["agentAssetSources"]; !ok {
		t.Fatal("empty project override was omitted")
	}
}
