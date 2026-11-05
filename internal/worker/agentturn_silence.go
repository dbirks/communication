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
//     already gone (acp.PeerGone) or it spent the turn retrying its provider
//     (the retry series pi-acp streams as message chunks; pi_retry.go).
//
// A reply with substance that fails extraction is untouched — that is the
// agent's own bad answer, and invalid_output still says so.
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
)

// chatterLine reports whether one streamed line is the launcher speaking
// about itself rather than answering: blank, its banner, the rule under it,
// or one of pi's transport-retry status lines (pi_retry.go's classifier — the
// same rule the transcript sink uses to keep those lines out of the
// conversation's agent rows, so the attempt and the thread agree on what the
// agent said).
func chatterLine(line string) bool {
	s := strings.TrimSpace(line)
	if s == "" {
		return true
	}
	if launcherBannerLine.MatchString(s) || launcherRuleLine.MatchString(s) {
		return true
	}
	return retryStatusLine(s) != ""
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
func unansweredDetail(peerGone bool, retries int) string {
	var b strings.Builder
	b.WriteString("agent turn produced no substantive reply — only the launcher's banner/separator")
	if retries > 0 {
		b.WriteString(" plus " + strconv.Itoa(retries) + " provider-retry status line(s) from the harness")
	}
	if peerGone {
		b.WriteString(", and the agent's transport was gone as the turn closed")
	} else {
		b.WriteString(", and the harness never recovered its provider transport")
	}
	b.WriteString(" — the agent never answered, so no reply exists for the schema to judge: invalid_output is reserved for a reply that violates its schema (ADR-0023 § 7); an unavailable agent/provider is infra, which retriableErrors may retry")
	return b.String()
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
	if !peerGone && retries <= 0 {
		// Silence with the harness alive and no provider trouble reported is
		// the agent's own non-answer: invalid_output stands.
		return false, ""
	}
	return true, unansweredDetail(peerGone, retries)
}
