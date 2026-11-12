package assistant

// as-reask: ONE server-side re-ask when a turn ends without answering.
//
// The lab showed the prompt alone is unreliable: asked "do you have access
// to any github tokens?", the model sometimes calls credential.list, then
// ui.navigate, and ends the turn with "I've opened the Secrets page…" —
// the question is never answered in words (acceptances 43152289714,
// 42799969404); it has also ended a turn with empty text twice (emulator
// repo-chat-nav:2799). The owner's chosen fix: when a turn's final reply
// did not answer, the runner feeds ONE fixed nudge back and lets the model
// answer in the same turn. The second reply is final whatever it says.
//
// This file holds only the pure decision helper and its fixed nudge; the
// loop wiring lives in runner.go RunTurn.

import (
	"regexp"
	"strings"
)

// reaskNudge is the fixed server-authored follow-up (not user data — the
// prompt-injection rules do not apply to it, and scanForSecrets still sees
// it like any other message). It names the exact failure mode the lab
// showed: navigating instead of answering.
const reaskNudge = "You haven't answered the question yet. Answer it in words now, " +
	"from the tool results above (for example, name each item a list tool returned). " +
	"Do not call ui.navigate again."

// Reasons a turn is re-asked, logged and nothing else: no user text ever
// reaches the log line.
const (
	reaskEmpty        = "empty"
	reaskNavigateOnly = "navigate_only"
)

// questionWord opens a question. The list is fixed and lower-case; a
// message whose first word matches (or that simply ends in "?") counts as
// someone asking something, which is the only case the navigate-only
// heuristic may fire on — a navigation REQUEST ("open the secrets page")
// never re-asks.
var questionWord = map[string]bool{}

func init() {
	for _, w := range strings.Fields("do does did is are can could what which who where when why how any have has") {
		questionWord[w] = true
	}
}

// isQuestionMessage reports whether the person's message reads as a
// question: it ends with "?" or starts with a question word. Deliberately
// dumb and conservative — the navigate-only re-ask fires only on the
// narrowest reading of "was this a question".
func isQuestionMessage(msg string) bool {
	s := strings.TrimSpace(msg)
	if s == "" {
		return false
	}
	if strings.HasSuffix(s, "?") || strings.HasSuffix(s, "？") {
		return true
	}
	first := s
	if i := strings.IndexAny(first, " \t\n"); i >= 0 {
		first = first[:i]
	}
	first = strings.ToLower(strings.Trim(first, `"'“”‘’*_.:;!?（）()[]`))
	return questionWord[first]
}

// navAckSentence matches a sentence that is ONLY a navigation
// acknowledgement: it names opening/navigating/taking the reader to a page
// and says nothing else worth reading ("I've opened the Secrets page.",
// "Taking you there now.", the bare "Opened." / "Done." forms). The
// heuristic is intentionally narrow and documented: every clause must be
// one of these shapes, and anything that looks like content (a colon
// introducing a list, code, a table, a bullet, a digit, a quoted name)
// vetoes the re-ask. Erring toward NOT re-asking is the rule — a wrong
// re-ask costs a model call and can nag; a wrong silence about a real
// answer is what the loop already handles.
var navAckSentence = regexp.MustCompile(`(?i)^\s*[*_>\s]*(?:` +
	`(?:i|i'?ve|i have|we|we'?ve|just|now|here'?s|the|that|this|all|everything)\b[^.!?]*\b(?:open|opens|opened|opening|navigat\w*|tak\w*|bring\w*|show\w*|load\w*)\b[^.!?]*` + // "I've opened the Secrets page"
	`|(?:taking|takes|take|taken|bringing|brought|showing) (?:you|this|us)\b[^.!?]*` + // "Taking you to the page now"
	`|\b(?:go to|heading to|head to|navigat\w* to)\b[^.!?]*` + // "Go to the settings page"
	`|the page is (?:open|up|ready|loaded)\b[^.!?]*` + // "The page is open."
	`|(?:done|opened|sure|ok|okay|there you go|here you go)\b[^.!?]*` + // bare acks
	`)[.!?]*\s*$`)

// navigationAckOnly reports whether every sentence of an already-stripped
// reply is a bare navigation acknowledgement. An empty text is NOT an ack
// (it is the "empty" reason, decided before this runs).
func navigationAckOnly(text string) bool {
	s := strings.TrimSpace(text)
	if s == "" {
		return false
	}
	// Anything shaped like content vetoes the re-ask outright.
	if strings.ContainsAny(s, ":：`|") {
		return false
	}
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "-") || strings.HasPrefix(strings.TrimSpace(line), "*") {
			return false // a bullet list is an answer, not an ack
		}
	}
	if strings.ContainsAny(s, "0123456789") {
		return false // a number in the reply is usually the answer itself
	}
	// Split sentences on terminators (same spirit as the guard-remark
	// filter's sentenceRun); a stray empty fragment is not content.
	sentences := regexp.MustCompile(`[^.!?？]+[.!?？]*`).FindAllString(s, -1)
	seen := false
	for _, sent := range sentences {
		if strings.TrimSpace(sent) == "" {
			continue
		}
		seen = true
		if !navAckSentence.MatchString(sent) {
			return false
		}
	}
	return seen
}

// turnNavigated reports whether this turn successfully ran ui.navigate.
// A refused navigation (route_not_allowed) is not a navigation the model
// could hide behind.
func turnNavigated(calls []ToolCall) bool {
	for _, c := range calls {
		if c.Name == "ui.navigate" && c.OK {
			return true
		}
	}
	return false
}

// reaskReason decides whether a turn's final reply did not answer, and
// why. answerText is the reply AFTER the runner's existing prose
// stripping (guard remarks, dangling lead-in, cleanMarkdown) — the exact
// text that would ship. It returns reaskEmpty, reaskNavigateOnly, or ""
// for "this reply answered; ship it".
func reaskReason(answerText string, navigated bool, personMessage string) string {
	if strings.TrimSpace(answerText) == "" {
		return reaskEmpty
	}
	if navigated && isQuestionMessage(personMessage) && navigationAckOnly(answerText) {
		return reaskNavigateOnly
	}
	return ""
}
