package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFactoryRunCLIHTTPBoundary(t *testing.T) {
	for _, operation := range []string{"list", "get", "history", "create", "record", "advance"} {
		t.Run(operation, func(t *testing.T) {
			cfg := setConfigEnv(t)
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/internal/telemetry/") {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				requests++
				path, method := "/api/v1/runs", http.MethodGet
				switch operation {
				case "get":
					path += "/run-1"
				case "history":
					path += "/run-1/evidence"
					if r.URL.Query().Get("afterVersion") != "4" || r.URL.Query().Get("limit") != "7" {
						t.Error("lost history cursor")
					}
				case "create":
					method = http.MethodPost
				case "record":
					path += "/run-1/evidence"
					method = http.MethodPost
				case "advance":
					path += "/run-1/advance"
					method = http.MethodPost
				}
				if r.URL.Path != path || r.Method != method {
					t.Errorf("unexpected request %s %s", r.Method, r.URL)
				}
				if operation == "list" && r.URL.Query().Get("projectId") != "p & one" {
					t.Error("project query changed")
				}
				if method == http.MethodPost {
					var input advanceRunDTO
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Actor != "human" || input.ExpectedVersion != 4 || input.Decision != "approved" {
						t.Errorf("request changed: %+v %v", input, err)
					}
				}
				_, _ = w.Write([]byte(`{"run":{"id":"run-1","version":5},"evidence":[],"blockers":["check_missing"],"nextAction":"hold"}`))
			}))
			defer server.Close()
			writeRunFileFor(t, cfg, server)
			args := []string{"run", operation}
			if operation == "history" {
				args = []string{"run", "get"}
			}
			switch operation {
			case "list":
				args = append(args, "--project", "p & one")
			case "get":
				args = append(args, "run-1")
			case "history":
				args = append(args, "run-1", "--after-version", "4", "--limit", "7")
			case "advance":
				args = append(args, "run-1", "--expected-version", "4", "--actor", "human", "--decision", "approved")
			default:
				file := filepath.Join(t.TempDir(), "receipt.json")
				if err := os.WriteFile(file, []byte(`{"expectedVersion":4,"actor":"human","decision":"approved"}`), 0600); err != nil {
					t.Fatal(err)
				}
				if operation == "record" {
					args = append(args, "run-1")
				}
				args = append(args, "--file", file)
			}
			out, stderr, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, args...)
			if err != nil || requests != 1 || !strings.Contains(out, `"nextAction": "hold"`) {
				t.Fatalf("requests=%d out=%s err=%v stderr=%s", requests, out, err, stderr)
			}
		})
	}
}

func TestFactoryRunCLIValidationAndErrorEnvelope(t *testing.T) {
	for _, args := range [][]string{{"run", "list"}, {"run", "get"}, {"run", "create"}, {"run", "record", "r"}, {"run", "advance", "r", "--actor", "human", "--decision", "approved"}} {
		_, _, err := executeCLI(t, Deps{}, args...)
		if err == nil {
			t.Fatalf("expected usage error: %v", args)
		}
	}
	cfg := setConfigEnv(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/internal/telemetry/") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"RUN_VERSION_CONFLICT","message":"Run changed","requestId":"request-1"}`))
	}))
	defer server.Close()
	writeRunFileFor(t, cfg, server)
	_, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "run", "get", "r")
	if err == nil || !strings.Contains(err.Error(), "RUN_VERSION_CONFLICT") || !strings.Contains(err.Error(), "request-1") {
		t.Fatalf("lost error envelope: %v", err)
	}
}

func TestRunStatusAndAttentionOnlyGet(t *testing.T) {
	cfg := setConfigEnv(t)
	methods := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/internal/telemetry/") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		methods = append(methods, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/api/v1/runs/r/status" {
			_, _ = w.Write([]byte(`{"runId":"r","state":"in_progress","freshness":"unknown"}`))
			return
		}
		if r.URL.Path == "/api/v1/runs/monitoring" {
			_, _ = w.Write([]byte(`{"runs":[]}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	writeRunFileFor(t, cfg, server)
	for _, args := range [][]string{{"run", "status", "r"}, {"run", "attention", "--project", "p"}} {
		if _, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, method := range methods {
		if !strings.HasPrefix(method, "GET ") {
			t.Fatalf("status mutates: %s", method)
		}
	}
}

func TestRunAttentionCursorPage(t *testing.T) {
	cfg := setConfigEnv(t)
	seen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/internal/telemetry/") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/runs/monitoring" || r.URL.Query().Get("afterId") != "run-099" || r.URL.Query().Get("limit") != "25" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		seen = true
		_, _ = w.Write([]byte(`{"runs":[],"nextCursor":"run-124"}`))
	}))
	defer server.Close()
	writeRunFileFor(t, cfg, server)
	if _, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "run", "attention", "--project", "p", "--after-id", "run-099", "--limit", "25"); err != nil {
		t.Fatal(err)
	}
	if !seen {
		t.Fatal("monitoring page was not read")
	}
}
