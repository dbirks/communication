package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/dbirks/communication/internal/events"
)

// Agent mail (ADR-0072): the minimal channel by which one chat's agent asks
// the agent of another repository in the same project.
//
// No tool channel reaches an ACP agent today — internal/agent/acp/handle.go
// negotiates `McpServers: []` on every session/new and offers no fs or
// terminal client capabilities — so the harness cannot be handed a real MCP
// tool without an unproven spike per launcher (docs/compatibility/ACP.md
// forbids prefilled PASS rows). The minimal channel instead: the worker
// tells the agent a fenced command block is a tool call, interprets the
// blocks it emits at the end of a completed turn, and delivers the answer
// back as the follow-up prompt on the asking chat. The command IS the tool:
// inputs are the target repo name and the question, output is the answer.
const (
	// MailCommandFence names the fenced code block an agent writes to ask.
	MailCommandFence = "communication-mail"
	// MaxMailAsksPerTurn bounds how many commands one turn may dispatch.
	MaxMailAsksPerTurn = 4
	// MailRepoMax bounds a repository name; MailQuestionMax bounds one
	// question. Both mirror the conversation_links CHECKs.
	MailRepoMax     = 200
	MailQuestionMax = 4096
	// MailScanCap bounds the text the command scan reads (the turn's whole
	// agent answer); beyond it the tail is not scanned.
	MailScanCap = 128 * 1024
)

// mailBlock matches one ```communication-mail fenced block. The body must be
// one JSON object; anything else is skipped (a malformed command is not a
// tool call).
var mailBlock = regexp.MustCompile("(?s)```" + MailCommandFence + "[ \\t]*\\r?\\n(.*?)```")

// ParseMailCommands extracts the mail commands from one turn's whole agent
// answer, in order, capped at MaxMailAsksPerTurn. A block whose JSON does
// not decode to a usable {repo, question} is dropped; a repo/question over
// the bound is truncated to it (the journal shows what was dispatched).
func ParseMailCommands(text string) []MailAsk {
	if text == "" {
		return nil
	}
	if len(text) > MailScanCap {
		text = text[:MailScanCap]
	}
	var out []MailAsk
	for _, m := range mailBlock.FindAllStringSubmatch(text, -1) {
		var ask MailAsk
		trimmed := strings.TrimSpace(m[1])
		if err := json.Unmarshal([]byte(trimmed), &ask); err != nil {
			continue
		}
		ask.Repo = strings.TrimSpace(ask.Repo)
		ask.Question = strings.TrimSpace(ask.Question)
		if ask.Repo == "" || ask.Question == "" {
			continue
		}
		if len(ask.Repo) > MailRepoMax {
			ask.Repo = string([]rune(ask.Repo)[:MailRepoMax])
		}
		if len(ask.Question) > MailQuestionMax {
			ask.Question = string([]rune(ask.Question)[:MailQuestionMax])
		}
		out = append(out, ask)
		if len(out) >= MaxMailAsksPerTurn {
			break
		}
	}
	return out
}

// MailPreamble returns the instruction the worker prepends to a prompt sent
// to an agent whose turn may dispatch mail. repoNames lists the project's
// repositories so the agent asks about repos that exist; an empty list
// still explains the command. The journal keeps the human's raw prompt
// (conversation.message.user) — this text is transport framing, never a
// transcript row.
func MailPreamble(repoNames []string) string {
	var b strings.Builder
	b.WriteString("(Communication agent mail is enabled for this project. ")
	b.WriteString("You may ask the agent of another repository in this project a question; ")
	b.WriteString("replies arrive in this chat. ")
	if len(repoNames) > 0 {
		b.WriteString("The project's repositories are: ")
		b.WriteString(strings.Join(repoNames, ", "))
		b.WriteString(". ")
	}
	b.WriteString("To ask, end your reply with a fenced block exactly like this:\n```")
	b.WriteString(MailCommandFence)
	b.WriteString("\n{\"repo\": \"<repository name>\", \"question\": \"<your question>\"}\n```\n")
	b.WriteString("Asked agents answer read-only: they cannot edit their repository. ")
	b.WriteString("Do not edit another repository yourself, and do not promise edits the mail channel cannot deliver.)\n\n")
	return b.String()
}

// MailTargetPrompt builds the prompt for a mailed target turn: the question,
// its provenance, and the read-only rule. The target chat's transcript shows
// this text as its conversation.message.user row — the honest record of who
// asked what, with nothing hidden.
//
// The read-only sentence states what the sandbox now does about it (ADR-0072
// § 12): the repository is mounted read-only, so an edit is refused by the
// kernel rather than by a prompt. Telling the agent which kind of rule it is
// saves it from retrying a write that cannot land.
func MailTargetPrompt(fromTitle string, askedBy string, question string) string {
	return "(Agent mail (ADR-0072) from the chat \u201c" + bounded(fromTitle, 120) +
		"\u201d, on behalf of user " + askedBy +
		". You are answering read-only: your repository is mounted read-only in the sandbox, so an edit is refused there until a person approves it in this chat. Question:\n\n" +
		question
}

// MailAnswerPrompt builds the follow-up prompt delivered to the asking
// agent when the target turn answers.
func MailAnswerPrompt(repo string, answer string) string {
	return "(Agent mail (ADR-0072): the agent in the repository \u201c" + repo +
		"\u201d answered the question you asked:\n\n" + answer +
		"\n\nYou may now use that answer. (This repository's agent remains read-only from your side.)"
}

// MailRejectionPrompt builds the follow-up prompt naming the asks that were
// rejected and why, so the asking agent is not left waiting on silence.
func MailRejectionPrompt(results []MailResult) string {
	parts := make([]string, 0, len(results))
	for _, r := range results {
		parts = append(parts, "- repo \u201c"+r.Repo+"\u201d: "+r.Reason)
	}
	return "(Agent mail (ADR-0072): your mail asks were rejected:\n" + strings.Join(parts, "\n") +
		"\nNothing was asked. Do not wait for answers that will not arrive.)"
}

// turnPrompt is the text actually sent to the harness for one claimed turn:
// the raw prompt, wrapped in the agent-mail preamble when the turn may
// dispatch mail (ADR-0072). The preamble is never journaled —
// conversation.message.user keeps the human's raw text; BeginTurn writes
// that row from the turn column, this wrapper lives only on the wire to the
// agent. The project's repository names ride the preamble so the agent asks
// about repos that exist; a failed name read still gets the generic
// instruction, and a failed mail-dispatching read is not a turn failure.
func (l *TurnLoop) turnPrompt(base context.Context, c Claim) string {
	if !c.MailAllowed || l.mail == nil {
		return c.Prompt
	}
	var names []string
	ctx, cancel := context.WithTimeout(base, 5*time.Second)
	defer cancel()
	if repos, err := l.store.ProjectRepos(ctx, c.ProjectID); err == nil {
		for _, r := range repos {
			names = append(names, r.Name)
		}
	}
	return MailPreamble(names) + c.Prompt
}

// dispatchMail interprets one completed turn's answer and returns the
// rejected asks (already journalled by the store). A lost lease here stops
// every further write for the turn, exactly as a lost fenced append does.
func (l *TurnLoop) dispatchMail(base context.Context, c Claim, rt *runningTurn, answer string) []MailResult {
	if l.units != nil {
		// The sink's whole-text buffer is pre-redaction: secrets never ride
		// into a mail command (the journal chunks went through the same hook).
		if red := l.unitRedact(c.ConversationID); red != nil {
			answer, _ = red(answer)
		}
	}
	asks := ParseMailCommands(answer)
	if len(asks) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(base, 15*time.Second)
	defer cancel()
	results, err := l.mail.DispatchMail(ctx, c, asks)
	if err != nil {
		if errors.Is(err, ErrLeaseLost) {
			rt.lostLease.Store(true)
			if s := rt.sessionLoad(); s != nil {
				s.cancelACP(base)
			}
			rt.cancel()
			return nil
		}
		l.log.Warn("agent mail dispatch failed", slog.String("turn_id", c.TurnID), slog.String("error", err.Error()))
		return nil
	}
	var rejected []MailResult
	for _, res := range results {
		if res.State == events.MailStateRejected {
			rejected = append(rejected, res)
		}
	}
	return rejected
}

// mailNotice queues a system-authored follow-up prompt (the answer notice
// for an accepted ask lands through the store's FinishMail arm; this arm
// carries rejections). A lost race — a human prompt already queued on the
// conversation — is not an error: the journal row still tells the story and
// the human sees the card.
func (l *TurnLoop) mailNotice(base context.Context, conversationID, prompt, submittedBy string) {
	if l.mail == nil {
		return
	}
	ctx, cancel := context.WithTimeout(base, 10*time.Second)
	defer cancel()
	inserted, err := l.mail.EnqueueMailNotice(ctx, conversationID, prompt, submittedBy)
	if err != nil {
		l.log.Warn("agent mail notice failed", slog.String("conversation_id", conversationID), slog.String("error", err.Error()))
		return
	}
	if !inserted {
		l.log.Info("agent mail notice skipped: conversation already carries a turn or is archived",
			slog.String("conversation_id", conversationID))
	}
}
