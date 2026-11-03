package worker

import (
	"regexp"
	"strings"
)

// piRetryLine is launcher pi's transport retry status, one whole line per
// agent message chunk: pi-acp streams the harness's own model-retry state as
// agent_message_chunk updates (observed live on the lab at e900d34, round-6
// review defect):
//
//	Retrying (attempt 1/3, waiting 2s)…
//
// Each attempt is its own line; both the single-glyph ellipsis and the plain
// three-dot spelling occur. The series closes with its own terminating line
//
//	Retry finished, resuming.
//
// These lines are the HARNESS speaking, not the agent: a consumer that quotes
// "what the agent said" reads the turn's conversation.message.agent rows, and
// so do the thread-list preview and the agent-mail answer (ADR-0072 § 7). A
// status line journalled as agent text is served everywhere as the agent's
// own words — and a turn whose only "answer" is its retry series ends up
// "answered" with no answer at all. The sink routes each line to a
// conversation.notice (kind agent_retry) instead.
var piRetryLine = regexp.MustCompile(`^Retrying \(attempt \d+/\d+, waiting \d+s\)(…|\.\.\.)$`)

// piRetryDone is the line that closes the retry series.
var piRetryDone = regexp.MustCompile(`^Retry finished, resuming\.$`)

// retryStatusLine reports the chunk as a whole when it is exactly one of pi's
// retry status lines (surrounding whitespace ignored); anything else —
// including a real answer that merely mentions a retry, or a line the harness
// is still mid-way through streaming — is the agent's own words and returns
// "". The match is deliberately anchored on the whole line: narrow enough that
// no prose can be mistaken for status, wide enough to take every line of one
// series.
func retryStatusLine(chunk string) string {
	line := strings.TrimSpace(chunk)
	if piRetryLine.MatchString(line) || piRetryDone.MatchString(line) {
		return line
	}
	return ""
}
