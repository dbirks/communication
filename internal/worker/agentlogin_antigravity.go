package worker

// ADR-0085: the Antigravity sign-in driver. Unlike Codex, antigravity has no
// control socket — its `acp --login` mode is an interactive terminal prompt
// that prints a Google OAuth URL, reads the authorization code (or the full
// callback URL) back from the keyboard, exchanges it, and exits. The worker
// plays the terminal: it reads the URL out of the child's output, publishes it
// with needs_code, and feeds whatever the admin pastes into the UI back down
// the child's stdin. Observed against antigravity (agy) 1.5.9.
//
// The code is PKCE-bound: the verifier lives in this child process's memory,
// so a code that transits the API is useless to anyone else — and this file is
// where it must never be echoed. Failure text from the CLI is passed through
// agentLoginRedactText before it becomes an error sentence.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// The Antigravity child is a CLI, not a protocol endpoint, so these are the
// three clocks it is judged by. Vars, so tests do not sleep for real seconds.
var (
	// antigravityLinkTimeout bounds how long the child may take to print its
	// sign-in link.
	antigravityLinkTimeout = 30 * time.Second
	// antigravityExitTimeout bounds the token exchange after the code is fed.
	antigravityExitTimeout = 60 * time.Second
	// antigravityStatusTimeout bounds one status probe's ACP handshake.
	antigravityStatusTimeout = 30 * time.Second
)

// antigravityAccountLabel is all the identity a signed-in Antigravity volume
// reports: the ACP handshake says "authenticated", not "as whom".
const antigravityAccountLabel = "Google account"

// AntigravityLoginDriver signs the worker's Antigravity home in.
type AntigravityLoginDriver struct {
	// Command is the antigravity argv without the subcommand, e.g.
	// ["antigravity"].
	Command []string
	// Env is the FULL child environment, and must carry HOME — the
	// Antigravity home this worker owns (ADR-0086).
	Env []string
	// ScratchDir is the empty directory the status probe opens an ACP session
	// in (session/new requires a cwd, and the probe must not touch a
	// repository).
	ScratchDir string
}

func (d *AntigravityLoginDriver) argv(args ...string) ([]string, error) {
	if len(d.Command) == 0 {
		return nil, errors.New("the Antigravity sign-in driver has no command configured")
	}
	return append(append([]string{}, d.Command...), args...), nil
}

// Login runs `acp --login --disable-telemetry`, publishes the Google link,
// feeds the pasted code back in, and maps the child's exit to an outcome.
func (d *AntigravityLoginDriver) Login(ctx context.Context, s AgentLoginSession) (AgentLoginResult, error) {
	var zero AgentLoginResult
	argv, err := d.argv("acp", "--login", "--disable-telemetry")
	if err != nil {
		return zero, err
	}
	child, err := startAgentLoginChild(ctx, argv, d.Env, true, true, true)
	if err != nil {
		return zero, fmt.Errorf("couldn't start the Antigravity sign-in: %w", err)
	}
	defer child.Close()

	out := newAntigravityOutput(child.stdout)
	if err := d.runLogin(ctx, child, s, out); err != nil {
		if errors.Is(err, ErrAgentLoginStopped) || ctx.Err() != nil {
			// Cancelled, expired or drained: the child is holding an OAuth
			// exchange that nobody is waiting for any more.
			child.Kill()
		}
		// Every other error is already the sentence the user reads, built by
		// runLogin out of the child's last line and passed through the
		// redactor, so the pasted code cannot ride out in it.
		return zero, err
	}
	return AgentLoginResult{AccountLabel: antigravityAccountLabel}, nil
}

func (d *AntigravityLoginDriver) runLogin(ctx context.Context, child *agentLoginChild, s AgentLoginSession, out *antigravityOutput) error {
	link, err := out.waitForLink(ctx, antigravityLinkTimeout)
	if err != nil {
		return err
	}
	if err := s.Prompt(ctx, AgentLoginPrompt{
		VerificationURL: link,
		UserCode:        "",
		NeedsCode:       true,
	}); err != nil {
		return err
	}
	code, err := s.WaitCode(ctx)
	if err != nil {
		return err
	}
	// The child reads the code from the keyboard and closes its own input when
	// the line lands; nothing else has to be typed.
	if _, err := fmt.Fprintf(child.stdin, "%s\n", code); err != nil {
		return errors.New("the Antigravity sign-in stopped answering before the code reached it.")
	}
	_ = child.stdin.Close()

	waitCtx, cancel := context.WithTimeout(ctx, antigravityExitTimeout)
	defer cancel()
	// Read to EOF first: reaping closes the pipe, and the CLI's verdict is the
	// last thing it writes before exiting.
	err = out.waitClosed(waitCtx)
	exitErr := child.Wait()
	if err != nil {
		child.Kill()
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("Antigravity didn't finish signing in before its sign-in window closed.")
		}
		return err
	}
	if exitErr != nil {
		if ctx.Err() != nil {
			child.Kill()
			return ctx.Err()
		}
		return fmt.Errorf("Antigravity sign-in failed: %s",
			agentLoginRedactText(out.lastLine(), code))
	}
	return nil
}

// Status asks the harness itself whether the home is signed in: an ACP
// session/new either opens or is refused with "Authentication required".
func (d *AntigravityLoginDriver) Status(ctx context.Context) (AgentAccountState, error) {
	if d.ScratchDir == "" {
		return AgentAccountState{}, errors.New("the Antigravity sign-in driver has no scratch directory to probe from")
	}
	argv, err := d.argv("acp", "--disable-telemetry")
	if err != nil {
		return AgentAccountState{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, antigravityStatusTimeout)
	defer cancel()
	child, err := startAgentLoginChild(ctx, argv, d.Env, true, true, false)
	if err != nil {
		return AgentAccountState{}, fmt.Errorf("couldn't start the Antigravity status probe: %w", err)
	}
	defer child.Close()

	if _, err := fmt.Fprintf(child.stdin,
		"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}\n"+
			"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":%q,\"mcpServers\":[]}}\n",
		d.ScratchDir); err != nil {
		return AgentAccountState{}, fmt.Errorf("couldn't ask Antigravity for its sign-in status: %s", err)
	}

	out := newAntigravityOutput(child.stdout)
	resp, err := out.waitForResponse(ctx, "2")
	if err != nil {
		if ctx.Err() != nil {
			return AgentAccountState{}, fmt.Errorf("Antigravity didn't answer the sign-in status check: %s", ctx.Err())
		}
		return AgentAccountState{}, fmt.Errorf("Antigravity didn't answer the sign-in status check: %s", err)
	}
	if resp.Error != nil {
		msg := resp.Error.Message
		if strings.Contains(msg, "Authentication required") {
			return AgentAccountState{State: AgentAccountSignedOut}, nil
		}
		return AgentAccountState{}, fmt.Errorf("Antigravity refused the sign-in status check: %s",
			agentLoginRedactText(msg))
	}
	// The session opened, so the home is authenticated. Close it best-effort:
	// the probe owns no conversation and the child dies either way.
	_, _ = fmt.Fprintf(child.stdin,
		"{\"jsonrpc\":\"2.0\",\"method\":\"session/close\",\"params\":{\"sessionId\":%q}}\n",
		jsonString(resp.Result, "sessionId"))
	child.stdin.Close()
	// Give the child the grace to read what we just wrote and leave on its
	// own: killing it on the spot would drop the close notification in the
	// pipe, which is the difference between a harness that logged us out of
	// nothing and one that holds an open session we never closed.
	waitAntigravityExit(child)
	return AgentAccountState{State: AgentAccountSignedIn, AccountLabel: antigravityAccountLabel}, nil
}

// antigravityCloseGrace bounds how long the status probe waits for its child
// to leave after the best-effort session/close.
var antigravityCloseGrace = 500 * time.Millisecond

func waitAntigravityExit(child *agentLoginChild) {
	exited := make(chan struct{})
	go func() {
		_ = child.Wait()
		close(exited)
	}()
	select {
	case <-exited:
	case <-time.After(antigravityCloseGrace):
	}
}

// antigravityLine is one JSON message from the ACP child.
type antigravityLine struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    json.Number `json:"code"`
		Message string      `json:"message"`
	} `json:"error"`
}

func (l antigravityLine) idKey() string { return strings.TrimSpace(string(l.ID)) }

// jsonString pulls one string field out of a result object without dragging
// an unmarshal target in for a message the driver does not model.
func jsonString(raw json.RawMessage, field string) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if v, ok := m[field].(string); ok {
		return v
	}
	return ""
}

// antigravityOutput reads a child's merged stdout/stderr line by line for both
// uses of its output: whoever is waiting for a link, and whoever needs the
// last thing the CLI said after it exited.
type antigravityOutput struct {
	mu    sync.Mutex
	lines []string

	wake   chan struct{}
	done   chan struct{}
	reader *bufio.Reader
}

func newAntigravityOutput(r io.Reader) *antigravityOutput {
	o := &antigravityOutput{
		wake:   make(chan struct{}, 1),
		done:   make(chan struct{}),
		reader: bufio.NewReader(r),
	}
	go o.read()
	return o
}

func (o *antigravityOutput) read() {
	defer close(o.done)
	for {
		line, err := o.reader.ReadString('\n')
		if line != "" {
			o.mu.Lock()
			o.lines = append(o.lines, line)
			if len(o.lines) > 200 { // a chatty CLI cannot grow the buffer forever
				o.lines = o.lines[len(o.lines)-200:]
			}
			o.mu.Unlock()
			select {
			case o.wake <- struct{}{}:
			default:
			}
		}
		if err != nil {
			return
		}
	}
}

func (o *antigravityOutput) snapshot() ([]string, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.lines...), o.doneClosed()
}

// doneClosed reports EOF on the child's output; the caller holds o.mu.
func (o *antigravityOutput) doneClosed() bool {
	select {
	case <-o.done:
		return true
	default:
		return false
	}
}

// waitForLink returns the first https://accounts.google.com/ token the child
// prints. The CLI wraps and indents, so the search is token-wise, not
// line-wise; a child that dies before printing one, and one that prints
// nothing at all, are both the same failure the admin can retry.
func (o *antigravityOutput) waitForLink(ctx context.Context, timeout time.Duration) (string, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		lines, closed := o.snapshot()
		for _, line := range lines {
			for _, tok := range strings.Fields(line) {
				if strings.HasPrefix(tok, "https://accounts.google.com/") {
					return tok, nil
				}
			}
		}
		if closed {
			return "", errors.New("Antigravity didn't print a sign-in link.")
		}
		select {
		case <-o.wake:
		case <-o.done:
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			return "", errors.New("Antigravity didn't print a sign-in link.")
		}
	}
}

// lastLine is the last non-empty thing the child printed, newline stripped.
func (o *antigravityOutput) lastLine() string {
	lines, _ := o.snapshot()
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimRight(lines[i], "\r\n")
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return "the sign-in ended without saying why"
}

// waitClosed waits for the child's output to end — which, for a CLI that
// prints its verdict and exits, is the same event as its exit, and arrives
// before reaping would cut the pipe.
func (o *antigravityOutput) waitClosed(ctx context.Context) error {
	select {
	case <-o.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// waitForResponse returns the first response message carrying id.
func (o *antigravityOutput) waitForResponse(ctx context.Context, id string) (antigravityLine, error) {
	var out antigravityLine
	for {
		lines, closed := o.snapshot()
		for _, line := range lines {
			var msg antigravityLine
			if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &msg); err != nil {
				continue // the CLI's own chatter is not JSON-RPC
			}
			if msg.idKey() == id {
				return msg, nil
			}
		}
		if closed {
			return out, errors.New("the Antigravity status probe ended without answering")
		}
		select {
		case <-o.wake:
		case <-o.done:
		case <-ctx.Done():
			return out, ctx.Err()
		}
	}
}
