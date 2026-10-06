// Package multicahost runs the Multica agent daemon inside the AO daemon.
package multicahost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

const (
	enabledEnv        = "AO_MULTICA_INPROCESS"
	profileEnv        = "AO_MULTICA_PROFILE"
	healthPortEnv     = "AO_MULTICA_HEALTH_PORT"
	managedCLIVersion = "0.0.0-ao-inprocess"
	shutdownTimeout   = 15 * time.Second
)

// ErrDaemonAlreadyRunning reports that starting a Multica daemon could
// interfere with an existing daemon or its machine-wide runtime identity.
type ErrDaemonAlreadyRunning struct {
	Profile         string
	Port            int
	OtherProfile    string
	OtherProfileSet bool
}

func (e *ErrDaemonAlreadyRunning) Error() string {
	if e.OtherProfileSet {
		otherProfile := e.OtherProfile
		if otherProfile == "" {
			otherProfile = "default"
		}
		return fmt.Sprintf("Multica daemon for profile %q is already running; refusing profile %q on port %d", otherProfile, e.Profile, e.Port)
	}
	return fmt.Sprintf("Multica daemon health port %d is already in use for profile %q", e.Port, e.Profile)
}

type daemon interface {
	Run(context.Context) error
	RestartBinary() string
}

type dependencies struct {
	getenv      func(string) string
	homeDir     func() (string, error)
	loadConfig  func(daemonhost.Overrides) (daemonhost.Config, error)
	newDaemon   func(daemonhost.Config, *slog.Logger) daemon
	processLive func(int) bool
}

// Start starts the embedded Multica daemon when AO_MULTICA_INPROCESS is on.
// Startup failures are logged and leave the AO daemon running.
func Start(ctx context.Context, logger *slog.Logger) (stop func()) {
	stop = noop
	if !inProcessEnabled(os.Getenv(enabledEnv)) {
		return stop
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn("Multica in-process daemon panicked during startup", "panic", recovered)
			stop = noop
		}
	}()

	started, err := startWith(ctx, logger, realDependencies())
	if err != nil {
		logStartFailure(logger, err)
		return stop
	}
	return started
}

func startWith(ctx context.Context, logger *slog.Logger, deps dependencies) (func(), error) {
	if deps.getenv == nil || !inProcessEnabled(deps.getenv(enabledEnv)) {
		return noop, nil
	}
	if err := ctx.Err(); err != nil {
		return noop, err
	}
	if logger == nil {
		logger = slog.Default()
	}

	profile := strings.TrimSpace(deps.getenv(profileEnv))
	port := healthPortForProfile(profile)
	if override := strings.TrimSpace(deps.getenv(healthPortEnv)); override != "" {
		if parsed, err := strconv.Atoi(override); err == nil && parsed > 0 && parsed <= 65535 {
			port = parsed
		}
	}

	home, err := deps.homeDir()
	if err != nil {
		return noop, fmt.Errorf("resolve home directory for Multica: %w", err)
	}
	stateDir, err := profileStateDir(home, profile)
	if err != nil {
		return noop, err
	}
	if healthPortInUse(port) {
		return noop, &ErrDaemonAlreadyRunning{Profile: profile, Port: port}
	}
	otherProfile, foundOtherProfile, err := findOtherRunningProfile(home, profile, deps.processLive)
	if err != nil {
		return noop, fmt.Errorf("check Multica profile daemons: %w", err)
	}
	if foundOtherProfile {
		return noop, &ErrDaemonAlreadyRunning{Profile: profile, Port: port, OtherProfile: otherProfile, OtherProfileSet: true}
	}

	overrides := daemonhost.Overrides{
		Profile:           profile,
		HealthPort:        port,
		DisableAutoUpdate: true,
		DisableAutoReload: true,
	}
	cfg, err := deps.loadConfig(overrides)
	if err != nil {
		return noop, fmt.Errorf("load Multica daemon config: %w", err)
	}
	cfg.Profile = profile
	cfg.HealthPort = port
	cfg.AutoUpdateEnabled = false
	cfg.AutoReloadEnabled = false
	cfg.LaunchedBy = "desktop"
	cfg.CLIVersion = managedCLIVersion

	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return noop, fmt.Errorf("create Multica profile directory: %w", err)
	}
	logFile, err := os.OpenFile(filepath.Join(stateDir, "daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return noop, fmt.Errorf("open Multica daemon log: %w", err)
	}
	hostLogger := newHostLogger(logFile, logger)
	host := deps.newDaemon(cfg, hostLogger)
	if host == nil {
		_ = logFile.Close()
		return noop, errors.New("create Multica daemon: nil daemon")
	}

	hostCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer logFile.Close()
		defer close(done)
		defer func() {
			if recovered := recover(); recovered != nil {
				hostLogger.Error("Multica daemon panicked", "panic", recovered)
			}
		}()
		if runErr := host.Run(hostCtx); runErr != nil && !errors.Is(runErr, context.Canceled) {
			hostLogger.Error("Multica daemon stopped with an error", "err", runErr)
		}
		if restartPath := host.RestartBinary(); restartPath != "" {
			hostLogger.Warn("Multica daemon requested restart; ignoring in-process restart", "path", restartPath)
		}
	}()

	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			timer := time.NewTimer(shutdownTimeout)
			defer timer.Stop()
			select {
			case <-done:
			case <-timer.C:
				hostLogger.Warn("timed out waiting for Multica daemon to stop", "timeout", shutdownTimeout)
			}
		})
	}
	return stop, nil
}

func realDependencies() dependencies {
	return dependencies{
		getenv:      os.Getenv,
		homeDir:     os.UserHomeDir,
		loadConfig:  daemonhost.LoadConfig,
		newDaemon:   func(cfg daemonhost.Config, logger *slog.Logger) daemon { return daemonhost.New(cfg, logger) },
		processLive: processIsAlive,
	}
}

func inProcessEnabled(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "on":
		return true
	default:
		return false
	}
}

func healthPortForProfile(profile string) int {
	if profile == "" {
		return daemonhost.DefaultHealthPort
	}
	var sum int
	for _, b := range []byte(profile) {
		sum += int(b)
	}
	return daemonhost.DefaultHealthPort + 1 + sum%1000
}

func profileStateDir(home, profile string) (string, error) {
	root := filepath.Join(home, ".multica")
	if profile == "" {
		return root, nil
	}
	if profile == "." || profile == ".." || filepath.Base(profile) != profile || strings.ContainsAny(profile, `/\\`) {
		return "", fmt.Errorf("invalid Multica profile %q", profile)
	}
	return filepath.Join(root, "profiles", profile), nil
}

func healthPortInUse(port int) bool {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return true
	}
	_ = ln.Close()

	client := &http.Client{
		Timeout: time.Second,
		Transport: &http.Transport{
			Proxy: nil,
		},
	}
	defer client.CloseIdleConnections()
	resp, err := client.Get("http://" + addr + "/health")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return true
}

func findOtherRunningProfile(home, selected string, processLive func(int) bool) (string, bool, error) {
	root := filepath.Join(home, ".multica")
	profiles := []struct {
		name string
		dir  string
	}{{name: "", dir: root}}

	entries, err := os.ReadDir(filepath.Join(root, "profiles"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", false, fmt.Errorf("read profiles directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			profiles = append(profiles, struct {
				name string
				dir  string
			}{name: entry.Name(), dir: filepath.Join(root, "profiles", entry.Name())})
		}
	}

	for _, profile := range profiles {
		if profile.name == selected {
			continue
		}
		pidPath := filepath.Join(profile.dir, "daemon.pid")
		contents, err := os.ReadFile(pidPath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", false, fmt.Errorf("read %s: %w", pidPath, err)
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(contents)))
		if err == nil && pid > 0 && processLive(pid) {
			return profile.name, true, nil
		}
	}
	return "", false, nil
}

func logStartFailure(logger *slog.Logger, err error) {
	if logger == nil {
		logger = slog.Default()
	}
	var alreadyRunning *ErrDaemonAlreadyRunning
	if errors.As(err, &alreadyRunning) {
		attrs := []any{"profile", alreadyRunning.Profile, "port", alreadyRunning.Port, "err", err}
		if alreadyRunning.OtherProfileSet {
			otherProfile := alreadyRunning.OtherProfile
			if otherProfile == "" {
				otherProfile = "default"
			}
			attrs = append(attrs, "other_profile", otherProfile)
		}
		logger.Warn("Multica in-process daemon not started", attrs...)
		return
	}
	logger.Warn("Multica in-process daemon failed to start", "err", err)
}

func noop() {}

func newHostLogger(file io.Writer, aoLogger *slog.Logger) *slog.Logger {
	if aoLogger == nil {
		aoLogger = slog.Default()
	}
	handlers := []slog.Handler{
		slog.NewTextHandler(file, nil),
		aoLogger.With("component", "multica-daemon").Handler(),
	}
	return slog.New(&fanoutHandler{handlers: handlers})
}

type fanoutHandler struct {
	handlers []slog.Handler
}

func (h *fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (h *fanoutHandler) Handle(ctx context.Context, record slog.Record) error {
	var errs []error
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, record.Level) {
			if err := handler.Handle(ctx, record.Clone()); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (h *fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	wrapped := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		wrapped[i] = handler.WithAttrs(attrs)
	}
	return &fanoutHandler{handlers: wrapped}
}

func (h *fanoutHandler) WithGroup(name string) slog.Handler {
	wrapped := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		wrapped[i] = handler.WithGroup(name)
	}
	return &fanoutHandler{handlers: wrapped}
}
