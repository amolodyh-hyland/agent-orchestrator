package main

import (
	"fmt"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/cli"
	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

func main() {
	if handled, code := multicahost.RunHelperIfRequested(os.Args, os.Stdin, os.Stdout, os.Stderr); handled {
		os.Exit(code)
	}
	if err := cli.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(cli.ExitCode(err))
	}
}
