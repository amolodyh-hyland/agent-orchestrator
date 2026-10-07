package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

type multicaAPIStub struct {
	status      int
	body        string
	method      string
	path        string
	requestBody []byte
}

func (s *multicaAPIStub) RoundTrip(req *http.Request) (*http.Response, error) {
	if !strings.HasPrefix(req.URL.Path, "/api/v1/multica/") {
		return jsonResponse(http.StatusAccepted, ""), nil
	}
	s.method = req.Method
	s.path = req.URL.Path
	if req.Body != nil && req.Body != http.NoBody {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		s.requestBody = body
	}
	return jsonResponse(s.status, s.body), nil
}

func TestMulticaStatusHumanAndJSONOutput(t *testing.T) {
	startedAt := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	nextRetryAt := startedAt.Add(30 * time.Second)
	lastExitAt := startedAt.Add(-time.Minute)
	for _, tc := range []struct {
		name   string
		status multicaDaemonStatus
		want   []string
		omit   []string
	}{
		{
			name: "running",
			status: multicaDaemonStatus{Enabled: true, State: "running", Desired: "running", PID: 123,
				Profile: "default", HealthPort: 4700, StartedAt: &startedAt},
			want: []string{"Multica daemon: running (pid 123)", "Profile: default", "Health port: 4700", "Desired: running", "Restarts: 0"},
		},
		{
			name: "backoff",
			status: multicaDaemonStatus{Enabled: true, State: "backoff", Desired: "running", Profile: "work",
				HealthPort: 4701, Restarts: 3, NextRetryAt: &nextRetryAt, LastError: "daemon exited"},
			want: []string{"Multica daemon: backoff", "Desired: running", "Restarts: 3", "Next retry at: 2026-10-06T12:00:30Z", "Last error: daemon exited"},
		},
		{
			name: "failed",
			status: multicaDaemonStatus{Enabled: true, State: "failed", Desired: "stopped", Profile: "work",
				HealthPort: 4701, LastExit: &multicaLastExit{Code: 1, Signal: "SIGTERM", At: lastExitAt, Crash: true},
				LastError: "startup failed", LogLines: []string{"first log", "last log"}},
			want: []string{"Multica daemon: failed", "Last exit: code 1, signal SIGTERM, crash at 2026-10-06T11:59:00Z", "Last error: startup failed", "Recent logs:\n  first log\n  last log\n"},
		},
		{
			name: "refused configuration",
			status: multicaDaemonStatus{Enabled: true, State: "failed", Desired: "running", Profile: "work",
				HealthPort: 4701, LastExit: &multicaLastExit{Code: 78, At: lastExitAt},
				LastError: "Multica profile token is required"},
			want: []string{"Multica daemon: failed", "Last exit: code 78, configuration refused at 2026-10-06T11:59:00Z", "Last error: Multica profile token is required"},
		},
		{
			name: "external",
			status: multicaDaemonStatus{Enabled: true, State: "external", Desired: "stopped", Profile: "work", HealthPort: 4701,
				Health: &multicaHealth{Status: "ok", PID: 456, DaemonID: "multica-123", Profile: "work", DeviceName: "laptop", ServerURL: "https://multica.example"}},
			want: []string{"Multica daemon: external", "Daemon ID: multica-123", "Server: https://multica.example", "Device: laptop"},
		},
		{
			name:   "disabled",
			status: multicaDaemonStatus{State: "disabled", Desired: "stopped", Profile: "default", HealthPort: 4700},
			want:   []string{"Multica daemon: disabled", "Multica daemon hosting is off. Start the AO daemon with AO_MULTICA_DAEMON=1 to host it."},
			omit:   []string{"Profile:", "Health port:", "Desired:", "Restarts:"},
		},
		{
			name:   "stopped",
			status: multicaDaemonStatus{Enabled: true, State: "stopped", Desired: "stopped", Profile: "default", HealthPort: 4700},
			want:   []string{"Multica daemon: stopped", "Desired: stopped", "Restarts: 0"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := multicaPayload(t, tc.status)
			out, _, stub, err := runMulticaCLI(t, payload, http.StatusOK, "multica", "status")
			if err != nil {
				t.Fatalf("human status: %v", err)
			}
			if stub.method != http.MethodGet || stub.path != "/api/v1/multica/status" {
				t.Fatalf("request = %s %s, want GET /api/v1/multica/status", stub.method, stub.path)
			}
			for _, want := range tc.want {
				if !strings.Contains(out, want) {
					t.Errorf("human status missing %q:\n%s", want, out)
				}
			}
			for _, omitted := range tc.omit {
				if strings.Contains(out, omitted) {
					t.Errorf("human status unexpectedly contains %q:\n%s", omitted, out)
				}
			}

			jsonOut, _, stub, err := runMulticaCLI(t, payload, http.StatusOK, "multica", "status", "--json")
			if err != nil {
				t.Fatalf("JSON status: %v", err)
			}
			if stub.method != http.MethodGet || stub.path != "/api/v1/multica/status" {
				t.Fatalf("JSON request = %s %s, want GET /api/v1/multica/status", stub.method, stub.path)
			}
			var got, want multicaDaemonStatus
			if err := json.Unmarshal([]byte(jsonOut), &got); err != nil {
				t.Fatalf("decode JSON output: %v\n%s", err, jsonOut)
			}
			wantData, _ := json.Marshal(tc.status)
			if err := json.Unmarshal(wantData, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("JSON daemon = %#v, want %#v", got, want)
			}
			if !strings.HasPrefix(jsonOut, "{\n  \"enabled\":") {
				t.Fatalf("JSON daemon should be indented without an outer response envelope:\n%s", jsonOut)
			}
		})
	}
}

func TestMulticaActionsUseRoutesAndPrintStatus(t *testing.T) {
	for _, tc := range []struct {
		action string
		state  string
	}{
		{action: "start", state: "running"},
		{action: "stop", state: "stopped"},
		{action: "restart", state: "running"},
	} {
		t.Run(tc.action, func(t *testing.T) {
			status := multicaDaemonStatus{Enabled: true, State: tc.state, Desired: tc.state, Profile: "default", HealthPort: 4700}
			for _, jsonMode := range []bool{false, true} {
				name := "human"
				args := []string{"multica", tc.action}
				if jsonMode {
					name = "json"
					args = append(args, "--json")
				}
				t.Run(name, func(t *testing.T) {
					out, _, stub, err := runMulticaCLI(t, multicaPayload(t, status), http.StatusOK, args...)
					if err != nil {
						t.Fatalf("command: %v", err)
					}
					wantPath := "/api/v1/multica/" + tc.action
					if stub.method != http.MethodPost || stub.path != wantPath {
						t.Fatalf("request = %s %s, want POST %s", stub.method, stub.path, wantPath)
					}
					if len(stub.requestBody) != 0 {
						t.Fatalf("request body = %q, want no body", stub.requestBody)
					}
					if jsonMode {
						if !strings.HasPrefix(out, "{\n  \"enabled\":") || strings.Contains(out, "\"daemon\":") {
							t.Fatalf("JSON output should be the indented daemon object:\n%s", out)
						}
					} else if !strings.Contains(out, "Multica daemon: "+tc.state) {
						t.Fatalf("human output missing state %q:\n%s", tc.state, out)
					}
				})
			}
		})
	}
}

func TestMulticaActionAPIErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		name       string
		statusCode int
		code       string
		message    string
	}{
		{name: "disabled", statusCode: http.StatusConflict, code: "MULTICA_DISABLED", message: "hosting is disabled"},
		{name: "external", statusCode: http.StatusConflict, code: "MULTICA_EXTERNAL", message: "external Multica daemon holds the profile"},
		{name: "unavailable", statusCode: http.StatusServiceUnavailable, code: "MULTICA_UNAVAILABLE", message: "Multica supervisor is unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"message":"` + tc.message + `","code":"` + tc.code + `"}`
			_, _, _, err := runMulticaCLI(t, body, tc.statusCode, "multica", "start")
			if err == nil || ExitCode(err) == 0 {
				t.Fatalf("error = %v, want non-zero exit", err)
			}
			var apiErr apiResponseError
			if !errors.As(err, &apiErr) {
				t.Fatalf("error type = %T, want apiResponseError", err)
			}
			if apiErr.StatusCode != tc.statusCode || apiErr.ErrorBody.Code != tc.code || apiErr.ErrorBody.Message != tc.message {
				t.Fatalf("API error = %#v", apiErr)
			}
			if !strings.Contains(err.Error(), tc.message) || !strings.Contains(err.Error(), tc.code) {
				t.Fatalf("error %q should preserve the server message and code", err)
			}
		})
	}
}

func TestMulticaActionsRequireHTTP200(t *testing.T) {
	status := multicaDaemonStatus{Enabled: true, State: "running", Desired: "running", Profile: "default", HealthPort: 4700}
	_, _, _, err := runMulticaCLI(t, multicaPayload(t, status), http.StatusAccepted, "multica", "start")
	if err == nil || ExitCode(err) == 0 || !strings.Contains(err.Error(), "HTTP 202") {
		t.Fatalf("error = %v, want non-zero HTTP 202 failure", err)
	}
}

func TestMulticaDaemonNotRunning(t *testing.T) {
	setConfigEnv(t)
	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "multica", "status")
	if err == nil || !strings.Contains(err.Error(), "AO daemon is not running — start it with `ao start`") {
		t.Fatalf("error = %v, want daemon-not-running diagnostic", err)
	}
}

func TestMulticaHelpExplainsSupervision(t *testing.T) {
	out, _, err := executeCLI(t, Deps{}, "multica", "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Stop and restart through this command", "keep AO supervising the daemon", "multica daemon restart", "standalone daemon", "AO does not supervise"} {
		if !strings.Contains(out, want) {
			t.Errorf("help missing %q:\n%s", want, out)
		}
	}
}

func multicaPayload(t *testing.T, status multicaDaemonStatus) string {
	t.Helper()
	body, err := json.Marshal(multicaResponse{Daemon: status})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func runMulticaCLI(t *testing.T, body string, status int, args ...string) (string, string, *multicaAPIStub, error) {
	t.Helper()
	cfg := setConfigEnv(t)
	if err := runfile.Write(cfg.runFile, runfile.Info{PID: os.Getpid(), Port: 3001, StartedAt: time.Unix(100, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	stub := &multicaAPIStub{status: status, body: body}
	out, errOut, err := executeCLI(t, Deps{
		HTTPClient:   &http.Client{Transport: stub},
		ProcessAlive: func(int) bool { return true },
	}, args...)
	return out, errOut, stub, err
}
