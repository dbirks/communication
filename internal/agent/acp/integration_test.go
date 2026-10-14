//go:build acp_integration

// Package acp integration test: drives the real claude-agent-acp adapter
// end to end. Run with:
//
//	COMMUNICATION_ACP_CLAUDE=<path to claude-agent-acp> \
//	  go test -count=1 -tags acp_integration -run Integration -v ./internal/agent/acp/
//
// Evidence baseline: docs/compatibility/probes/acp/results-claude.json.
package acp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// claudeAdapterEnv selects the claude-agent-acp executable.
const claudeAdapterEnv = "COMMUNICATION_ACP_CLAUDE"

type eventCollector struct {
	mu     sync.Mutex
	events []domain.ConversationEvent
}

func (c *eventCollector) run(ctx context.Context, events <-chan domain.ConversationEvent) {
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			c.mu.Lock()
			c.events = append(c.events, ev)
			c.mu.Unlock()
		case <-ctx.Done():
			return
		}
	}
}

func (c *eventCollector) since(n int) []domain.ConversationEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n > len(c.events) {
		n = len(c.events)
	}
	return append([]domain.ConversationEvent(nil), c.events[n:]...)
}

func (c *eventCollector) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.events)
}

func initScratchRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main"},
		{"-c", "user.email=tests@example.invalid", "-c", "user.name=tests", "commit", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

func TestClaudeAdapterIntegrationRoundTrip(t *testing.T) {
	exe := strings.TrimSpace(os.Getenv(claudeAdapterEnv))
	if exe == "" {
		t.Skipf("%s not set; set it to the claude-agent-acp executable", claudeAdapterEnv)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("%s: %v", claudeAdapterEnv, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	repo := initScratchRepo(t)
	rt := &Runtime{PermissionPolicy: PermissionPreapproved}
	h, err := rt.Start(ctx, domain.AgentLaunchSpec{
		LauncherID: "claude-acp",
		Executable: exe,
		WorkDir:    repo,
	})
	if err != nil {
		t.Fatalf("Start: %v\nstderr: %s", err, stderrOf(h))
	}
	defer func() { _ = h.Close() }()

	collector := &eventCollector{}
	collCtx, collCancel := context.WithCancel(ctx)
	defer collCancel()
	go collector.run(collCtx, h.Events())

	// Turn 1: must create hello.txt and end the turn.
	reason, err := h.Prompt(ctx, "Create a file named hello.txt in the current directory containing exactly the word hello. Then reply DONE.")
	if err != nil {
		t.Fatalf("turn 1 Prompt: %v\nstderr: %s", err, stderrOf(h))
	}
	if reason != domain.StopEndTurn {
		t.Fatalf("turn 1 stop reason = %q, want end_turn\nstderr: %s", reason, stderrOf(h))
	}
	first := collector.since(0)
	if n := countKind(first, "message_chunk"); n == 0 {
		t.Fatalf("turn 1 produced no message_chunk events: %+v", first)
	}
	if n := countKind(first, "tool_call"); n == 0 {
		t.Fatalf("turn 1 produced no tool_call events: %+v", first)
	}
	body, err := os.ReadFile(filepath.Join(repo, "hello.txt"))
	if err != nil {
		t.Fatalf("hello.txt: %v\nstderr: %s", err, h.(*handle).Stderr())
	}
	if got := strings.TrimSpace(string(body)); got != "hello" {
		t.Fatalf("hello.txt = %q, want %q", got, "hello")
	}

	// Turn 2: session must still be alive and remember nothing special —
	// just require the literal reply word SECOND in streamed text.
	mark := collector.count()
	reason, err = h.Prompt(ctx, "Reply with the single word SECOND.")
	if err != nil {
		t.Fatalf("turn 2 Prompt: %v\nstderr: %s", err, h.(*handle).Stderr())
	}
	if reason != domain.StopEndTurn {
		t.Fatalf("turn 2 stop reason = %q, want end_turn", reason)
	}
	second := collector.since(mark)
	var text strings.Builder
	for _, ev := range second {
		if ev.Kind == "message_chunk" {
			text.WriteString(ev.Text)
		}
	}
	if !strings.Contains(text.String(), "SECOND") {
		t.Fatalf("turn 2 reply missing SECOND: %q (events %+v)", text.String(), second)
	}

	// Turn 3: cancellation of a long tool call. Baseline expects
	// stopReason=cancelled shortly after session/cancel; ACP.md documents a
	// known flakiness where end_turn arrives anyway.
	mark = collector.count()
	type promptResult struct {
		reason domain.StopReason
		err    error
	}
	prompts := make(chan promptResult, 1)
	go func() {
		r, err := h.Prompt(ctx, "Run the shell command: sleep 60 ; then reply FINISHED.")
		prompts <- promptResult{r, err}
	}()

	time.Sleep(5 * time.Second)
	if err := h.Cancel(ctx); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	select {
	case pr := <-prompts:
		if pr.err != nil {
			t.Fatalf("cancel Prompt error: %v\nstderr: %s", pr.err, h.(*handle).Stderr())
		}
		if pr.reason != domain.StopCancelled {
			t.Fatalf("cancel stop reason = %q, want cancelled — see \"Cancel\" under Known limits in docs/compatibility/ACP.md: this adapter is known-flaky and sometimes returns end_turn at the instant of cancel; rerun and record the observation before trusting this row", pr.reason)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("prompt did not finish within 30s of Cancel\nstderr: %s", h.(*handle).Stderr())
	}
	_ = mark
}

func countKind(events []domain.ConversationEvent, kind string) int {
	n := 0
	for _, ev := range events {
		if ev.Kind == kind {
			n++
		}
	}
	return n
}

func stderrOf(h domain.AgentHandle) string {
	if hh, ok := h.(*handle); ok {
		return hh.Stderr()
	}
	return ""
}
