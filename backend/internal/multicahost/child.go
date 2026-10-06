package multicahost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

// RunChild runs Multica's daemon until it stops or the child receives a stop
// signal. The hidden CLI command calls this from its own process.
func RunChild(ctx context.Context, stdin io.Reader, stderr io.Writer, watchStdin bool) error {
	if stderr == nil {
		stderr = os.Stderr
	}
	logger := slog.New(slog.NewTextHandler(stderr, nil))
	return runChildWith(ctx, stdin, watchStdin, logger, realDependencies())
}

func runChildWith(ctx context.Context, stdin io.Reader, watchStdin bool, logger *slog.Logger, deps dependencies) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if logger == nil {
		logger = slog.Default()
	}
	deps = deps.withDefaults()

	if !Enabled(deps.getenv) {
		return &ErrConfiguration{Err: errors.New("Multica daemon hosting is disabled (set AO_MULTICA_DAEMON=1)")}
	}
	profile, port, stateDir, profileCfg, err := preflight(deps)
	if err != nil {
		return err
	}

	prependCLIPath(deps, logger)
	overrides := daemonhost.Overrides{
		Profile:           profile,
		HealthPort:        port,
		ServerURL:         serverURLOverride(deps.getenv, profileCfg.ServerURL),
		DisableAutoUpdate: true,
		DisableAutoReload: true,
	}
	cfg, err := deps.loadConfig(overrides)
	if err != nil {
		return fmt.Errorf("load Multica daemon config: %w", err)
	}
	if err := requireLocalServer(cfg.ServerBaseURL); err != nil {
		return &ErrConfiguration{Err: err}
	}
	cfg.Profile = profile
	cfg.HealthPort = port
	cfg.AutoUpdateEnabled = false
	cfg.AutoReloadEnabled = false
	cfg.LaunchedBy = "desktop"
	cfg.CLIVersion = managedCLIVersion

	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return fmt.Errorf("create Multica profile directory: %w", err)
	}
	pidPath := filepath.Join(stateDir, "daemon.pid")
	pid := deps.pid()
	if err := writePIDAtomically(pidPath, pid); err != nil {
		return fmt.Errorf("write Multica daemon pid: %w", err)
	}
	defer func() {
		if err := removePIDIfOwned(pidPath, pid); err != nil {
			logger.Warn("could not remove Multica daemon pid file", "err", err)
		}
	}()

	logFile, err := os.OpenFile(filepath.Join(stateDir, "daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open Multica daemon log: %w", err)
	}
	defer logFile.Close()
	hostLogger := newHostLogger(logFile, logger)
	host := deps.newDaemon(cfg, hostLogger)
	if host == nil {
		return errors.New("create Multica daemon: nil daemon")
	}

	signalCtx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	hostCtx, cancel := context.WithCancel(signalCtx)
	if watchStdin {
		if stdin == nil {
			stdin = strings.NewReader("")
		}
		go func() {
			_, _ = io.Copy(io.Discard, stdin)
			cancel()
		}()
	}
	runErr := host.Run(hostCtx)
	cancel()

	if restartPath := host.RestartBinary(); restartPath != "" {
		hostLogger.Warn("Multica daemon requested restart; exiting successfully", "path", restartPath)
		return nil
	}
	if runErr == nil || errors.Is(runErr, context.Canceled) {
		return nil
	}
	hostLogger.Error("Multica daemon stopped with an error", "err", runErr)
	return fmt.Errorf("Multica daemon stopped: %w", runErr)
}

func (d dependencies) withDefaults() dependencies {
	defaults := realDependencies()
	if d.getenv == nil {
		d.getenv = defaults.getenv
	}
	if d.setenv == nil {
		d.setenv = defaults.setenv
	}
	if d.homeDir == nil {
		d.homeDir = defaults.homeDir
	}
	if d.loadConfig == nil {
		d.loadConfig = defaults.loadConfig
	}
	if d.newDaemon == nil {
		d.newDaemon = defaults.newDaemon
	}
	if d.processLive == nil {
		d.processLive = defaults.processLive
	}
	if d.portInUse == nil {
		d.portInUse = defaults.portInUse
	}
	if d.pid == nil {
		d.pid = defaults.pid
	}
	return d
}

func realDependencies() dependencies {
	return dependencies{
		getenv:      os.Getenv,
		setenv:      os.Setenv,
		homeDir:     os.UserHomeDir,
		loadConfig:  daemonhost.LoadConfig,
		newDaemon:   func(cfg daemonhost.Config, logger *slog.Logger) daemon { return daemonhost.New(cfg, logger) },
		processLive: processIsAlive,
		portInUse:   healthPortInUse,
		pid:         os.Getpid,
	}
}

func preflight(deps dependencies) (string, int, string, profileConfig, error) {
	profile := Profile(deps.getenv)
	port := HealthPort(deps.getenv)
	home, err := deps.homeDir()
	if err != nil {
		return "", 0, "", profileConfig{}, fmt.Errorf("resolve home directory for Multica: %w", err)
	}
	stateDir, err := StateDir(home, profile)
	if err != nil {
		return "", 0, "", profileConfig{}, &ErrConfiguration{Err: err}
	}
	profileCfg, err := readProfileConfig(filepath.Join(stateDir, "config.json"))
	if err != nil {
		return "", 0, "", profileConfig{}, &ErrConfiguration{Err: err}
	}
	serverURL := serverURLOverride(deps.getenv, profileCfg.ServerURL)
	if serverURL == "" {
		serverURL = daemonhost.DefaultServerURL
	}
	if err := requireLocalServer(serverURL); err != nil {
		return "", 0, "", profileConfig{}, &ErrConfiguration{Err: err}
	}
	if deps.portInUse(port) {
		return "", 0, "", profileConfig{}, &ErrConfiguration{Err: &ErrDaemonAlreadyRunning{Profile: profile, Port: port}}
	}
	otherProfile, foundOtherProfile, err := findOtherRunningProfile(home, profile, deps.processLive, deps.portInUse)
	if err != nil {
		return "", 0, "", profileConfig{}, fmt.Errorf("check Multica profile daemons: %w", err)
	}
	if foundOtherProfile {
		return "", 0, "", profileConfig{}, &ErrConfiguration{Err: &ErrDaemonAlreadyRunning{
			Profile: profile, Port: port, OtherProfile: otherProfile, OtherProfileSet: true,
		}}
	}
	return profile, port, stateDir, profileCfg, nil
}

func prependCLIPath(deps dependencies, logger *slog.Logger) {
	cliPath := strings.TrimSpace(deps.getenv(CLIPathEnv))
	if cliPath == "" {
		return
	}
	if !usableCLIPath(cliPath) {
		logger.Warn("ignoring invalid Multica CLI path", "path", cliPath)
		return
	}
	dir := filepath.Dir(cliPath)
	path := deps.getenv("PATH")
	if path != "" {
		dir += string(os.PathListSeparator) + path
	}
	if err := deps.setenv("PATH", dir); err != nil {
		logger.Warn("could not prepend Multica CLI directory to PATH", "err", err)
	}
}

func usableCLIPath(path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	_, err = exec.LookPath(path)
	return err == nil
}

func writePIDAtomically(path string, pid int) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".daemon.pid-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := fmt.Fprintf(tmp, "%d\n", pid); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func removePIDIfOwned(path string, pid int) error {
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	currentPID, err := strconv.Atoi(strings.TrimSpace(string(contents)))
	if err != nil || currentPID != pid {
		return nil
	}
	if err := os.Remove(path); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
