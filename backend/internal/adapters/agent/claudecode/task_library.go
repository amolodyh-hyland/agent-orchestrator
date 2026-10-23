package claudecode

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"golang.org/x/text/cases"
	"gopkg.in/yaml.v3"
)

type taskLibraryEvidence struct {
	providerVersion    string
	resolutionVerified bool
	externalNames      []string
	maxBytes           int64
	maxGuidance        int64
}

func (p *Plugin) PrepareTaskLibrary(ctx context.Context, cfg ports.TaskLibraryConfig) (ports.TaskLibraryProjection, error) {
	// No provider/version has passed the native resolution and collision evidence gate.
	return prepareTaskLibrary(ctx, cfg, nil)
}

type taskLibraryFile struct{ path, text string }

func prepareTaskLibrary(ctx context.Context, cfg ports.TaskLibraryConfig, evidence *taskLibraryEvidence) (ports.TaskLibraryProjection, error) {
	result := ports.TaskLibraryProjection{}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if cfg.Snapshot.SchemaVersion != 1 {
		return result, fmt.Errorf("library: unsupported_schema")
	}
	if err := cfg.Snapshot.VerifyDigest(); err != nil {
		return result, fmt.Errorf("library: snapshot_digest_mismatch")
	}
	if cfg.Snapshot.Channel != domain.SessionModeTUI || cfg.Snapshot.ProviderID != "claude-code" {
		return result, fmt.Errorf("library: unsupported_provider")
	}
	names := map[string][]int{}
	files := map[int][]taskLibraryFile{}
	rules := map[int]string{}
	for _, selected := range cfg.Snapshot.Entries {
		e := selected.Entry
		b := ports.TaskLibraryBinding{EntryID: e.EntryID, ContentHash: e.ContentHash, Status: selected.Status, ReasonCode: selected.ReasonCode}
		if selected.ApprovalID == "" {
			result.Bindings = append(result.Bindings, b)
			continue
		}
		if err := (domain.LibraryStagedEntry{Entry: e, Content: selected.Content}).Verify(); err != nil {
			return result, fmt.Errorf("library: digest_mismatch")
		}
		b.Status, b.ReasonCode = "unsupported_format", "unsupported_behavior"
		if len(e.Requirements) == 0 && e.Status != "unsupported_format" && declarativeTaskContent(selected) {
			switch {
			case e.Kind == "rule" && e.Format == "plain-rule-v1" && len(e.Files) == 1 && !strings.HasPrefix(selected.Content[e.EntryPoint], "---"):
				rules[len(result.Bindings)] = selected.Content[e.EntryPoint]
				b.Status, b.ReasonCode = "unsupported_provider", "version_evidence_required"
			case e.Kind == "skill" && e.Format == "native-skill-v1" && path.Base(e.EntryPoint) == "SKILL.md":
				name, err := taskSkillName(selected.Content[e.EntryPoint])
				dir := path.Dir(e.EntryPoint)
				if err == nil && (dir == "." || path.Base(dir) == name) {
					b.NativeName = name
					b.NativePath = path.Join(".claude/skills", name, "SKILL.md")
					for _, f := range e.Files {
						relative := f.Path
						if dir != "." {
							relative = strings.TrimPrefix(f.Path, dir+"/")
						}
						if f.Path != e.EntryPoint && (dir != "." && relative == f.Path) {
							return result, fmt.Errorf("library: external_include")
						}
						files[len(result.Bindings)] = append(files[len(result.Bindings)], taskLibraryFile{path.Join(".claude/skills", name, relative), selected.Content[f.Path]})
					}
					b.Status, b.ReasonCode = "unsupported_provider", "version_evidence_required"
				}
			case e.Kind == "prompt_command" && e.Format == "claude-command-v1" && len(e.Files) == 1:
				name := strings.TrimSuffix(e.EntryPoint, ".md")
				if strings.HasSuffix(e.EntryPoint, ".md") && validTaskNativeName(strings.ReplaceAll(name, "/", ":")) {
					b.NativeName = strings.ReplaceAll(name, "/", ":")
					b.NativePath = path.Join(".claude/commands", e.EntryPoint)
					files[len(result.Bindings)] = []taskLibraryFile{{b.NativePath, selected.Content[e.EntryPoint]}}
					b.Status, b.ReasonCode = "unsupported_provider", "version_evidence_required"
				}
			}
		}
		if b.NativeName != "" {
			key := cases.Fold().String(b.NativeName)
			names[key] = append(names[key], len(result.Bindings))
		}
		result.Bindings = append(result.Bindings, b)
	}
	for _, indexes := range names {
		if len(indexes) > 1 {
			for _, i := range indexes {
				result.Bindings[i].Status, result.Bindings[i].ReasonCode = "conflict", "ambiguous_native_name"
			}
		}
	}
	// Fixture placement is not native-provider conformance evidence. Production passes no evidence.
	if evidence == nil || evidence.providerVersion == "" || !evidence.resolutionVerified {
		return result, nil
	}
	for _, name := range evidence.externalNames {
		for _, i := range names[cases.Fold().String(name)] {
			result.Bindings[i].Status, result.Bindings[i].ReasonCode = "conflict", "ambiguous_native_name"
		}
	}
	var total, guidance int64
	var selectedFiles []taskLibraryFile
	for i, b := range result.Bindings {
		if b.Status != "unsupported_provider" || b.ReasonCode != "version_evidence_required" {
			continue
		}
		for _, f := range files[i] {
			total += int64(len(f.text))
			selectedFiles = append(selectedFiles, f)
		}
		if text, ok := rules[i]; ok {
			total += int64(len(text) + 1)
			guidance += int64(len(text) + 1)
		}
	}
	if evidence.maxBytes <= 0 || evidence.maxGuidance <= 0 || total > evidence.maxBytes || guidance > evidence.maxGuidance {
		return result, fmt.Errorf("library: runtime_limit")
	}
	sort.Slice(selectedFiles, func(i, j int) bool { return selectedFiles[i].path < selectedFiles[j].path })
	cleanup, err := materializeTaskLibrary(ctx, cfg.WorkspacePath, selectedFiles)
	if err != nil {
		return result, err
	}
	result.Cleanup = cleanup
	for i, b := range result.Bindings {
		if b.Status == "unsupported_provider" && b.ReasonCode == "version_evidence_required" {
			result.Bindings[i].Status, result.Bindings[i].ReasonCode = "prepared", "native_conformance_not_released"
			if text, ok := rules[i]; ok {
				result.Rules += text + "\n"
			}
		}
	}
	return result, nil
}

func validTaskNativeName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == ':') {
			return false
		}
	}
	return true
}
func taskSkillName(text string) (string, error) {
	lines := strings.Split(text, "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return "", errors.New("frontmatter_required")
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			var fields map[string]any
			if err := yaml.Unmarshal([]byte(strings.Join(lines[1:i], "\n")), &fields); err != nil {
				return "", err
			}
			name, ok := fields["name"].(string)
			if !ok || !validTaskNativeName(name) || strings.Contains(name, ":") {
				return "", errors.New("invalid_native_name")
			}
			for k := range fields {
				if k != "name" && k != "description" {
					return "", errors.New("unsupported_behavior")
				}
			}
			return name, nil
		}
	}
	return "", errors.New("invalid_frontmatter")
}

var _ ports.TaskLibraryProjector = (*Plugin)(nil)

func declarativeTaskContent(selected domain.LibrarySnapshotEntry) bool {
	for name, text := range selected.Content {
		if strings.Contains(text, "!`") || strings.Contains(text, "$(") || strings.Contains(text, "${") {
			return false
		}
		if name != selected.Entry.EntryPoint {
			if path.Ext(name) != ".md" && path.Ext(name) != ".txt" {
				return false
			}
			for _, part := range strings.Split(name, "/") {
				if strings.HasPrefix(part, ".") {
					return false
				}
			}
		}
	}
	if selected.Entry.Kind != "prompt_command" {
		return true
	}
	text := selected.Content[selected.Entry.EntryPoint]
	lines := strings.Split(text, "\n")
	if strings.TrimSpace(lines[0]) != "---" {
		return true
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			var fields map[string]any
			if yaml.Unmarshal([]byte(strings.Join(lines[1:i], "\n")), &fields) != nil {
				return false
			}
			for k, v := range fields {
				if k != "name" && k != "description" && k != "argument-hint" {
					return false
				}
				if _, ok := v.(string); !ok {
					return false
				}
			}
			return true
		}
	}
	return false
}

func (p *Plugin) TaskLibraryCapabilities() ports.TaskLibraryCapabilities {
	return ports.TaskLibraryCapabilities{ProviderID: "claude-code", AdapterID: "claude-code-task-library", AdapterVersion: "1", Surface: "task", Status: "unsupported_provider", ReasonCode: "version_evidence_required"}
}
