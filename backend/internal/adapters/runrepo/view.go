package runrepo

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const maxIndexBytes = 64 << 20
const maxObjectEntries = 250000
const maxObjectBytes = int64(8) << 30

// gitView contains only a fixed configuration, snapshotted HEAD/index and owned
// object files. Git never discovers or opens the original repository config,
// config.worktree, include/includeIf targets, alternates, or external excludes.
type gitView struct {
	directory                string
	commonPath, metadataPath string
	common, metadata         *os.Root
	initial                  metadataSnapshot
}

type metadataSnapshot struct {
	head, ref, sha             string
	indexDigest, excludeDigest [32]byte
}

func fixedConfig(sha256Objects bool) string {
	version := 0
	extension := ""
	if sha256Objects {
		version = 1
		extension = "[extensions]\nobjectformat = sha256\n"
	}
	return fmt.Sprintf("[core]\nrepositoryformatversion = %d\nbare = false\nexcludesfile = %s\nattributesfile = %s\n%s", version, os.DevNull, os.DevNull, extension)
}

// readOwnedFile pins a bounded regular file before reading; os.Root prevents
// intermediate symlinks from resolving outside the owned metadata directory.
func readOwnedFile(root *os.Root, name string, limit int64, optional bool) ([]byte, error) {
	if !filepath.IsLocal(name) {
		return nil, errors.New("invalid metadata path")
	}
	before, err := root.Lstat(name)
	if optional && os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errors.New("unsafe or oversized metadata file")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) {
		return nil, errors.New("metadata identity changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("metadata exceeds limit")
	}
	return data, nil
}

func metadataPaths(repo, worktree string, root *os.Root) (string, string, error) {
	common, err := canonical(filepath.Join(repo, ".git"))
	if err != nil {
		return "", "", err
	}
	entry, err := root.Lstat(".git")
	if err != nil {
		return "", "", err
	}
	if entry.IsDir() {
		actual, err := canonical(filepath.Join(worktree, ".git"))
		if err != nil || actual != common {
			return "", "", errors.New("repository identity mismatch")
		}
		return common, common, nil
	}
	data, err := readOwnedFile(root, ".git", 4096, false)
	if err != nil {
		return "", "", err
	}
	target, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir: ")
	if !ok {
		return "", "", errors.New("invalid worktree pointer")
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(worktree, target)
	}
	target, err = canonical(target)
	if err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(common, target)
	if err != nil || !filepath.IsLocal(rel) {
		return "", "", errors.New("worktree metadata escapes registered repository")
	}
	metadata, _, err := openOwned(target)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = metadata.Close() }()
	data, err = readOwnedFile(metadata, "commondir", 4096, false)
	if err != nil {
		return "", "", err
	}
	shared := strings.TrimSpace(string(data))
	if !filepath.IsAbs(shared) {
		shared = filepath.Join(target, shared)
	}
	shared, err = canonical(shared)
	if err != nil || shared != common {
		return "", "", errors.New("repository identity mismatch")
	}
	return common, target, nil
}

func sourceSnapshot(common, metadata *os.Root) (metadataSnapshot, []byte, []byte, error) {
	var s metadataSnapshot
	head, err := readOwnedFile(metadata, "HEAD", 4096, false)
	if err != nil {
		return s, nil, nil, err
	}
	s.head = string(head)
	s.ref = strings.TrimPrefix(strings.TrimSpace(s.head), "ref: ")
	if !strings.HasPrefix(s.ref, "refs/heads/") || !filepath.IsLocal(s.ref) || strings.Contains(s.ref, "..") || strings.ContainsAny(s.ref, "\x00 \t\r\n~^:?*[\\") {
		return s, nil, nil, errors.New("owned branch HEAD required")
	}
	raw, err := readOwnedFile(common, s.ref, 4096, true)
	if err != nil {
		return s, nil, nil, err
	}
	if raw != nil {
		s.sha = strings.TrimSpace(string(raw))
	} else {
		packed, err := readOwnedFile(common, "packed-refs", 32<<20, true)
		if err != nil {
			return s, nil, nil, err
		}
		for _, line := range strings.Split(string(packed), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 2 && fields[1] == s.ref {
				if s.sha != "" {
					return s, nil, nil, errors.New("duplicate packed branch")
				}
				s.sha = fields[0]
			}
		}
	}
	if !domain.FullCommit(s.sha) {
		return s, nil, nil, errors.New("owned HEAD unavailable")
	}
	index, err := readOwnedFile(metadata, "index", maxIndexBytes, true)
	if err != nil {
		return s, nil, nil, err
	}
	exclude, err := readOwnedFile(common, "info/exclude", 128<<10, true)
	if err != nil {
		return s, nil, nil, err
	}
	s.indexDigest = sha256.Sum256(index)
	s.excludeDigest = sha256.Sum256(exclude)
	return s, index, exclude, nil
}

func newGitView(ctx context.Context, repo, worktree string, root *os.Root, base string) (*gitView, error) {
	commonPath, metadataPath, err := metadataPaths(repo, worktree, root)
	if err != nil {
		return nil, err
	}
	v := &gitView{commonPath: commonPath, metadataPath: metadataPath}
	ready := false
	defer func() {
		if !ready {
			v.close()
		}
	}()
	v.common, _, err = openOwned(commonPath)
	if err != nil {
		return nil, err
	}
	v.metadata, _, err = openOwned(metadataPath)
	if err != nil {
		return nil, err
	}
	var index, exclude []byte
	v.initial, index, exclude, err = sourceSnapshot(v.common, v.metadata)
	if err != nil {
		return nil, err
	}
	if len(v.initial.sha) != len(base) {
		return nil, errors.New("object format differs from owned base")
	}
	dir, err := os.MkdirTemp("", "ao-run-repo-")
	if err != nil {
		return nil, err
	}
	v.directory = dir
	clean, err := canonical(dir)
	if err != nil {
		return nil, err
	}
	v.directory = clean
	for _, name := range []string{"objects", filepath.Dir(v.initial.ref), "info"} {
		if err := os.MkdirAll(filepath.Join(v.directory, name), 0o700); err != nil {
			return nil, err
		}
	}
	files := map[string][]byte{"config": []byte(fixedConfig(len(base) == 64)), "HEAD": []byte(v.initial.head), v.initial.ref: []byte(v.initial.sha + "\n"), "info/exclude": exclude}
	if index != nil {
		files["index"] = index
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(v.directory, name), data, 0o600); err != nil {
			return nil, err
		}
	}
	if err := v.copyObjects(ctx); err != nil {
		return nil, err
	}
	ready = true
	return v, nil
}

// Object files are linked by verified inode into the private view, or copied
// from an anchored descriptor across volumes. Git therefore needs no original
// metadata paths, and cannot follow an original config or alternate-object path.
func (v *gitView) copyObjects(ctx context.Context) error {
	objects, source, err := openOwned(filepath.Join(v.commonPath, "objects"))
	if err != nil {
		return err
	}
	defer func() { _ = objects.Close() }()
	entries, total := 0, int64(0)
	return fs.WalkDir(objects.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		entries++
		if entries > maxObjectEntries {
			return errors.New("object entry limit exceeded")
		}
		if name == "info/alternates" || name == "info/http-alternates" {
			return errors.New("alternate object stores are unsupported")
		}
		if name == "." {
			return nil
		}
		target := filepath.Join(v.directory, "objects", name)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("object store contains a nonregular file")
		}
		if info.Size() < 0 || info.Size() > maxObjectBytes-total {
			return errors.New("object byte limit exceeded")
		}
		total += info.Size()
		file, err := objects.Open(name)
		if err != nil {
			return err
		}
		defer func() { _ = file.Close() }()
		pinned, err := file.Stat()
		if err != nil || !os.SameFile(info, pinned) {
			return errors.New("object identity changed")
		}
		// Windows object files may have a shared read-only attribute. Copy there
		// so cleanup never needs to alter an attribute on an original object inode.
		if runtime.GOOS != "windows" {
			if err := os.Link(filepath.Join(source, name), target); err == nil {
				linked, err := os.Lstat(target)
				if err != nil || !linked.Mode().IsRegular() || !os.SameFile(pinned, linked) {
					return errors.New("object link identity changed")
				}
				return nil
			}
		}
		destination, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		size, copyErr := io.Copy(destination, io.LimitReader(file, info.Size()+1))
		closeErr := destination.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if size != info.Size() {
			return errors.New("object changed while copying")
		}
		return nil
	})
}

func (v *gitView) unchanged(repo, worktree string, root *os.Root) error {
	common, metadata, err := metadataPaths(repo, worktree, root)
	if err != nil || common != v.commonPath || metadata != v.metadataPath {
		return errors.New("owned metadata changed")
	}
	for _, pair := range []struct {
		path string
		root *os.Root
	}{{common, v.common}, {metadata, v.metadata}} {
		current, _, err := openOwned(pair.path)
		if err != nil {
			return err
		}
		before, e := pair.root.Stat(".")
		after, e2 := current.Stat(".")
		_ = current.Close()
		if e != nil || e2 != nil || !os.SameFile(before, after) {
			return errors.New("owned metadata identity changed")
		}
	}
	now, _, _, err := sourceSnapshot(v.common, v.metadata)
	if err != nil || now != v.initial {
		return errors.New("repository metadata changed during observation")
	}
	return nil
}

func (v *gitView) close() {
	if v.metadata != nil {
		_ = v.metadata.Close()
		v.metadata = nil
	}
	if v.common != nil {
		_ = v.common.Close()
		v.common = nil
	}
	if v.directory != "" {
		directory := v.directory
		v.directory = ""
		_ = os.RemoveAll(directory)
	}
}

// validateViewConfig also fences the child-only trampoline from being used with
// an arbitrary Git directory. Only a fixed configuration generated here is read.
func validateViewConfig(path string) error {
	root, _, err := openOwned(path)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	data, err := readOwnedFile(root, "config", 1024, false)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, []byte(fixedConfig(false))) && !bytes.Equal(data, []byte(fixedConfig(true))) {
		return errors.New("inspection config is not sanitized")
	}
	return nil
}

func indexDigest(index string) string {
	sum := sha256.Sum256([]byte(index))
	return hex.EncodeToString(sum[:])
}
