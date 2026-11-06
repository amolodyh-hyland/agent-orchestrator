package startupstatus

import (
	"strconv"
	"strings"
	"testing"
)

func TestNativeWindowsProcessStartWithoutPS(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	identity := currentProcessStart()
	if !strings.HasPrefix(identity, "windows-filetime:") {
		t.Fatalf("missing native Windows process identity: %q", identity)
	}
	ticks, err := strconv.ParseUint(strings.TrimPrefix(identity, "windows-filetime:"), 10, 64)
	if err != nil || ticks == 0 || identity != currentProcessStart() {
		t.Fatalf("unstable or invalid native Windows process identity: %q", identity)
	}
}
