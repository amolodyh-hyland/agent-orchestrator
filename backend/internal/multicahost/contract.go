package multicahost

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/pkg/daemonhost"
)

// The contract between AO's daemon (which supervises the Multica daemon) and the
// hidden child command that hosts it. Both sides use these names and codes.
const (
	// FlagEnv turns hosting on ("1", "true" or "on"). Off by default; with it off
	// the hidden modes below do nothing.
	FlagEnv = "AO_MULTICA_DAEMON"
	// ProfileEnv selects the Multica CLI profile (empty means the default profile).
	ProfileEnv = "AO_MULTICA_PROFILE"
	// HealthPortEnv overrides the profile's health port.
	HealthPortEnv = "AO_MULTICA_HEALTH_PORT"
	// CLIPathEnv is the absolute path of the multica CLI whose directory is put on
	// the hosted daemon's PATH so tasks can run it.
	CLIPathEnv = "AO_MULTICA_CLI"

	// HostCommand is the hidden `ao` subcommand that runs the Multica daemon.
	HostCommand = "__multica_daemon"

	// Exit codes of the hosted child.
	ExitOK     = 0  // graceful stop, including a stop requested through the health port
	ExitError  = 1  // the daemon stopped with an error: a crash, restartable
	ExitConfig = 78 // refused to start (no token, non-local server, another daemon owns the profile): never restarted
)

// Enabled reports whether hosting is turned on.
func Enabled(getenv func(string) string) bool {
	switch strings.ToLower(strings.TrimSpace(getenv(FlagEnv))) {
	case "1", "true", "on":
		return true
	default:
		return false
	}
}

// Profile returns the selected profile name.
func Profile(getenv func(string) string) string {
	return strings.TrimSpace(getenv(ProfileEnv))
}

// HealthPort returns the health port of the selected profile: the override when
// valid, otherwise Multica's per-profile formula (default profile 19514, a named
// profile 19514 + 1 + sum of its bytes mod 1000).
func HealthPort(getenv func(string) string) int {
	if raw := strings.TrimSpace(getenv(HealthPortEnv)); raw != "" {
		if port, err := strconv.Atoi(raw); err == nil && port > 0 && port <= 65535 {
			return port
		}
	}
	profile := Profile(getenv)
	if profile == "" {
		return daemonhost.DefaultHealthPort
	}
	var sum int
	for _, b := range []byte(profile) {
		sum += int(b)
	}
	return daemonhost.DefaultHealthPort + 1 + sum%1000
}

// StateDir returns the Multica state directory of a profile under home:
// HOME/.multica for the default profile, HOME/.multica/profiles/<name> otherwise.
// It holds config.json, daemon.pid and daemon.log.
func StateDir(home, profile string) (string, error) {
	root := filepath.Join(home, ".multica")
	if profile == "" {
		return root, nil
	}
	if profile == "." || profile == ".." || filepath.Base(profile) != profile || strings.ContainsAny(profile, `/\`) {
		return "", fmt.Errorf("invalid Multica profile %q", profile)
	}
	return filepath.Join(root, "profiles", profile), nil
}
