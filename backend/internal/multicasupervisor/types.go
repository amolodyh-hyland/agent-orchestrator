package multicasupervisor

import (
	"context"
	"io"
	"os/exec"
	"time"
)

type State string

const (
	StateDisabled State = "disabled"
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateBackoff  State = "backoff"
	StateFailed   State = "failed"
	StateExternal State = "external"
)

type Desired string

const (
	DesiredRunning Desired = "running"
	DesiredStopped Desired = "stopped"
)

type Service interface {
	Status() Status
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

type Status struct {
	Enabled         bool        `json:"enabled"`
	State           State       `json:"state"`
	Desired         Desired     `json:"desired"`
	PID             int         `json:"pid,omitempty"`
	Profile         string      `json:"profile"`
	HealthPort      int         `json:"health_port"`
	StartedAt       time.Time   `json:"started_at,omitempty"`
	Restarts        int         `json:"restarts"`
	NextRetryAt     time.Time   `json:"next_retry_at,omitempty"`
	LastExit        *ExitStatus `json:"last_exit,omitempty"`
	LastError       string      `json:"last_error,omitempty"`
	LogLines        []string    `json:"log_lines,omitempty"`
	Health          *Health     `json:"health,omitempty"`
	HealthFetchedAt time.Time   `json:"health_fetched_at,omitempty"`
}

type ExitStatus struct {
	Code     int       `json:"code"`
	Signal   string    `json:"signal,omitempty"`
	At       time.Time `json:"at"`
	Graceful bool      `json:"graceful"`
	Crash    bool      `json:"crash"`
}

type Health struct {
	Status         string   `json:"status"`
	PID            int      `json:"pid"`
	DaemonID       string   `json:"daemon_id"`
	Profile        string   `json:"profile"`
	DeviceName     string   `json:"device_name"`
	ServerURL      string   `json:"server_url"`
	Agents         []string `json:"agents"`
	WorkspaceCount int      `json:"workspace_count"`
	RuntimeIDs     []string `json:"runtime_ids"`
}

type ProcessExit struct {
	Code   int
	Signal string
	Err    error
}

type Process interface {
	PID() int
	Stdin() io.WriteCloser
	Wait() ProcessExit
	Kill() error
}

type ProcessSpec struct {
	Executable  string
	Args        []string
	Environment []string
	Command     CommandConstructor
}

type ProcessFactory func(context.Context, ProcessSpec, func(stream, line string)) (Process, error)
type CommandConstructor func(string, ...string) *exec.Cmd

type Config struct {
	Enabled           bool
	Profile           string
	HealthPort        int
	Executable        string
	CLIPath           string
	Environment       []string
	Clock             Clock
	ProcessFactory    ProcessFactory
	Command           CommandConstructor
	HealthTimeout     time.Duration
	StopTimeout       time.Duration
	ShutdownTimeout   time.Duration
	BackoffBase       time.Duration
	BackoffMax        time.Duration
	StableRunDuration time.Duration
	MaxFastCrashes    int
}

type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

type Clock interface {
	Now() time.Time
	NewTimer(time.Duration) Timer
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) NewTimer(d time.Duration) Timer { return realTimer{timer: time.NewTimer(d)} }

type realTimer struct{ timer *time.Timer }

func (t realTimer) C() <-chan time.Time { return t.timer.C }

func (t realTimer) Stop() bool { return t.timer.Stop() }
