//go:build !windows

package library

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestLibraryRejectsLinksFIFOAndRootReplacement(t *testing.T) {
	for _, kind := range []string{"link", "directory_link", "fifo", "root_replaced", "parent_escape", "case_collision"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, "rules")
			f.write("guide.md", "owned")
			root := f.result.Sources[0].LibraryRootIdentity
			f.apply(Operation{Operation: "allow_inspection", SourceID: "source", RootIdentity: &root})
			switch kind {
			case "link":
				if err := os.Symlink(filepath.Join(t.TempDir(), "secret"), filepath.Join(f.root, "link.md")); err != nil {
					t.Fatal(err)
				}
			case "directory_link":
				if err := os.Symlink(t.TempDir(), filepath.Join(f.root, "nested")); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(filepath.Join(f.root, "pipe.md"), 0600); err != nil {
					t.Fatal(err)
				}
			case "root_replaced":
				if err := os.Rename(f.root, f.root+"_old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(f.root, 0700); err != nil {
					t.Fatal(err)
				}
			case "parent_escape":
				if err := os.Symlink("../outside", filepath.Join(f.root, "escape")); err != nil {
					t.Fatal(err)
				}
			case "case_collision":
				f.write("Guide.md", "different")
				info, _ := os.Stat(filepath.Join(f.root, "guide.md"))
				other, _ := os.Stat(filepath.Join(f.root, "Guide.md"))
				if os.SameFile(info, other) {
					t.Skip("case insensitive filesystem")
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := f.svc.Operate(ctx, Operation{Operation: "inspect", SourceID: "source", ExpectedRevision: f.result.Revision})
			if err == nil {
				t.Fatal("unsafe source accepted")
			}
			state, _ := f.store.ReadLibraryRegistry(context.Background())
			if len(state.Entries) != 0 {
				t.Fatal("partial scan published")
			}
		})
	}
}

func TestLibraryMutationDuringReadAndSymlinkSwap(t *testing.T) {
	for _, swap := range []bool{false, true} {
		t.Run(map[bool]string{false: "mutation", true: "link_swap"}[swap], func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "one.md"), []byte("one"), 0600); err != nil {
				t.Fatal(err)
			}
			handle, err := os.OpenRoot(root)
			if err != nil {
				t.Fatal(err)
			}
			defer handle.Close()
			scan := inspection{ctx: context.Background(), files: map[string]string{}, dirs: map[string]bool{}, afterRead: func(name string) {
				if swap {
					if err := os.Remove(filepath.Join(root, name)); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(filepath.Join(t.TempDir(), "foreign"), filepath.Join(root, name)); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := os.WriteFile(filepath.Join(root, name), []byte("two"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}}
			err = scan.walk(handle, "", 0)
			if err == nil {
				verify := inspection{ctx: context.Background(), files: map[string]string{}, dirs: map[string]bool{}}
				err = verify.walk(handle, "", 0)
				if err == nil && scan.files["one.md"] == verify.files["one.md"] {
					t.Fatal("mutation not detected")
				}
			}
		})
	}
}
