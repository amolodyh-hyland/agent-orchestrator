//go:build darwin || linux

package claudecode

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"syscall"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type ownedTaskLibraryPath struct {
	path string
	info os.FileInfo
	hash string
}

func materializeTaskLibrary(ctx context.Context, workspace string, files []taskLibraryFile) (cleanup func() error, err error) {
	if len(files) == 0 {
		return func() error { return nil }, nil
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, fmt.Errorf("library: workspace_unavailable")
	}
	var dirs, owned []ownedTaskLibraryPath
	parents := map[string]os.FileInfo{}
	handles := map[string]*os.Root{".": root}
	closed := false
	var cleanupMu sync.Mutex
	cleanup = func() error {
		cleanupMu.Lock()
		defer cleanupMu.Unlock()
		if closed {
			return nil
		}
		closed = true
		defer func() {
			for _, handle := range handles {
				_ = handle.Close()
			}
		}()
		var conflicts []error
		validParents := func(name string) bool {
			for dir := path.Dir(name); dir != "."; dir = path.Dir(dir) {
				info, e := root.Lstat(dir)
				if e != nil || !info.IsDir() || !os.SameFile(info, parents[dir]) {
					return false
				}
			}
			return true
		}
		for i := len(owned) - 1; i >= 0; i-- {
			f := owned[i]
			if !validParents(f.path) {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
				continue
			}
			parent := handles[path.Dir(f.path)]
			info, e := parent.Lstat(path.Base(f.path))
			if os.IsNotExist(e) {
				continue
			}
			if e != nil || !info.Mode().IsRegular() || !os.SameFile(info, f.info) {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
				continue
			}
			handle, e := parent.OpenFile(path.Base(f.path), os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
			if e != nil {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
				continue
			}
			opened, statErr := handle.Stat()
			var data []byte
			if statErr == nil && opened.Mode().IsRegular() && os.SameFile(opened, f.info) {
				data, e = io.ReadAll(io.LimitReader(handle, domain.MaxLibraryFileBytes+1))
			} else {
				e = errors.New("replaced")
			}
			_ = handle.Close()
			after, afterErr := parent.Lstat(path.Base(f.path))
			if e != nil || afterErr != nil || !os.SameFile(after, f.info) || domain.LibraryBytesHash(data) != f.hash {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
				continue
			}
			if e = parent.Remove(path.Base(f.path)); e != nil {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
			}
		}
		for i := len(dirs) - 1; i >= 0; i-- {
			d := dirs[i]
			info, e := root.Lstat(d.path)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil || !validParents(d.path) || !info.IsDir() || !os.SameFile(info, d.info) {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
				continue
			}
			if e = handles[path.Dir(d.path)].Remove(path.Base(d.path)); e != nil {
				conflicts = append(conflicts, errors.New("library: cleanup_conflict"))
			}
		}
		return errors.Join(conflicts...)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, cleanup())
		}
	}()
	sort.Slice(files, func(i, j int) bool { return files[i].path < files[j].path })
	for _, f := range files {
		if err = ctx.Err(); err != nil {
			return cleanup, err
		}
		if domain.ValidateLibraryPath(f.path) != nil || !(strings.HasPrefix(f.path, ".claude/skills/") || strings.HasPrefix(f.path, ".claude/commands/")) {
			return cleanup, errors.New("library: invalid_path")
		}
		parts := strings.Split(path.Dir(f.path), "/")
		for i := range parts {
			dir := strings.Join(parts[:i+1], "/")
			parent := handles[path.Dir(dir)]
			info, e := parent.Lstat(path.Base(dir))
			if e == nil && i == 2 && parts[1] == "skills" && parents[dir] == nil {
				return cleanup, errors.New("library: native_path_conflict")
			}
			if os.IsNotExist(e) {
				if e = parent.Mkdir(path.Base(dir), 0700); e != nil {
					return cleanup, errors.New("library: materialization_conflict")
				}
				info, e = parent.Lstat(path.Base(dir))
				if e != nil {
					return cleanup, errors.New("library: materialization_conflict")
				}
				dirs = append(dirs, ownedTaskLibraryPath{path: dir, info: info})
			} else if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return cleanup, errors.New("library: materialization_conflict")
			}
			if old, ok := parents[dir]; ok && !os.SameFile(old, info) {
				return cleanup, errors.New("library: materialization_conflict")
			}
			if _, ok := handles[dir]; !ok {
				child, e := parent.OpenRoot(path.Base(dir))
				if e != nil {
					return cleanup, errors.New("library: materialization_conflict")
				}
				opened, e := child.Stat(".")
				current, currentErr := parent.Lstat(path.Base(dir))
				if e != nil || currentErr != nil || !current.IsDir() || !os.SameFile(info, opened) || !os.SameFile(info, current) {
					_ = child.Close()
					return cleanup, errors.New("library: materialization_conflict")
				}
				handles[dir] = child
			}
			parents[dir] = info
		}
		handle, e := handles[path.Dir(f.path)].OpenFile(path.Base(f.path), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0400)
		if e != nil {
			return cleanup, errors.New("library: native_path_conflict")
		}
		info, e := handle.Stat()
		if e != nil {
			_ = handle.Close()
			return cleanup, errors.New("library: materialization_failed")
		}
		owned = append(owned, ownedTaskLibraryPath{path: f.path, info: info, hash: domain.LibraryBytesHash([]byte(f.text))})
		written, writeErr := io.WriteString(handle, f.text)
		owned[len(owned)-1].hash = domain.LibraryBytesHash([]byte(f.text[:written]))
		closeErr := handle.Close()
		if writeErr != nil || closeErr != nil {
			return cleanup, errors.New("library: materialization_failed")
		}
	}
	for _, f := range owned {
		for dir := path.Dir(f.path); dir != "."; dir = path.Dir(dir) {
			info, e := root.Lstat(dir)
			if e != nil || !info.IsDir() || !os.SameFile(info, parents[dir]) {
				return cleanup, errors.New("library: materialization_conflict")
			}
		}
		handle, e := handles[path.Dir(f.path)].OpenFile(path.Base(f.path), os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
		if e != nil {
			return cleanup, errors.New("library: digest_mismatch")
		}
		data, e := io.ReadAll(io.LimitReader(handle, domain.MaxLibraryFileBytes+1))
		_ = handle.Close()
		if e != nil || domain.LibraryBytesHash(data) != f.hash {
			return cleanup, errors.New("library: digest_mismatch")
		}
	}
	return cleanup, nil
}
