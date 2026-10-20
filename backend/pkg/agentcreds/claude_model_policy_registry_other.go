//go:build !windows

package agentcreds

import (
	"context"
	"errors"
)

func readClaudeRegistryValue(context.Context, string) (claudeRegistryValue, error) {
	return claudeRegistryValue{}, errors.ErrUnsupported
}
