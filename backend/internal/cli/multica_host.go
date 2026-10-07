package cli

import (
	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

func newMulticaHostCommand() *cobra.Command {
	var watchStdin bool
	cmd := &cobra.Command{
		Use:               multicahost.HostCommand,
		Short:             "Run the hosted Multica daemon (internal)",
		Hidden:            true,
		Args:              cobra.NoArgs,
		PersistentPreRunE: func(*cobra.Command, []string) error { return nil },
		RunE: func(cmd *cobra.Command, _ []string) error {
			return multicahost.RunChild(cmd.Context(), cmd.InOrStdin(), cmd.ErrOrStderr(), watchStdin)
		},
	}
	cmd.Flags().BoolVar(&watchStdin, "watch-stdin", false, "Stop when the parent closes stdin")
	return cmd
}
