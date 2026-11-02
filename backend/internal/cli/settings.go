package cli

import (
	"encoding/json"
	"errors"

	"github.com/spf13/cobra"
)

func newSettingsCommand(ctx *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "settings", Short: "Read daemon preferences and configure native asset sources"}
	cmd.AddCommand(&cobra.Command{
		Use: "get", Short: "Read daemon preferences as JSON", Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var result json.RawMessage
			if err := ctx.getJSON(cmd.Context(), "settings", &result); err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), result)
		},
	})
	var sources []string
	var clear bool
	set := &cobra.Command{
		Use: "agent-asset-sources", Short: "Replace global native asset source defaults", Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if clear == (len(sources) > 0) {
				return usageError{errors.New("provide --source directories or --clear")}
			}
			if clear {
				sources = []string{}
			}
			var result json.RawMessage
			if err := ctx.patchJSON(cmd.Context(), "settings/agent-asset-sources", struct {
				AgentAssetSources []string `json:"agentAssetSources"`
			}{sources}, &result); err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), result)
		},
	}
	set.Flags().StringArrayVar(&sources, "source", nil, "Absolute or project-relative source directory (repeatable)")
	set.Flags().BoolVar(&clear, "clear", false, "Clear all global asset source defaults")
	cmd.AddCommand(set)
	return cmd
}
