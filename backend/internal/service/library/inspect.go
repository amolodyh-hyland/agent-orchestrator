package library

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"gopkg.in/yaml.v3"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func targetIdentity(info os.FileInfo) (string, error) {
	v := reflect.Indirect(reflect.ValueOf(info.Sys()))
	if !v.IsValid() || v.Kind() != reflect.Struct {
		return "", fail("unsupported_provider")
	}
	dev, ino := v.FieldByName("Dev"), v.FieldByName("Ino")
	if !dev.IsValid() || !ino.IsValid() {
		return "", fail("unsupported_provider")
	}
	return fmt.Sprintf("%v:%v", dev.Interface(), ino.Interface()), nil
}

type inspection struct {
	ctx        context.Context
	nodes      int
	totalBytes int64
	afterRead  func(string)
	candidates int
	files      map[string]string
	dirs       map[string]bool
}

func (i *inspection) walk(root *os.Root, prefix string, depth int) error {
	if err := i.ctx.Err(); err != nil {
		return fail("resolution_timeout")
	}
	before, err := root.Stat(".")
	if err != nil {
		return fail("missing_source")
	}
	dir, err := root.Open(".")
	if err != nil {
		return fail("missing_source")
	}
	nodes, err := dir.ReadDir(domain.MaxLibraryNodes + 1)
	_ = dir.Close()
	if err != nil {
		return fail("missing_source")
	}
	sort.Slice(nodes, func(a, b int) bool { return nodes[a].Name() < nodes[b].Name() })
	for _, node := range nodes {
		i.nodes++
		if i.nodes > domain.MaxLibraryNodes {
			return fail("scan_limit")
		}
		name := node.Name()
		relative := path.Join(prefix, name)
		if err := domain.ValidateLibraryPath(relative); err != nil {
			return fail("invalid_path")
		}
		pre, err := root.Lstat(name)
		if err != nil {
			return fail("source_changed")
		}
		if pre.Mode()&os.ModeSymlink != 0 {
			return fail("symlink_denied")
		}
		if pre.IsDir() {
			if depth >= domain.MaxLibraryDepth {
				return fail("scan_limit")
			}
			child, err := root.OpenRoot(name)
			if err != nil {
				return fail("source_changed")
			}
			info, err := child.Stat(".")
			if err != nil || !os.SameFile(pre, info) {
				_ = child.Close()
				return fail("source_changed")
			}
			i.dirs[relative] = true
			err = i.walk(child, relative, depth+1)
			_ = child.Close()
			if err != nil {
				return err
			}
			post, err := root.Lstat(name)
			if err != nil || !os.SameFile(pre, post) || post.Mode()&os.ModeSymlink != 0 {
				return fail("source_changed")
			}
		} else {
			if !pre.Mode().IsRegular() {
				return fail("special_file")
			}
			if pre.Size() > domain.MaxLibraryFileBytes {
				return fail("file_limit")
			}
			if pre.Mode().Perm()&0o111 != 0 {
				return fail("executable_file")
			}
			f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return fail("source_changed")
			}
			actual, err := f.Stat()
			if err != nil || !actual.Mode().IsRegular() || !os.SameFile(pre, actual) {
				_ = f.Close()
				return fail("source_changed")
			}
			data, err := io.ReadAll(io.LimitReader(f, domain.MaxLibraryFileBytes+1))
			post, statErr := f.Stat()
			_ = f.Close()
			current, currentErr := root.Lstat(name)
			if err != nil || statErr != nil || currentErr != nil || !os.SameFile(pre, current) || current.Mode()&os.ModeSymlink != 0 || post.Size() != pre.Size() || !post.ModTime().Equal(pre.ModTime()) || int64(len(data)) != pre.Size() {
				return fail("source_changed")
			}
			if len(data) > domain.MaxLibraryFileBytes {
				return fail("file_limit")
			}
			if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
				return fail("invalid_text")
			}
			i.totalBytes += int64(len(data))
			if i.totalBytes > domain.MaxLibraryEntryBytes {
				return fail("session_size_limit")
			}
			i.files[relative] = string(data)
			if i.afterRead != nil {
				i.afterRead(relative)
			}
		}
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		return fail("source_changed")
	}
	return nil
}

func inspectRoot(ctx context.Context, local domain.LibraryLocalSource, existing map[string]domain.LibraryStagedEntry, authority string) ([]domain.LibraryStagedEntry, error) {
	pre, err := os.Lstat(local.RootPath)
	if err != nil || !pre.IsDir() || pre.Mode()&os.ModeSymlink != 0 {
		return nil, fail("source_changed")
	}
	identity, err := targetIdentity(pre)
	if err != nil || identity != local.TargetIdentity {
		return nil, fail("root_replaced")
	}
	root, err := os.OpenRoot(local.RootPath)
	if err != nil {
		return nil, fail("missing_source")
	}
	defer func() { _ = root.Close() }()
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(pre, opened) {
		return nil, fail("root_replaced")
	}
	scan := inspection{ctx: ctx, files: map[string]string{}, dirs: map[string]bool{}}
	if err := scan.walk(root, "", 0); err != nil {
		return nil, err
	}
	verify := inspection{ctx: ctx, files: map[string]string{}, dirs: map[string]bool{}}
	if err := verify.walk(root, "", 0); err != nil {
		return nil, err
	}
	if len(scan.files) != len(verify.files) {
		return nil, fail("source_changed")
	}
	for name, data := range scan.files {
		if verify.files[name] != data {
			return nil, fail("source_changed")
		}
	}
	post, err := os.Lstat(local.RootPath)
	if err != nil || post.Mode()&os.ModeSymlink != 0 || !os.SameFile(pre, post) {
		return nil, fail("root_replaced")
	}
	paths := make([]string, 0, len(scan.files))
	for p := range scan.files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	folded := map[string]bool{}
	for _, name := range paths {
		key := cases.Fold().String(name)
		if folded[key] {
			return nil, fail("path_collision")
		}
		folded[key] = true
	}
	var out []domain.LibraryStagedEntry
	selected := map[string]bool{}
	for _, p := range paths {
		kind, format := "", ""
		switch local.RootKind {
		case "claude-skills", "codex-skills":
			if path.Base(p) == "SKILL.md" && (strings.Count(p, "/") == 1 || p == "SKILL.md") {
				kind = "skill"
				format = "native-skill-v1"
			}
		case "claude-commands":
			if strings.HasSuffix(p, ".md") {
				kind = "prompt_command"
				format = "claude-command-v1"
			}
		case "rules":
			if strings.HasSuffix(p, ".md") {
				kind = "rule"
				format = "plain-rule-v1"
			}
		case "claude-personas":
			if strings.HasSuffix(p, ".md") {
				kind = "persona"
				format = "claude-role-v1"
			}
		case "codex-personas":
			if strings.HasSuffix(p, ".toml") {
				kind = "persona"
				format = "codex-role-v1"
			}
		case "hooks":
			kind = "hook"
			format = "hook-inventory-v1"
		}
		if kind == "" {
			continue
		}
		scan.candidates++
		if scan.candidates > domain.MaxLibraryEntries {
			return nil, fail("scan_limit")
		}
		id := "ent_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		for _, old := range existing {
			if old.Entry.SourceID == local.Source.SourceID && old.Entry.EntryPoint == p {
				id = old.Entry.EntryID
				break
			}
		}
		entry := domain.LibraryEntry{SchemaVersion: 1, EntryID: id, SourceID: local.Source.SourceID, Kind: kind, DisplayName: strings.TrimSuffix(path.Base(p), path.Ext(p)), Format: format, EntryPoint: p, Files: []domain.LibraryFile{}, Requirements: []string{}, Status: "unsupported_provider", ReasonCode: "version_evidence_required"}
		content := map[string]string{}
		for _, f := range paths {
			belongs := f == p
			if kind == "skill" {
				belongs = belongs || path.Dir(p) == "." || strings.HasPrefix(f, path.Dir(p)+"/")
			}
			if !belongs {
				continue
			}
			data := scan.files[f]
			content[f] = data
			selected[f] = true
			entry.Files = append(entry.Files, domain.LibraryFile{Path: f, SHA256: domain.LibraryBytesHash([]byte(data)), SizeBytes: int64(len(data)), Mode: "text"})
		}
		classifyEntry(&entry, content[p])
		for name := range content {
			switch path.Ext(name) {
			case ".md", ".txt", ".json", ".yaml", ".yml", ".toml":
			default:
				entry.Status = "unsupported_format"
				entry.ReasonCode = "helper_dependency"
				entry.Requirements = append(entry.Requirements, "helper_dependency")
			}
		}
		entry.Provenance = domain.LibraryProvenance{OriginAuthorityID: authority, OriginSourceID: entry.SourceID, OriginEntryID: id, OriginKind: local.Source.OriginKind, ResolverID: local.Source.ResolverID, SourceRevision: local.Source.Revision + 1, AdapterVersion: format, Verification: "observed"}
		hash, err := entry.ComputeContentHash()
		if err != nil {
			return nil, fail(err.Error())
		}
		entry.ContentHash = hash
		out = append(out, domain.LibraryStagedEntry{Entry: entry, RootIdentity: local.Source.LibraryRootIdentity, Content: content, Present: true})
	}
	for _, p := range paths {
		if !selected[p] {
			return nil, fail("unsupported_file")
		}
	}
	return out, nil
}

func classifyEntry(e *domain.LibraryEntry, data string) {
	if e.Kind == "hook" || e.Kind == "persona" {
		e.Status = "unsupported_format"
		e.ReasonCode = "inventory_only"
		e.Requirements = []string{e.Kind}
		return
	}
	if strings.Contains(data, "!`") || strings.Contains(data, "$(") || strings.Contains(data, "${") {
		e.Kind = "executable_command"
		e.Status = "unsupported_format"
		e.ReasonCode = "executable_preprocessing"
		e.Requirements = []string{"executable_preprocessing"}
		return
	}
	if !strings.HasPrefix(data, "---\n") && !strings.HasPrefix(data, "---\r\n") {
		if e.Kind == "skill" {
			e.Status = "unsupported_format"
			e.ReasonCode = "frontmatter_required"
		}
		return
	}
	lines := strings.Split(data, "\n")
	end := 0
	for n := 1; n < len(lines); n++ {
		if strings.TrimSpace(lines[n]) == "---" {
			end = n
			break
		}
	}
	if end == 0 {
		e.Status = "unsupported_format"
		e.ReasonCode = "invalid_frontmatter"
		return
	}
	var fields map[string]any
	if err := yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &fields); err != nil {
		e.Status = "unsupported_format"
		e.ReasonCode = "invalid_frontmatter"
		return
	}
	for k, v := range fields {
		switch k {
		case "name", "description":
			if text, ok := v.(string); ok && k == "name" {
				e.DisplayName = text
			}
		case "argument-hint":
			if e.Kind != "prompt_command" {
				e.Requirements = append(e.Requirements, k)
			}
		default:
			e.Requirements = append(e.Requirements, k)
		}
	}
	sort.Strings(e.Requirements)
	if len(e.Requirements) > 0 {
		e.Status = "unsupported_format"
		e.ReasonCode = "unsupported_behavior"
	}
	if e.Kind == "rule" {
		e.Status = "unsupported_format"
		e.ReasonCode = "scoped_rule_unsupported"
	}
}
