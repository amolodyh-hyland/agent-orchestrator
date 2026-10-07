package multicasupervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/multicahost"
)

const maxChildLogLine = 16 * 1024

func startExecProcess(_ context.Context, spec ProcessSpec, emit func(stream, line string)) (Process, error) {
	command := spec.Command
	if command == nil {
		command = exec.Command
	}
	args := append([]string(nil), spec.Args...)
	cmd := command(spec.Executable, args...)
	cmd.Env = append([]string(nil), spec.Environment...)
	stdout := &lineWriter{stream: "stdout", emit: emit}
	stderr := &lineWriter{stream: "stderr", emit: emit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open Multica stdin: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("start Multica host: %w", err)
	}
	return &execProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *lineWriter
	stderr *lineWriter
}

func (p *execProcess) PID() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }

func (p *execProcess) Wait() ProcessExit {
	err := p.cmd.Wait()
	if p.stdout != nil {
		p.stdout.Flush()
	}
	if p.stderr != nil {
		p.stderr.Flush()
	}
	if err == nil {
		return ProcessExit{Code: 0}
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result := ProcessExit{Code: exitErr.ExitCode(), Err: err}
		if result.Code < 0 {
			result.Signal = fmt.Sprint(exitErr.Sys())
		}
		return result
	}
	return ProcessExit{Code: -1, Err: err}
}

func (p *execProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

type lineWriter struct {
	stream    string
	emit      func(string, string)
	line      []byte
	truncated bool
}

func (w *lineWriter) Write(data []byte) (int, error) {
	for _, value := range data {
		if value == '\n' {
			w.flushLine()
			continue
		}
		if len(w.line) < maxChildLogLine {
			w.line = append(w.line, value)
		} else {
			w.truncated = true
		}
	}
	return len(data), nil
}

func (w *lineWriter) Flush() {
	if len(w.line) > 0 || w.truncated {
		w.flushLine()
	}
}

func (w *lineWriter) flushLine() {
	line := strings.TrimSuffix(string(w.line), "\r")
	if w.truncated {
		line += " [line truncated]"
	}
	if w.emit != nil {
		w.emit(w.stream, line)
	}
	w.line = w.line[:0]
	w.truncated = false
}

// BuildEnvironment returns the environment the hosted daemon inherits from environ.
func BuildEnvironment(environ []string) []string {
	allowed := make(map[string]string)
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || !allowedEnvironmentKey(key, runtime.GOOS) {
			continue
		}
		allowed[key] = value
	}
	keys := make([]string, 0, len(allowed))
	for key := range allowed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+allowed[key])
	}
	return result
}

func allowedEnvironmentKey(key, goos string) bool {
	if goos == "windows" {
		key = strings.ToUpper(key)
	}
	if key == strings.ToUpper(multicahost.FlagEnv) || key == strings.ToUpper(multicahost.ProfileEnv) || key == strings.ToUpper(multicahost.HealthPortEnv) || key == strings.ToUpper(multicahost.CLIPathEnv) { //nolint:gocritic // the key is only upper-cased on Windows, so this must stay case-sensitive elsewhere
		return true
	}
	switch key {
	case "HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ",
		"CODEX_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_INCLUDE_ROOTS",
		"CLAWDBOT_CONFIG_PATH", "KIMI_CODE_HOME", "DSH_HOME", "REASONIX_HOME", "QWEN_HOME", "QWENPAW_WORKING_DIR",
		"COPAW_WORKING_DIR", "HERMES_HOME", "GROK_HOME", "CODEBUDDY_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
		"XDG_CACHE_HOME", "XDG_STATE_HOME":
		return true
	}
	if goos == "windows" {
		switch key {
		case "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
			"PATHEXT", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES":
			return true
		}
	}
	if strings.HasPrefix(key, "MULTICA_") {
		// Multica's own settings (server URL, workspaces root, agent paths, daemon
		// toggles) are configuration; anything that looks like a credential is not.
		for _, suffix := range []string{"_TOKEN", "_SECRET", "_KEY", "_PASSWORD", "_PAT"} {
			if strings.HasSuffix(key, suffix) {
				return false
			}
		}
		return true
	}
	return strings.HasPrefix(key, "LC_")
}
