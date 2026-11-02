// Package agentassets maps configured source directories to native harness inputs.
package agentassets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// SourcesEnv carries resolved sources across AO's provider launch boundary.
const SourcesEnv = "AO_AGENT_ASSET_SOURCES"

// ClaudeInstructionsEnv enables instruction discovery in native added roots.
const ClaudeInstructionsEnv = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"

// Resolve validates sources and skips unavailable directories without modifying them.
func Resolve(ctx context.Context, projectPath string, sources []string, warn func(string)) ([]string, error) {
	if err := domain.ValidateAgentAssetSources(sources); err != nil {
		return nil, err
	}
	resolved := make([]string, 0, len(sources))
	seen := map[string]bool{}
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !filepath.IsAbs(source) {
			if projectPath == "" {
				warn(fmt.Sprintf("relative agent asset source %q has no project root; skipped", source))
				continue
			}
			source = filepath.Join(projectPath, source)
		}
		absolute, err := filepath.Abs(source)
		if err != nil {
			return nil, err
		}
		if err := readableDirectory(absolute); err != nil {
			warn(fmt.Sprintf("agent asset source %q is missing, unreadable, or not a directory; skipped: %v", absolute, err))
			continue
		}
		if !seen[absolute] {
			seen[absolute] = true
			resolved = append(resolved, absolute)
		}
	}
	return resolved, nil
}

// SetEnv records the resolved directories for one provider launch.
func SetEnv(env map[string]string, sources []string) {
	data, _ := json.Marshal(sources)
	env[SourcesEnv] = string(data)
}

// FromEnv reads the launch-owned source list.
func FromEnv(env map[string]string) []string {
	var sources []string
	_ = json.Unmarshal([]byte(env[SourcesEnv]), &sources)
	return sources
}

// ClaudeRoots returns roots containing Claude Code's native asset folders.
func ClaudeRoots(env map[string]string) []string {
	roots := make([]string, 0, len(FromEnv(env)))
	seen := map[string]bool{}
	for _, source := range FromEnv(env) {
		root := source
		switch filepath.Base(source) {
		case ".claude":
			root = filepath.Dir(source)
		case ".agents":
			continue
		}
		if !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots
}

// CodexSkillRoots returns native skill directories for a session-owned app-server.
func CodexSkillRoots(ctx context.Context, env map[string]string, warn func(string)) ([]string, error) {
	roots := make([]string, 0, len(FromEnv(env)))
	seen := map[string]bool{}
	for _, source := range FromEnv(env) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var root string
		switch filepath.Base(source) {
		case ".agents":
			root = filepath.Join(source, "skills")
		case ".claude":
			continue
		default:
			root = filepath.Join(source, ".agents", "skills")
		}
		if err := readableDirectory(root); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				warn(fmt.Sprintf("agent skill source %q is unreadable or not a directory; skipped: %v", root, err))
			}
			continue
		}
		if !seen[root] {
			seen[root] = true
			roots = append(roots, root)
		}
	}
	return roots, nil
}

func readableDirectory(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("not a directory")
	}
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	_, readErr := directory.ReadDir(1)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return readErr
	}
	return closeErr
}

// ClaudeCommand adds native directory flags without replacing workspace assets.
func ClaudeCommand(argv []string, env map[string]string) []string {
	roots := ClaudeRoots(env)
	if len(argv) == 0 || len(roots) == 0 {
		return argv
	}
	env[ClaudeInstructionsEnv] = "1"
	out := []string{argv[0]}
	for _, root := range roots {
		out = append(out, "--add-dir", root)
	}
	return append(out, argv[1:]...)
}
