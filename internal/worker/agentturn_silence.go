package worker

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/dbirks/communication/internal/agent/acp"
)

// A turn whose coalesced stream holds nothing but the launcher talking about
// itself never got an answer, and refusing its reply `invalid_output` blames
// the agent for an outage the harness itself reported (Actions run
// 42079149686, issue #344, /implement attempt 1). The journal of that attempt
// is the shape:
//
//	conversation.message.agent  "pi v1.4.0\n---\n"   (the start-up banner — the ONLY agent text)
//	conversation.notice         kind=agent_retry ×3  (pi's own provider retries)
//	conversation.notice         "Retry finished, resuming."
//	agent.session.disconnected  reason=process_exited
//	node.attempt.failed         error_class=invalid_output
//
// pi's model gateway was failing all day (timeouts, 502s). The turn closed
// with a silence and the harness exited; the silence was read as a bad
// answer. ADR-0023 § 7 reserves invalid_output for "output failed its JSON
// Schema" — a reply to judge — and this executor already names the silence a
// dying harness leaves `infra` (disconnectDetail, mapTurnOutcome's promptErr
// arm): a dead agent is not an agent verdict. `infra` is the class the seed
// pipelines admit to retry (docs/compatibility/probes/m4/pipeline.yaml's
// /plan, /implement and /review all list it), so a flaky provider costs an
// attempt, not the node. No new class is needed, so none is invented.
//
// Two facts decide it, both observed and never inferred:
//
//   - the coalesced final text carries nothing the AGENT said (chatterOnly);
//   - the harness was unavailable as the turn closed: its transport was
//     already gone (acp.PeerGone), it spent the turn retrying its provider
//     (the retry series pi-acp streams as message chunks; pi_retry.go), or it
//     said out loud that its provider failed (providerErrorLine below).
//
// A reply with substance that fails extraction is untouched — that is the
// agent's own bad answer, and invalid_output still says so.
//
// Ordering is part of the rule. A banner-only silence whose harness is alive
// and reported no provider trouble stays invalid_output HERE, and only then
// may ADR-0076 read the turn's thought channel for a document the node's own
// schema accepts (agentturn.go's outputsFromThought). A silence this file
// classifies infra never reaches that arm: an agent that never got to answer
// has no answer waiting in its thoughts, and rescuing one would invent output
// for an outage. Keep this classifier first in the end_turn arm.
var (
	// launcherBannerLine is a launcher's own start-up banner, streamed as
	// agent message text before any answer: pi prints `pi v1.4.0` and
	// underlines it with `---` (observed live: run 42079149686 row E174;
	// docs/compatibility/ACP.md's pi probe rows). Anchored on a bare
	// `<name> v<version>` line so prose can never be mistaken for it.
	launcherBannerLine = regexp.MustCompile(`^\s*[A-Za-z][\w.-]*\s+v\d+(\.\d+)*(?:\s+\([^)]*\))?\s*$`)

	// launcherRuleLine is the separator a CLI draws under its banner. A lone
	// rule is markdown scaffolding, never an answer.
	launcherRuleLine = regexp.MustCompile(`^\s*[-=*_]{2,}\s*$`)

	// launcherRetryAlone is pi-acp's DEGENERATE retry status: when the
	// auto_retry_start event carries no finite attempt/max/delay numbers its
	// formatter falls back to the bare word (pi-acp@0.0.34 dist/index.js's
	// formatAutoRetryMessage: `return "Retrying..."`). pi_retry.go's anchored
	// series line cannot match it, so this is the one retry-status shape that
	// reaches the reply text as raw agent chunks.
	launcherRetryAlone = regexp.MustCompile(`^Retrying\s*(?:…|\.{3})$`)

	// harnessErrorLead opens a line the HARNESS states as an error: an
	// optional single qualifier ("OpenAI API error (502): …", "Proxy error:
	// …"), the word error, and a colon/dash or a parenthesised status. Anchored
	// at column 0 so a sentence that merely mentions an error mid-prose is
	// never this shape.
	harnessErrorLead = regexp.MustCompile(`(?i)^\s*(?:[\w.-]{1,24}\s+)?(?:api\s+|provider\s+|request\s+|proxy\s+|stream\s+|http\s+|upstream\s+)?error\s*(?:\(\s*(?:5\d{2}|4(?:08|09|25|29|99))\s*\))?\s*[:\-]\s*(.*)$`)

	// harnessStatusLead is pi-ai's body-first error shape —
	// formatProviderError composes `"<status>: <body>"` when no prefix is
	// given (pi-ai/dist/utils/error-body.js), and that string is the last
	// thing a dying turn says.
	harnessStatusLead = regexp.MustCompile(`^(?:5\d{2}|4(?:08|09|25|29|99))\s*[:\-]\s*(.*)$`)

	// providerStatus is the status family a gateway/provider outage carries:
	// 5xx and the retriable 4xx set (408/409/425/429/499).
	providerStatus = `(?:5\d{2}|4(?:08|09|25|29|99))`

	// providerFailurePhrase is the recognisable transport fact: a status with
	// its canonical reason, one of the gateway's own failure words, or the
	// OPENING of a provider error body (`{"error":…`, `<html>…`). It is
	// anchored: see providerErrorLine for how far into the line it may sit.
	providerFailurePhrase = regexp.MustCompile(`(?i)^(?:` +
		providerStatus + `\b.{0,60}?\b(?:bad gateway|gateway time-?out|service unavailable|internal server error|too many requests|overloaded(?:_error)?|rate[ -]?limit|timed? ?out|timeout|unavailable)\b` +
		`|bad gateway|gateway (?:time-?out|error|failure)|service unavailable|internal server error|too many requests|overloaded(?:_error)?|rate[ -]?limit(?:ed|ing)?|timed? ?out|timeout|deadline exceeded` +
		`|etimedout|econn(?:reset|refused|aborted|timedout)|enotfound|eai_again|socket hang up|network error|fetch failed|connection (?:error|lost|closed|reset|refused|failed|timed out)|provider (?:error|unavailable)` +
		`|[{<])`)
)

// providerErrorLeadWindow bounds how far into a line the failure fact may sit
// for a bare `Error:` lead: the marker plus at most a handful of connector
// words. A gateway says it in six tokens ("Error: upstream returned 502 Bad
// Gateway"); an answer that merely mentions one keeps talking.
const providerErrorLeadWindow = 120

// chatterLine reports whether one streamed line is the launcher speaking
// about itself rather than answering: blank, its banner, the rule under it,
// or one of pi's transport-retry status lines (pi_retry.go's classifier — the
// same rule the transcript sink uses to keep those lines out of the
// conversation's agent rows, so the attempt and the thread agree on what the
// agent said) — including pi-acp's degenerate bare `Retrying…`.
func chatterLine(line string) bool {
	s := strings.TrimSpace(line)
	if s == "" {
		return true
	}
	if launcherBannerLine.MatchString(s) || launcherRuleLine.MatchString(s) {
		return true
	}
	if retryStatusLine(s) != "" || launcherRetryAlone.MatchString(s) {
		return true
	}
	return providerErrorLine(line) != ""
}

// providerErrorLine reports one whole line when it is the HARNESS naming its
// own provider failure in streamed agent text, "" for anything else.
//
// pi-acp@0.0.34 does not relay pi's provider errorMessage text (its
// message_update arm forwards only text/thinking/toolcall deltas, and a turn
// whose provider died settles as end_turn with nothing further said), which is
// why the gateway outages in our evidence close as banner + retry-status lines
// (Actions run 42079149686, issue #344). The shapes that DO reach agent text
// are the harness's own error sentences and pi's composed provider errors, and
// a line is a provider failure only when BOTH halves agree:
//
//   - it LEADS with an error marker at column 0 (`Error: …`,
//     `OpenAI API error (429): …`, `Proxy error: …`) or with a bare
//     5xx/retriable-4xx status followed by a colon — pi-ai's
//     formatProviderError composition `"<status>: <body>"`; and
//   - the SAME line, within providerErrorLeadWindow characters and at most
//     three connector words past that marker, states the transport fact: a
//     status with its canonical reason ("502 Bad Gateway"), one of the
//     gateway's failure words (timed out, overloaded, ECONNRESET, rate limit,
//     service unavailable, …), or the opening of a provider error body
//     (`{"error":…`, `<html>…`).
//
// Prose fails the second arm or the window: "Error: 502 is what the gateway
// module documents in README.md." leads with a marker but never states a
// failure fact near it — it stays the agent's own answer, and invalid_output
// still says so. A reply that consists of NOTHING but such lines never got to
// answer; turnUnavailableClass treats that as the transport's story.
func providerErrorLine(line string) string {
	s := strings.TrimSpace(line)
	if s == "" || len(s) > 4*providerErrorLeadWindow {
		return ""
	}
	rest := ""
	if m := harnessErrorLead.FindStringSubmatch(s); m != nil {
		rest = m[1]
	} else if m := harnessStatusLead.FindStringSubmatch(s); m != nil {
		// The lead itself IS the status fact.
		return s
	} else {
		return ""
	}
	if len(rest) > providerErrorLeadWindow {
		rest = rest[:providerErrorLeadWindow]
	}
	for skip := 0; ; skip++ {
		if candidate, ok := dropLeadingWords(rest, skip); ok {
			if providerFailurePhrase.MatchString(candidate) {
				return s
			}
		} else {
			return ""
		}
		if skip >= 3 {
			return ""
		}
	}
}

// dropLeadingWords returns rest with the first n space-separated words
// removed (n=0 → unchanged). ok=false when there are fewer than n words left,
// so the caller stops rather than matching an empty tail.
func dropLeadingWords(rest string, n int) (string, bool) {
	if n == 0 {
		return rest, true
	}
	i := 0
	for taken := 0; taken < n; taken++ {
		for i < len(rest) && rest[i] != ' ' && rest[i] != '\t' {
			i++
		}
		for i < len(rest) && (rest[i] == ' ' || rest[i] == '\t') {
			i++
		}
		if i >= len(rest) {
			return "", false
		}
	}
	return rest[i:], true
}

// providerErrorSpeech is the transport evidence a coalesced reply carries by
// itself: the launcher's own provider-failure lines (the anchored bare
// `Retrying…` counts — pi-acp's degenerate retry status reaches the reply text
// where pi_retry.go's series line does not). It is what makes an outage whose
// harness stayed alive a transport story rather than an agent verdict.
func providerErrorSpeech(text string) []string {
	var hits []string
	for _, line := range strings.Split(text, "\n") {
		s := strings.TrimSpace(line)
		if s == "" {
			continue
		}
		if launcherRetryAlone.MatchString(s) || providerErrorLine(s) != "" {
			if len(hits) < 4 {
				hits = append(hits, s)
			}
		}
	}
	return hits
}

// chatterOnly reports whether a coalesced reply is nothing but launcher
// chatter: every streamed line blank, banner, rule or retry status. One
// surviving line of anything else is an agent answer — a bad one, if
// extraction refused it, and bad answers stay invalid_output.
func chatterOnly(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		if !chatterLine(line) {
			return false
		}
	}
	return true
}

// unansweredDetail is the honest sentence for a turn that closed with nobody
// left answering. failureDiagnostics appends the agent's stderr tail at the
// call site, which carries the gateway's own words (502s, timeouts).
func unansweredDetail(peerGone bool, retries int, spoken []string) string {
	var b strings.Builder
	b.WriteString("agent turn produced no substantive reply — only the launcher's banner/separator")
	if retries > 0 {
		b.WriteString(" plus " + strconv.Itoa(retries) + " provider-retry status line(s) from the harness")
	}
	if len(spoken) > 0 {
		b.WriteString(" plus " + strconv.Itoa(len(spoken)) +
			" provider-failure line(s) spoken by the harness: " + quoteBounded(spoken))
	}
	if peerGone {
		b.WriteString(", and the agent's transport was gone as the turn closed")
	} else if retries <= 0 && len(spoken) > 0 {
		b.WriteString(", and the harness reported its provider failing as the turn closed")
	} else {
		b.WriteString(", and the harness never recovered its provider transport")
	}
	b.WriteString(" — the agent never answered, so no reply exists for the schema to judge: invalid_output is reserved for a reply that violates its schema (ADR-0023 § 7); an unavailable agent/provider is infra, which retriableErrors may retry")
	return b.String()
}

// quoteBounded renders the launcher's own failure lines for the attempt
// detail: at most 3, each cut to 120 characters, so the ledger names the
// shape without becoming a dump of a gateway's HTML error body. The detail
// travels through Execute's redactResult like every other attempt fact.
func quoteBounded(lines []string) string {
	quoted := make([]string, 0, 3)
	for i, l := range lines {
		if i >= 3 {
			break
		}
		if len(l) > 120 {
			l = l[:120] + "…"
		}
		quoted = append(quoted, strconv.Quote(l))
	}
	return strings.Join(quoted, ", ")
}

// turnUnavailableClass is the classification decision, stated once outside
// executeAttempt so it is testable without a live session: a refused
// extraction is the agent's own bad answer UNLESS the turn never spoke and the
// harness was unavailable, which is the transport's. It returns the honest
// detail for the transient arm, or "" when the reply is the agent's to blame.
func turnUnavailableClass(text string, midTurnDisc bool, discInfo acp.DisconnectInfo, peerGone bool, retries int) (bool, string) {
	if midTurnDisc {
		return true, disconnectDetail(discInfo)
	}
	if !chatterOnly(text) {
		return false, ""
	}
	spoken := providerErrorSpeech(text)
	if !peerGone && retries <= 0 && len(spoken) == 0 {
		// Silence with the harness alive and no provider trouble reported is
		// the agent's own non-answer: invalid_output stands.
		return false, ""
	}
	return true, unansweredDetail(peerGone, retries, spoken)
}
