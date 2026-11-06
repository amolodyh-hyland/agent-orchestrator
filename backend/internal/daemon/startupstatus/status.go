package startupstatus

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Record struct {
	LaunchID       string `json:"launchId"`
	PID            int    `json:"pid"`
	ProcessStart   string `json:"processStart"`
	Executable     string `json:"executable"`
	StartedAt      int64  `json:"startedAt"`
	HeartbeatAt    int64  `json:"heartbeatAt"`
	Phase          string `json:"phase"`
	Stage          string `json:"stage"`
	StageStartedAt int64  `json:"stageStartedAt"`
	MigrationID    string `json:"migrationId"`
	ElapsedMS      int64  `json:"elapsedMs"`
}

type Status struct {
	mu         sync.Mutex
	record     Record
	file       string
	log        *slog.Logger
	logFile    *os.File
	since      time.Time
	stageSince time.Time
	stop       chan struct{}
	done       chan struct{}
}

func New(runFile string, log *slog.Logger) (*Status, error) {
	dir := filepath.Join(filepath.Dir(runFile), "startup")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	id := uuid.NewString()
	s := &Status{record: Record{LaunchID: id, PID: os.Getpid(), ProcessStart: currentProcessStart(), Executable: executable, StartedAt: now.Unix(), Phase: "starting", Stage: "initializing", StageStartedAt: now.Unix()}, file: filepath.Join(dir, id+".json"), log: log, since: now, stageSince: now, stop: make(chan struct{}), done: make(chan struct{})}
	logPath := filepath.Join(dir, "stages.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 4*1024*1024 {
		_ = os.Rename(logPath, logPath+".previous")
	}
	s.logFile, err = os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	if err := s.write(); err != nil {
		_ = s.logFile.Close()
		return nil, err
	}
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				s.mu.Lock()
				if err := s.write(); err != nil {
					s.log.Warn("startup heartbeat failed", "err", err)
				}
				s.mu.Unlock()
			}
		}
	}()
	return s, nil
}

func windowsProcessStart(high, low uint32) string {
	return fmt.Sprintf("windows-filetime:%d", uint64(high)<<32|uint64(low))
}

func (s *Status) write() error {
	s.record.HeartbeatAt = time.Now().Unix()
	s.record.ElapsedMS = time.Since(s.since).Milliseconds()
	data, err := json.Marshal(s.record)
	if err != nil {
		return err
	}
	temporary := s.file + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.file)
}

func (s *Status) Set(phase, stage, migration string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	elapsed := time.Since(s.stageSince)
	s.log.Info("startup stage completed", "stage", s.record.Stage, "migration", s.record.MigrationID, "duration", elapsed)
	entry := struct {
		LaunchID   string `json:"launchId"`
		Stage      string `json:"stage"`
		Migration  string `json:"migrationId"`
		DurationMS int64  `json:"durationMs"`
		At         int64  `json:"at"`
	}{s.record.LaunchID, s.record.Stage, s.record.MigrationID, elapsed.Milliseconds(), time.Now().Unix()}
	if data, err := json.Marshal(entry); err == nil {
		_, _ = fmt.Fprintln(s.logFile, string(data))
	}
	s.stageSince = time.Now()
	s.record.Phase, s.record.Stage, s.record.MigrationID = phase, stage, migration
	s.record.StageStartedAt = s.stageSince.Unix()
	if err := s.write(); err != nil {
		s.log.Warn("startup status failed", "err", err)
	}
}

func (s *Status) Close(err error) {
	if err != nil {
		s.Set("failed", "startup-failed", s.record.MigrationID)
	}
	close(s.stop)
	<-s.done
	_ = s.logFile.Close()
}
