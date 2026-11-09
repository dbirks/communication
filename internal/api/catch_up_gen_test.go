package api

// The catch-up generator's HTTP-side pieces (ADR-0078): the deterministic
// tour page — unseen stops collected across the caller's items, ranked by
// the tour's shared importance and the work's recency, paged 4 at a time —
// and the lazy generator trigger fired from the visit stamp AFTER the answer
// is written — never from the items list, which the sidebar badge reads on
// every page (ADR-0078 § Migration, Trigger note). Plus the pure
// ref-harvesting the DATA block depends on: refs
// are read off the run's own outputs, which is what makes an invented PR
// number unrepresentable rather than merely filtered.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// tourStore serves per-item views keyed by id on top of the shared fake.
type tourStore struct {
	*fakeCatchUp
	byID    map[string]CatchUpItemView
	queried []string
}

func (f *tourStore) GetCatchUpItem(ctx context.Context, c Caller, itemID string) (CatchUpItemView, error) {
	f.queried = append(f.queried, itemID)
	if view, ok := f.byID[itemID]; ok {
		return view, nil
	}
	return CatchUpItemView{}, ErrCatchUpNotFound
}

func cuItem(id, updatedImportance string, unseen int, updated time.Time, stops ...CatchUpStopView) CatchUpListItemView {
	return CatchUpListItemView{
		ID: id, Project: cuChip(), Shape: "pr", Title: "Item " + id,
		Summary: "summary", Resolution: "open", Importance: updatedImportance,
		UnseenStops: unseen, TotalStops: len(stops), UpdatedAt: updated,
		CreatedAt: updated,
	}
}

func cuItemView(id string, stops ...CatchUpStopView) CatchUpItemView {
	return CatchUpItemView{
		ID: id, Project: cuChip(), Shape: "pr", Title: "Item " + id,
		Summary: "s", Resolution: "open",
		Refs: CatchUpRefsView{
			PullRequests: []CatchUpNumberedRef{{Number: 7}},
			RunIDs:       []string{cuItemID},
		},
		Latest: &CatchUpTourView{Version: 1, Reason: "first",
			CreatedAt: time.Now().UTC(), Stops: stops},
		History: []CatchUpTourHeaderView{{Version: 1, StopCount: len(stops)}},
	}
}

func cuStop(id, importance string, seen bool, evidence ...map[string]any) CatchUpStopView {
	return CatchUpStopView{
		ID: id, Title: "beat " + id, Narrative: "narrative " + id,
		Importance: importance, AddedInVersion: 1, Seen: seen, Evidence: evidence,
	}
}

func logEv() map[string]any { return map[string]any{"type": "log", "text": "the log line"} }
func fileEv() map[string]any {
	return map[string]any{"type": "files", "text": "branch comm/x"}
}

func TestCatchUpTourPagesFourByRankAndReadsMinutes(t *testing.T) {
	t.Parallel()
	newer := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	older := newer.Add(-3 * time.Hour)
	store := &tourStore{fakeCatchUp: &fakeCatchUp{list: CatchUpItemList{
		Items: []CatchUpListItemView{
			cuItem(cuItemID, "must_know", 2, newer),
			cuItem(cuOtherID, "worth_a_look", 2, older),
		},
		TotalUnseen: 2,
	}}, byID: map[string]CatchUpItemView{
		cuItemID: cuItemView(cuItemID,
			cuStop("s1", "must_know", false, logEv()),
			cuStop("s2", "routine", false)),
		cuOtherID: cuItemView(cuOtherID,
			cuStop("s3", "worth_a_look", false),
			cuStop("s4", "routine", false, fileEv()),
			cuStop("s-read", "must_know", true)), // seen: never owed
	}}
	srv := cuServer(t, store, nil)

	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/tour")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	stops, _ := body["stops"].([]any)
	if len(stops) != 4 {
		t.Fatalf("stops = %v, want the whole page of 4", body["stops"])
	}
	wantOrder := []string{"s1", "s3", "s2", "s4"}
	for i, want := range wantOrder {
		got := stops[i].(map[string]any)["stop"].(map[string]any)["id"]
		if got != want {
			t.Fatalf("stop %d = %v, want %v (rank then recency)", i, got, want)
		}
	}
	for _, field := range []string{"work_item_id", "stop", "project", "refs", "minutes"} {
		if _, ok := stops[0].(map[string]any)[field]; !ok {
			t.Errorf("tour stop is missing %q: %v", field, stops[0])
		}
	}
	// Minutes: the beat with log evidence costs 2, a bare beat and a
	// files-evidence beat cost 1 each.
	if body["minutes_total"] != float64(5) {
		t.Errorf("minutes_total = %v, want 5", body["minutes_total"])
	}
	if body["total_unseen_stops"] != float64(4) {
		t.Errorf("total_unseen_stops = %v, want 4", body["total_unseen_stops"])
	}
	if body["more_available"] != false {
		t.Errorf("more_available = %v, want false on the last page", body["more_available"])
	}
	if body["built_from"] != float64(2) {
		t.Errorf("built_from = %v, want 2 items", body["built_from"])
	}
}

// The design's catch-up tour is a SUMMARY: one condensed stop per piece of
// work before any piece gets a second one. A four-beat bug story may not fill
// page 1 and push the piece that waits on your call down the list.
func TestCatchUpTourTakesOneStopPerPieceBeforeAnySecond(t *testing.T) {
	t.Parallel()
	bug := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	pr := bug.Add(-20 * time.Minute)
	push := bug.Add(-90 * time.Minute)
	asks := func(id, importance string) CatchUpStopView {
		st := cuStop(id, importance, false)
		st.Decision = &CatchUpDecisionView{Prompt: "Ship it?", Options: []string{"yes", "no"}}
		return st
	}
	store := &tourStore{fakeCatchUp: &fakeCatchUp{list: CatchUpItemList{
		Items: []CatchUpListItemView{
			cuItem("i-bug", "must_know", 4, bug),
			cuItem("i-pr", "worth_a_look", 2, pr),
			cuItem("i-push", "routine", 1, push),
		},
		TotalUnseen: 3,
	}}, byID: map[string]CatchUpItemView{
		// The bug piece's beats come back in the order the tour tells them.
		"i-bug": cuItemView("i-bug",
			cuStop("b1", "must_know", false), cuStop("b2", "must_know", false),
			cuStop("b3", "worth_a_look", false), cuStop("b4", "routine", false)),
		// Ties inside one piece go to the beat that asks a decision.
		"i-pr": cuItemView("i-pr",
			cuStop("p-old", "worth_a_look", false), asks("p-ask", "worth_a_look")),
		"i-push": cuItemView("i-push", cuStop("u1", "routine", false)),
	}}
	srv := cuServer(t, store, nil)

	ids := func(want int, query string) []string {
		t.Helper()
		body := decodeBody(t, cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?"+query))
		stops, _ := body["stops"].([]any)
		out := make([]string, 0, len(stops))
		for _, s := range stops {
			out = append(out, s.(map[string]any)["stop"].(map[string]any)["id"].(string))
		}
		if len(out) != want {
			t.Fatalf("%s: stops = %v, want %d", query, out, want)
		}
		return out
	}
	// One stop from each piece first (bug, pr, push), then the bug's next beat.
	page1 := decodeBody(t, cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?offset=0&limit=4"))
	stops1, _ := page1["stops"].([]any)
	got1 := make([]string, 0, len(stops1))
	for _, s := range stops1 {
		got1 = append(got1, s.(map[string]any)["stop"].(map[string]any)["id"].(string))
	}
	want1 := []string{"b1", "p-ask", "u1", "b2"}
	if !equalCatchUpStopIDs(got1, want1) {
		t.Fatalf("page 1 = %v, want %v", got1, want1)
	}
	if page1["built_from"] != float64(3) {
		t.Errorf("built_from = %v, want the 3 pieces this page condensed", page1["built_from"])
	}
	if page1["total_unseen_stops"] != float64(7) {
		t.Errorf("total_unseen_stops = %v, want all 7 owed beats", page1["total_unseen_stops"])
	}
	// The rest keeps going round-robin: pr's second beat, then the bug's third.
	if got, want := ids(3, "offset=4&limit=4"), []string{"p-old", "b3", "b4"}; !equalCatchUpStopIDs(got, want) {
		t.Fatalf("page 2 = %v, want %v", got, want)
	}
	if rest := decodeBody(t, cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?offset=4&limit=4")); rest["built_from"] != float64(2) {
		t.Errorf("page 2 built_from = %v, want 2 pieces", rest["built_from"])
	}
}

func equalCatchUpStopIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestCatchUpTourOffsetIsSeeMore(t *testing.T) {
	t.Parallel()
	newer := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	store := &tourStore{fakeCatchUp: &fakeCatchUp{list: CatchUpItemList{
		Items:       []CatchUpListItemView{cuItem(cuItemID, "must_know", 3, newer)},
		TotalUnseen: 1,
	}}, byID: map[string]CatchUpItemView{cuItemID: cuItemView(cuItemID,
		cuStop("s1", "must_know", false),
		cuStop("s2", "worth_a_look", false),
		cuStop("s3", "routine", false))}}
	srv := cuServer(t, store, nil)

	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?limit=2&offset=0")
	body := decodeBody(t, rec)
	first, _ := body["stops"].([]any)
	if len(first) != 2 || first[0].(map[string]any)["stop"].(map[string]any)["id"] != "s1" {
		t.Fatalf("page 1 = %v", body["stops"])
	}
	if body["more_available"] != true {
		t.Errorf("more_available = %v, want true with one beat left", body["more_available"])
	}

	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?limit=2&offset=2")
	body = decodeBody(t, rec)
	second, _ := body["stops"].([]any)
	if len(second) != 1 || second[0].(map[string]any)["stop"].(map[string]any)["id"] != "s3" {
		t.Fatalf("page 2 = %v, want only s3", body["stops"])
	}
	if body["more_available"] != false {
		t.Errorf("more_available = %v, want false past the backlog", body["more_available"])
	}
	if body["built_from"] != float64(1) {
		t.Errorf("built_from = %v, want 1", body["built_from"])
	}
}

func TestCatchUpTourEmptyIsAnArray(t *testing.T) {
	t.Parallel()
	store := &tourStore{fakeCatchUp: &fakeCatchUp{list: CatchUpItemList{
		TotalUnseen: 0,
	}}, byID: map[string]CatchUpItemView{}}
	srv := cuServer(t, store, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/tour")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := decodeBody(t, rec)
	stops, ok := body["stops"].([]any)
	if !ok || len(stops) != 0 {
		t.Fatalf("empty tour stops = %v, want []", body["stops"])
	}
	if body["total_unseen_stops"] != float64(0) || body["more_available"] != false {
		t.Errorf("empty page totals = %v", body)
	}
}

func TestCatchUpTourRefusesBadPages(t *testing.T) {
	t.Parallel()
	store := &tourStore{fakeCatchUp: &fakeCatchUp{}}
	srv := cuServer(t, store, nil)
	for _, q := range []string{"offset=-1", "offset=201", "offset=soon",
		"limit=0", "limit=9", "limit=4.5", "projects=not-a-uuid"} {
		rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/tour?"+q)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422 (%s)", q, rec.Code, rec.Body)
		}
	}
}

func TestCatchUpTourSkipsItemsTheListNoLongerOwns(t *testing.T) {
	t.Parallel()
	newer := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	store := &tourStore{fakeCatchUp: &fakeCatchUp{list: CatchUpItemList{
		Items: []CatchUpListItemView{
			cuItem(cuItemID, "must_know", 1, newer),
			cuItem(cuOtherID, "must_know", 1, newer),
		},
	}}, byID: map[string]CatchUpItemView{cuItemID: cuItemView(cuItemID,
		cuStop("s1", "must_know", false))}}
	srv := cuServer(t, store, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/tour")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if stops, _ := body["stops"].([]any); len(stops) != 1 {
		t.Fatalf("stops = %v, want the surviving item only", body["stops"])
	}
}

// --- the generator trigger ------------------------------------------------

type catchUpTriggerSpy struct {
	calls    int
	projects []string
	caller   Caller
}

func (g *catchUpTriggerSpy) CatchUpVisitRecorded(_ context.Context, c Caller, projects []string) {
	g.calls++
	g.projects = projects
	g.caller = c
}

func cuServerWithGen(t *testing.T, store CatchUpStore, gen CatchUpGeneratorTrigger) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterCatchUp(s, store, nil, WithTourGenerator(gen))
	return s
}

// The list read is PURE now (ADR-0078 § Migration, Trigger note): the sidebar
// badge calls it on every page of the app, so a list trigger spent a model
// call per page load and the lab's rate-limited gateway 429'd the assistant
// and the agents. The route still answers; it just never schedules a pass.
func TestCatchUpListRouteDoesNotFireTheGenerator(t *testing.T) {
	t.Parallel()
	spy := &catchUpTriggerSpy{}
	store := &fakeCatchUp{list: CatchUpItemList{
		Items:       []CatchUpListItemView{cuItem(cuItemID, "must_know", 1, time.Now().UTC())},
		TotalUnseen: 1,
	}}
	srv := cuServerWithGen(t, store, spy)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items?projects="+cuProjectID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if spy.calls != 0 {
		t.Fatalf("trigger calls = %d, want 0: the list read must not schedule generation", spy.calls)
	}
}

// The visit stamp is the one catch-up route that schedules a pass: a visit
// says a human opened the page and is waiting for tours.
func TestCatchUpVisitRouteFiresTheGeneratorAfterAnswering(t *testing.T) {
	t.Parallel()
	spy := &catchUpTriggerSpy{}
	store := &fakeCatchUp{}
	srv := cuServerWithGen(t, store, spy)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/visits", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if spy.calls != 1 {
		t.Fatalf("trigger calls = %d, want 1 after a visit", spy.calls)
	}
	if len(spy.projects) != 0 {
		t.Errorf("trigger projects = %v, want none: a visit carries no scope", spy.projects)
	}
	if spy.caller.UserID != testPrincipal().UserID {
		t.Errorf("trigger caller = %+v, want the session principal", spy.caller)
	}
	// A refused visit is not a visit: the trigger fires only after the stamp.
	store.visitErr = errors.New("the pool is on fire")
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/visits", nil)
	if rec.Code == http.StatusNoContent {
		t.Fatal("a failing visit stamp answered 204")
	}
	if spy.calls != 1 {
		t.Fatalf("trigger calls = %d, want still 1: a refused visit schedules nothing", spy.calls)
	}
}

func TestCatchUpListWithoutATriggerIsThePureRead(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{list: CatchUpItemList{}}
	srv := cuServerWithGen(t, store, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items")
	if rec.Code != http.StatusOK {
		t.Fatalf("a nil trigger must not change the route's answer: %d", rec.Code)
	}
}

func TestBuildCatchUpGeneratorNeedsAModelAndEveryRead(t *testing.T) {
	t.Parallel()
	configured, err := assistant.NewTextOnly(assistant.Config{BaseURL: "http://127.0.0.1:1/v1"})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}
	full := CatchUpGenDeps{
		Broker:    configured,
		CatchUp:   &fakeCatchUpGenStore{},
		Runs:      &fakeCatchUpRuns{},
		Pipelines: &fakeCatchUpPipelines{},
		Chats:     &fakeCatchUpChats{},
	}
	if BuildCatchUpGenerator(full) == nil {
		t.Fatal("fully wired deps built no generator")
	}
	// A broker with no endpoint configured behaves as the egress triple's
	// absence: BuildAssistantBroker returns nil there, and the catch-up
	// builder must answer nil too — never a stub narrative.
	noEgress := full
	noEgress.Broker = nil
	if BuildCatchUpGenerator(noEgress) != nil {
		t.Error("no broker must mean no generator")
	}
	for name, drop := range map[string]func(*CatchUpGenDeps){
		"store":     func(d *CatchUpGenDeps) { d.CatchUp = nil },
		"runs":      func(d *CatchUpGenDeps) { d.Runs = nil },
		"pipelines": func(d *CatchUpGenDeps) { d.Pipelines = nil },
		"chats":     func(d *CatchUpGenDeps) { d.Chats = nil },
	} {
		broken := full
		drop(&broken)
		if BuildCatchUpGenerator(broken) != nil {
			t.Errorf("missing %s must mean no generator", name)
		}
	}
}

// --- the grouping key the reader derives (ADR-0078 § Grouping) -------------

// scriptedRuns is the run reader with a run to name: the DATA block's refs and
// the grouping key BOTH come off this one read, which is why they cannot
// disagree.
type scriptedRuns struct {
	run   RunView
	nodes []NodeExecutionView
}

func (f *scriptedRuns) GetRun(context.Context, Caller, string) (RunView, error) {
	return f.run, nil
}
func (f *scriptedRuns) ListRunNodes(context.Context, Caller, string) ([]NodeExecutionView, error) {
	return f.nodes, nil
}

func catchUpReaderFor(runs *scriptedRuns) *catchUpGenReader {
	return &catchUpGenReader{
		store: &fakeCatchUpGenStore{}, runs: runs,
		pipelines: &fakeCatchUpPipelines{}, chats: &fakeCatchUpChats{},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// The issue-trigger input names the issue, so an issue-to-pr run belongs to
// the ISSUE: that is the piece of work, with the PR it opened nested under it.
func TestCatchUpRunFactsGroupsByIssueThenPRThenRun(t *testing.T) {
	t.Parallel()
	repo := "repo-1"
	issueRun := &scriptedRuns{
		run: RunView{
			RunSummaryView: RunSummaryView{Status: "completed", RepositoryID: &repo},
			Inputs:         []RunInputValueView{{Name: "issue_number", Value: json.RawMessage("42")}},
		},
		nodes: []NodeExecutionView{{NodeInstanceKey: "open_pr", Status: "succeeded",
			Outputs: json.RawMessage(`{"pr_number":7,"branch":"comm/issue-42-x"}`)}},
	}
	facts, err := catchUpReaderFor(issueRun).RunFacts(context.Background(),
		assistant.Caller{UserID: "u1"}, "run-1")
	if err != nil {
		t.Fatalf("RunFacts: %v", err)
	}
	if facts.RepositoryID != repo || facts.IssueNumber != 42 || facts.PRNumber != 7 {
		t.Fatalf("facts = %+v, want the repository, the issue and the PR", facts)
	}
	if facts.GroupKey != "issue:repo-1:42" {
		t.Fatalf("group key = %q, want the issue's piece of work", facts.GroupKey)
	}

	// A run with no issue input but a PR output IS the PR's piece of work.
	prRun := &scriptedRuns{
		run: RunView{RunSummaryView: RunSummaryView{Status: "completed", RepositoryID: &repo}},
		nodes: []NodeExecutionView{{NodeInstanceKey: "push", Status: "succeeded",
			Outputs: json.RawMessage(`{"pr_url":"https://github.com/acme/web/pull/9"}`)}},
	}
	facts, err = catchUpReaderFor(prRun).RunFacts(context.Background(),
		assistant.Caller{UserID: "u1"}, "run-2")
	if err != nil {
		t.Fatalf("RunFacts (pr): %v", err)
	}
	if facts.GroupKey != "pr:repo-1:9" {
		t.Fatalf("group key = %q, want the PR's piece of work", facts.GroupKey)
	}

	// A run that names no number in no repository is its own piece of work —
	// grouped by the run, exactly as the store keyed it before grouping.
	alone := &scriptedRuns{run: RunView{RunSummaryView: RunSummaryView{Status: "failed"}}}
	facts, err = catchUpReaderFor(alone).RunFacts(context.Background(),
		assistant.Caller{UserID: "u1"}, "run-3")
	if err != nil {
		t.Fatalf("RunFacts (alone): %v", err)
	}
	if facts.GroupKey != "run:run-3" {
		t.Fatalf("group key = %q, want the run itself", facts.GroupKey)
	}
}

// The write path carries the key to the store's conflict target and the run id
// to the tour append, where the run is CLAIMED: appending a version is what
// stops a run being owed a story.
func TestCatchUpWriterCarriesTheGroupKeyAndClaimsTheRun(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUpGenStore{itemID: "item-9"}
	w := &catchUpGenWriter{store: store}
	tour := assistant.CatchUpTourWrite{
		ProjectID: "p1", RunID: "run-2", ExistingID: "item-9",
		GroupKey: "issue:repo-1:42", Shape: "issue", Title: "Issue 42",
		Summary: "Checkout is green.", Resolution: "merged", Reason: "Fix landed.",
		Refs:  assistant.CatchUpRefsDraft{IssueNumbers: []int{42}, PRNumbers: []int{7}},
		Stops: []assistant.CatchUpStopDraft{{ID: "fix", Title: "Fix", Narrative: "N.", Importance: "must_know"}},
	}
	if err := w.WriteCatchUpTour(context.Background(), assistant.Caller{UserID: "u1"}, tour); err != nil {
		t.Fatalf("WriteCatchUpTour: %v", err)
	}
	item, stops := store.snapshot()
	if item.ID != "item-9" || item.GroupKey != "issue:repo-1:42" || item.SourceRunID != "run-2" {
		t.Fatalf("upsert = %+v, want the grouped item revised by its newest run", item)
	}
	if len(stops) != 1 || stops[0].ID != "fix" {
		t.Fatalf("stops = %+v, want the one beat appended", stops)
	}
}

// --- ref harvesting --------------------------------------------------------

func TestCatchUpHarvestOutputsReadsOnlyTheRunsOwnClaims(t *testing.T) {
	t.Parallel()
	facts := assistant.CatchUpRunFacts{}
	out := json.RawMessage(`{
		"branch":"comm/issue-42-checkout",
		"pr_url":"https://github.com/acme/web/pull/7",
		"issue_number":42,
		"commits":["0123456789abcdef0123456789abcdef01234567"],
		"notes":"just prose"
	}`)
	catchUpHarvestOutputs(out, &facts)
	if facts.Branch != "comm/issue-42-checkout" {
		t.Errorf("branch = %q", facts.Branch)
	}
	if facts.PRNumber != 7 || facts.PRURL == "" {
		t.Errorf("pr = %d %q, want 7 off the url tail", facts.PRNumber, facts.PRURL)
	}
	if facts.IssueNumber != 42 {
		t.Errorf("issue = %d, want 42", facts.IssueNumber)
	}
	if len(facts.Commits) != 1 {
		t.Errorf("commits = %v", facts.Commits)
	}
	// Nested one level (the report node wraps its claims):
	nested := json.RawMessage(`{"report":{"pull_request_number":9,"head_sha":"abcdef1234567890abcdef1234567890abcdef12"}}`)
	catchUpHarvestOutputs(nested, &facts)
	if facts.PRNumber != 7 {
		t.Errorf("a second harvest overwrote the first PR: %d", facts.PRNumber)
	}
	if facts.Branch != "comm/issue-42-checkout" {
		t.Errorf("a second harvest dropped the branch")
	}
	// Junk never fabricates a ref.
	catchUpHarvestOutputs(json.RawMessage(`{"pr_number":"seven"}`), &facts)
	catchUpHarvestOutputs(json.RawMessage(`not json`), &facts)
	if facts.PRNumber != 7 || facts.IssueNumber != 42 {
		t.Fatalf("junk outputs moved the refs: %+v", facts)
	}
}

func TestCatchUpStopMinutesCountsReadableEvidence(t *testing.T) {
	t.Parallel()
	if got := catchUpStopMinutes(cuStop("a", "routine", false, logEv())); got != 2 {
		t.Errorf("log evidence minutes = %d, want 2", got)
	}
	if got := catchUpStopMinutes(cuStop("a", "routine", false, map[string]any{"type": "diff"})); got != 2 {
		t.Errorf("diff evidence minutes = %d, want 2", got)
	}
	if got := catchUpStopMinutes(cuStop("a", "routine", false, fileEv())); got != 1 {
		t.Errorf("files evidence minutes = %d, want 1", got)
	}
	if got := catchUpStopMinutes(cuStop("a", "routine", false)); got != 1 {
		t.Errorf("bare beat minutes = %d, want 1", got)
	}
}

// --- fakes for the generator's store/reads ---------------------------------

// fakeCatchUpGenStore records what the generator's write path asked the store
// to do, and serves the one grouped item its read path looks up.
type fakeCatchUpGenStore struct {
	mu          sync.Mutex
	group       CatchUpGroupView
	found       bool
	item        CatchUpWorkItemWrite
	runs        []string
	appended    []CatchUpStopWrite
	itemID      string
	sweep       []CatchUpSweepCandidateView
	sweepErr    error
	sweepWindow time.Duration
	sweepLimit  int
	toured      map[string]bool
}

func (f *fakeCatchUpGenStore) CatchUpCandidates(context.Context, Caller, []string,
	time.Duration, int) ([]CatchUpCandidateView, error) {
	return nil, nil
}
func (f *fakeCatchUpGenStore) CatchUpSweepCandidates(_ context.Context,
	window time.Duration, limit int) ([]CatchUpSweepCandidateView, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sweepWindow, f.sweepLimit = window, limit
	return f.sweep, f.sweepErr
}
func (f *fakeCatchUpGenStore) CatchUpRunAlreadyToured(_ context.Context,
	runID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.toured[runID], nil
}
func (f *fakeCatchUpGenStore) CatchUpItemForGroup(_ context.Context, _ Caller,
	_, groupKey string) (CatchUpGroupView, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.found || f.group.ItemID == "" {
		return CatchUpGroupView{}, false, nil
	}
	return f.group, true, nil
}
func (f *fakeCatchUpGenStore) UpsertCatchUpWorkItem(_ context.Context, _ Caller,
	in CatchUpWorkItemWrite) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.item = in
	if f.itemID == "" {
		f.itemID = "item-new"
	}
	return f.itemID, nil
}
func (f *fakeCatchUpGenStore) AppendCatchUpTour(_ context.Context, _ Caller,
	itemID, runID, reason string, stops []CatchUpStopWrite) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if itemID != f.itemID || runID == "" || reason == "" {
		return fmt.Errorf("appended %d stops to %s/%s with reason %q",
			len(stops), itemID, runID, reason)
	}
	f.appended = append(f.appended, stops...)
	return nil
}

func (f *fakeCatchUpGenStore) snapshot() (CatchUpWorkItemWrite, []CatchUpStopWrite) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.item, append([]CatchUpStopWrite(nil), f.appended...)
}

type fakeCatchUpRuns struct{}

func (f *fakeCatchUpRuns) GetRun(context.Context, Caller, string) (RunView, error) {
	return RunView{}, nil
}
func (f *fakeCatchUpRuns) ListRunNodes(context.Context, Caller, string) ([]NodeExecutionView, error) {
	return nil, nil
}

type fakeCatchUpPipelines struct{}

func (f *fakeCatchUpPipelines) ListPipelines(context.Context, Caller) ([]PipelineSummaryView, error) {
	return nil, nil
}

type fakeCatchUpChats struct{}

func (f *fakeCatchUpChats) ReadChatTranscript(context.Context, assistant.Caller,
	string) (assistant.ChatTranscript, error) {
	return assistant.ChatTranscript{}, nil
}

// --- the completion sweep's reader face (ADR-0078 § Trigger) -------------

// The sweep read hands each candidate the attributed human it is generated
// as; the reader must carry that caller across the boundary whole (user,
// organization, admin flag) or the pass would run as the wrong person — or,
// worse, as nobody.
func TestCatchUpSweepReaderCarriesTheAttributedCaller(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUpGenStore{sweep: []CatchUpSweepCandidateView{{
		Candidate: CatchUpCandidateView{
			RunID: "run-9", ProjectID: "proj-1", TourHead: 2,
			HeadStops: []CatchUpHeadStopView{{ID: "s1", Title: "Beat", AddedInVersion: 1}},
		},
		Caller: Caller{UserID: "u-author", OrganizationID: "o-1", IsOrgAdmin: true},
	}}}
	r := &catchUpGenReader{store: store, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	cands, err := r.SweepCandidates(context.Background())
	if err != nil {
		t.Fatalf("SweepCandidates: %v", err)
	}
	if len(cands) != 1 {
		t.Fatalf("candidates = %d, want 1", len(cands))
	}
	got := cands[0]
	if got.Caller.UserID != "u-author" || got.Caller.OrganizationID != "o-1" || !got.Caller.IsOrgAdmin {
		t.Fatalf("caller = %+v, want the store's attributed human whole", got.Caller)
	}
	if got.Candidate.RunID != "run-9" || got.Candidate.TourHead != 2 ||
		len(got.Candidate.HeadStops) != 1 || got.Candidate.HeadStops[0].ID != "s1" {
		t.Fatalf("candidate = %+v, want the head the rewrite must inherit", got.Candidate)
	}
	if store.sweepWindow != assistant.CatchUpGenWindow ||
		store.sweepLimit != 4*assistant.CatchUpGenMaxPerPass {
		t.Fatalf("sweep read used window=%s limit=%d, want the generator's own numbers",
			store.sweepWindow, store.sweepLimit)
	}
}

// RunAlreadyToured is the two-replica idempotency question; the reader answers
// it from the claim table without a caller (the answer is a bool about a run
// the asking side already proved visible).
func TestCatchUpSweepReaderAnswersTheClaimQuestion(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUpGenStore{toured: map[string]bool{"told": true}}
	r := &catchUpGenReader{store: store, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if ok, err := r.RunAlreadyToured(context.Background(), "told"); err != nil || !ok {
		t.Fatalf("RunAlreadyToured(told) = %v, %v; want true", ok, err)
	}
	if ok, err := r.RunAlreadyToured(context.Background(), "untold"); err != nil || ok {
		t.Fatalf("RunAlreadyToured(untold) = %v, %v; want false", ok, err)
	}
}

// The grouped item read carries the failure fact the bug story is keyed on: a
// prior failed run in the group is the store's sentence, not the model's.
func TestCatchUpExistingItemCarriesThePriorFailure(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUpGenStore{
		found: true,
		group: CatchUpGroupView{ItemID: "item-9", TourHead: 1, PriorRunFailed: true},
	}
	r := &catchUpGenReader{store: store, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	item, err := r.ExistingItem(context.Background(), assistant.Caller{UserID: "u1"},
		"proj-1", "issue:repo-1:42")
	if err != nil {
		t.Fatalf("ExistingItem: %v", err)
	}
	if !item.PriorRunFailed || item.ItemID != "item-9" {
		t.Fatalf("item = %+v, want the prior-failure fact carried", item)
	}
}

// The store's sweep read is newest-finished-first (its ORDER BY is pinned in
// internal/store/postgres), and the generator's pass spends its budget in
// list order — so the reader must hand the candidates over in exactly the
// order the store returned them. A just-finished run that loses its place on
// the way across the boundary is a run stuck behind the backlog.
func TestCatchUpSweepReaderKeepsNewestFirstOrder(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUpGenStore{sweep: []CatchUpSweepCandidateView{
		{Candidate: CatchUpCandidateView{RunID: "newest", ProjectID: "p1"}},
		{Candidate: CatchUpCandidateView{RunID: "middle", ProjectID: "p1"}},
		{Candidate: CatchUpCandidateView{RunID: "oldest", ProjectID: "p1"}},
	}}
	r := &catchUpGenReader{store: store, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	cands, err := r.SweepCandidates(context.Background())
	if err != nil {
		t.Fatalf("SweepCandidates: %v", err)
	}
	if len(cands) != 3 {
		t.Fatalf("candidates = %d, want 3", len(cands))
	}
	for i, want := range []string{"newest", "middle", "oldest"} {
		if cands[i].Candidate.RunID != want {
			t.Fatalf("candidate %d = %q, want %q: the reader reordered the sweep",
				i, cands[i].Candidate.RunID, want)
		}
	}
}

// The built generator answers the sweep face — serve's ticker type-asserts
// for exactly this, and the builder is the only place the assertion's
// subject is made.
func TestBuildCatchUpGeneratorCarriesTheSweepFace(t *testing.T) {
	t.Parallel()
	configured, err := assistant.NewTextOnly(assistant.Config{BaseURL: "http://127.0.0.1:1/v1"})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}
	gen := BuildCatchUpGenerator(CatchUpGenDeps{
		Broker:    configured,
		CatchUp:   &fakeCatchUpGenStore{},
		Runs:      &fakeCatchUpRuns{},
		Pipelines: &fakeCatchUpPipelines{},
		Chats:     &fakeCatchUpChats{},
	})
	if gen == nil {
		t.Fatal("fully wired deps built no generator")
	}
	if _, ok := gen.(CatchUpSweeper); !ok {
		t.Fatal("the built generator has no sweep face")
	}
}

// The sweep's OWN budget crosses the builder boundary: at zero the sweep is
// silent without ever asking the store for candidates (no read, no model
// call), while the same deployment with nobody's say gets its normal
// candidate read. The visit face's budget is a different knob and is not
// consulted on this path.
func TestBuildCatchUpGeneratorHonoursTheSweepBudget(t *testing.T) {
	t.Parallel()
	configured, err := assistant.NewTextOnly(assistant.Config{BaseURL: "http://127.0.0.1:1/v1"})
	if err != nil {
		t.Fatalf("NewTextOnly: %v", err)
	}
	build := func(sweep *int, store *fakeCatchUpGenStore) CatchUpSweeper {
		gen := BuildCatchUpGenerator(CatchUpGenDeps{
			Broker: configured, CatchUp: store,
			Runs: &fakeCatchUpRuns{}, Pipelines: &fakeCatchUpPipelines{},
			Chats: &fakeCatchUpChats{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			MaxSweepCallsPerWindow: sweep,
		})
		if gen == nil {
			t.Fatal("fully wired deps built no generator")
		}
		sw, ok := gen.(CatchUpSweeper)
		if !ok {
			t.Fatal("the built generator has no sweep face")
		}
		return sw
	}
	off := 0
	quiet := &fakeCatchUpGenStore{}
	build(&off, quiet).CatchUpCompletionSweep(context.Background())
	if quiet.sweepLimit != 0 {
		t.Fatalf("sweep read candidates (limit %d) with its budget at zero", quiet.sweepLimit)
	}
	open := &fakeCatchUpGenStore{}
	build(nil, open).CatchUpCompletionSweep(context.Background())
	if open.sweepLimit != 4*assistant.CatchUpGenMaxPerPass {
		t.Fatalf("sweep read limit = %d, want the generator's own number with a default budget",
			open.sweepLimit)
	}
}
