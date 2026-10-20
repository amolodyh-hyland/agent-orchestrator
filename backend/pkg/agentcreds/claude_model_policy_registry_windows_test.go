//go:build windows

package agentcreds

import (
	"errors"
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func TestClaudeRegistryErrorCodes(t *testing.T) {
	for _, err := range []error{registry.ErrNotExist, windows.ERROR_FILE_NOT_FOUND, fmt.Errorf("registry read: %w", registry.ErrNotExist)} {
		if !errors.Is(claudeRegistryError(err), os.ErrNotExist) {
			t.Fatal("missing registry key/value was not recognized by code")
		}
	}
	for _, err := range []error{windows.ERROR_ACCESS_DENIED, registry.ErrUnexpectedType, windows.ERROR_INVALID_DATA} {
		if got := claudeRegistryError(err); got != err || errors.Is(got, os.ErrNotExist) {
			t.Fatal("registry read failure was mistaken for missing policy")
		}
	}
}
