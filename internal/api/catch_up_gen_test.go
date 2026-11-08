package api

// The catch-up generator's HTTP-side pieces (ADR-0078): the deterministic
// tour page — unseen stops collected across the caller's items, ranked by
// the tour's shared importance and the work's recency, paged 4 at a time —
// and the lazy generator trigger fired from the items list AFTER the answer
// is written. Plus the pure ref-harvesting the DATA block depends on: refs
// are read off the run's own outputs, which is what makes an invented PR
// number unrepresentable rather than merely filtered.

import (
	"context"
	"encoding/json"
	"net/http"
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

func (g *catchUpTriggerSpy) CatchUpItemsListed(_ context.Context, c Caller, projects []string) {
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

func TestCatchUpListRouteFiresTheGeneratorAfterAnswering(t *testing.T) {
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
	if spy.calls != 1 || len(spy.projects) != 1 || spy.projects[0] != cuProjectID {
		t.Fatalf("trigger = %+v, want one call scoped to the named project", spy)
	}
	if spy.caller.UserID != testPrincipal().UserID {
		t.Errorf("trigger caller = %+v, want the session principal", spy.caller)
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

type fakeCatchUpGenStore struct{}

func (f *fakeCatchUpGenStore) CatchUpCandidates(context.Context, Caller, []string,
	time.Duration, int) ([]CatchUpCandidateView, error) {
	return nil, nil
}
func (f *fakeCatchUpGenStore) UpsertCatchUpWorkItem(context.Context, Caller,
	CatchUpWorkItemWrite) (string, error) {
	return "", nil
}
func (f *fakeCatchUpGenStore) AppendCatchUpTour(context.Context, Caller, string, string,
	[]CatchUpStopWrite) error {
	return nil
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
