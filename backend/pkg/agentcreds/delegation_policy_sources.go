package agentcreds

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

type delegationPolicyFiles struct {
	lstat   func(string) (os.FileInfo, error)
	open    func(string) (*os.File, error)
	owner   func(string, os.FileInfo) bool
	readDir func(string) ([]os.DirEntry, error)
}

func nativeDelegationPolicyFiles() delegationPolicyFiles {
	return delegationPolicyFiles{lstat: os.Lstat, open: openProtectedPolicyFile, owner: protectedPolicyOwner, readDir: os.ReadDir}
}

func (fs delegationPolicyFiles) safe(path string, info os.FileInfo, directory bool) bool {
	return info.Mode()&os.ModeSymlink == 0 && protectedPolicyMode(info) && fs.owner(path, info) && (directory && info.IsDir() || !directory && info.Mode().IsRegular())
}

// Check every ancestor, including for missing sources: a writable parent could
// otherwise erase enrollment or replace a protected file with a symlink.
func (fs delegationPolicyFiles) ancestors(path string) error {
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := fs.lstat(parent)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && !fs.safe(parent, info, true) {
			return errors.New("unsafe policy directory")
		}
		if filepath.Dir(parent) == parent {
			return nil
		}
	}
}

func (fs delegationPolicyFiles) read(path string) ([]byte, bool, error) {
	if err := fs.ancestors(path); err != nil {
		return nil, false, err
	}
	before, err := fs.lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !fs.safe(path, before, false) {
		return nil, true, errors.New("unsafe policy source")
	}
	f, err := fs.open(path)
	if err != nil {
		return nil, true, err
	}
	defer func() { _ = f.Close() }()
	opened, err := f.Stat()
	if err != nil || !fs.safe(path, opened, false) || !sameProtectedPolicyFile(before, opened) {
		return nil, true, errors.New("policy source changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	after, statErr := fs.lstat(path)
	if err != nil || statErr != nil || len(data) > 1<<20 || !sameProtectedPolicyFile(opened, after) || !fs.safe(path, after, false) || fs.ancestors(path) != nil {
		return nil, true, errors.New("policy source changed")
	}
	return data, true, nil
}

func sameProtectedPolicyFile(left, right os.FileInfo) bool {
	return os.SameFile(left, right) && left.Size() == right.Size() && left.ModTime().Equal(right.ModTime())
}

func (fs delegationPolicyFiles) enrollmentMarker(path string) (bool, error) {
	if err := fs.ancestors(path); err != nil {
		return false, err
	}
	info, err := fs.lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fs.safe(path, info, false) {
		return true, errors.New("unsafe enrollment marker")
	}
	return true, nil
}

func (fs delegationPolicyFiles) managedPreferencesEnrolled(directory string) (bool, error) {
	if err := fs.ancestors(directory); err != nil {
		return false, err
	}
	info, err := fs.lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fs.safe(directory, info, true) {
		return false, errors.New("unsafe managed preferences")
	}
	entries, err := fs.readDir(directory)
	if err != nil {
		return false, err
	}
	enrolled := false
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".plist") {
			exists, err := fs.enrollmentMarker(filepath.Join(directory, entry.Name()))
			if err != nil {
				return false, err
			}
			enrolled = enrolled || exists
		}
	}
	return enrolled, nil
}

func delegationProtectedSources(ctx context.Context, opts ResolveOptions, fs delegationPolicyFiles) ([]claudePolicyDocument, bool) {
	systemDir := opts.ManagedSettingsDir
	if systemDir == "" {
		switch opts.goos() {
		case "darwin":
			systemDir = "/Library/Application Support/ClaudeCode"
		case "windows":
			systemDir = `C:\Program Files\ClaudeCode`
		default:
			systemDir = "/etc/claude-code"
		}
	}
	paths := []string{filepath.Join(systemDir, "managed-settings.json"), filepath.Join(systemDir, "ao-managed-enrollment")}
	documents := []claudePolicyDocument{}
	enrolled := false
	dropDir := filepath.Join(systemDir, "managed-settings.d")
	if err := fs.ancestors(dropDir); err != nil {
		return []claudePolicyDocument{{broken: true}}, true
	}
	if info, err := fs.lstat(dropDir); err == nil {
		enrolled = true
		if !fs.safe(dropDir, info, true) {
			return []claudePolicyDocument{{broken: true}}, true
		}
		entries, err := fs.readDir(dropDir)
		if err != nil {
			return []claudePolicyDocument{{broken: true}}, true
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), ".") && strings.HasSuffix(entry.Name(), ".json") {
				paths = append(paths, filepath.Join(dropDir, entry.Name()))
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return []claudePolicyDocument{{broken: true}}, true
	}
	if opts.ManagedSettingsDir == "" && opts.goos() == "darwin" {
		current, err := user.Current()
		if err != nil || filepath.Base(current.Username) != current.Username {
			return []claudePolicyDocument{{broken: true}}, true
		}
		preferences := filepath.Join(string(filepath.Separator), "Library", "Managed Preferences")
		userPreferences := filepath.Join(preferences, current.Username)
		paths = append(paths, filepath.Join(preferences, "com.anthropic.claudecode.plist"), filepath.Join(userPreferences, "com.anthropic.claudecode.plist"))
		for _, directory := range []string{preferences, userPreferences} {
			exists, err := fs.managedPreferencesEnrolled(directory)
			if err != nil {
				return []claudePolicyDocument{{broken: true}}, true
			}
			enrolled = enrolled || exists
		}
		for _, marker := range []string{"/private/var/db/ConfigurationProfiles/Settings/.cloudConfigHasActivationRecord", "/private/var/db/ConfigurationProfiles/Settings/.cloudConfigProfileInstalled"} {
			exists, err := fs.enrollmentMarker(marker)
			if err != nil {
				return []claudePolicyDocument{{broken: true}}, true
			}
			enrolled = enrolled || exists
		}

	}
	for _, path := range paths {
		data, exists, err := fs.read(path)
		enrolled = enrolled || exists
		if err != nil || ctx.Err() != nil {
			return []claudePolicyDocument{{broken: true}}, true
		}
		if !exists || filepath.Base(path) == "ao-managed-enrollment" {
			continue
		}
		if strings.HasSuffix(path, ".plist") {
			runner := opts.Runner
			if runner == nil {
				runner = execCommand
			}
			bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
			converted, convertErr := runner(bounded, "/usr/bin/plutil", "-convert", "json", "-o", "-", path)
			cancel()
			after, _, readErr := fs.read(path)
			if convertErr != nil || readErr != nil || !bytes.Equal(data, after) {
				return []claudePolicyDocument{{broken: true}}, true
			}
			data = converted
		}
		documents = append(documents, parseClaudePolicyDocument(data))
	}
	if opts.ManagedSettingsDir == "" && opts.goos() == "windows" {
		registry, exists := protectedDelegationRegistry(ctx)
		documents = append(documents, registry...)
		enrolled = enrolled || exists
	}
	return documents, enrolled
}
