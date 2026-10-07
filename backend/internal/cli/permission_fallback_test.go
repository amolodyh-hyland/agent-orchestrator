package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestProjectSetConfig_PermissionFallbackFlag(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string // the raw permissionFallback member, or "" when it must be absent
	}{
		{"omitted keeps the daemon default", []string{"--permission", "auto"}, ""},
		{"explicitly off", []string{"--permission", "bypass-permissions", "--permission-fallback=false"}, "false"},
		{"explicitly on", []string{"--permission", "bypass-permissions", "--permission-fallback=true"}, "true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := setConfigEnv(t)
			srv, capture := projectServer(t, http.StatusOK, `{"project":{"id":"demo","path":"/repo/demo"}}`)
			writeRunFileFor(t, cfg, srv)

			args := append([]string{"project", "set-config", "demo"}, tc.args...)
			_, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, args...)
			if err != nil {
				t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
			}
			var body struct {
				Config struct {
					AgentConfig map[string]json.RawMessage `json:"agentConfig"`
				} `json:"config"`
			}
			if err := json.Unmarshal(capture.body, &body); err != nil {
				t.Fatalf("decode request: %v\nbody=%s", err, capture.body)
			}
			got, present := body.Config.AgentConfig["permissionFallback"]
			if tc.want == "" && present {
				t.Fatalf("permissionFallback = %s was sent although the flag was not passed", got)
			}
			if tc.want != "" && string(got) != tc.want {
				t.Fatalf("permissionFallback = %s, want %s", got, tc.want)
			}
		})
	}
}

// --config-json passes the whole object through the CLI's mirror of AgentConfig, so
// the mirror must carry the field or a deliberate "off" would be silently dropped.
func TestProjectSetConfig_ConfigJSONKeepsPermissionFallback(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := projectServer(t, http.StatusOK, `{"project":{"id":"demo","path":"/repo/demo"}}`)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }},
		"project", "set-config", "demo", "--config-json",
		`{"agentConfig":{"permissions":"bypass-permissions","permissionFallback":false}}`)
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	var got setConfigRequest
	if err := json.Unmarshal(capture.body, &got); err != nil {
		t.Fatalf("decode request: %v\nbody=%s", err, capture.body)
	}
	if got.Config.AgentConfig.PermissionFallback == nil || *got.Config.AgentConfig.PermissionFallback {
		t.Fatalf("agentConfig = %#v, want permissionFallback=false preserved", got.Config.AgentConfig)
	}
}

func TestWriteSessionDetails_ShowsEffectivePermissions(t *testing.T) {
	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)
	if err := writeSessionDetails(cmd, sessionDTO{ID: "demo-1", Status: "working", Permissions: "auto"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "permissions: auto\n") {
		t.Fatalf("details do not show the effective permissions:\n%s", out.String())
	}

	out.Reset()
	if err := writeSessionDetails(cmd, sessionDTO{ID: "demo-1", Status: "working"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "permissions:") {
		t.Fatalf("details show a permissions line for a session that reports none:\n%s", out.String())
	}
}
