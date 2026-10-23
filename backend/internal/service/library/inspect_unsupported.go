//go:build !darwin && !linux

package library

import "os"

func targetIdentity(os.FileInfo) (string, error) { return "", fail("inspection_unsupported_platform") }
func openLibraryFile(*os.Root, string) (*os.File, error) {
	return nil, fail("inspection_unsupported_platform")
}
func checkLibraryRegularFile(os.FileInfo) error { return fail("inspection_unsupported_platform") }
func libraryFilesystemBoundary(*os.File) (filesystemBoundary, error) {
	return filesystemBoundary{}, fail("inspection_unsupported_platform")
}
