package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

func TestOuterPlanCLIOnlyStagesExactManifest(t *testing.T) {
	cfg := setConfigEnv(t)
	raw := `{"requestId":"human-request","sourceProjects":["a"],"actions":[{"operation":"send","projectId":"a","sessionId":"a-coordinator","text":"Exact text","config":{},"dependsOn":[]}]}`
	file := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		if r.URL.Path == "/internal/telemetry/cli-invoked" {
			w.WriteHeader(http.StatusNoContent)
			return w.Result(), nil
		}
		calls++
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/outer/plans" {
			t.Error("unexpected execution route", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if strings.TrimSpace(string(body)) != raw {
			t.Error("manifest changed", string(body))
		}
		if r.Header.Get("X-AO-Scope-Credential") != "owned-scope" {
			t.Error("scope missing")
		}
		_, _ = io.WriteString(w, `{"digest":"sealed","approvedAt":"0001-01-01T00:00:00Z"}`)
		return w.Result(), nil
	})}
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 9999, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_SCOPE_CREDENTIAL", "owned-scope")
	out, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }, HTTPClient: client}, "outer", "plan", "--file", file)
	if err != nil || calls != 1 || !strings.Contains(out, "sealed") {
		t.Fatal(out, calls, err)
	}
	for _, args := range [][]string{{"outer", "plan"}, {"outer", "plan", "--approve"}, {"outer", "plan", "--file", file, "extra"}} {
		if _, _, err := executeCLI(t, Deps{}, args...); err == nil || ExitCode(err) != 2 {
			t.Fatal("invalid CLI accepted", args, err)
		}
	}
	if calls != 1 {
		t.Fatal("validation performed network I/O")
	}
}
