package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

type advanceRunDTO struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Actor           string `json:"actor"`
	Decision        string `json:"decision"`
}

func newRunCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "run", Short: "Record and inspect manually advanced run evidence"}
	var project string
	list := &cobra.Command{Use: "list", Args: usageArgs(cobra.NoArgs), Short: "List project runs", RunE: func(cmd *cobra.Command, _ []string) error {
		if strings.TrimSpace(project) == "" {
			return usageError{errors.New("--project is required")}
		}
		var response json.RawMessage
		if err := ctx.getJSON(cmd.Context(), "runs?projectId="+url.QueryEscape(project), &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	list.Flags().StringVarP(&project, "project", "p", "", "Project id")
	get := &cobra.Command{Use: "get <run-id>", Args: usageArgs(cobra.ExactArgs(1)), Short: "Show current blockers and immutable evidence history", RunE: func(cmd *cobra.Command, args []string) error {
		var response json.RawMessage
		if err := ctx.getJSON(cmd.Context(), "runs/"+url.PathEscape(args[0]), &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	cmd.AddCommand(list, get, newRunFileCommand(ctx, "create", false), newRunFileCommand(ctx, "record", true))
	var input advanceRunDTO
	advance := &cobra.Command{Use: "advance <run-id>", Short: "Record a human decision to advance or hold; starts no execution", Args: usageArgs(cobra.ExactArgs(1)), RunE: func(cmd *cobra.Command, args []string) error {
		if !cmd.Flags().Changed("expected-version") || input.ExpectedVersion < 0 || strings.TrimSpace(input.Actor) == "" || strings.TrimSpace(input.Decision) == "" {
			return usageError{errors.New("--expected-version, --actor and --decision are required")}
		}
		var response json.RawMessage
		if err := ctx.postJSON(cmd.Context(), "runs/"+url.PathEscape(args[0])+"/advance", input, &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	advance.Flags().Int64Var(&input.ExpectedVersion, "expected-version", 0, "Latest observed run version")
	advance.Flags().StringVar(&input.Actor, "actor", "", "Human decision maker")
	advance.Flags().StringVar(&input.Decision, "decision", "", "Human decision reference or reason")
	cmd.AddCommand(advance)
	return cmd
}

func newRunFileCommand(ctx *commandContext, name string, record bool) *cobra.Command {
	var file string
	use, argCount := name, 0
	if record {
		use += " <run-id>"
		argCount = 1
	}
	cmd := &cobra.Command{Use: use, Short: "Record a human-approved JSON request without starting execution", Args: usageArgs(cobra.ExactArgs(argCount)), RunE: func(cmd *cobra.Command, args []string) error {
		if file == "" {
			return usageError{errors.New("--file is required")}
		}
		handle, err := os.Open(file)
		if err != nil {
			return err
		}
		defer func() { _ = handle.Close() }()
		data, err := io.ReadAll(io.LimitReader(handle, (256<<10)+1))
		if err != nil {
			return err
		}
		if len(data) > 256<<10 || !json.Valid(data) || !strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
			return usageError{errors.New("--file must contain one JSON object of at most 256 KiB")}
		}
		path := "runs"
		if record {
			path += "/" + url.PathEscape(args[0]) + "/evidence"
		}
		var response json.RawMessage
		if err := ctx.postJSON(cmd.Context(), path, json.RawMessage(data), &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	cmd.Flags().StringVar(&file, "file", "", "Human-approved request JSON file")
	return cmd
}
