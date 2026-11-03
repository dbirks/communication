package worker

import (
	"strings"
	"testing"
)

// TestRetryStatusLineAnchoredOnWholeLine is the classifier's own contract:
// it must take exactly the launcher's retry status lines (pi-acp streams
// them as agent message chunks, one whole line per chunk, observed on the
// lab at e900d34) and nothing else — an answer that merely mentions a
// retry is the agent's own words.
func TestRetryStatusLineAnchoredOnWholeLine(t *testing.T) {
	status := []string{
		"Retrying (attempt 1/3, waiting 2s)…",
		"Retrying (attempt 1/3, waiting 2s)...",
		"Retrying (attempt 1/3, waiting 2s)...\n",
		"  Retrying (attempt 2/3, waiting 4s)…  ",
		"Retrying (attempt 3/3, waiting 8s)...",
		"Retry finished, resuming.",
		"Retry finished, resuming.\n",
	}
	for _, line := range status {
		if got := retryStatusLine(line); got != strings.TrimSpace(line) {
			t.Errorf("retryStatusLine(%q) = %q, want the trimmed whole line %q", line, got, strings.TrimSpace(line))
		}
	}

	// Each negative is the status shape broken just enough to stop being a
	// status line: the closing paren and the ellipsis both belong to the
	// shape, and so does the whole-line anchoring.
	agentWords := []string{
		"",
		" ",
		"OK",
		"I am Retrying (attempt 1/3, waiting 2s)...",
		"Retrying (attempt 1/3, waiting 2s)…. and then the model answered.",
		"Retrying (attempt 1/3, waiting 2m)...",
		"Retrying (attempt 1/3, waiting 2s)....",
		"Retrying (attempt 1/3, waiting 2s)",
		"Retrying (attempt 1/3, waiting 2s)...\nMore of the answer.",
		"Retry finished, resuming. Now for the answer.",
		"retry finished, resuming.",
		"Retry finished, resuming…",
		"Retrying (attempt 1/3, waiting 2s)…Retry finished, resuming.",
	}
	for _, line := range agentWords {
		if got := retryStatusLine(line); got != "" {
			t.Errorf("retryStatusLine(%q) = %q, want \"\": real agent text is never a status line", line, got)
		}
	}
}
