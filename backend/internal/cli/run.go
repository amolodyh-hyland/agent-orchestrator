package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

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
	var afterVersion, historyLimit int64
	get := &cobra.Command{Use: "get <run-id>", Args: usageArgs(cobra.ExactArgs(1)), Short: "Show current blockers and immutable evidence history", RunE: func(cmd *cobra.Command, args []string) error {
		var response json.RawMessage
		path := "runs/" + url.PathEscape(args[0])
		if cmd.Flags().Changed("after-version") {
			path += "/evidence?afterVersion=" + strconv.FormatInt(afterVersion, 10) + "&limit=" + strconv.FormatInt(historyLimit, 10)
		}
		if err := ctx.getJSON(cmd.Context(), path, &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	get.Flags().Int64Var(&afterVersion, "after-version", -1, "Read history after this version (exclusive)")
	get.Flags().Int64Var(&historyLimit, "limit", 100, "History page size, 1..100")
	cmd.AddCommand(list, get, newRunFileCommand(ctx, "create", false), newRunFileCommand(ctx, "record", true), newRunFileCommand(ctx, "monitor", true))
	var input advanceRunDTO
	advance := &cobra.Command{Use: "advance <run-id>", Short: "Submit a stage claim; only native desktop confirmation advances", Args: usageArgs(cobra.ExactArgs(1)), RunE: func(cmd *cobra.Command, args []string) error {
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
	advance.Flags().StringVar(&input.Actor, "actor", "", "Claimed decision maker (requires desktop confirmation)")
	advance.Flags().StringVar(&input.Decision, "decision", "", "Claimed decision reference or reason")
	status := &cobra.Command{Use: "status <run-id>", Args: usageArgs(cobra.ExactArgs(1)), Short: "Read bounded passive status without starting or steering work", RunE: func(cmd *cobra.Command, args []string) error {
		bounded, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
		defer cancel()
		var response json.RawMessage
		if err := ctx.getJSON(bounded, "runs/"+url.PathEscape(args[0])+"/status", &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	var attentionAfter string
	var attentionLimit int64
	attention := &cobra.Command{Use: "attention", Args: usageArgs(cobra.NoArgs), Short: "Observe approved runs and deduplicated attention", RunE: func(cmd *cobra.Command, _ []string) error {
		if attentionLimit < 1 || attentionLimit > 100 {
			return usageError{errors.New("--limit must be 1..100")}
		}
		bounded, cancel := context.WithTimeout(cmd.Context(), 5*time.Second)
		defer cancel()
		var response json.RawMessage
		if err := ctx.getJSON(bounded, "runs/monitoring?projectId="+url.QueryEscape(project)+"&afterId="+url.QueryEscape(attentionAfter)+"&limit="+strconv.FormatInt(attentionLimit, 10), &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	attention.Flags().StringVarP(&project, "project", "p", "", "Optional project id")
	attention.Flags().StringVar(&attentionAfter, "after-id", "", "Exclusive run cursor from the previous page")
	attention.Flags().Int64Var(&attentionLimit, "limit", 100, "Monitoring page size, 1..100")
	cmd.AddCommand(status, attention)
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
	cmd := &cobra.Command{Use: use, Short: "Submit an unconfirmed JSON claim without starting execution", Args: usageArgs(cobra.ExactArgs(argCount)), RunE: func(cmd *cobra.Command, args []string) error {
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
			suffix := "evidence"
			if name == "monitor" {
				suffix = "monitor"
			}
			path += "/" + url.PathEscape(args[0]) + "/" + suffix
		}
		var response json.RawMessage
		if err := ctx.postJSON(cmd.Context(), path, json.RawMessage(data), &response); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), response)
	}}
	if name == "monitor" {
		cmd.Short = "Configure passive deadlines and next owner without starting work"
	}
	cmd.Flags().StringVar(&file, "file", "", "Unconfirmed request JSON file")
	return cmd
}
