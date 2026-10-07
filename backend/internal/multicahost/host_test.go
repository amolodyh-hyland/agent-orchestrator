package multicahost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

func TestEnabled(t *testing.T) {
	tests := []struct {
		value string
		want  bool
	}{
		{value: "1", want: true},
		{value: "true", want: true},
		{value: "TRUE", want: true},
		{value: "on", want: true},
		{value: "On", want: true},
		{value: "", want: false},
		{value: "yes", want: false},
		{value: "false", want: false},
		{value: "2", want: false},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%q", tt.value), func(t *testing.T) {
			if got := Enabled(func(string) string { return tt.value }); got != tt.want {
				t.Fatalf("Enabled(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestRunChildRefusals(t *testing.T) {
	tests := []struct {
		name       string
		prepare    func(*testing.T, *dependencies, string)
		wantString string
	}{
		{
			name: "missing token",
			prepare: func(t *testing.T, _ *dependencies, stateDir string) {
				if err := os.Remove(filepath.Join(stateDir, "config.json")); err != nil {
					t.Fatal(err)
				}
			},
			wantString: "token is required",
		},
		{
			name: "empty token",
			prepare: func(t *testing.T, _ *dependencies, stateDir string) {
				writeProfileConfig(t, stateDir, `{"token":"","server_url":"http://localhost:8080"}`)
			},
			wantString: "token is required",
		},
		{
			name: "malformed config",
			prepare: func(t *testing.T, _ *dependencies, stateDir string) {
				writeProfileConfig(t, stateDir, `{"token":`)
			},
			wantString: "token is required",
		},
		{
			name: "non-local server",
			prepare: func(t *testing.T, _ *dependencies, stateDir string) {
				writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"https://api.example.com"}`)
			},
			wantString: "requires a local server URL",
		},
		{
			name: "busy health port",
			prepare: func(_ *testing.T, deps *dependencies, _ string) {
				deps.portInUse = func(int) bool { return true }
			},
			wantString: "health port",
		},
		{
			name: "another profile alive",
			prepare: func(t *testing.T, deps *dependencies, stateDir string) {
				home := filepath.Dir(stateDir)
				otherProfileDir := filepath.Join(home, ".multica", "profiles", "other")
				if err := os.MkdirAll(otherProfileDir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(otherProfileDir, "daemon.pid"), []byte("1234\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				deps.processLive = func(pid int) bool { return pid == 1234 }
			},
			wantString: `profile "other" is already running`,
		},
		{
			name: "another profile health port is in use",
			prepare: func(t *testing.T, deps *dependencies, stateDir string) {
				otherProfileDir := filepath.Join(stateDir, "profiles", "other")
				if err := os.MkdirAll(otherProfileDir, 0o755); err != nil {
					t.Fatal(err)
				}
				otherPort := HealthPort(func(key string) string {
					if key == ProfileEnv {
						return "other"
					}
					return ""
				})
				deps.portInUse = func(port int) bool { return port == otherPort }
			},
			wantString: `profile "other" is already running`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			deps, stateDir := testDependencies(t, home, map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
			tt.prepare(t, &deps, stateDir)
			deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
				t.Fatal("loaded config after preflight refusal")
				return daemonhost.Config{}, nil
			}
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
				t.Fatal("constructed daemon after preflight refusal")
				return nil
			}

			err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps)
			var configErr *ErrConfiguration
			if !errors.As(err, &configErr) {
				t.Fatalf("error = %v, want ErrConfiguration", err)
			}
			if !strings.Contains(err.Error(), tt.wantString) {
				t.Fatalf("error = %q, want it to contain %q", err, tt.wantString)
			}
			if strings.ContainsAny(err.Error(), "\r\n") {
				t.Fatalf("refusal error is not one line: %q", err)
			}
		})
	}
}

func TestRunChildLoadConfigFailureIsConfigurationRefusal(t *testing.T) {
	deps, stateDir := testDependencies(t, t.TempDir(), map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		return daemonhost.Config{}, errors.New("no agent CLI found\nfor configured agent")
	}
	var stderr bytes.Buffer
	err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(&stderr, nil)), deps)
	var configErr *ErrConfiguration
	if !errors.As(err, &configErr) {
		t.Fatalf("error = %v, want ErrConfiguration", err)
	}
	if ExitConfig != 78 {
		t.Fatalf("configuration exit code = %d, want 78", ExitConfig)
	}
	if strings.ContainsAny(err.Error(), "\r\n") {
		t.Fatalf("configuration refusal is not one line: %q", err)
	}
	fmt.Fprintln(&stderr, err)
	if lines := strings.Count(strings.TrimSpace(stderr.String()), "\n") + 1; lines != 1 {
		t.Fatalf("stderr lines = %d, want one: %q", lines, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(stateDir, "daemon.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon.pid exists after config refusal: %v", err)
	}
}

func TestRunChildServerURLPrecedence(t *testing.T) {
	const profileURL = "http://127.0.0.1:8080"
	tests := []struct {
		name    string
		envURL  string
		noURL   bool
		wantURL string
	}{
		{name: "environment over profile", envURL: "http://localhost:8081", wantURL: "http://localhost:8081"},
		{name: "profile config", wantURL: profileURL},
		{name: "default when absent", noURL: true, wantURL: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			values := map[string]string{FlagEnv: "1", HealthPortEnv: "19617"}
			if tt.envURL != "" {
				values["MULTICA_SERVER_URL"] = tt.envURL
			}
			deps, stateDir := testDependencies(t, t.TempDir(), values)
			if tt.noURL {
				writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token"}`)
			} else if tt.envURL == "" {
				writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"`+profileURL+`"}`)
			}
			var gotURL string
			deps.loadConfig = func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
				gotURL = overrides.ServerURL
				serverURL := gotURL
				if serverURL == "" {
					serverURL = daemonhost.DefaultServerURL
				}
				return daemonhost.Config{ServerBaseURL: serverURL}, nil
			}
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon { return fakeDaemon{} }

			if err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
				t.Fatalf("runChildWith: %v", err)
			}
			if gotURL != tt.wantURL {
				t.Fatalf("Overrides.ServerURL = %q, want %q", gotURL, tt.wantURL)
			}
		})
	}
}

func TestRunChildRefusesLiveDefaultProfileForNamedProfile(t *testing.T) {
	home := t.TempDir()
	deps, _ := testDependencies(t, home, map[string]string{FlagEnv: "1", ProfileEnv: "desktop", HealthPortEnv: "19617"})
	if err := os.WriteFile(filepath.Join(home, ".multica", "daemon.pid"), []byte("1234\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deps.processLive = func(pid int) bool { return pid == 1234 }
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		t.Fatal("loaded config despite the live default profile")
		return daemonhost.Config{}, nil
	}
	err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps)
	var configErr *ErrConfiguration
	if !errors.As(err, &configErr) || !strings.Contains(err.Error(), `profile "default"`) {
		t.Fatalf("error = %v, want a default-profile configuration refusal", err)
	}
}

func TestRunChildIgnoresStaleOtherProfilePID(t *testing.T) {
	home := t.TempDir()
	deps, _ := testDependencies(t, home, map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
	staleProfileDir := filepath.Join(home, ".multica", "profiles", "stale")
	if err := os.MkdirAll(staleProfileDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staleProfileDir, "daemon.pid"), []byte("2147483647\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deps.processLive = func(int) bool { return false }
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon { return fakeDaemon{} }

	if err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
		t.Fatalf("runChildWith refused a stale PID: %v", err)
	}
}

func TestRunChildDisabledDoesNothing(t *testing.T) {
	stateRoot := t.TempDir()
	deps := dependencies{
		getenv: func(key string) string {
			if key == FlagEnv {
				return "off"
			}
			panic("read environment while disabled: " + key)
		},
		homeDir: func() (string, error) {
			t.Fatal("resolved home while disabled")
			return "", nil
		},
	}
	err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps)
	var configErr *ErrConfiguration
	if !errors.As(err, &configErr) || !strings.Contains(err.Error(), "hosting is disabled") {
		t.Fatalf("error = %v, want disabled ErrConfiguration", err)
	}
	entries, err := os.ReadDir(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("flag-off child created files: %v", entries)
	}
}

func TestRunChildWritesPIDBeforeRunAndRemovesIt(t *testing.T) {
	home := t.TempDir()
	port := 19617
	deps, stateDir := testDependencies(t, home, map[string]string{
		FlagEnv:       "true",
		ProfileEnv:    "desktop-localhost",
		HealthPortEnv: strconv.Itoa(port),
	})
	var gotOverrides daemonhost.Overrides
	var gotConfig daemonhost.Config
	deps.loadConfig = func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
		gotOverrides = overrides
		return daemonhost.Config{
			ServerBaseURL:     "http://localhost:8080",
			AutoUpdateEnabled: true,
			AutoReloadEnabled: true,
		}, nil
	}
	deps.newDaemon = func(cfg daemonhost.Config, logger *slog.Logger) daemon {
		gotConfig = cfg
		return fakeDaemon{run: func(context.Context) error {
			pidPath := filepath.Join(stateDir, "daemon.pid")
			pidInfo, err := os.Stat(pidPath)
			if err != nil {
				t.Fatalf("daemon.pid missing before Run: %v", err)
			}
			if got := pidInfo.Mode().Perm(); got != 0o644 {
				t.Fatalf("daemon.pid mode = %04o, want 0644", got)
			}
			contents, err := os.ReadFile(pidPath)
			if err != nil {
				t.Fatalf("daemon.pid missing before Run: %v", err)
			}
			if strings.TrimSpace(string(contents)) != strconv.Itoa(os.Getpid()) {
				t.Fatalf("daemon.pid = %q, want this process pid", contents)
			}
			if _, err := os.Stat(filepath.Join(stateDir, "daemon.log")); err != nil {
				t.Fatalf("daemon.log missing before Run: %v", err)
			}
			logger.Info("test daemon ran")
			return nil
		}}
	}
	var stderr bytes.Buffer
	err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(&stderr, nil)), deps)
	if err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
	if gotOverrides.Profile != "desktop-localhost" || gotOverrides.HealthPort != port {
		t.Fatalf("overrides = %+v, want profile and health port", gotOverrides)
	}
	if !gotOverrides.DisableAutoUpdate || !gotOverrides.DisableAutoReload {
		t.Fatalf("overrides = %+v, want auto-update and auto-reload disabled", gotOverrides)
	}
	if gotConfig.Profile != gotOverrides.Profile || gotConfig.HealthPort != port || gotConfig.AutoUpdateEnabled || gotConfig.AutoReloadEnabled {
		t.Fatalf("managed config = %+v", gotConfig)
	}
	if gotConfig.LaunchedBy != "desktop" || gotConfig.CLIVersion != "0.0.0-ao-hosted" {
		t.Fatalf("managed config identity = %q / %q", gotConfig.LaunchedBy, gotConfig.CLIVersion)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "daemon.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon.pid remains after Run: %v", err)
	}
	logContents, err := os.ReadFile(filepath.Join(stateDir, "daemon.log"))
	if err != nil || !strings.Contains(string(logContents), "test daemon ran") {
		t.Fatalf("daemon.log = %q, err=%v", logContents, err)
	}
	if !strings.Contains(stderr.String(), "test daemon ran") {
		t.Fatalf("stderr logs = %q, want daemon log", stderr.String())
	}
}

func TestRunChildDoesNotRemovePIDReplacedByAnotherProcess(t *testing.T) {
	home := t.TempDir()
	deps, stateDir := testDependencies(t, home, map[string]string{FlagEnv: "on", HealthPortEnv: "19617"})
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(context.Context) error {
			return os.WriteFile(filepath.Join(stateDir, "daemon.pid"), []byte("54321\n"), 0o644)
		}}
	}
	if err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(stateDir, "daemon.pid"))
	if err != nil || strings.TrimSpace(string(contents)) != "54321" {
		t.Fatalf("daemon.pid = %q, err=%v, want the replacement pid", contents, err)
	}
}

func TestRunChildWatchStdinCancelsOnEOF(t *testing.T) {
	deps, _ := testDependencies(t, t.TempDir(), map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
	started := make(chan struct{})
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}}
	}
	if err := runChildWith(context.Background(), strings.NewReader(""), true, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
	select {
	case <-started:
	default:
		t.Fatal("daemon did not start")
	}
}

func TestRunChildDoesNotReadStdinWithoutWatch(t *testing.T) {
	deps, _ := testDependencies(t, t.TempDir(), map[string]string{FlagEnv: "on", HealthPortEnv: "19617"})
	reader := &countingReader{}
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(ctx context.Context) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(20 * time.Millisecond):
				return nil
			}
		}}
	}
	if err := runChildWith(context.Background(), reader, false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
	if reader.reads != 0 {
		t.Fatalf("stdin was read %d times without --watch-stdin", reader.reads)
	}
}

func TestRunChildPrependsValidCLIPath(t *testing.T) {
	home := t.TempDir()
	cliDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(cliDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cliPath := filepath.Join(cliDir, "multica")
	if err := os.WriteFile(cliPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{FlagEnv: "1", HealthPortEnv: "19617", CLIPathEnv: cliPath, "PATH": "original-path"}
	deps, _ := testDependencies(t, home, values)
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(context.Context) error {
			if got, want := values["PATH"], cliDir+string(os.PathListSeparator)+"original-path"; got != want {
				t.Fatalf("PATH = %q, want %q", got, want)
			}
			return nil
		}}
	}
	if err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps); err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
}

func TestRunChildIgnoresBadCLIPathWithWarning(t *testing.T) {
	badCLIPath := filepath.Join(t.TempDir(), "multica")
	if err := os.WriteFile(badCLIPath, []byte("not executable"), 0o644); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{FlagEnv: "1", HealthPortEnv: "19617", CLIPathEnv: badCLIPath, "PATH": "original-path"}
	deps, _ := testDependencies(t, t.TempDir(), values)
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon { return fakeDaemon{} }
	var logs bytes.Buffer
	if err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(&logs, nil)), deps); err != nil {
		t.Fatalf("runChildWith: %v", err)
	}
	if values["PATH"] != "original-path" {
		t.Fatalf("PATH changed for invalid CLI: %q", values["PATH"])
	}
	if !strings.Contains(logs.String(), "ignoring invalid Multica CLI path") {
		t.Fatalf("logs = %q, want invalid-path warning", logs.String())
	}
}

func TestRunChildExitMapping(t *testing.T) {
	tests := []struct {
		name    string
		runErr  error
		wantErr bool
	}{
		{name: "nil"},
		{name: "cancellation", runErr: context.Canceled},
		{name: "other error", runErr: errors.New("daemon failed"), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deps, _ := testDependencies(t, t.TempDir(), map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
				return fakeDaemon{run: func(context.Context) error { return tt.runErr }}
			}
			err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(io.Discard, nil)), deps)
			if (err != nil) != tt.wantErr {
				t.Fatalf("runChildWith error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestRunChildLogsRestartRequestAndExitsSuccessfully(t *testing.T) {
	deps, _ := testDependencies(t, t.TempDir(), map[string]string{FlagEnv: "1", HealthPortEnv: "19617"})
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(context.Context) error { return errors.New("restart requested") }, restartPath: "/tmp/multica-next"}
	}
	var logs bytes.Buffer
	err := runChildWith(context.Background(), strings.NewReader(""), false, slog.New(slog.NewTextHandler(&logs, nil)), deps)
	if err != nil {
		t.Fatalf("runChildWith: %v, want successful restart exit", err)
	}
	if !strings.Contains(logs.String(), "Multica daemon requested restart") || !strings.Contains(logs.String(), "/tmp/multica-next") {
		t.Fatalf("logs = %q, want restart request and binary path", logs.String())
	}
}

func TestRequireLocalServer(t *testing.T) {
	tests := []struct {
		serverURL string
		allowed   bool
	}{
		{serverURL: "http://localhost:8080", allowed: true},
		{serverURL: "http://127.0.0.1:9", allowed: true},
		{serverURL: "http://[::1]:8080", allowed: true},
		{serverURL: "ws://localhost:8080/ws", allowed: true},
		{serverURL: "https://api.example.com"},
		{serverURL: "http://10.0.0.5:8080"},
		{serverURL: "http://localhost.evil.com:8080"},
		{serverURL: "http://user:secret@evil.example.com/x"},
	}
	for _, tt := range tests {
		t.Run(tt.serverURL, func(t *testing.T) {
			err := requireLocalServer(tt.serverURL)
			if tt.allowed {
				if err != nil {
					t.Fatalf("requireLocalServer(%q): %v", tt.serverURL, err)
				}
				return
			}
			var nonLocal *ErrNonLocalServer
			if !errors.As(err, &nonLocal) {
				t.Fatalf("error = %v, want ErrNonLocalServer", err)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "user:") || strings.Contains(err.Error(), "evil.example.com/x") {
				t.Fatalf("non-local URL error exposed credentials or path: %q", err)
			}
		})
	}
}

func testDependencies(t *testing.T, home string, values map[string]string) (dependencies, string) {
	t.Helper()
	profile := strings.TrimSpace(values[ProfileEnv])
	stateDir, err := StateDir(home, profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("create profile directory: %v", err)
	}
	writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"http://localhost:8080"}`)
	deps := dependencies{
		getenv: func(name string) string { return values[name] },
		setenv: func(name, value string) error {
			values[name] = value
			return nil
		},
		homeDir: func() (string, error) { return home, nil },
		loadConfig: func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
			serverURL := overrides.ServerURL
			if serverURL == "" {
				serverURL = daemonhost.DefaultServerURL
			}
			return daemonhost.Config{
				Profile:           overrides.Profile,
				HealthPort:        overrides.HealthPort,
				ServerBaseURL:     serverURL,
				AutoUpdateEnabled: !overrides.DisableAutoUpdate,
				AutoReloadEnabled: !overrides.DisableAutoReload,
			}, nil
		},
		newDaemon:   func(daemonhost.Config, *slog.Logger) daemon { return fakeDaemon{} },
		processLive: func(int) bool { return false },
		portInUse:   func(int) bool { return false },
		pid:         os.Getpid,
	}
	return deps, stateDir
}

type fakeDaemon struct {
	run         func(context.Context) error
	restartPath string
}

func (d fakeDaemon) Run(ctx context.Context) error {
	if d.run != nil {
		return d.run(ctx)
	}
	return nil
}

func (d fakeDaemon) RestartBinary() string { return d.restartPath }

type countingReader struct {
	reads int
}

func (r *countingReader) Read([]byte) (int, error) {
	r.reads++
	return 0, io.EOF
}

func writeProfileConfig(t *testing.T, stateDir, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(stateDir, "config.json"), []byte(contents), 0o600); err != nil {
		t.Fatalf("write profile config: %v", err)
	}
}
