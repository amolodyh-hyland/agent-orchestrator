package cli

import (
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/spf13/cobra"
)

func newOuterCommand(c *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "outer", Short: "Inspect outer state and propose exact actions"}
	cmd.AddCommand(&cobra.Command{Use: "view", Short: "Read current scope, requests and action receipts", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		var result json.RawMessage
		if err := c.getJSON(cmd.Context(), "outer", &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}})
	var file string
	plan := &cobra.Command{Use: "plan", Short: "Seal a finite manifest for native human review; does not execute it", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if file == "" {
			return usageError{errors.New("usage: --file is required")}
		}
		input, err := os.Open(file)
		if err != nil {
			return err
		}
		defer input.Close()
		raw, err := io.ReadAll(io.LimitReader(input, 128<<10+1))
		if err != nil {
			return err
		}
		if len(raw) > 128<<10 || !json.Valid(raw) {
			return usageError{errors.New("usage: exact JSON manifest must be at most 128 KiB")}
		}
		var result json.RawMessage
		if err := c.postJSON(cmd.Context(), "outer/plans", json.RawMessage(raw), &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}}
	plan.Flags().StringVar(&file, "file", "", "Exact request ID, source Projects and concrete action manifest")
	cmd.AddCommand(plan)
	return cmd
}
