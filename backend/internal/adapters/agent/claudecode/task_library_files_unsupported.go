//go:build !darwin && !linux

package claudecode

import (
	"context"
	"fmt"
)

func materializeTaskLibrary(context.Context, string, []taskLibraryFile) (func() error, error) {
	return nil, fmt.Errorf("library: materialization_unsupported_platform")
}
