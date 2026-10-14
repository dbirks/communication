package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dbirks/communication/internal/agent/acp"
	"github.com/dbirks/communication/internal/domain"
)

// ACP end-to-end doctor check (M0 exit proof-of-concept,
// communication-spec/11-build-roadmap.md). It drives a real adapter against a
// disposable repo using the developer's own agent login. A PASS here is one
// observed run on this host, never a claim of broad harness support
// (docs/compatibility/ACP.md).

const (
	// defaultACPTimeout bounds one full ACP end-to-end check (two turns).
	defaultACPTimeout = 4 * time.Minute

	// gitCommandTimeout bounds each disposable-repo git command.
	gitCommandTimeout = 30 * time.Second

	// stderrTailBytes is how much adapter stderr is quoted on failure.
	stderrTailBytes = 300
)

// Prompt texts used by the check. They are the same two turns proven by the
// ACP integration test; cancellation is deliberately not exercised here —
// it is timing-sensitive (see "Cancel" under Known limits in
// docs/compatibility/ACP.md) and belongs to the integration test instead.
const (
	acpPromptFirst  = "Create a file named hello.txt in the current directory containing exactly the word hello. Then reply DONE."
	acpPromptSecond = "Reply with the single word SECOND."
)

// acpConversation exposes the live-session diagnostics package acp's handle
// provides beyond domain.AgentHandle. Declared as a structural interface so
// doctor can report observed protocol facts without importing the SDK.
type acpConversation interface {
	SessionID() string
	LoadSessionSupported() bool
	ProtocolVersion() int
	Stderr() string
}

// checkACP runs the disposable-repo end-to-end conversation for one launcher
// and returns the acp:<id> result. Cancellation is not tested (see above).
func checkACP(ctx context.Context, l acp.Launcher, exe string, timeout time.Duration, keep bool, stderr io.Writer) CheckResult {
	res := CheckResult{Name: "acp:" + l.ID}
	started := time.Now()

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	repo, err := newDisposableRepo(cctx)
	if err != nil {
		res.Status = statusError
		res.Detail = fmt.Sprintf("disposable repo: %v", err)
		return res
	}
	defer func() {
		if keep {
			fmt.Fprintf(stderr, "doctor: kept acp:%s repo at %s\n", l.ID, repo)
			return
		}
		_ = os.RemoveAll(repo)
	}()

	rt := &acp.Runtime{PermissionPolicy: acp.PermissionPreapproved}
	h, err := rt.Start(cctx, domain.AgentLaunchSpec{
		LauncherID: l.ID,
		Executable: exe,
		Args:       l.Args,
		WorkDir:    repo,
	})
	if err != nil {
		res.Status = statusError
		res.Detail = fmt.Sprintf("start %s: %v", exe, err)
		return res
	}
	defer func() { _ = h.Close() }() // always reap the agent process

	conv, ok := h.(acpConversation)
	if !ok {
		res.Status = statusError
		res.Detail = "handle does not expose ACP session diagnostics"
		return res
	}
	fail := func(format string, args ...any) CheckResult {
		res.Status = statusError
		res.Detail = fmt.Sprintf(format, args...)
		if tail := stderrTail(conv.Stderr(), stderrTailBytes); tail != "" {
			res.Detail += "; adapter stderr (last " + fmt.Sprint(stderrTailBytes) + " bytes): " + tail
		}
		return res
	}

	log := &acpEventLog{}
	go log.drain(h.Events())

	// Turn 1: the agent must actually write the file and close its turn.
	mark := log.count()
	reason, err := h.Prompt(cctx, acpPromptFirst)
	if err != nil {
		return fail("prompt 1: %v", err)
	}
	if reason != domain.StopEndTurn {
		return fail("prompt 1 stop reason = %q, want end_turn", reason)
	}
	first := log.since(mark)

	body, err := os.ReadFile(filepath.Join(repo, "hello.txt"))
	if err != nil {
		return fail("hello.txt: %v", err)
	}
	if got := strings.TrimSpace(string(body)); got != "hello" {
		return fail("hello.txt = %q, want %q", got, "hello")
	}
	if n := countEventKind(first, "message_chunk"); n == 0 {
		return fail("prompt 1 produced no message_chunk events (kinds: %s)", eventKindCount(first))
	}
	if n := countEventKind(first, "tool_call"); n == 0 {
		return fail("prompt 1 produced no tool_call events (kinds: %s)", eventKindCount(first))
	}

	// Turn 2: the session must still be live and streaming.
	mark = log.count()
	reason, err = h.Prompt(cctx, acpPromptSecond)
	if err != nil {
		return fail("prompt 2: %v", err)
	}
	if reason != domain.StopEndTurn {
		return fail("prompt 2 stop reason = %q, want end_turn", reason)
	}
	second := log.since(mark)
	if text := eventMessageText(second); !strings.Contains(text, "SECOND") {
		return fail("prompt 2 reply does not contain SECOND: %q", text)
	}

	pkg := l.Package
	if l.Version != "" {
		pkg += "@" + l.Version
	}
	res.Status = statusOK
	res.Detail = fmt.Sprintf("%s protocol=%d loadSession=%t session=%s events=%s elapsed=%s",
		pkg, conv.ProtocolVersion(), conv.LoadSessionSupported(),
		shortSessionID(conv.SessionID()), eventKindCount(log.all()),
		time.Since(started).Round(100*time.Millisecond))
	return res
}

// shortSessionID abbreviates a session id for the report, never hiding that
// a session existed.
func shortSessionID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// newDisposableRepo creates a throwaway git repo with one committed file, so
// the agent has a real workspace and a real history to look at.
func newDisposableRepo(ctx context.Context) (string, error) {
	dir, err := os.MkdirTemp("", "communication-doctor-acp-*")
	if err != nil {
		return "", fmt.Errorf("mkdir temp: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	const readme = "# communication doctor\n\nDisposable repo for the M0 ACP end-to-end check.\n"
	if err := gitInRepo(ctx, dir, "init", "-q"); err != nil {
		cleanup()
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o600); err != nil {
		cleanup()
		return "", fmt.Errorf("write README.md: %w", err)
	}
	// Identity is passed inline: doctor must not depend on, or touch, the
	// developer's global git configuration.
	for _, args := range [][]string{
		{"add", "README.md"},
		{"-c", "user.name=communication-doctor", "-c", "user.email=doctor@communication.invalid",
			"commit", "-q", "-m", "communication doctor: disposable baseline"},
	} {
		if err := gitInRepo(ctx, dir, args...); err != nil {
			cleanup()
			return "", err
		}
	}
	return dir, nil
}

// gitInRepo runs one git command in dir without a shell.
func gitInRepo(ctx context.Context, dir string, args ...string) error {
	cctx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, "git", args...) //nolint:gosec // fixed argv, no shell
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, firstNonEmptyLine(string(out)))
	}
	return nil
}

// acpEventLog collects the normalized event stream while turns run, so the
// check can count kinds and concatenate streamed text afterwards.
type acpEventLog struct {
	mu     sync.Mutex
	events []domain.ConversationEvent
}

// drain consumes the stream until the handle closes it.
func (l *acpEventLog) drain(events <-chan domain.ConversationEvent) {
	for ev := range events {
		l.mu.Lock()
		l.events = append(l.events, ev)
		l.mu.Unlock()
	}
}

func (l *acpEventLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.events)
}

func (l *acpEventLog) since(n int) []domain.ConversationEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n > len(l.events) {
		n = len(l.events)
	}
	return append([]domain.ConversationEvent(nil), l.events[n:]...)
}

func (l *acpEventLog) all() []domain.ConversationEvent { return l.since(0) }

func countEventKind(events []domain.ConversationEvent, kind string) int {
	n := 0
	for _, ev := range events {
		if ev.Kind == kind {
			n++
		}
	}
	return n
}

// eventKindCount renders "kind:count,..." in kind order for the report.
func eventKindCount(events []domain.ConversationEvent) string {
	counts := map[string]int{}
	for _, ev := range events {
		counts[ev.Kind]++
	}
	kinds := make([]string, 0, len(counts))
	for k := range counts {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	parts := make([]string, 0, len(kinds))
	for _, k := range kinds {
		parts = append(parts, fmt.Sprintf("%s:%d", k, counts[k]))
	}
	return strings.Join(parts, ",")
}

// eventMessageText concatenates streamed agent message text.
func eventMessageText(events []domain.ConversationEvent) string {
	var b strings.Builder
	for _, ev := range events {
		if ev.Kind == "message_chunk" {
			b.WriteString(ev.Text)
		}
	}
	return b.String()
}

// stderrTail returns the last n bytes of s on a single line, so a failure
// detail stays one table row.
func stderrTail(s string, n int) string {
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return strings.Join(strings.Fields(s), " ")
}
