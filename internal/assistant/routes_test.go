package assistant

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// paramRe matches a ":param" route segment in ui/src/App.tsx path attributes.
var paramRe = regexp.MustCompile(`:[A-Za-z][A-Za-z0-9]*`)

// appRouteRe extracts every path="..." attribute from the UI route table.
var appRouteRe = regexp.MustCompile(`path="([^"]*)"`)

// idSegment is the allowlist form a ":param" segment takes.
const idSegment = `[A-Za-z0-9_-]{1,64}`

// expandOptionalRoutes expands React Router's optional segment markers — a
// trailing "?" on a ":param?" or a static "seg?" segment — into every
// concrete path the pattern can match. "/threads/:id?" expands to
// "/threads/:id" and "/threads"; "/a/b?" expands to "/a/b" and "/a". With k
// optional segments there are 2^k expansions; paths without markers expand to
// themselves.
func expandOptionalRoutes(p string) []string {
	segs := strings.Split(p, "/")
	var out []string
	var walk func(i int, acc []string)
	walk = func(i int, acc []string) {
		if i == len(segs) {
			out = append(out, strings.Join(acc, "/"))
			return
		}
		s := segs[i]
		if strings.HasSuffix(s, "?") && len(s) > 1 {
			with := append(append([]string{}, acc...), s[:len(s)-1])
			without := append([]string{}, acc...)
			walk(i+1, with)
			walk(i+1, without)
			return
		}
		walk(i+1, append(append([]string{}, acc...), s))
	}
	walk(0, nil)
	return out
}

// uiRoutes reads ../../ui/src/App.tsx (relative to this package) and returns
// the regexp strings every real <Route path="..."> compiles to. The catch-all
// `path="*"` (the NotFound page) is not a page the assistant may link to and
// is skipped, as is anything that is not a single absolute path.
func uiRoutes(t *testing.T) map[string]bool {
	t.Helper()
	blob, err := os.ReadFile("../../ui/src/App.tsx")
	if err != nil {
		t.Fatalf("cannot read ui/src/App.tsx: %v", err)
	}
	routes := map[string]bool{}
	for _, m := range appRouteRe.FindAllStringSubmatch(string(blob), -1) {
		p := m[1]
		if p == "*" || !strings.HasPrefix(p, "/") || strings.Contains(p, " ") {
			continue
		}
		for _, variant := range expandOptionalRoutes(p) {
			routes["^"+paramRe.ReplaceAllString(variant, idSegment)+"$"] = true
		}
	}
	if len(routes) == 0 {
		t.Fatalf("no path=\"...\" routes found in ui/src/App.tsx; the file format changed?")
	}
	return routes
}

// TestExpandOptionalRoutes pins the optional-segment expansion the mirror
// relies on: both the optional param form (":conversationId?") and the
// optional static form ("b?") must expand to the path with and without the
// optional segment, and plain paths must pass through untouched.
func TestExpandOptionalRoutes(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"/threads/:conversationId?", []string{"/threads/:conversationId", "/threads"}},
		{"/a/b?", []string{"/a/b", "/a"}},
		{"/runs/:runId", []string{"/runs/:runId"}},
		{"/", []string{"/"}},
		{"/x/:a?/y?", []string{"/x/:a/y", "/x/:a", "/x/y", "/x"}},
	}
	for _, c := range cases {
		got := expandOptionalRoutes(c.in)
		if len(got) != len(c.want) {
			t.Errorf("expandOptionalRoutes(%q) = %q, want %q", c.in, got, c.want)
			continue
		}
		seen := map[string]bool{}
		for _, g := range got {
			seen[g] = true
		}
		for _, w := range c.want {
			if !seen[w] {
				t.Errorf("expandOptionalRoutes(%q) = %q, missing %q", c.in, got, w)
			}
		}
	}
}

// TestAllowedRoutesMirrorUIRoutes fails the build when the link allowlist and
// the UI's route table drift: a new UI route the assistant could not link to,
// or a dead allowlist entry pointing at a page that no longer exists.
func TestAllowedRoutesMirrorUIRoutes(t *testing.T) {
	want := uiRoutes(t)
	have := map[string]bool{}
	for _, r := range allowedRoutes {
		have[r.String()] = true
	}
	var missing, extra []string
	for p := range want {
		if !have[p] {
			missing = append(missing, p)
		}
	}
	for p := range have {
		if !want[p] {
			extra = append(extra, p)
		}
	}
	if len(missing) > 0 || len(extra) > 0 {
		t.Errorf("allowedRoutes does not mirror ui/src/App.tsx:\n%s",
			joinDiff("ui route with no allowlist entry", missing)+joinDiff("allowlist entry with no ui route", extra))
	}
}

func joinDiff(what string, items []string) string {
	if len(items) == 0 {
		return ""
	}
	return "\t" + what + ": " + strings.Join(items, " ") + "\n"
}

// TestStaticPalettePagesAreRealRoutes fails the build if the palette's static
// page corpus (routes.go's staticPalettePages) names a route the UI does not
// mount: a search hit that jumps nowhere is worse than a 0-match answer. It
// also pins the corpus to the pages that RENDER (redesign findings 01-03): the
// retired /inbox, /board and bare /steps addresses are redirect-only now, so
// they must not be proposed as destinations even though the allowlist still
// mirrors them.
func TestStaticPalettePagesAreRealRoutes(t *testing.T) {
	want := map[string]bool{
		"/": true, "/catch-up": true, "/threads": true, "/workflows": true, "/workflows/steps": true,
		"/profiles": true, "/ops": true, "/settings/layout": true,
	}
	have := map[string]bool{}
	for _, page := range staticPalettePages {
		have[page.to] = true
	}
	b := (*Broker)(nil)
	for to := range want {
		if !have[to] {
			t.Errorf("static palette corpus is missing the %s page", to)
			continue
		}
		if _, ok := b.allowedHref(to); !ok {
			t.Errorf("static palette page %s is not on the route allowlist", to)
		}
	}
	for to := range have {
		if !want[to] {
			t.Errorf("static palette page %s is not a canonical app-shell page", to)
		}
	}
}

// TestApprovalLinkIsARealPage pins the approval.pending link behavior: a gate
// inside a run points at that run's page, and a gate without a run falls back
// to Today — both pages the UI actually renders. (It used to fall back to
// /inbox, which is a redirect since redesign finding 03.)
func TestApprovalLinkIsARealPage(t *testing.T) {
	tl := toolRegistry()["approval.pending"]
	if tl.links == nil {
		t.Fatal("approval.pending has no link builder")
	}

	withRun := tl.links(nil, nil, []map[string]any{
		{"id": "gate-1", "project_id": "p1", "run_id": "r1", "state": "pending"},
	})
	if len(withRun) != 1 || withRun[0].Href != "/runs/r1" {
		t.Fatalf("gate with run_id should link to the run page, got %#v", withRun)
	}

	withoutRun := tl.links(nil, nil, []map[string]any{
		{"id": "gate-2", "project_id": "p1", "state": "pending"},
	})
	if len(withoutRun) != 1 || withoutRun[0].Href != "/" {
		t.Fatalf("gate without run_id should link to Today, got %#v", withoutRun)
	}

	// And the old approvals href must not survive as a linkable route; the
	// legacy run redirect and the legacy inbox are still real routes the
	// allowlist must mirror.
	b := (*Broker)(nil)
	if _, ok := b.allowedHref("/projects/p1/approvals"); ok {
		t.Fatal("/projects/{id}/approvals has no UI route and must be dropped")
	}
	if _, ok := b.allowedHref("/runs/r1"); !ok {
		t.Fatal("/runs/{run_id} is a real UI route and must be allowed")
	}
	if _, ok := b.allowedHref("/projects/p1/runs/r1"); !ok {
		t.Fatal("/projects/{id}/runs/{run_id} is a live redirect route and must be allowed")
	}
	if _, ok := b.allowedHref("/inbox"); !ok {
		t.Fatal("/inbox is a live redirect route and must be allowed")
	}
}
