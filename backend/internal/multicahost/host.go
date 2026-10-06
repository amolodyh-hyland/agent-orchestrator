// Package multicahost runs the Multica agent daemon inside the AO daemon.
package multicahost

import "github.com/multica-ai/multica/server/pkg/daemonhost"

var (
	_ daemonhost.Config
	_ daemonhost.Overrides
	_ *daemonhost.Daemon
	_ = daemonhost.DefaultServerURL
	_ = daemonhost.DefaultHealthPort
	_ = daemonhost.LoadConfig
	_ = daemonhost.New
	_ = daemonhost.NormalizeServerBaseURL
)
