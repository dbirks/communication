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
		routes["^"+paramRe.ReplaceAllString(p, idSegment)+"$"] = true
	}
	if len(routes) == 0 {
		t.Fatalf("no path=\"...\" routes found in ui/src/App.tsx; the file format changed?")
	}
	return routes
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

// TestApprovalLinkIsARealPage pins the approval.pending link behavior: a gate
// inside a run points at that run's page, and a gate without a run falls back
// to the inbox — both pages the UI actually renders.
func TestApprovalLinkIsARealPage(t *testing.T) {
	tl := toolRegistry()["approval.pending"]
	if tl.links == nil {
		t.Fatal("approval.pending has no link builder")
	}

	withRun := tl.links(nil, nil, []map[string]any{
		{"id": "gate-1", "project_id": "p1", "run_id": "r1", "state": "pending"},
	})
	if len(withRun) != 1 || withRun[0].Href != "/projects/p1/runs/r1" {
		t.Fatalf("gate with run_id should link to the run page, got %#v", withRun)
	}

	withoutRun := tl.links(nil, nil, []map[string]any{
		{"id": "gate-2", "project_id": "p1", "state": "pending"},
	})
	if len(withoutRun) != 1 || withoutRun[0].Href != "/inbox" {
		t.Fatalf("gate without run_id should link to the inbox, got %#v", withoutRun)
	}

	// And the old approvals href must not survive as a linkable route.
	b := (*Broker)(nil)
	if _, ok := b.allowedHref("/projects/p1/approvals"); ok {
		t.Fatal("/projects/{id}/approvals has no UI route and must be dropped")
	}
	if _, ok := b.allowedHref("/projects/p1/runs/r1"); !ok {
		t.Fatal("/projects/{id}/runs/{run_id} is a real UI route and must be allowed")
	}
}
