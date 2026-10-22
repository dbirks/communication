package assistant

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Route allowlist — the app routes a link may name (docs/design/assistant-v1.md:
// "href must be same-origin and match a route allowlist ... or the server drops
// the link"). The list mirrors ui/src/App.tsx's <Routes> exactly — one entry
// per real route, nothing else — so a returned href is always a page that
// exists; anything beyond that, including every URL a model invents, is
// dropped. routes_test.go re-derives this list from ui/src/App.tsx and fails
// the build if the two ever drift apart.
var allowedRoutes = []*regexp.Regexp{
	// Shell pages.
	regexp.MustCompile(`^/login$`),
	regexp.MustCompile(`^/$`),
	regexp.MustCompile(`^/inbox$`),
	regexp.MustCompile(`^/board$`),
	regexp.MustCompile(`^/threads$`),
	regexp.MustCompile(`^/threads/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects$`),
	// Project pages (canonical /p/… form).
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/artifacts$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/runs$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/pipelines$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/settings$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/conversations$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/conversations/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/p/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$`),
	// Global pages.
	regexp.MustCompile(`^/workflows$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/workflows/[A-Za-z0-9_-]{1,64}/drafts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/steps$`),
	regexp.MustCompile(`^/steps/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/profiles$`),
	regexp.MustCompile(`^/profiles/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/runs/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/settings$`),
	regexp.MustCompile(`^/settings/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/ops$`),
	regexp.MustCompile(`^/artifacts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/approvals/[A-Za-z0-9_-]{1,64}$`),
	// Legacy routes the app-shell redesign still serves as redirects.
	regexp.MustCompile(`^/library$`),
	regexp.MustCompile(`^/library/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/library/[A-Za-z0-9_-]{1,64}/drafts/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/agents$`),
	regexp.MustCompile(`^/agents/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/artifacts$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/runs$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/runs/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/pipelines$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/settings$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/conversations$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/conversations/[A-Za-z0-9_-]{1,64}$`),
}

// allowedHref is declared in conversation.go over CleanRoute (ADR-0050
// extracted the v1 validation there); this file owns the allowlist it
// matches against.

// staticPalettePage is one top-level app-shell page in the palette's own
// static corpus (the C1 canonical routes). The client-supplied palette index
// is whatever the UI chose to forward — which today is nothing — and the
// entity fan only names the caller's rows, so without this table "take me
// to the board" would find 0 matches for a page that exists. Synonyms live
// in the secondary line: matching is a case-insensitive substring over the
// whole row, so every synonym is a needle that hits. Every To must be on the
// allowlist; add() below re-checks, so a drift cannot leak a dead link.
var staticPalettePages = []struct {
	label     string
	secondary string
	to        string
}{
	{"Home", "page · overview · dashboard", "/"},
	{"Inbox", "page · approvals · decisions · attention", "/inbox"},
	{"Board", "page · kanban · runs board", "/board"},
	{"Threads", "page · one-off conversations · threads", "/threads"},
	{"Workflows", "page · pipelines · pipeline library", "/workflows"},
	{"Steps", "page · node templates · saved steps", "/steps"},
	{"Agent profiles", "page · agents · agent profiles", "/profiles"},
	{"Operations", "page · ops · workers · replicas", "/ops"},
	{"Settings", "page · preferences · trust level · layout", "/settings/layout"},
}

// paletteSearch is the palette's own read fan: the app-shell's own pages, the
// caller's projects, pipelines and agent profiles plus each project's runs,
// matched case-insensitively against the needle. Every row that survives
// carries a "to" the allowlist already accepted, which is how a search hit
// becomes a jump button.
func (t *turn) paletteSearch(needle string) (json.RawMessage, error) {
	lower := strings.ToLower(needle)
	var out []map[string]any
	seenPage := map[string]bool{}
	add := func(entry map[string]any, to string) {
		if entry == nil || to == "" {
			return
		}
		if _, allowed := t.b.allowedHref(to); !allowed {
			return
		}
		blob, err := json.Marshal(entry)
		if err != nil || !strings.Contains(strings.ToLower(string(blob)), lower) {
			return
		}
		entry["to"] = to
		out = append(out, entry)
	}
	// addPage is add plus one-row-per-(label, route) for the two page passes
	// (entity rows have no label, so they never go through it).
	addPage := func(entry map[string]any, to string) {
		key := strings.ToLower(entry["label"].(string)) + "\x00" + to
		if seenPage[key] {
			return
		}
		seenPage[key] = true
		add(entry, to)
	}

	// The app-shell's own top-level pages first: they exist regardless of
	// what the caller's workspace contains. The client's own jump list can
	// name the same page again (an "Inbox" row pointing at /inbox from
	// both), so the two page passes share one seen map; the entity fan below
	// keeps its one-row-per-hit shape (every profile links at /profiles).
	for _, page := range staticPalettePages {
		addPage(map[string]any{"label": page.label, "secondary": page.secondary}, page.to)
	}

	// The client-supplied index second: it is what the caller is looking at.
	for _, e := range t.qc.Palette {
		addPage(map[string]any{"label": e.Label, "secondary": e.Secondary}, e.To)
	}

	projects, err := t.b.store.ListProjects(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(projects) {
		add(p, "/p/"+field(p, "id"))
	}
	pipelines, err := t.b.store.ListPipelines(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(pipelines) {
		add(p, "/workflows/"+field(p, "id"))
	}
	profiles, err := t.b.store.ListAgentProfiles(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(profiles) {
		add(p, "/profiles")
	}
	for _, p := range rows(projects) {
		pid := field(p, "id")
		if pid == "" {
			continue
		}
		runsRaw, err := t.b.store.ListProjectRuns(t.ctx, t.caller, pid)
		if err != nil {
			// A project that vanished mid-fan does not void the hits already
			// found; the caller's view simply has fewer runs in it.
			continue
		}
		for _, r := range rows(runsRaw) {
			add(r, "/runs/"+field(r, "id"))
		}
	}
	if len(out) > MaxItems {
		out = out[:MaxItems]
	}
	if out == nil {
		out = []map[string]any{}
	}
	marshalled, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("assistant: palette results cannot be serialized: %w", err)
	}
	return marshalled, nil
}
