package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

const multicaActionTimeout = 70 * time.Second

type multicaOptions struct {
	json bool
}

type multicaResponse struct {
	Daemon multicaDaemonStatus `json:"daemon"`
}

type multicaDaemonStatus struct {
	Enabled     bool             `json:"enabled"`
	State       string           `json:"state"`
	Desired     string           `json:"desired"`
	PID         int              `json:"pid,omitempty"`
	Profile     string           `json:"profile"`
	HealthPort  int              `json:"healthPort"`
	StartedAt   *time.Time       `json:"startedAt,omitempty"`
	Restarts    int              `json:"restarts"`
	NextRetryAt *time.Time       `json:"nextRetryAt,omitempty"`
	LastExit    *multicaLastExit `json:"lastExit,omitempty"`
	LastError   string           `json:"lastError,omitempty"`
	LogLines    []string         `json:"logLines,omitempty"`
	Health      *multicaHealth   `json:"health,omitempty"`
}

type multicaLastExit struct {
	Code     int       `json:"code"`
	Signal   string    `json:"signal,omitempty"`
	At       time.Time `json:"at"`
	Graceful bool      `json:"graceful"`
	Crash    bool      `json:"crash"`
}

type multicaHealth struct {
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

func newMulticaCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "multica",
		Short: "Manage the Multica daemon supervised by AO",
		Long: "Manage the Multica daemon supervised by AO. Stop and restart through this command " +
			"keep AO supervising the daemon. Running `multica daemon restart` directly starts a " +
			"standalone daemon that AO does not supervise.",
	}
	cmd.AddCommand(newMulticaStatusCommand(ctx))
	cmd.AddCommand(newMulticaActionCommand(ctx, "start"))
	cmd.AddCommand(newMulticaActionCommand(ctx, "stop"))
	cmd.AddCommand(newMulticaActionCommand(ctx, "restart"))
	return cmd
}

func newMulticaStatusCommand(ctx *commandContext) *cobra.Command {
	var opts multicaOptions
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the supervised Multica daemon status",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var response multicaResponse
			if err := ctx.getJSON(cmd.Context(), "multica/status", &response); err != nil {
				return err
			}
			return writeMulticaStatus(cmd.OutOrStdout(), response.Daemon, opts.json)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the daemon status as JSON")
	return cmd
}

func newMulticaActionCommand(ctx *commandContext, action string) *cobra.Command {
	var opts multicaOptions
	cmd := &cobra.Command{
		Use:   action,
		Short: strings.ToUpper(action[:1]) + action[1:] + " the supervised Multica daemon",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			response, err := ctx.multicaAction(cmd.Context(), action)
			if err != nil {
				return err
			}
			return writeMulticaStatus(cmd.OutOrStdout(), response.Daemon, opts.json)
		},
	}
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the daemon status as JSON")
	return cmd
}

func (c *commandContext) multicaAction(ctx context.Context, action string) (multicaResponse, error) {
	var response multicaResponse
	statusCode := 0
	client := *c.deps.HTTPClient
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = multicaStatusRoundTripper{base: transport, statusCode: &statusCode}
	command := *c
	command.deps.HTTPClient = &client
	err := command.doJSONPathWithHeadersAndTimeout(ctx, http.MethodPost, "/api/v1/multica/"+action, nil, &response, nil, multicaActionTimeout)
	if err != nil {
		return response, err
	}
	if statusCode != http.StatusOK {
		return response, apiResponseError{StatusCode: statusCode}
	}
	return response, nil
}

type multicaStatusRoundTripper struct {
	base       http.RoundTripper
	statusCode *int
}

func (t multicaStatusRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if resp != nil {
		*t.statusCode = resp.StatusCode
	}
	return resp, err
}

func writeMulticaStatus(w io.Writer, status multicaDaemonStatus, jsonOutput bool) error {
	if jsonOutput {
		return writeJSON(w, status)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Multica daemon: %s", status.State)
	if status.PID != 0 {
		fmt.Fprintf(&b, " (pid %d)", status.PID)
	}
	b.WriteByte('\n')
	if status.Enabled {
		fmt.Fprintf(&b, "Profile: %s\n", status.Profile)
		fmt.Fprintf(&b, "Health port: %d\n", status.HealthPort)
		if status.Desired != "" {
			fmt.Fprintf(&b, "Desired: %s\n", status.Desired)
		}
		fmt.Fprintf(&b, "Restarts: %d\n", status.Restarts)
	}
	if status.NextRetryAt != nil {
		fmt.Fprintf(&b, "Next retry at: %s\n", status.NextRetryAt.Format(time.RFC3339Nano))
	}
	if status.LastExit != nil {
		condition := "unknown"
		switch {
		case status.LastExit.Crash:
			condition = "crash"
		case status.LastExit.Graceful:
			condition = "graceful"
		case status.LastExit.Code == multicahost.ExitConfig:
			condition = "configuration refused"
		}
		fmt.Fprintf(&b, "Last exit: code %d", status.LastExit.Code)
		if status.LastExit.Signal != "" {
			fmt.Fprintf(&b, ", signal %s", status.LastExit.Signal)
		}
		fmt.Fprintf(&b, ", %s at %s\n", condition, status.LastExit.At.Format(time.RFC3339Nano))
	}
	if status.LastError != "" {
		fmt.Fprintf(&b, "Last error: %s\n", status.LastError)
	}
	if status.State == "external" && status.Health != nil {
		fmt.Fprintf(&b, "Daemon ID: %s\n", status.Health.DaemonID)
		fmt.Fprintf(&b, "Server: %s\n", status.Health.ServerURL)
		fmt.Fprintf(&b, "Device: %s\n", status.Health.DeviceName)
	}
	if status.State == "disabled" {
		b.WriteString("Multica daemon hosting is off. Start the AO daemon with AO_MULTICA_DAEMON=1 to host it.\n")
	}
	if status.State == "failed" && len(status.LogLines) > 0 {
		b.WriteString("Recent logs:\n")
		for _, line := range status.LogLines {
			fmt.Fprintf(&b, "  %s\n", line)
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}
