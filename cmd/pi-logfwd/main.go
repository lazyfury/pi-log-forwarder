// Command pi-logfwd forwards the logs of commands run by pi.
//
// It runs a shell script/command (inside a pseudo-terminal by default),
// streams every chunk of output as JSONL events to stdout in real time, and
// optionally appends the same events to a log file. It also handles the
// special environments the built-in pi process cannot: commands that need a
// PTY (their output would otherwise be buffered/truncated by the built-in
// bash tool).
//
// Events (one JSON object per line):
//
//	{"ts":<unix ms>,"event":"start","pid":123,"command":"echo hi"}
//	{"ts":<unix ms>,"event":"output","stream":"stdout","data":"hi\n"}
//	{"ts":<unix ms>,"event":"exit","code":0,"durationMs":12}
//	{"ts":<unix ms>,"event":"error","message":"..."}
//
// Note on interactive secrets: a PTY can *render* a password prompt, but
// nothing can answer it for the agent, and GUI authorization dialogs cannot
// be driven programmatically. Those scenarios are intentionally NOT
// supported - see .pi/skills/log-forwarding.md for the full investigation
// table and the recommended "ask the human" fallback.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

const version = "0.1.0"

func main() {
	code, err := runCLI(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "pi-logfwd:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func usage() {
	fmt.Fprint(os.Stderr, `pi-logfwd v`+version+` - forward logs of commands run by pi

Usage:
  pi-logfwd run [flags] [--] <shell-script>   run a shell script (PTY by default)
  pi-logfwd run [flags] -                     read the script from stdin
  pi-logfwd version
  pi-logfwd help

Flags (run):
  --no-pty         run without a pseudo-terminal (stdout/stderr stay separate)
  --plain          emit raw text instead of JSONL events
  --timeout D      kill the child after D (e.g. 30s, 2m, or bare seconds)
  --cwd DIR        working directory for the child
  --log-file FILE  also append the emitted events to FILE
`)
}

func runCLI(args []string) (int, error) {
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	switch args[0] {
	case "version":
		fmt.Printf("pi-logfwd %s\n", version)
		return 0, nil
	case "help", "-h", "--help":
		usage()
		return 0, nil
	case "run":
		return cmdRun(args[1:])
	default:
		return 1, fmt.Errorf("unknown subcommand %q (see 'pi-logfwd help')", args[0])
	}
}

func cmdRun(args []string) (int, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	noPty := fs.Bool("no-pty", false, "")
	plain := fs.Bool("plain", false, "")
	timeout := fs.String("timeout", "", "")
	cwd := fs.String("cwd", "", "")
	logFile := fs.String("log-file", "", "")
	if err := fs.Parse(args); err != nil {
		return 1, fmt.Errorf("bad flags: %w", err)
	}

	var script string
	switch rest := fs.Args(); {
	case len(rest) == 0:
		if isTTY(os.Stdin) {
			return 1, fmt.Errorf("no command given (stdin is a terminal; pass a script or pipe one in)")
		}
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return 1, fmt.Errorf("reading stdin: %w", err)
		}
		script = string(b)
	case rest[0] == "-":
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return 1, fmt.Errorf("reading stdin: %w", err)
		}
		script = string(b)
	default:
		script = strings.Join(rest, " ")
	}
	if strings.TrimSpace(script) == "" {
		return 1, fmt.Errorf("empty command")
	}

	opt := options{
		noPty:   *noPty,
		plain:   *plain,
		cwd:     *cwd,
		logFile: *logFile,
		script:  script,
	}
	if *timeout != "" {
		d, err := parseDuration(*timeout)
		if err != nil {
			return 1, fmt.Errorf("bad --timeout %q: %w", *timeout, err)
		}
		opt.timeout = d
	}

	s, err := newSink(opt)
	if err != nil {
		return 1, err
	}
	defer s.close()

	r := &runner{opt: opt, sink: s}
	code, err := r.run()
	if err != nil {
		s.emit(Event{Event: "error", Message: err.Error()})
		return 1, err
	}
	return code, nil
}

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// parseDuration accepts "30s"/"2m" (time.ParseDuration) or a bare number of seconds.
func parseDuration(s string) (time.Duration, error) {
	if d, err := time.ParseDuration(s); err == nil {
		return d, nil
	}
	if n, err := strconv.Atoi(s); err == nil && n >= 0 {
		return time.Duration(n) * time.Second, nil
	}
	return 0, fmt.Errorf("expected e.g. 30s or 30, got %q", s)
}
