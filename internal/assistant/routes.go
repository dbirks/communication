package assistant
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
import (
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	"encoding/json"
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	"fmt"
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	"regexp"
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	"strings"
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// Route allowlist — the app routes a link may name (docs/design/assistant-v1.md:
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// "href must be same-origin and match a route allowlist ... or the server drops
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// the link"). The list mirrors ui/src/App.tsx's <Routes> exactly — one entry
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// per real route, nothing else — so a returned href is always a page that
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// exists; anything beyond that, including every URL a model invents, is
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// dropped. routes_test.go re-derives this list from ui/src/App.tsx and fails
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// the build if the two ever drift apart.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
var allowedRoutes = []*regexp.Regexp{
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Shell pages.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/login$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/threads$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/threads/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Catch up (design 8a, ADR-0078): the reader's own pile of pieces of work.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/catch-up$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// One piece of work (design 8b): `/catch-up/{workId}`.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/catch-up/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// The assistant as a page (Assistant handoff §1): `/assistant`.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/assistant$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// The tour player (design 7b): a static segment, listed explicitly so a
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// model cannot invent `/catch-up/<anything>` and have it read as the tour.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/catch-up/tour$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Project pages (canonical /p/… form).
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/artifacts$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/runs$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/workflows$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/settings$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/threads$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Members/activity page (Projects Review design 1b); a static segment, so
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// it is listed explicitly like `runs` and `settings` rather than leaning on
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// the repository catch-all below.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/members$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/threads/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Global pages.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}/yaml$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}/used-in$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}/history$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}/drafts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Steps is a tab of the Workflows page now (redesign finding 02).
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/steps$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/steps/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/profiles$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/profiles/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/profile$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/runs/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/settings$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/settings/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/ops$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/artifacts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/approvals/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// Legacy routes the app-shell redesign still serves as redirects. They are
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// on the allowlist because routes_test.go mirrors every mounted <Route>
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// (a stale bookmark resolves instead of 404ing), but nothing the assistant
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// generates links here — see staticPalettePages below, which names only
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// destinations that render a page.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/inbox$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/board$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/steps$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/steps/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/pipelines$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/conversations$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/conversations/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/library$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/library/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/library/[A-Za-z0-9_-]{1,64}/drafts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/agents$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/agents/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/artifacts$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/runs$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/runs/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/pipelines$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/settings$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/conversations$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/conversations/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// allowedHref is declared in conversation.go over CleanRoute (ADR-0050
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// extracted the v1 validation there); this file owns the allowlist it
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// matches against.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// staticPalettePage is one top-level app-shell page in the palette's own
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// static corpus (the C1 canonical routes). The client-supplied palette index
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// is whatever the UI chose to forward — which today is nothing — and the
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// entity fan only names the caller's rows, so without this table "take me
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// to the threads" would find 0 matches for a page that exists. Synonyms live
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// in the secondary line: matching is a case-insensitive substring over the
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// whole row, so every synonym is a needle that hits. Every To must be on the
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// allowlist; add() below re-checks, so a drift cannot leak a dead link.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
//
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// Every To here is also a page that RENDERS, not a redirect (redesign
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// findings 01-03): /inbox and /board now redirect to Today, /steps redirects
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// under /workflows, and the conversations/pipelines segments redirect to
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// threads/workflows. Those legacy names survive as needles on the row that
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// took their job, so "take me to the inbox" jumps to a real page instead of a
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// URL that bounces. routes_test.go pins the set.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
var staticPalettePages = []struct {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	label     string
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	secondary string
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	to        string
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
}{
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Today", "page · home · overview · dashboard · inbox · board · attention · approvals · decisions", "/"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Catch up", "page · what agents did · unseen work · tours", "/catch-up"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Threads", "page · one-off threads · conversations", "/threads"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Workflows", "page · pipelines · workflow library", "/workflows"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Steps", "page · node templates · saved steps", "/workflows/steps"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Agents", "page · agent profiles · profiles", "/profiles"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Operations", "page · ops · workers · replicas", "/ops"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	{"Settings", "page · preferences · trust level · layout", "/settings/layout"},
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// paletteSearch is the palette's own read fan: the app-shell's own pages, the
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// caller's projects, pipelines and agent profiles plus each project's runs,
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// matched case-insensitively against the needle. Every row that survives
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// carries a "to" the allowlist already accepted, which is how a search hit
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
// becomes a jump button.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
func (t *turn) paletteSearch(needle string) (json.RawMessage, error) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	lower := strings.ToLower(needle)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	var out []map[string]any
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	seenPage := map[string]bool{}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	add := func(entry map[string]any, to string) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if entry == nil || to == "" {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			return
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if _, allowed := t.b.allowedHref(to); !allowed {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			return
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		blob, err := json.Marshal(entry)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if err != nil || !strings.Contains(strings.ToLower(string(blob)), lower) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			return
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		entry["to"] = to
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		out = append(out, entry)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// addPage is add plus one-row-per-(label, route) for the two page passes
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// (entity rows have no label, so they never go through it).
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	addPage := func(entry map[string]any, to string) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		key := strings.ToLower(entry["label"].(string)) + "\x00" + to
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if seenPage[key] {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			return
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		seenPage[key] = true
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		add(entry, to)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// The app-shell's own top-level pages first: they exist regardless of
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// what the caller's workspace contains. The client's own jump list can
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// name the same page again (a "Threads" row pointing at /threads from
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// both), so the two page passes share one seen map; the entity fan below
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// keeps its one-row-per-hit shape (every profile links at /profiles).
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, page := range staticPalettePages {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		addPage(map[string]any{"label": page.label, "secondary": page.secondary}, page.to)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	// The client-supplied index second: it is what the caller is looking at.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, e := range t.qc.Palette {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		addPage(map[string]any{"label": e.Label, "secondary": e.Secondary}, e.To)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),

	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	projects, err := t.b.store.ListProjects(t.ctx, t.caller)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if err != nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		return nil, err
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, p := range rows(projects) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		add(p, "/p/"+field(p, "id"))
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	pipelines, err := t.b.store.ListPipelines(t.ctx, t.caller)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if err != nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		return nil, err
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, p := range rows(pipelines) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		add(p, "/workflows/"+field(p, "id"))
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	profiles, err := t.b.store.ListAgentProfiles(t.ctx, t.caller)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if err != nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		return nil, err
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, p := range rows(profiles) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		add(p, "/profiles")
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	for _, p := range rows(projects) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		pid := field(p, "id")
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if pid == "" {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			continue
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		runsRaw, err := t.b.store.ListProjectRuns(t.ctx, t.caller, pid)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		if err != nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			// A project that vanished mid-fan does not void the hits already
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			// found; the caller's view simply has fewer runs in it.
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			continue
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		for _, r := range rows(runsRaw) {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
			add(r, "/runs/"+field(r, "id"))
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if len(out) > MaxItems {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		out = out[:MaxItems]
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if out == nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		out = []map[string]any{}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	marshalled, err := json.Marshal(out)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	if err != nil {
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
		return nil, fmt.Errorf("assistant: palette results cannot be serialized: %w", err)
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
	return marshalled, nil
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
}
	regexp.MustCompile(`^/workflows/collections$`),
	regexp.MustCompile(`^/workflows/collections/[A-Za-z0-9_-]{1,64}$`),
