package domain

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
)

// ValidateAgentAssetSources checks machine-local or project-relative directory names.
func ValidateAgentAssetSources(sources []string) error {
	if len(sources) > 64 {
		return fmt.Errorf("agentAssetSources: at most 64 directories are allowed")
	}
	for _, source := range sources {
		if strings.TrimSpace(source) == "" || strings.ContainsFunc(source, unicode.IsControl) {
			return fmt.Errorf("agentAssetSources: directory must be nonempty and contain no control characters")
		}
		if !filepath.IsAbs(source) && source != "." {
			if err := validateRepoRelative(source); err != nil {
				return fmt.Errorf("agentAssetSources: %w", err)
			}
		}
	}
	return nil
}

// ResolveAgentAssetSources inherits defaults only when the project has no override.
func (c ProjectConfig) ResolveAgentAssetSources(defaults []string) []string {
	if c.AgentAssetSources != nil {
		return append([]string{}, (*c.AgentAssetSources)...)
	}
	return append([]string{}, defaults...)
}
