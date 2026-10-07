package controllers

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/multicasupervisor"
)

// MulticaService exposes the daemon-hosted Multica lifecycle and status.
type MulticaService interface {
	Status() multicasupervisor.Status
	Start(context.Context) error
	Stop(context.Context) error
	Restart(context.Context) error
}

// MulticaController owns the loopback Multica daemon routes.
type MulticaController struct {
	Svc MulticaService
}

// Register mounts the Multica daemon routes on the supplied router.
func (c *MulticaController) Register(r chi.Router) {
	r.Get("/multica/status", c.status)
	r.Post("/multica/start", c.start)
	r.Post("/multica/stop", c.stop)
	r.Post("/multica/restart", c.restart)
}

func (c *MulticaController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/multica/status")
		return
	}
	envelope.WriteJSON(w, http.StatusOK, multicaStatusResponse(c.Svc.Status()))
}

func (c *MulticaController) start(w http.ResponseWriter, r *http.Request) {
	c.action(w, r, http.MethodPost, "/api/v1/multica/start", func(ctx context.Context) error {
		return c.Svc.Start(ctx)
	})
}

func (c *MulticaController) stop(w http.ResponseWriter, r *http.Request) {
	c.action(w, r, http.MethodPost, "/api/v1/multica/stop", func(ctx context.Context) error {
		return c.Svc.Stop(ctx)
	})
}

func (c *MulticaController) restart(w http.ResponseWriter, r *http.Request) {
	c.action(w, r, http.MethodPost, "/api/v1/multica/restart", func(ctx context.Context) error {
		return c.Svc.Restart(ctx)
	})
}

func (c *MulticaController) action(w http.ResponseWriter, r *http.Request, method, path string, action func(context.Context) error) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, method, path)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 55*time.Second)
	defer cancel()
	if err := action(ctx); err != nil {
		envelope.WriteError(w, r, multicaActionError(err))
		return
	}
	envelope.WriteJSON(w, http.StatusOK, multicaStatusResponse(c.Svc.Status()))
}

func multicaActionError(err error) error {
	switch {
	case errors.Is(err, multicasupervisor.ErrDisabled):
		return apierr.Conflict("MULTICA_DISABLED", "Multica daemon hosting is disabled", nil)
	case errors.Is(err, multicasupervisor.ErrExternal):
		return apierr.Conflict("MULTICA_EXTERNAL", "An external Multica daemon is using the profile", nil)
	case errors.Is(err, multicasupervisor.ErrNotRunning):
		return apierr.Unavailable("MULTICA_UNAVAILABLE", "Multica daemon supervisor is not running")
	case errors.Is(err, multicasupervisor.ErrStopped):
		return apierr.Conflict("MULTICA_STOPPED", "Multica daemon supervisor has stopped", nil)
	default:
		return err
	}
}

// MulticaStatusResponse is the response envelope for Multica status and actions.
type MulticaStatusResponse struct {
	Daemon MulticaDaemonStatus `json:"daemon"`
}

// MulticaDaemonStatus is the public status of AO's hosted Multica daemon.
type MulticaDaemonStatus struct {
	Enabled     bool             `json:"enabled"`
	State       string           `json:"state" enum:"disabled,stopped,starting,running,backoff,failed,external"`
	Desired     string           `json:"desired" enum:"running,stopped"`
	PID         int              `json:"pid,omitempty"`
	Profile     string           `json:"profile"`
	HealthPort  int              `json:"healthPort"`
	StartedAt   *time.Time       `json:"startedAt,omitempty"`
	Restarts    int              `json:"restarts"`
	NextRetryAt *time.Time       `json:"nextRetryAt,omitempty"`
	LastExit    *MulticaLastExit `json:"lastExit,omitempty"`
	LastError   string           `json:"lastError,omitempty"`
	LogLines    []string         `json:"logLines,omitempty"`
	Health      *MulticaHealth   `json:"health,omitempty"`
}

// MulticaLastExit describes the most recent hosted daemon process exit.
type MulticaLastExit struct {
	Code     int       `json:"code"`
	Signal   string    `json:"signal,omitempty"`
	At       time.Time `json:"at"`
	Graceful bool      `json:"graceful"`
	Crash    bool      `json:"crash"`
}

// MulticaHealth is the latest health response reported by the daemon.
type MulticaHealth struct {
	Status         string   `json:"status"`
	PID            int      `json:"pid"`
	DaemonID       string   `json:"daemonId"`
	Profile        string   `json:"profile"`
	DeviceName     string   `json:"deviceName"`
	ServerURL      string   `json:"serverUrl"`
	Agents         []string `json:"agents"`
	WorkspaceCount int      `json:"workspaceCount"`
	RuntimeIDs     []string `json:"runtimeIds"`
}

func multicaStatusResponse(status multicasupervisor.Status) MulticaStatusResponse {
	var startedAt *time.Time
	if !status.StartedAt.IsZero() {
		startedAt = &status.StartedAt
	}
	var nextRetryAt *time.Time
	if !status.NextRetryAt.IsZero() {
		nextRetryAt = &status.NextRetryAt
	}
	var lastExit *MulticaLastExit
	if status.LastExit != nil {
		lastExit = &MulticaLastExit{
			Code:     status.LastExit.Code,
			Signal:   status.LastExit.Signal,
			At:       status.LastExit.At,
			Graceful: status.LastExit.Graceful,
			Crash:    status.LastExit.Crash,
		}
	}
	var health *MulticaHealth
	if status.Health != nil {
		health = &MulticaHealth{
			Status:         status.Health.Status,
			PID:            status.Health.PID,
			DaemonID:       status.Health.DaemonID,
			Profile:        status.Health.Profile,
			DeviceName:     status.Health.DeviceName,
			ServerURL:      status.Health.ServerURL,
			Agents:         status.Health.Agents,
			WorkspaceCount: status.Health.WorkspaceCount,
			RuntimeIDs:     status.Health.RuntimeIDs,
		}
	}
	return MulticaStatusResponse{Daemon: MulticaDaemonStatus{
		Enabled:     status.Enabled,
		State:       string(status.State),
		Desired:     string(status.Desired),
		PID:         status.PID,
		Profile:     status.Profile,
		HealthPort:  status.HealthPort,
		StartedAt:   startedAt,
		Restarts:    status.Restarts,
		NextRetryAt: nextRetryAt,
		LastExit:    lastExit,
		LastError:   status.LastError,
		LogLines:    status.LogLines,
		Health:      health,
	}}
}
