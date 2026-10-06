package multicahost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

func TestInProcessEnabled(t *testing.T) {
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
			if got := inProcessEnabled(tt.value); got != tt.want {
				t.Fatalf("inProcessEnabled(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestHealthPortForProfileMatchesMulticaFormula(t *testing.T) {
	for _, profile := range []string{"", "desktop-localhost", "a", "zzz"} {
		var sum int
		for _, b := range []byte(profile) {
			sum += int(b)
		}
		want := daemonhost.DefaultHealthPort
		if profile != "" {
			want += 1 + sum%1000
		}
		if got := healthPortForProfile(profile); got != want {
			t.Errorf("healthPortForProfile(%q) = %d, want %d", profile, got, want)
		}
	}
}

func TestStartWithFlagOffDoesNothing(t *testing.T) {
	deps := dependencies{
		getenv: func(name string) string {
			if name == enabledEnv {
				return "off"
			}
			panic("read environment while disabled: " + name)
		},
	}
	stop, err := startWith(context.Background(), slog.Default(), deps)
	if err != nil {
		t.Fatalf("startWith returned error while disabled: %v", err)
	}
	stop()
}

func TestStartWithUsesOverridesAndManagedConfig(t *testing.T) {
	home := t.TempDir()
	port := freePort(t)
	values := map[string]string{
		enabledEnv:    "true",
		profileEnv:    "desktop-localhost",
		healthPortEnv: strconv.Itoa(port),
	}
	var gotOverrides daemonhost.Overrides
	var gotConfig daemonhost.Config
	runStarted := make(chan struct{})
	deps := testDependencies(t, home, values)
	deps.loadConfig = func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
		gotOverrides = overrides
		return daemonhost.Config{
			Profile:           overrides.Profile,
			HealthPort:        overrides.HealthPort,
			ServerBaseURL:     "http://localhost:8080",
			AutoUpdateEnabled: !overrides.DisableAutoUpdate,
			AutoReloadEnabled: !overrides.DisableAutoReload,
		}, nil
	}
	deps.newDaemon = func(cfg daemonhost.Config, _ *slog.Logger) daemon {
		gotConfig = cfg
		return fakeDaemon{run: func(ctx context.Context) error {
			close(runStarted)
			<-ctx.Done()
			return ctx.Err()
		}}
	}

	stop, err := startWith(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), deps)
	if err != nil {
		t.Fatalf("startWith: %v", err)
	}
	<-runStarted
	if gotOverrides.Profile != "desktop-localhost" || gotOverrides.HealthPort != port {
		t.Fatalf("overrides = %+v, want profile and port", gotOverrides)
	}
	if !gotOverrides.DisableAutoUpdate || !gotOverrides.DisableAutoReload {
		t.Fatalf("overrides = %+v, want auto-update and auto-reload disabled", gotOverrides)
	}
	if gotConfig.Profile != "desktop-localhost" || gotConfig.HealthPort != port {
		t.Fatalf("config profile/port = %q/%d, want %q/%d", gotConfig.Profile, gotConfig.HealthPort, "desktop-localhost", port)
	}
	if gotConfig.AutoUpdateEnabled || gotConfig.AutoReloadEnabled {
		t.Fatalf("auto-update/reload = %v/%v, want both disabled", gotConfig.AutoUpdateEnabled, gotConfig.AutoReloadEnabled)
	}
	if gotConfig.LaunchedBy != "desktop" || gotConfig.CLIVersion != managedCLIVersion {
		t.Fatalf("managed config = launched_by %q, cli_version %q", gotConfig.LaunchedBy, gotConfig.CLIVersion)
	}
	stateDir := filepath.Join(home, ".multica", "profiles", "desktop-localhost")
	if _, err := os.Stat(filepath.Join(stateDir, "daemon.log")); err != nil {
		t.Fatalf("daemon log was not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "daemon.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon.pid exists or could not be checked: %v", err)
	}
	stop()
}

func TestStartWithRequiresProfileTokenBeforeLoadingConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  string
		missing bool
	}{
		{name: "missing", missing: true},
		{name: "empty token", config: `{"token":"","server_url":"http://localhost:8080"}`},
		{name: "malformed JSON", config: `{"token":`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			deps := testDependencies(t, home, map[string]string{enabledEnv: "on", healthPortEnv: strconv.Itoa(freePort(t))})
			configPath := filepath.Join(home, ".multica", "config.json")
			if tt.missing {
				if err := os.Remove(configPath); err != nil {
					t.Fatalf("remove profile config: %v", err)
				}
			} else {
				writeProfileConfig(t, filepath.Dir(configPath), tt.config)
			}
			deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
				t.Fatal("loaded daemon config without a usable profile token")
				return daemonhost.Config{}, nil
			}
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
				t.Fatal("constructed daemon without a usable profile token")
				return nil
			}

			_, err := startWith(context.Background(), slog.Default(), deps)
			var noToken *ErrNoToken
			if !errors.As(err, &noToken) {
				t.Fatalf("error = %v, want ErrNoToken", err)
			}
			if noToken.ConfigPath != configPath || !strings.Contains(err.Error(), configPath) {
				t.Fatalf("error = %q, want config path %q", err, configPath)
			}
		})
	}
}

func TestStartWithDoesNotExposeProfileToken(t *testing.T) {
	const token = "recognizable-fake-token"
	home := t.TempDir()
	deps := testDependencies(t, home, map[string]string{enabledEnv: "on", healthPortEnv: strconv.Itoa(freePort(t))})
	var output strings.Builder
	logger := slog.New(slog.NewTextHandler(&output, nil))
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		return daemonhost.Config{}, errors.New("configuration unavailable")
	}
	_, err := startWith(context.Background(), logger, deps)
	if err == nil {
		t.Fatal("startWith succeeded despite the injected config failure")
	}
	logStartFailure(logger, err)
	if strings.Contains(err.Error(), token) || strings.Contains(output.String(), token) {
		t.Fatalf("profile token leaked into error or log output: err=%q logs=%q", err, output.String())
	}
}

func TestStartWithServerURLPrecedence(t *testing.T) {
	const profileURL = "http://127.0.0.1:8080"
	tests := []struct {
		name    string
		envURL  string
		wantURL string
	}{
		{name: "environment over profile", envURL: "http://localhost:8081", wantURL: "http://localhost:8081"},
		{name: "profile config", wantURL: profileURL},
		{name: "empty when neither is set"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			values := map[string]string{enabledEnv: "on", profileEnv: "url-precedence", healthPortEnv: strconv.Itoa(freePort(t))}
			if tt.envURL != "" {
				values["MULTICA_SERVER_URL"] = tt.envURL
			}
			deps := testDependencies(t, home, values)
			stateDir, _ := profileStateDir(home, values[profileEnv])
			writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"`+profileURL+`"}`)
			if tt.name == "empty when neither is set" {
				writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token"}`)
			}
			var gotURL string
			deps.loadConfig = func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
				gotURL = overrides.ServerURL
				return daemonhost.Config{ServerBaseURL: localURLFor(overrides.ServerURL)}, nil
			}
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
				return fakeDaemon{run: func(context.Context) error { return nil }}
			}

			stop, err := startWith(context.Background(), slog.Default(), deps)
			if err != nil {
				t.Fatalf("startWith: %v", err)
			}
			stop()
			if gotURL != tt.wantURL {
				t.Fatalf("Overrides.ServerURL = %q, want %q", gotURL, tt.wantURL)
			}
		})
	}
}

func TestStartWithRequiresLocalServerURL(t *testing.T) {
	tests := []struct {
		url     string
		allowed bool
	}{
		{url: "http://localhost:8080", allowed: true},
		{url: "http://127.0.0.1:9", allowed: true},
		{url: "http://[::1]:8080", allowed: true},
		{url: "ws://localhost:8080/ws", allowed: true},
		{url: "https://api.example.com"},
		{url: "http://10.0.0.5:8080"},
		{url: "http://localhost.evil.com:8080"},
		{url: "http://user:secret@evil.example.com/x"},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			home := t.TempDir()
			deps := testDependencies(t, home, map[string]string{enabledEnv: "on", healthPortEnv: strconv.Itoa(freePort(t))})
			stateDir, _ := profileStateDir(home, "")
			writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"`+tt.url+`"}`)
			deps.loadConfig = func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
				return daemonhost.Config{ServerBaseURL: overrides.ServerURL}, nil
			}
			constructed := false
			deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
				constructed = true
				return fakeDaemon{run: func(context.Context) error { return nil }}
			}

			stop, err := startWith(context.Background(), slog.Default(), deps)
			if tt.allowed {
				if err != nil {
					t.Fatalf("startWith refused local URL: %v", err)
				}
				stop()
				if !constructed {
					t.Fatal("daemon constructor was not called for local URL")
				}
				return
			}
			var nonLocal *ErrNonLocalServer
			if !errors.As(err, &nonLocal) {
				t.Fatalf("error = %v, want ErrNonLocalServer", err)
			}
			if constructed {
				t.Fatal("daemon constructor was called for non-local URL")
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "user:") || strings.Contains(err.Error(), "evil.example.com/x") {
				t.Fatalf("non-local URL error exposed userinfo or path: %q", err)
			}
		})
	}
}

func TestStartWithCancelsContextWhenRunnerReturns(t *testing.T) {
	deps := testDependencies(t, t.TempDir(), map[string]string{enabledEnv: "on", healthPortEnv: strconv.Itoa(freePort(t))})
	var runCtx context.Context
	cancelledAfterRun := make(chan error, 1)
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{
			run: func(ctx context.Context) error {
				runCtx = ctx
				return errors.New("runner failed")
			},
			restart: func() string {
				cancelledAfterRun <- runCtx.Err()
				return ""
			},
		}
	}
	_, err := startWith(context.Background(), slog.Default(), deps)
	if err != nil {
		t.Fatalf("startWith returned runner error synchronously: %v", err)
	}
	select {
	case ctxErr := <-cancelledAfterRun:
		if ctxErr == nil {
			t.Fatal("host context was not cancelled after runner returned")
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not return")
	}
}

func TestStartWithRefusesBusyHealthPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	deps := testDependencies(t, t.TempDir(), map[string]string{
		enabledEnv:    "on",
		healthPortEnv: strconv.Itoa(port),
	})
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		t.Fatal("loaded config despite the occupied health port")
		return daemonhost.Config{}, nil
	}

	_, err = startWith(context.Background(), slog.Default(), deps)
	var alreadyRunning *ErrDaemonAlreadyRunning
	if !errors.As(err, &alreadyRunning) {
		t.Fatalf("error = %v, want ErrDaemonAlreadyRunning", err)
	}
	if alreadyRunning.Profile != "" || alreadyRunning.Port != port {
		t.Fatalf("already-running error = %+v, want default profile and port %d", alreadyRunning, port)
	}
}

func TestStartWithRefusesLiveOtherProfilePID(t *testing.T) {
	home := t.TempDir()
	profileDir := filepath.Join(home, ".multica", "profiles", "x")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatalf("create profile directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "daemon.pid"), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatalf("write daemon pid: %v", err)
	}
	port := freePort(t)
	deps := testDependencies(t, home, map[string]string{
		enabledEnv:    "1",
		healthPortEnv: strconv.Itoa(port),
	})
	deps.processLive = func(pid int) bool { return pid == os.Getpid() }
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		t.Fatal("loaded config despite another live profile")
		return daemonhost.Config{}, nil
	}

	_, err := startWith(context.Background(), slog.Default(), deps)
	var alreadyRunning *ErrDaemonAlreadyRunning
	if !errors.As(err, &alreadyRunning) {
		t.Fatalf("error = %v, want ErrDaemonAlreadyRunning", err)
	}
	if alreadyRunning.Profile != "" || alreadyRunning.Port != port || alreadyRunning.OtherProfile != "x" || !alreadyRunning.OtherProfileSet {
		t.Fatalf("already-running error = %+v, want default profile, port %d, other profile x", alreadyRunning, port)
	}
}

func TestStartWithRefusesOtherProfileHealthPortWithoutPID(t *testing.T) {
	home := t.TempDir()
	selectedPort := freePort(t)
	listener, profile := listenForFreeProfilePort(t, selectedPort)
	defer listener.Close()
	profileDir := filepath.Join(home, ".multica", "profiles", profile)
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatalf("create other profile directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(profileDir, "daemon.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon.pid exists or could not be checked: %v", err)
	}
	deps := testDependencies(t, home, map[string]string{
		enabledEnv:    "on",
		healthPortEnv: strconv.Itoa(selectedPort),
	})
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		t.Fatal("loaded config despite another profile health listener")
		return daemonhost.Config{}, nil
	}
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		t.Fatal("constructed daemon despite another profile health listener")
		return nil
	}

	_, err := startWith(context.Background(), slog.Default(), deps)
	var alreadyRunning *ErrDaemonAlreadyRunning
	if !errors.As(err, &alreadyRunning) {
		t.Fatalf("error = %v, want ErrDaemonAlreadyRunning", err)
	}
	if !alreadyRunning.OtherProfileSet || alreadyRunning.OtherProfile != profile {
		t.Fatalf("already-running error = %+v, want other profile %q", alreadyRunning, profile)
	}
}

func TestStartWithRefusesLiveDefaultProfilePIDForNamedProfile(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".multica"), 0o755); err != nil {
		t.Fatalf("create default profile directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(home, ".multica", "daemon.pid"), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatalf("write default daemon pid: %v", err)
	}
	port := freePort(t)
	deps := testDependencies(t, home, map[string]string{
		enabledEnv:    "on",
		profileEnv:    "desktop-localhost",
		healthPortEnv: strconv.Itoa(port),
	})
	deps.processLive = func(pid int) bool { return pid == os.Getpid() }
	deps.loadConfig = func(daemonhost.Overrides) (daemonhost.Config, error) {
		t.Fatal("loaded config despite the live default profile")
		return daemonhost.Config{}, nil
	}

	_, err := startWith(context.Background(), slog.Default(), deps)
	var alreadyRunning *ErrDaemonAlreadyRunning
	if !errors.As(err, &alreadyRunning) {
		t.Fatalf("error = %v, want ErrDaemonAlreadyRunning", err)
	}
	if alreadyRunning.Profile != "desktop-localhost" || alreadyRunning.Port != port || !alreadyRunning.OtherProfileSet || alreadyRunning.OtherProfile != "" {
		t.Fatalf("already-running error = %+v, want named profile and default other profile", alreadyRunning)
	}
	if !strings.Contains(alreadyRunning.Error(), `profile "default"`) {
		t.Fatalf("error = %q, want to identify the default profile", alreadyRunning)
	}
}

func TestStartWithIgnoresStaleOtherProfilePID(t *testing.T) {
	home := t.TempDir()
	profileDir := filepath.Join(home, ".multica", "profiles", "x")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatalf("create profile directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "daemon.pid"), []byte("2147483647"), 0o644); err != nil {
		t.Fatalf("write stale daemon pid: %v", err)
	}
	port := freePort(t)
	started := make(chan struct{})
	deps := testDependencies(t, home, map[string]string{
		enabledEnv:    "on",
		healthPortEnv: strconv.Itoa(port),
	})
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}}
	}

	stop, err := startWith(context.Background(), slog.Default(), deps)
	if err != nil {
		t.Fatalf("startWith refused stale PID: %v", err)
	}
	<-started
	stop()
}

func TestStartWithWaitsForRunnerAfterCancelAndLogsRunError(t *testing.T) {
	home := t.TempDir()
	port := freePort(t)
	values := map[string]string{
		enabledEnv:    "on",
		healthPortEnv: strconv.Itoa(port),
	}
	runStarted := make(chan struct{})
	runExited := make(chan struct{})
	deps := testDependencies(t, home, values)
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{
			run: func(ctx context.Context) error {
				close(runStarted)
				<-ctx.Done()
				close(runExited)
				return errors.New("runner failed")
			},
			restartPath: "/tmp/updated-multica",
		}
	}
	var output strings.Builder
	logger := slog.New(slog.NewTextHandler(&output, nil))
	stop, err := startWith(context.Background(), logger, deps)
	if err != nil {
		t.Fatalf("startWith returned runner error synchronously: %v", err)
	}
	<-runStarted
	startedAt := time.Now()
	stop()
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("stop took %s, want prompt cancellation", elapsed)
	}
	select {
	case <-runExited:
	default:
		t.Fatal("stop returned before the runner exited")
	}
	if got := output.String(); !strings.Contains(got, "runner failed") || !strings.Contains(got, "component=multica-daemon") || !strings.Contains(got, "ignoring in-process restart") {
		t.Fatalf("AO log output does not contain runner error, component, and ignored restart: %q", got)
	}
}

func TestLogStartFailureNamesRefusedProfileAndPort(t *testing.T) {
	var output strings.Builder
	logger := slog.New(slog.NewTextHandler(&output, nil))
	logStartFailure(logger, &ErrDaemonAlreadyRunning{Profile: "desktop-localhost", Port: 19600})
	got := output.String()
	if strings.Count(got, "level=WARN") != 1 || !strings.Contains(got, "desktop-localhost") || !strings.Contains(got, "port=19600") {
		t.Fatalf("refusal warning = %q, want one warning naming the profile and port", got)
	}
}

func TestStartWithRunnerThatReturnsErrorDoesNotPropagate(t *testing.T) {
	port := freePort(t)
	deps := testDependencies(t, t.TempDir(), map[string]string{
		enabledEnv:    "on",
		healthPortEnv: strconv.Itoa(port),
	})
	deps.newDaemon = func(daemonhost.Config, *slog.Logger) daemon {
		return fakeDaemon{run: func(context.Context) error { return errors.New("run failed") }}
	}
	stop, err := startWith(context.Background(), slog.Default(), deps)
	if err != nil {
		t.Fatalf("startWith returned asynchronous runner error: %v", err)
	}
	stop()
}

func testDependencies(t *testing.T, home string, values map[string]string) dependencies {
	t.Helper()
	profile := values[profileEnv]
	stateDir, err := profileStateDir(home, profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("create profile directory: %v", err)
	}
	writeProfileConfig(t, stateDir, `{"token":"recognizable-fake-token","server_url":"http://localhost:8080"}`)
	return dependencies{
		getenv:  func(name string) string { return values[name] },
		homeDir: func() (string, error) { return home, nil },
		loadConfig: func(overrides daemonhost.Overrides) (daemonhost.Config, error) {
			return daemonhost.Config{
				Profile:           overrides.Profile,
				HealthPort:        overrides.HealthPort,
				ServerBaseURL:     localURLFor(overrides.ServerURL),
				AutoUpdateEnabled: !overrides.DisableAutoUpdate,
				AutoReloadEnabled: !overrides.DisableAutoReload,
			}, nil
		},
		newDaemon: func(daemonhost.Config, *slog.Logger) daemon {
			return fakeDaemon{run: func(ctx context.Context) error {
				<-ctx.Done()
				return ctx.Err()
			}}
		},
		processLive: processIsAlive,
	}
}

type fakeDaemon struct {
	run         func(context.Context) error
	restartPath string
	restart     func() string
}

func (d fakeDaemon) Run(ctx context.Context) error {
	if d.run != nil {
		return d.run(ctx)
	}
	return nil
}

func (d fakeDaemon) RestartBinary() string {
	if d.restart != nil {
		return d.restart()
	}
	return d.restartPath
}

func localURLFor(serverURL string) string {
	if serverURL == "" {
		return "http://localhost:8080"
	}
	return serverURL
}

func writeProfileConfig(t *testing.T, stateDir, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(stateDir, "config.json"), []byte(contents), 0o600); err != nil {
		t.Fatalf("write profile config: %v", err)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocate free port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func listenForFreeProfilePort(t *testing.T, except int) (net.Listener, string) {
	t.Helper()
	for i := 0; i < 10000; i++ {
		profile := fmt.Sprintf("listener-%d", i)
		port := healthPortForProfile(profile)
		if port == except {
			continue
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			return listener, profile
		}
	}
	t.Fatal("could not bind a free Multica profile health port")
	return nil, ""
}
