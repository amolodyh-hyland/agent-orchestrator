package cli

import (
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/spf13/cobra"
)

func newLibraryCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "library", Short: "Inspect and approve the local library"}
	cmd.AddCommand(&cobra.Command{Use: "ls", Aliases: []string{"list", "catalog"}, Short: "List the inert library catalog", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		var result json.RawMessage
		if err := ctx.getJSON(cmd.Context(), "library", &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}})
	for _, operation := range []string{"register", "rebind", "allow_inspection", "inspect", "approve", "revoke", "bind", "detach_binding", "detach_source"} {
		var file string
		child := &cobra.Command{Use: operation, Short: "Apply a library " + operation + " request", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
			if file == "" {
				return usageError{err: errors.New("--file is required")}
			}
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()
			data, err := io.ReadAll(io.LimitReader(f, (128<<10)+1))
			if err != nil {
				return err
			}
			if len(data) > 128<<10 {
				return usageError{err: errors.New("request exceeds 128 KiB")}
			}
			var request map[string]json.RawMessage
			if err := json.Unmarshal(data, &request); err != nil {
				return usageError{err: errors.New("invalid request JSON")}
			}
			if request == nil {
				return usageError{err: errors.New("request must be an object")}
			}
			request["operation"], _ = json.Marshal(operation)
			var result json.RawMessage
			if err := ctx.postJSON(cmd.Context(), "library/operations", request, &result); err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), result)
		}}
		child.Flags().StringVar(&file, "file", "", "Path to the exact operation request JSON")
		cmd.AddCommand(child)
	}
	return cmd
}
