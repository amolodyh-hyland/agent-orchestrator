package startupstatus

import (
	"os"

	"golang.org/x/sys/windows"
)

func currentProcessStart() string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(os.Getpid()))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return ""
	}
	return windowsProcessStart(creation.HighDateTime, creation.LowDateTime)
}
