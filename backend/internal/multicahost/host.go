// Package multicahost runs the Multica agent daemon in a child AO process.
package multicahost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

const managedCLIVersion = "0.0.0-ao-hosted"

// ErrConfiguration reports a child-host refusal that should not be retried.
type ErrConfiguration struct {
	Err error
}

func (e *ErrConfiguration) Error() string {
	if e == nil || e.Err == nil {
		return "Multica daemon configuration is not usable"
	}
	return strings.Join(strings.Fields(e.Err.Error()), " ")
}

func (e *ErrConfiguration) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// ErrDaemonAlreadyRunning reports that a daemon already owns a profile or port.
type ErrDaemonAlreadyRunning struct {
	Profile         string
	Port            int
	OtherProfile    string
	OtherProfileSet bool
}

type ErrNoToken struct {
	ConfigPath string
}

func (e *ErrNoToken) Error() string {
	return fmt.Sprintf("Multica profile token is required in %s", e.ConfigPath)
}

type ErrNonLocalServer struct {
	Scheme string
	Host   string
}

func (e *ErrNonLocalServer) Error() string {
	return fmt.Sprintf("Multica daemon requires a local server URL (got %s://%s)", e.Scheme, e.Host)
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
	setenv      func(string, string) error
	homeDir     func() (string, error)
	loadConfig  func(daemonhost.Overrides) (daemonhost.Config, error)
	newDaemon   func(daemonhost.Config, *slog.Logger) daemon
	processLive func(int) bool
	portInUse   func(int) bool
	pid         func() int
}

type profileConfig struct {
	ServerURL string `json:"server_url"`
	Token     string `json:"token"`
}

func readProfileConfig(path string) (profileConfig, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return profileConfig{}, &ErrNoToken{ConfigPath: path}
	}
	var cfg profileConfig
	if err := json.Unmarshal(contents, &cfg); err != nil || strings.TrimSpace(cfg.Token) == "" {
		return profileConfig{}, &ErrNoToken{ConfigPath: path}
	}
	return cfg, nil
}

func serverURLOverride(getenv func(string) string, profileURL string) string {
	if serverURL := strings.TrimSpace(getenv("MULTICA_SERVER_URL")); serverURL != "" {
		return serverURL
	}
	return profileURL
}

func requireLocalServer(serverURL string) error {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return &ErrNonLocalServer{}
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return nil
	}
	return &ErrNonLocalServer{Scheme: parsed.Scheme, Host: parsed.Host}
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

func findOtherRunningProfile(home, selected string, processLive func(int) bool, portInUse func(int) bool) (string, bool, error) {
	root := filepath.Join(home, ".multica")
	profiles := []struct {
		name string
		dir  string
	}{}
	if info, err := os.Stat(root); err == nil && info.IsDir() {
		profiles = append(profiles, struct {
			name string
			dir  string
		}{name: "", dir: root})
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", false, fmt.Errorf("stat default profile directory: %w", err)
	}

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
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", false, fmt.Errorf("read %s: %w", pidPath, err)
		}
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(contents)))
			if parseErr == nil && pid > 0 && processLive(pid) {
				return profile.name, true, nil
			}
		}
		getenv := func(key string) string {
			if key == ProfileEnv {
				return profile.name
			}
			return ""
		}
		if portInUse(HealthPort(getenv)) {
			return profile.name, true, nil
		}
	}
	return "", false, nil
}

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
