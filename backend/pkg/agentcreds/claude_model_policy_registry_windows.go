//go:build windows

package agentcreds

import (
	"context"
	"errors"
	"os"

	"golang.org/x/sys/windows/registry"
)

func readClaudeRegistryValue(ctx context.Context, hive string) (claudeRegistryValue, error) {
	if err := ctx.Err(); err != nil {
		return claudeRegistryValue{}, err
	}
	var root registry.Key
	switch hive {
	case "HKLM":
		root = registry.LOCAL_MACHINE
	case "HKCU":
		root = registry.CURRENT_USER
	default:
		return claudeRegistryValue{}, errors.New("unsupported managed policy registry hive")
	}
	key, err := registry.OpenKey(root, `SOFTWARE\Policies\ClaudeCode`, registry.QUERY_VALUE)
	if err != nil {
		return claudeRegistryValue{}, claudeRegistryError(err)
	}
	defer func() { _ = key.Close() }()
	value, kind, err := key.GetStringValue("Settings")
	if err != nil {
		return claudeRegistryValue{}, claudeRegistryError(err)
	}
	if err := ctx.Err(); err != nil {
		return claudeRegistryValue{}, err
	}
	return claudeRegistryValue{data: []byte(value), expandable: kind == registry.EXPAND_SZ}, nil
}

func claudeRegistryError(err error) error {
	if errors.Is(err, registry.ErrNotExist) {
		return os.ErrNotExist
	}
	return err
}
