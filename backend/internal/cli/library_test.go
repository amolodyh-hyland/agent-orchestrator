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

func TestLibraryCLIUsesHTTPAndPreservesEnvelope(t *testing.T) {
	for _, status := range []int{200, 409} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			cfg := setConfigEnv(t)
			seen := false
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/internal/") {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				seen = true
				if r.URL.Path != "/api/v1/library/operations" || r.Method != http.MethodPost {
					t.Errorf("request=%s %s", r.Method, r.URL.Path)
				}
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				if request["operation"] != "inspect" || request["sourceId"] != "source" {
					t.Errorf("body=%v", request)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				if status == 200 {
					_, _ = w.Write([]byte(`{"status":"unsupported_provider"}`))
				} else {
					_, _ = w.Write([]byte(`{"code":"LIBRARY_UNAVAILABLE","message":"inspection_required","requestId":"req_1"}`))
				}
			}))
			defer srv.Close()
			writeRunFileFor(t, cfg, srv)
			file := filepath.Join(t.TempDir(), "request.json")
			if err := os.WriteFile(file, []byte(`{"sourceId":"source","expectedRevision":1}`), 0600); err != nil {
				t.Fatal(err)
			}
			out, _, err := executeCLI(t, Deps{ProcessAlive: func(int) bool { return true }}, "library", "inspect", "--file", file)
			if !seen {
				t.Fatal("no HTTP request")
			}
			if status == 200 {
				if err != nil || !strings.Contains(out, "unsupported_provider") {
					t.Fatalf("out=%s err=%v", out, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "LIBRARY_UNAVAILABLE") {
				t.Fatalf("error=%v", err)
			}
		})
	}
}
func TestLibraryCLIRequiresExactRequestFile(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "library", "approve")
	if ExitCode(err) != 2 {
		t.Fatalf("error=%v code=%d", err, ExitCode(err))
	}
}
