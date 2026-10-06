package multicasupervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
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
			result.Signal = fmt.Sprint(exitErr.ProcessState.Sys())
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

func BuildEnvironment(environ []string) []string {
	allowed := make(map[string]string)
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || !allowedEnvironmentKey(key) {
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

func allowedEnvironmentKey(key string) bool {
	if key == multicahost.FlagEnv || key == multicahost.ProfileEnv || key == multicahost.HealthPortEnv || key == multicahost.CLIPathEnv {
		return true
	}
	switch key {
	case "HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ":
		return true
	}
	return strings.HasPrefix(key, "LC_") || strings.HasPrefix(key, "MULTICA_")
}
