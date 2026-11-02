package worker_test

// ADR-0072 agent mail, worker side: the command block IS the tool call, so
// the parse is the tool surface, and the loop's interpretation arm is proven
// end to end against a fake store that speaks MailPort: a completed,
// mail-allowed turn's whole answer is scanned (across chunk boundaries), the
// asks are dispatched BEFORE the terminal write, the preamble rides the wire
// and not the journal, and rejected asks come back as the asking chat's
// follow-up notice.

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	worker "github.com/dbirks/communication/internal/worker"
)

// mailFake is a fakeStore that also answers the mail port, with one ordered
// call log so a test can prove dispatch precedes the finish.
type mailFake struct {
	*fakeStore
	mu         sync.Mutex
	log        []string
	asks       []worker.MailAsk
	dispatched []worker.Claim
	results    []worker.MailResult
	notices    []string
	noticeAt   string
}

func newMailFake() *mailFake {
	return &mailFake{fakeStore: newFakeStore()}
}

func (m *mailFake) record(what string) {
	m.mu.Lock()
	m.log = append(m.log, what)
	m.mu.Unlock()
}

func (m *mailFake) callLog() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.log...)
}

func (m *mailFake) DispatchMail(_ context.Context, c worker.Claim, asks []worker.MailAsk) ([]worker.MailResult, error) {
	m.mu.Lock()
	m.log = append(m.log, "dispatch")
	m.asks = append(m.asks, asks...)
	m.dispatched = append(m.dispatched, c)
	results := append([]worker.MailResult(nil), m.results...)
	m.mu.Unlock()
	return results, nil
}

func (m *mailFake) EnqueueMailNotice(_ context.Context, conversationID, prompt, submittedBy string) (bool, error) {
	m.mu.Lock()
	m.log = append(m.log, "notice")
	m.notices = append(m.notices, prompt)
	m.noticeAt = conversationID + "/" + submittedBy
	m.mu.Unlock()
	return true, nil
}

func (m *mailFake) FinishTurn(ctx context.Context, c worker.Claim, o worker.TurnOutcome) error {
	m.record("finish")
	return m.fakeStore.FinishTurn(ctx, c, o)
}

func mailLoop(t *testing.T, cfg worker.TurnConfig, st *mailFake, ff *fakeFactory) *worker.TurnLoop {
	t.Helper()
	l, err := worker.NewTurnLoop(cfg, st, ff, &fakeWork{dir: t.TempDir()}, func() string { return "worker-1" })
	if err != nil {
		t.Fatalf("worker.NewTurnLoop: %v", err)
	}
	return l
}

func TestParseMailCommands(t *testing.T) {
	text := "Answer first.\n\n```communication-mail\n{\"repo\": \"api\", \"question\": \"where is search wired?\"}\n```\n" +
		"and a second:\n```communication-mail\n{\"repo\":\"web\",\"question\":\"q2\"}\n```\n" +
		"```\nnot mail\n```\n" +
		"```communication-mail\n{not json\n```\n" +
		"```communication-mail\n{\"repo\":\"\",\"question\":\"no repo\"}\n```\n"
	asks := worker.ParseMailCommands(text)
	if len(asks) != 2 {
		t.Fatalf("asks = %+v, want the two well-formed commands", asks)
	}
	if asks[0].Repo != "api" || asks[0].Question != "where is search wired?" {
		t.Errorf("ask 1 = %+v", asks[0])
	}
	if asks[1].Repo != "web" || asks[1].Question != "q2" {
		t.Errorf("ask 2 = %+v", asks[1])
	}
	if got := worker.ParseMailCommands(strings.Repeat(
		"```communication-mail\n{\"repo\":\"r\",\"question\":\"q\"}\n```\n", 6)); len(got) != worker.MaxMailAsksPerTurn {
		t.Errorf("cap: %d asks parsed, want %d", len(got), worker.MaxMailAsksPerTurn)
	}
	if got := worker.ParseMailCommands("no commands at all"); got != nil {
		t.Errorf("plain answer parsed %v, want none", got)
	}
}

func TestMailPreambleNamesReposAndCommand(t *testing.T) {
	p := worker.MailPreamble([]string{"api", "web"})
	for _, want := range []string{"communication-mail", "\"repo\"", "api, web", "read-only"} {
		if !strings.Contains(p, want) {
			t.Errorf("preamble missing %q:\n%s", want, p)
		}
	}
}

// TestMailDispatchOnCompletedTurnProvesToolSemantics: the fenced block
// straddling chunk boundaries is one tool call; the preamble reaches the
// agent; dispatch is fenced on the claim and lands before the terminal
// write; a failed turn dispatches nothing.
func TestMailDispatchOnCompletedTurnProvesToolSemantics(t *testing.T) {
	m := newMailFake()
	claim := testClaim()
	claim.PermissionMode = "deny"
	claim.MailAllowed = true
	m.claims = []worker.Claim{claim}
	m.repos = []worker.Repo{{Name: "api"}, {Name: "web"}}
	m.results = []worker.MailResult{{Repo: "api", Question: "where?", State: events.MailStateAsked, LinkID: "l-1"}}

	block := "Sure —\n```communication-mail\n{\"repo\":\"api\",\"question\":\"where?\"}\n"
	sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-m", Origin: "new", LauncherID: "claude"})
	sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: block})
		s.send(domain.ConversationEvent{Kind: "message_chunk", Text: "```\n"})
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := mailLoop(t, fastCfg(), m, ff)
	startLoop(t, l)

	recv(t, m.finishing, "terminal outcome")
	deadline := time.After(5 * time.Second)
	for {
		log := m.callLog()
		if len(log) >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("mail arm never completed: log = %v", log)
		case <-time.After(5 * time.Millisecond):
		}
	}
	log := m.callLog()
	if log[0] != "dispatch" || log[1] != "finish" {
		t.Errorf("call order = %v, want dispatch before finish (asked must precede turn.completed in the journal)", log)
	}
	m.mu.Lock()
	asks := append([]worker.MailAsk(nil), m.asks...)
	claims := append([]worker.Claim(nil), m.dispatched...)
	m.mu.Unlock()
	if len(asks) != 1 || asks[0].Repo != "api" {
		t.Fatalf("dispatched asks = %+v, want the one block parsed across chunks", asks)
	}
	if claims[0].TurnID != claim.TurnID || claims[0].FencingToken != claim.FencingToken {
		t.Errorf("dispatch claim = %+v, want the live lease triple", claims[0])
	}
	fakeSessionPromptMu.Lock()
	prompt := fakeSessionPromptTexts[len(fakeSessionPromptTexts)-1]
	fakeSessionPromptMu.Unlock()
	if !strings.HasPrefix(prompt, "(Communication agent mail is enabled") || !strings.Contains(prompt, "api, web") {
		t.Errorf("agent prompt lost the mail preamble:\n%s", prompt)
	}
	if !strings.HasSuffix(prompt, claim.Prompt) {
		t.Errorf("agent prompt lost the human text: %q", prompt)
	}
}

// TestMailRejectionNoticesAskingChat: a rejected ask never waits — the
// asking chat gets a follow-up notice AFTER the terminal write (the
// one-active-turn rule makes the order mandatory).
func TestMailRejectionNoticesAskingChat(t *testing.T) {
	m := newMailFake()
	claim := testClaim()
	claim.PermissionMode = "deny"
	claim.MailAllowed = true
	m.claims = []worker.Claim{claim}
	m.results = []worker.MailResult{{Repo: "ghost", Question: "there?", State: events.MailStateRejected, Reason: "no repository named \"ghost\" in this project"}}

	sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-r", Origin: "new", LauncherID: "claude"})
	sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
		s.send(domain.ConversationEvent{Kind: "message_chunk",
			Text: "```communication-mail\n{\"repo\":\"ghost\",\"question\":\"there?\"}\n```"})
		return domain.StopEndTurn, nil
	}
	ff := &fakeFactory{sessions: []*fakeSession{sess}}
	l := mailLoop(t, fastCfg(), m, ff)
	startLoop(t, l)

	recv(t, m.finishing, "terminal outcome")
	recvNotice := func() {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			m.mu.Lock()
			n := len(m.notices)
			m.mu.Unlock()
			if n > 0 {
				return
			}
			select {
			case <-deadline:
				t.Fatal("rejection notice never queued")
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	recvNotice()
	m.mu.Lock()
	notice := m.notices[0]
	at := m.noticeAt
	log := append([]string(nil), m.log...)
	m.mu.Unlock()
	if !strings.Contains(notice, "ghost") || !strings.Contains(notice, "no repository") {
		t.Errorf("notice = %q, want it to name the repo and the reason", notice)
	}
	if at != claim.ConversationID+"/"+claim.SubmittedBy {
		t.Errorf("notice addressed to %q, want asking conversation on behalf of the turn's human", at)
	}
	for i := range log {
		if log[i] == "notice" && i > 0 && log[i-1] == "dispatch" {
			t.Fatalf("notice queued before the finish: %v", log)
		}
	}
	if log[len(log)-1] != "notice" {
		t.Errorf("call order = %v, want the notice last (after finish)", log)
	}
}

// TestMailNotDispatchedWhenNotAllowed or on a failed turn: the whole arm is
// gated twice (claim flag + completed status).
func TestMailNotDispatchedWhenTurnIsNotEligible(t *testing.T) {
	for _, tt := range []struct {
		name      string
		allowed   bool
		stop      domain.StopReason
		promptErr bool
	}{
		{"claim not allowed", false, domain.StopEndTurn, false},
		{"turn failed", true, domain.StopEndTurn, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := newMailFake()
			claim := testClaim()
			claim.PermissionMode = "deny"
			claim.MailAllowed = tt.allowed
			m.claims = []worker.Claim{claim}
			sess := newFakeSession(domain.SessionInfo{ACPSessionID: "acp-n", Origin: "new", LauncherID: "claude"})
			sess.promptFn = func(_ context.Context, s *fakeSession) (domain.StopReason, error) {
				s.send(domain.ConversationEvent{Kind: "message_chunk",
					Text: "```communication-mail\n{\"repo\":\"api\",\"question\":\"q\"}\n```"})
				if tt.promptErr {
					return "", context.DeadlineExceeded
				}
				return tt.stop, nil
			}
			ff := &fakeFactory{sessions: []*fakeSession{sess}}
			l := mailLoop(t, fastCfg(), m, ff)
			startLoop(t, l)
			recv(t, m.finishing, "terminal outcome")
			time.Sleep(100 * time.Millisecond)
			for _, e := range m.callLog() {
				if e == "dispatch" || e == "notice" {
					t.Fatalf("mail arm ran for an ineligible turn: %v", m.callLog())
				}
			}
		})
	}
}
