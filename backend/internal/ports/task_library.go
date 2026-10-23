package ports

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type TaskLibraryConfig struct {
	Snapshot      domain.LibrarySnapshot
	WorkspacePath string
	Env           map[string]string
}

type TaskLibraryBinding struct {
	EntryID     string
	ContentHash string
	NativeName  string
	NativePath  string
	Status      string
	ReasonCode  string
}

type TaskLibraryProjection struct {
	Bindings []TaskLibraryBinding
	Rules    string
	Cleanup  func() error
}

type TaskLibraryProjector interface {
	PrepareTaskLibrary(context.Context, TaskLibraryConfig) (TaskLibraryProjection, error)
}

type TaskLibrarySelection interface {
	AcquireTaskLaunch(context.Context, domain.SessionID) (context.Context, domain.LibrarySnapshot, func(), error)
}

type TaskLibraryLifecycle interface {
	FenceLibraryInput(context.Context, domain.SessionID) (func(), error)
	StopLibraryRuntime(context.Context, domain.SessionID) error
}

type TaskLibraryCapabilities struct {
	ProviderID            string
	ProviderVersion       string
	AdapterID             string
	AdapterVersion        string
	Surface               string
	CanList               bool
	CanMaterialize        bool
	CanBindExactEntry     bool
	CanInvoke             bool
	CanReloadSameSnapshot bool
	RequiresRepository    bool
	SupportedKinds        []string
	SupportedFormats      []string
	Status                string
	ReasonCode            string
}
