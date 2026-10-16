package assistant

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// Route allowlist — the app routes a link may name (docs/design/assistant-v1.md:
// "href must be same-origin and match a route allowlist ... or the server drops
// the link"). The list mirrors ui/src/App.tsx's <Routes>, so a returned href is
// a page that exists; anything else — including every URL a model invents — is
// dropped. /projects/{id}/approvals is the one design-named href that has no UI
// route yet (the inbox page carries pending gates today); it is allowed because
// the brief's own example response uses it and it stays inside /projects/{id}.
var allowedRoutes = []*regexp.Regexp{
	regexp.MustCompile(`^/$`),
	regexp.MustCompile(`^/inbox$`),
	regexp.MustCompile(`^/library$`),
	regexp.MustCompile(`^/library/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/agents$`),
	regexp.MustCompile(`^/ops$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/(runs|pipelines|artifacts|settings|approvals|conversations)$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/runs/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/projects/[A-Za-z0-9_-]{1,64}/conversations/[A-Za-z0-9_-]{1,64}$`),
	regexp.MustCompile(`^/artifacts/[A-Za-z0-9_-]{1,64}$`),
}

// allowedHref accepts a same-origin app route and returns its clean form. A
// path with a scheme, a host, a query, a fragment, a backslash or a "." segment
// is refused, so no answer can carry an off-origin URL however the tool built
// it.
func (b *Broker) allowedHref(href string) (string, bool) {
	href = strings.TrimSpace(href)
	if href == "" || strings.ContainsAny(href, "?#\\@") {
		return "", false
	}
	if !strings.HasPrefix(href, "/") || strings.HasPrefix(href, "//") {
		return "", false
	}
	if u, err := url.Parse(href); err != nil || u.Host != "" || u.Scheme != "" {
		return "", false
	}
	for _, r := range allowedRoutes {
		if r.MatchString(href) {
			return path.Clean(href), true
		}
	}
	return "", false
}

// paletteSearch is the palette's own read fan: the caller's projects, pipelines
// and agent profiles plus each project's runs, matched case-insensitively
// against the needle. Every row that survives carries a "to" the allowlist
// already accepted, which is how a search hit becomes a jump button.
func (t *turn) paletteSearch(needle string) (json.RawMessage, error) {
	lower := strings.ToLower(needle)
	var out []map[string]any
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

	// The client-supplied index first: it is what the caller is looking at.
	for _, e := range t.qc.Palette {
		add(map[string]any{"label": e.Label, "secondary": e.Secondary}, e.To)
	}

	projects, err := t.b.store.ListProjects(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(projects) {
		add(p, "/projects/"+field(p, "id"))
	}
	pipelines, err := t.b.store.ListPipelines(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(pipelines) {
		add(p, "/library/"+field(p, "id"))
	}
	profiles, err := t.b.store.ListAgentProfiles(t.ctx, t.caller)
	if err != nil {
		return nil, err
	}
	for _, p := range rows(profiles) {
		add(p, "/agents")
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
			add(r, "/projects/"+pid+"/runs/"+field(r, "id"))
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
