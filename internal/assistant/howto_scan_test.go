package assistant

// Deployed finding F-3 (docs/testing/assistant-exercise-2026-11-11.md): the
// shipped how-to corpus refused the very journey that reads it.
//
// `docs.search` returns the first `howtoMaxExcerpt` bytes of a page's body, the
// loop folds that payload into the NEXT request body, and `scanForSecrets`
// (internal/assistant/scan.go) is re-run on every iteration
// (internal/assistant/runner.go). One page whose prose read like
// `token: <something 6+ chars>` therefore made every turn that found it die
// with `secret_in_request` — 3/3 refusals on "How do I set up a GitHub
// credential?", and the same on its two sibling asks. The scan is the right
// rule (ADR-0018's fail-closed egress gate is not to be weakened for
// convenience); the corpus is what has to hold the line.
//
// So this is the corpus's own gate: NO page in the embedded set — neither its
// full body nor the excerpt a turn would actually carry — may match
// `secretShape`. A future page that breaks its own journey fails here, at
// `go test`, instead of refusing a person's how-to question in production.

import (
	"encoding/json"
	"testing"
)

// TestHowToPagesCarryNoSecretShape is that gate, in three passes over every
// embedded page: the whole body, the exact excerpt `searchHowTo` puts in the
// payload, and the marshalled payload of a search that returns the page — the
// bytes that re-enter the next request body and are scanned there.
func TestHowToPagesCarryNoSecretShape(t *testing.T) {
	docs := loadHowto()
	if len(docs) == 0 {
		t.Fatal("the embedded how-to corpus is empty")
	}
	secretShapeScan := secretShape // the shipped scanner, unpinned and unweakened
	for _, d := range docs {
		excerpt := bounded(d.body, howtoMaxExcerpt)
		for _, part := range []struct {
			name, text string
		}{
			{"body", d.body},
			{"excerpt", excerpt},
		} {
			if hit := secretShapeScan.FindString(part.text); hit != "" {
				t.Errorf("%s: %s carries secret-shaped material %q — a turn that reads this page is refused with secret_in_request",
					d.path, part.name, hit)
			}
		}

		// The payload as the loop would see it: the page found by its own
		// title, marshalled the way execSetupRead marshals it before the next
		// scanForSecrets. This is the byte-exact repro of F-3.
		blob, err := json.Marshal(searchHowTo(d.title))
		if err != nil {
			t.Fatalf("%s: marshal search payload: %v", d.path, err)
		}
		if hit := secretShapeScan.FindString(string(blob)); hit != "" {
			t.Errorf("%s: the docs.search payload for %q carries secret-shaped material %q",
				d.path, d.title, hit)
		}
	}
}

// TestHowToGitHubTokenPageAnswersItsOwnJourney pins the F-3 repro itself: the
// asks the exercise sent ("How do I set up a GitHub credential?", "How do I add
// a GitHub token?") find the page, and the request body a turn would build from
// that payload passes the scan. The wording of line 4 is the fix — a secret
// word followed by a colon is what the key=value branch reads as a credential.
func TestHowToGitHubTokenPageAnswersItsOwnJourney(t *testing.T) {
	for _, query := range []string{
		"How do I set up a GitHub credential?",
		"How do I add a GitHub token?",
		"how do I add a github token",
	} {
		hits := searchHowTo(query)
		if len(hits) == 0 {
			t.Fatalf("docs.search(%q) found nothing", query)
		}
		if hits[0]["path"] != "howto/add-a-github-token.md" {
			t.Errorf("docs.search(%q) top hit = %v, want the GitHub token page", query, hits[0]["path"])
		}
		blob, err := json.Marshal(hits)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		f := scanForSecrets(chatRequest{Model: DefaultModel, Messages: []chatMessage{
			{Role: "user", Content: ptrStr(query)},
			{Role: "tool", Content: ptrStr(string(blob))},
		}})
		if f != nil {
			t.Errorf("the turn that read the GitHub token page for %q is refused: %s: %s",
				query, f.Code, f.Detail)
		}
	}
}

func ptrStr(s string) *string { return &s }
