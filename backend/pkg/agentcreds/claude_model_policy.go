package agentcreds

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// ClaudeModelPolicy contains only model-selection policy, never credentials.
// A nil Available list is unrestricted; a non-nil empty list blocks named models.
type ClaudeModelPolicy struct {
	Available  []string          `json:"available"`
	Denied     []string          `json:"denied"`
	Exact      bool              `json:"exact"`
	Disable1M  bool              `json:"disable1m"`
	Unresolved bool              `json:"unresolved"`
	Aliases    map[string]string `json:"aliases,omitempty"`
	Overrides  map[string]string `json:"overrides,omitempty"`
}

func (p ClaudeModelPolicy) Fingerprint() string {
	data, _ := json.Marshal(p)
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

type claudePolicyDocument struct {
	delegationPolicies []json.RawMessage
	dynamic            bool
	empty              bool
	values             map[string]json.RawMessage
	broken             bool
	userFallback       bool
}

func readClaudePolicyDocument(ctx context.Context, path string) claudePolicyDocument {
	if ctx.Err() != nil {
		return claudePolicyDocument{broken: true}
	}
	f, err := os.Open(path) //nolint:gosec // documented settings paths, not credential stores
	if os.IsNotExist(err) {
		return claudePolicyDocument{}
	}
	if err != nil {
		return claudePolicyDocument{broken: true}
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || ctx.Err() != nil {
		return claudePolicyDocument{broken: true}
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return claudePolicyDocument{empty: true}
	}
	return parseClaudePolicyDocument(data)
}

func parseClaudePolicyDocument(data []byte) claudePolicyDocument {
	var values map[string]json.RawMessage
	if len(data) > 1<<20 || json.Unmarshal(data, &values) != nil || values == nil {
		return claudePolicyDocument{broken: true}
	}
	doc := claudePolicyDocument{values: values}
	decoder := json.NewDecoder(bytes.NewReader(data))
	_, _ = decoder.Token()
	for decoder.More() {
		name, _ := decoder.Token()
		var raw json.RawMessage
		_ = decoder.Decode(&raw)
		if name == "aoMulticaDelegation" {
			doc.delegationPolicies = append(doc.delegationPolicies, raw)
		}
		if name == "policyHelper" && string(raw) != "null" {
			doc.dynamic = true
		}
	}
	return doc
}

func (d claudePolicyDocument) present() bool {
	for key, value := range d.values {
		if key != "managedSourcesBehavior" && key != "wslInheritsWindowsSettings" && string(value) != "null" {
			return true
		}
	}
	return d.broken
}

func policyStringList(raw json.RawMessage) []string {
	items := []json.RawMessage{}
	if json.Unmarshal(raw, &items) != nil {
		return []string{}
	}
	result := []string{}
	for _, item := range items {
		var value string
		if json.Unmarshal(item, &value) == nil && strings.TrimSpace(value) != "" && !slices.Contains(result, value) {
			result = append(result, value)
		}
	}
	return result
}

// ResolveClaudeModelPolicy reads cached remote, OS and file-based policy, then
// user/project/local model settings. No network fetch or executable helper runs.
// Unreadable/dynamic policy yields no asserted named choices rather than guessing.
func ResolveClaudeModelPolicy(ctx context.Context, workingDir string, env map[string]string, opts ResolveOptions) ClaudeModelPolicy {
	settings := ResolveClaudeSettings(ctx, workingDir, env, opts)
	p := ClaudeModelPolicy{Aliases: make(map[string]string), Overrides: make(map[string]string)}
	p.Disable1M = settings.Env["CLAUDE_CODE_DISABLE_1M_CONTEXT"] == "1" || settings.Env["CLAUDE_CODE_DISABLE_1M_CONTEXT"] == "true"
	for _, family := range []string{"sonnet", "opus", "haiku", "fable"} {
		if value := settings.Env["ANTHROPIC_DEFAULT_"+strings.ToUpper(family)+"_MODEL"]; value != "" {
			p.Aliases[family] = value
		}
	}
	pathOpts := opts
	pathOpts.WorkingDir = workingDir
	pathOpts.Env = func(key string) string {
		if value, ok := env[key]; ok {
			return value
		}
		return opts.env(key)
	}
	dir, err := claudeConfigDir(pathOpts)
	if err != nil {
		p.Unresolved = true
		return p
	}
	paths := []string{filepath.Join(dir, "settings.json")}
	if workingDir != "" {
		paths = append(paths, filepath.Join(workingDir, ".claude", "settings.json"), filepath.Join(workingDir, ".claude", "settings.local.json"))
	}
	for _, path := range paths {
		doc := readClaudePolicyDocument(ctx, path)
		if raw, ok := doc.values["availableModels"]; ok {
			if p.Available == nil {
				p.Available = []string{}
			}
			p.Available = appendPolicyUnique(p.Available, policyStringList(raw)...)
		}
		mergePolicyOverrides(&p, doc)
	}
	remote, sources := readClaudeManagedPolicySources(ctx, opts, dir)
	merge := false
	for _, source := range sources {
		raw, control := source.values["managedSourcesBehavior"]
		if source.present() || control {
			var behavior string
			_ = json.Unmarshal(raw, &behavior)
			merge = behavior == "merge"
			break
		}
	}
	// env is a per-variable cross-source merge even under first-wins.
	for i := len(sources) - 1; i >= 0; i-- {
		mergePolicyEnv(&p, sources[i])
	}
	var selected []claudePolicyDocument
	for _, source := range sources {
		p.Unresolved = p.Unresolved || source.broken
		if source.present() && (merge || len(selected) == 0) {
			selected = append(selected, source)
		}
	}
	// Across managed sources the highest allowlist wins, even in merge mode.
	for i := len(selected) - 1; i >= 0; i-- {
		source := selected[i]
		if raw, ok := source.values["availableModels"]; ok {
			p.Available = policyStringList(raw)
			p.Overrides = make(map[string]string)
		}
		if raw, ok := source.values["deniedModels"]; ok {
			var valid []string
			if json.Unmarshal(raw, &valid) != nil {
				p.Unresolved = true
			}
			p.Denied = appendPolicyUnique(p.Denied, policyStringList(raw)...)
		}
		if raw, ok := source.values["availableModelsMatch"]; ok {
			var match string
			if json.Unmarshal(raw, &match) != nil || match != "prefix" && match != "exact" {
				p.Unresolved = true
			}
			p.Exact = p.Exact || match == "exact"
		}
		if raw := source.values["policyHelper"]; len(raw) != 0 && string(raw) != "null" {
			p.Unresolved = true
		}
		mergePolicyOverrides(&p, source)
	}
	// A cached remote policy on another provider may not be the policy the CLI
	// selects. Do not use it to suppress a device policy or assert model access.
	providerOpts := pathOpts
	providerOpts.Env = func(key string) string { return settings.Env[key] }
	provider, _ := ResolveProvider("", providerOpts)
	if remote.present() && provider != ProviderFirstParty {
		p.Unresolved = true
	}
	return p
}

func readClaudeManagedPolicySources(ctx context.Context, opts ResolveOptions, dir string) (claudePolicyDocument, []claudePolicyDocument) {
	remote := readClaudePolicyDocument(ctx, filepath.Join(dir, "remote-settings.json"))
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
	file := readClaudePolicyDocument(ctx, filepath.Join(systemDir, "managed-settings.json"))
	dropIns, readErr := os.ReadDir(filepath.Join(systemDir, "managed-settings.d"))
	if readErr != nil && !os.IsNotExist(readErr) {
		file.broken = true
	}
	for _, entry := range dropIns { // os.ReadDir returns lexical order.
		if !entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && strings.HasSuffix(entry.Name(), ".json") {
			file = mergeClaudePolicyDocuments(file, readClaudePolicyDocument(ctx, filepath.Join(systemDir, "managed-settings.d", entry.Name())))
		}
	}
	osPolicy := claudePolicyDocument{}
	if opts.ManagedSettingsDir == "" {
		osPolicy = readClaudeOSPolicy(ctx, opts, readClaudeRegistryValue)
	}
	sources := []claudePolicyDocument{remote, osPolicy, file}
	if osPolicy.userFallback {
		sources = []claudePolicyDocument{remote, file}
		if !remote.present() && !file.present() {
			sources = append(sources, osPolicy)
		}
	}
	return remote, sources
}

func appendPolicyUnique(values []string, extra ...string) []string {
	for _, value := range extra {
		if !slices.Contains(values, value) {
			values = append(values, value)
		}
	}
	return values
}

func mergeClaudePolicyDocuments(base, next claudePolicyDocument) claudePolicyDocument {
	if base.values == nil {
		base.values = make(map[string]json.RawMessage)
	}
	base.broken = base.broken || next.broken
	base.empty = base.empty || next.empty
	base.dynamic = base.dynamic || next.dynamic
	base.delegationPolicies = append(base.delegationPolicies, next.delegationPolicies...)
	for key, value := range next.values {
		if (key == "availableModels" || key == "deniedModels") && base.values[key] != nil {
			merged := appendPolicyUnique(policyStringList(base.values[key]), policyStringList(value)...)
			base.values[key], _ = json.Marshal(merged)
		} else if key == "env" || key == "modelOverrides" {
			var old, extra map[string]json.RawMessage
			_ = json.Unmarshal(base.values[key], &old)
			if json.Unmarshal(value, &extra) != nil {
				base.broken = true
				continue
			}
			if old == nil {
				old = make(map[string]json.RawMessage)
			}
			for name, item := range extra {
				old[name] = item
			}
			base.values[key], _ = json.Marshal(old)
		} else {
			base.values[key] = value
		}
	}
	return base
}

func mergePolicyOverrides(p *ClaudeModelPolicy, doc claudePolicyDocument) {
	var overrides map[string]string
	if json.Unmarshal(doc.values["modelOverrides"], &overrides) == nil {
		for key, value := range overrides {
			p.Overrides[key] = value
		}
	}
}

func mergePolicyEnv(p *ClaudeModelPolicy, doc claudePolicyDocument) {
	var env map[string]string
	if json.Unmarshal(doc.values["env"], &env) == nil {
		for _, family := range []string{"sonnet", "opus", "haiku", "fable"} {
			if value, ok := env["ANTHROPIC_DEFAULT_"+strings.ToUpper(family)+"_MODEL"]; ok {
				p.Aliases[family] = strings.TrimSpace(value)
			}
		}
		if value, ok := env["CLAUDE_CODE_DISABLE_1M_CONTEXT"]; ok {
			p.Disable1M = value == "1" || value == "true"
		}
	}
}

type claudeRegistryValue struct {
	data       []byte
	expandable bool
}

type claudeRegistryReader func(context.Context, string) (claudeRegistryValue, error)

func readClaudeOSPolicy(ctx context.Context, opts ResolveOptions, readRegistry claudeRegistryReader) claudePolicyDocument {
	runner := opts.Runner
	if runner == nil {
		runner = execCommand
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	switch opts.goos() {
	case "darwin":
		paths := []string{filepath.Join("/Library/Managed Preferences", opts.env("USER"), "com.anthropic.claudecode.plist"), "/Library/Managed Preferences/com.anthropic.claudecode.plist"}
		return readClaudeMacPolicy(ctx, runner, paths)
	case "windows":
		for _, hive := range []string{"HKLM", "HKCU"} {
			value, err := readRegistry(ctx, hive)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return claudePolicyDocument{broken: true}
			}
			if value.expandable && strings.Contains(string(value.data), "%") {
				// Expansion can alter restrictions, not just paths. Without a
				// native effective-settings report do not guess its result.
				return claudePolicyDocument{broken: true}
			}
			doc := parseClaudePolicyDocument(value.data)
			if !doc.present() && len(doc.delegationPolicies) == 0 && !doc.dynamic && hive == "HKLM" {
				continue
			}
			doc.userFallback = hive == "HKCU"
			return doc
		}
	}
	return claudePolicyDocument{}
}

func readClaudeMacPolicy(ctx context.Context, runner commandRunner, paths []string) claudePolicyDocument {
	// Managed preferences can be delivered for a user or for the machine.
	// Merge per key with the user-specific managed preference taking priority.
	merged := claudePolicyDocument{}
	for i := len(paths) - 1; i >= 0; i-- {
		path := paths[i]
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		}
		data, err := runner(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", path)
		if err != nil {
			return claudePolicyDocument{broken: true}
		}
		doc := parseClaudePolicyDocument(data)
		merged.broken = merged.broken || doc.broken
		merged.dynamic = merged.dynamic || doc.dynamic
		merged.delegationPolicies = append(merged.delegationPolicies, doc.delegationPolicies...)
		if merged.values == nil {
			merged.values = make(map[string]json.RawMessage)
		}
		for key, value := range doc.values {
			merged.values[key] = value
		}
	}
	return merged
}

var claudePolicyFamily = regexp.MustCompile(`^(?:claude-)?(sonnet|opus|haiku|fable)(?:-|\[|$)`)
var claudePolicySnapshot = regexp.MustCompile(`(?:-|@)[0-9]{8}$`)
var claudePolicyBedrockSuffix = regexp.MustCompile(`-v[0-9]+:[0-9]+$`)

func canonicalClaudePolicyID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	id, _, _ = strings.Cut(id, "[")
	return id
}

// Denials apply to every provider spelling. Allowlist version entries, however,
// match the full provider ID; stripping its prefix would broaden permission.
func underlyingClaudePolicyID(id string) string {
	id = canonicalClaudePolicyID(id)
	if start := strings.Index(id, "claude-"); start >= 0 {
		id = id[start:]
	}
	id = claudePolicyBedrockSuffix.ReplaceAllString(id, "")
	return strings.ReplaceAll(id, "@", "-")
}

func policyFamily(id string) string {
	if match := claudePolicyFamily.FindStringSubmatch(underlyingClaudePolicyID(id)); match != nil {
		return match[1]
	}
	return ""
}

// Allows checks named selections only. Unresolved aliases under a version or
// deny restriction are omitted instead of guessing which version the CLI uses.
func (p ClaudeModelPolicy) Allows(id string) bool {
	if p.Unresolved || p.Disable1M && strings.Contains(strings.ToLower(id), "[1m]") {
		return false
	}
	original := canonicalClaudePolicyID(id)
	model := original
	family := policyFamily(model)
	alias := model == family && family != ""
	if target := p.Aliases[family]; alias && target != "" {
		model = canonicalClaudePolicyID(target)
	}
	// Ambiguous reverse overrides must satisfy every possible mapping,
	// independent of map iteration order.
	var mapped []string
	for source, target := range p.Overrides {
		if canonicalClaudePolicyID(target) == model {
			mapped = append(mapped, source)
		}
	}
	if len(mapped) > 0 {
		copy := p
		copy.Overrides = nil
		for _, source := range mapped {
			if !copy.Allows(source) {
				return false
			}
		}
		return true
	}
	family = policyFamily(model)
	for _, denied := range p.Denied {
		if policyIDMatches(underlyingClaudePolicyID(denied), underlyingClaudePolicyID(model), false) || alias && model == original && policyFamily(denied) == family {
			return false
		}
	}
	if p.Available == nil {
		return true
	}
	for _, allowed := range p.Available {
		entry := canonicalClaudePolicyID(allowed)
		if entry == family && family != "" {
			if slices.ContainsFunc(p.Available, func(other string) bool {
				return policyFamily(other) == family && canonicalClaudePolicyID(other) != family
			}) {
				continue
			}
			return true
		}
		if policyIDMatches(entry, model, p.Exact) {
			return true
		}
	}
	return false
}

func policyIDMatches(pattern, model string, exact bool) bool {
	pattern, model = canonicalClaudePolicyID(pattern), canonicalClaudePolicyID(model)
	if pattern == policyFamily(model) && pattern != "" {
		return true
	}
	if exact && !claudePolicySnapshot.MatchString(pattern) {
		model = claudePolicySnapshot.ReplaceAllString(model, "")
	}
	return model == pattern || !exact && strings.HasPrefix(model, pattern+"-")
}
