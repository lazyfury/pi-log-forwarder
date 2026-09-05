package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type options struct {
	noPty   bool
	plain   bool
	timeout time.Duration
	cwd     string
	logFile string
	script  string
}

// Event is one JSONL record emitted to stdout (and optionally the log file).
type Event struct {
	TS       int64  `json:"ts"`                   // unix milliseconds
	Event    string `json:"event"`                // start | output | exit | error
	Stream   string `json:"stream,omitempty"`     // stdout | stderr
	Data     string `json:"data,omitempty"`       // raw output chunk
	Code     *int   `json:"code,omitempty"`       // exit code (exit only)
	PID      int    `json:"pid,omitempty"`        // child pid (start only)
	Command  string `json:"command,omitempty"`    // the shell script (start only)
	Duration int64  `json:"durationMs,omitempty"` // (exit only)
	Message  string `json:"message,omitempty"`    // human note (exit/error only)
}

func nowMs() int64 { return time.Now().UnixMilli() }

// sink writes events to stdout (JSONL or plain) and optionally to a log file.
type sink struct {
	out     io.Writer
	logFile *os.File
	plain   bool
	mu      sync.Mutex
}

func newSink(opt options) (*sink, error) {
	s := &sink{out: os.Stdout, plain: opt.plain}
	if opt.logFile != "" {
		f, err := os.OpenFile(opt.logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, fmt.Errorf("opening log file: %w", err)
		}
		s.logFile = f
	}
	return s, nil
}

func (s *sink) close() {
	if s.logFile != nil {
		_ = s.logFile.Close()
	}
}

func (s *sink) emit(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var line []byte
	if s.plain {
		line = s.plainLine(e)
	} else {
		b, err := json.Marshal(e)
		if err != nil {
			line = []byte(fmt.Sprintf(`{"event":"error","message":%q}`, err.Error()))
		} else {
			line = append(b, '\n')
		}
	}
	_, _ = s.out.Write(line)
	if s.logFile != nil {
		_, _ = s.logFile.Write(line)
	}
}

func (s *sink) plainLine(e Event) []byte {
	switch e.Event {
	case "start":
		return []byte(fmt.Sprintf("# [start] pid=%d command=%q\n", e.PID, e.Command))
	case "output":
		return []byte(e.Data)
	case "exit":
		c := -1
		if e.Code != nil {
			c = *e.Code
		}
		msg := ""
		if e.Message != "" {
			msg = " (" + e.Message + ")"
		}
		return []byte(fmt.Sprintf("# [exit] code=%d durationMs=%d%s\n", c, e.Duration, msg))
	case "error":
		return []byte(fmt.Sprintf("# [error] %s\n", e.Message))
	}
	return nil
}

func (s *sink) start(pid int, command string) {
	s.emit(Event{TS: nowMs(), Event: "start", PID: pid, Command: command})
}

func (s *sink) output(stream, data string) {
	s.emit(Event{TS: nowMs(), Event: "output", Stream: stream, Data: data})
}

func (s *sink) exit(code int, dur time.Duration, msg string) {
	c := code
	s.emit(Event{TS: nowMs(), Event: "exit", Code: &c, Duration: dur.Milliseconds(), Message: msg})
}

// runner executes the script and forwards its logs through the sink.
type runner struct {
	opt  options
	sink *sink
}

func (r *runner) run() (int, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	cmd := exec.Command(shell, "-c", r.opt.script)
	cmd.Env = os.Environ()
	// PTY 模式下 git 把 stdout 当成交互终端，会自动拉起 less 分页器；agent 场景里
	// 没人能在子进程 PTY 里按键，git diff/log 等长输出会一直挂到超时。默认注入
	// GIT_PAGER=cat 让 git 不分页直接吐全部输出（用户在环境中显式设过 GIT_PAGER
	// 则尊重其选择，不覆盖）。pipes 模式 stdout 非 TTY，git 本来就不分页，无需处理。
	if !r.opt.noPty && os.Getenv("GIT_PAGER") == "" {
		cmd.Env = append(cmd.Env, "GIT_PAGER=cat")
	}
	if r.opt.cwd != "" {
		cmd.Dir = r.opt.cwd
	}
	start := time.Now()

	var code int
	var err error
	if r.opt.noPty {
		code, err = r.runPipes(cmd, start)
	} else {
		code, err = r.runPTY(cmd, start)
	}
	if err != nil {
		return 1, err
	}
	return code, nil
}

// waitWithTimeout blocks until the process exits or the timeout elapses.
// It returns true when the timeout fired (caller must kill the process).
func (r *runner) waitWithTimeout(waitCh <-chan error) bool {
	if r.opt.timeout <= 0 {
		<-waitCh
		return false
	}
	timer := time.NewTimer(r.opt.timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-waitCh:
		return false
	}
}

// forwardSignals relays SIGINT/SIGTERM to the child. Returns a stop function.
func forwardSignals(cmd *exec.Cmd) func() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case s := <-sigCh:
				_ = cmd.Process.Signal(s)
			case <-stop:
				return
			}
		}
	}()
	return func() {
		signal.Stop(sigCh)
		close(stop)
	}
}

func exitCodeOf(cmd *exec.Cmd) int {
	if cmd.ProcessState == nil {
		return -1
	}
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ws.ExitStatus()
	}
	return cmd.ProcessState.ExitCode()
}

func (r *runner) runPTY(cmd *exec.Cmd, start time.Time) (int, error) {
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return 1, fmt.Errorf("starting PTY: %w", err)
	}
	defer func() { _ = ptmx.Close() }()
	_ = pty.Setsize(ptmx, &pty.Winsize{Rows: 24, Cols: 120})
	r.sink.start(cmd.Process.Pid, r.opt.script)

	stopSig := forwardSignals(cmd)
	defer stopSig()

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				r.sink.output("stdout", string(buf[:n])) // PTY merges stderr into stdout
			}
			if err != nil {
				return
			}
		}
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	timedOut := r.waitWithTimeout(waitCh)
	if timedOut {
		_ = cmd.Process.Kill()
		<-waitCh
	}

	// Drain whatever is still buffered in the master, then close it.
	_ = ptmx.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	<-readDone

	code := exitCodeOf(cmd)
	msg := ""
	if timedOut {
		code = 124 // timeout convention
		msg = "killed by --timeout"
	}
	r.sink.exit(code, time.Since(start), msg)
	return code, nil
}

func (r *runner) runPipes(cmd *exec.Cmd, start time.Time) (int, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 1, err
	}
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("starting command: %w", err)
	}
	r.sink.start(cmd.Process.Pid, r.opt.script)

	stopSig := forwardSignals(cmd)
	defer stopSig()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); copyStream(r.sink, "stdout", stdout) }()
	go func() { defer wg.Done(); copyStream(r.sink, "stderr", stderr) }()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	timedOut := r.waitWithTimeout(waitCh)
	if timedOut {
		_ = cmd.Process.Kill()
		<-waitCh
	}
	wg.Wait()

	code := exitCodeOf(cmd)
	msg := ""
	if timedOut {
		code = 124
		msg = "killed by --timeout"
	}
	r.sink.exit(code, time.Since(start), msg)
	return code, nil
}

func copyStream(s *sink, stream string, rd io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := rd.Read(buf)
		if n > 0 {
			s.output(stream, string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}
