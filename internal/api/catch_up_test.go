package api

// The catch-up routes (ADR-0078) at the HTTP layer: the query filters parsed
// before any store is asked, the 404 a stranger and a gone item share (never a
// 403 that confirms a project has catch-up content), the payloads `seen` and
// `reply` refuse, the reply's delivery through the conversation store's own
// PostMessage — with exactly the text the human gave — and the 409 a busy agent
// answers with.
//
// The store's own behaviour (the seen/unseen flip across a tour rewrite, the
// membership predicate, the audit rows) is proven against real PostgreSQL in
// internal/store/postgres/catch_up_test.go and catch_up_api_test.go; these tests
// pin the contract its answers are turned into.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeCatchUp is the in-memory CatchUpStore: it serves the rows the test asks
// for, answers the sentinels the real store answers with, and remembers what the
// routes asked it for.
type fakeCatchUp struct {
	list     CatchUpItemList
	item     CatchUpItemView
	question *CatchUpDecisionView
	recap    CatchUpRecapView
	visits   []time.Time
	reply    CatchUpReplyRecord

	listErr, itemErr, questionErr, seenErr, allErr                  error
	visitErr, visitsErr, recapErr, replyErr, postErr, recapWriteErr error
	postConv                                                        string

	gotFilter      CatchUpListFilter
	gotSeenItem    string
	gotSeenVersion int
	gotSeenIDs     []string
	gotAllProjects []string
	gotRecapWith   []string
	gotReplyItem   string
	gotReplyStop   string
	gotReplyText   string
	gotRecapWrite  CatchUpRecapWrite
	recapWrites    int
	recapWrittenAt time.Time
	posted         []string
	lastCaller     Caller
}

func (f *fakeCatchUp) ListCatchUpItems(_ context.Context, c Caller,
	in CatchUpListFilter) (CatchUpItemList, error) {
	f.lastCaller = c
	f.gotFilter = in
	if f.listErr != nil {
		return CatchUpItemList{}, f.listErr
	}
	return f.list, nil
}

func (f *fakeCatchUp) GetCatchUpItem(_ context.Context, c Caller,
	itemID string) (CatchUpItemView, error) {
	f.lastCaller = c
	f.gotSeenItem = itemID
	if f.itemErr != nil {
		return CatchUpItemView{}, f.itemErr
	}
	return f.item, nil
}

func (f *fakeCatchUp) CatchUpStopQuestion(_ context.Context, _ Caller,
	itemID, stopID string) (*CatchUpDecisionView, error) {
	f.gotReplyItem, f.gotReplyStop = itemID, stopID
	return f.question, f.questionErr
}

func (f *fakeCatchUp) MarkCatchUpStopsSeen(_ context.Context, _ Caller, itemID string,
	version int, stopIDs []string) error {
	f.gotSeenItem, f.gotSeenVersion, f.gotSeenIDs = itemID, version, stopIDs
	return f.seenErr
}

func (f *fakeCatchUp) MarkAllCatchUpSeen(_ context.Context, _ Caller,
	projectIDs []string) error {
	f.gotAllProjects = projectIDs
	return f.allErr
}

func (f *fakeCatchUp) RecordCatchUpVisit(context.Context, Caller) error { return f.visitErr }

func (f *fakeCatchUp) RecentCatchUpVisits(context.Context, Caller) ([]time.Time, error) {
	return f.visits, f.visitsErr
}

func (f *fakeCatchUp) LatestCatchUpRecap(_ context.Context, _ Caller,
	projectIDs []string) (CatchUpRecapView, error) {
	f.gotRecapWith = projectIDs
	if f.recapErr != nil {
		return CatchUpRecapView{}, f.recapErr
	}
	return f.recap, nil
}

func (f *fakeCatchUp) SaveCatchUpRecap(_ context.Context, _ Caller,
	in CatchUpRecapWrite) (CatchUpRecapView, error) {
	f.gotRecapWrite = in
	f.recapWrites++
	if f.recapWriteErr != nil {
		return CatchUpRecapView{}, f.recapWriteErr
	}
	ids := in.ProjectIDs
	if ids == nil {
		ids = []string{}
	}
	return CatchUpRecapView{Text: in.Text, WrittenAt: f.recapWrittenAt,
		Window: in.Window, ProjectIDs: ids}, nil
}

func (f *fakeCatchUp) InsertCatchUpDecisionReply(_ context.Context, _ Caller,
	itemID, stopID, text string) (CatchUpReplyRecord, error) {
	f.gotReplyItem, f.gotReplyStop, f.gotReplyText = itemID, stopID, text
	if f.replyErr != nil {
		return CatchUpReplyRecord{}, f.replyErr
	}
	out := f.reply
	if out.ConversationID == nil && f.postConv != "" {
		out.ConversationID = &f.postConv
	}
	if out.Text == "" {
		out.Text = text
	}
	if out.ID == "" {
		out.ID = cuReplyID
	}
	return out, nil
}

// cuPoster is the conversation seam. It is a separate fake from the store on
// purpose: the whole point of the seam is that the catch-up route does not own
// the conversation's rules, and a reply that reached a different code path would
// look the same to a store fake.
type cuPoster struct {
	err      error
	gotConv  []string
	gotText  []string
	turnView ConversationTurnView
}

func (p *cuPoster) PostMessage(_ context.Context, _ Caller,
	conversationID, prompt string) (ConversationTurnView, error) {
	p.gotConv = append(p.gotConv, conversationID)
	p.gotText = append(p.gotText, prompt)
	if p.err != nil {
		return ConversationTurnView{}, p.err
	}
	return p.turnView, nil
}

const (
	cuProjectID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80"
	cuItemID    = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81"
	cuOtherID   = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b82"
	cuConvID    = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b83"
	cuReplyID   = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b84"
	cuBase      = "http://localhost:8080"
)

func cuStr(s string) *string { return &s }

func cuChip() CatchUpProjectChip {
	return CatchUpProjectChip{ID: cuProjectID, Name: "Communication", Color: "#1f8077"}
}

func cuServer(t *testing.T, store CatchUpStore, poster CatchUpConversationPoster) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	RegisterCatchUp(s, store, poster)
	return s
}

func cuGet(t *testing.T, s *Server, target string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, s, request(http.MethodGet, target, nil))
}

func cuPost(t *testing.T, s *Server, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		data = raw
	}
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", cuBase)
	req.Header.Set(HeaderCSRFToken, testPrincipal().CSRFToken)
	return do(t, s, req)
}

// cuMustProblem asserts the problem+json answer and its status.
func cuMustProblem(t *testing.T, rec *httptest.ResponseRecorder, want int) Problem {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, want, rec.Body.String())
	}
	return decodeProblem(t, rec)
}

func TestCatchUpListParsesFilters(t *testing.T) {
	t.Parallel()
	since := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	store := &fakeCatchUp{list: CatchUpItemList{
		Items: []CatchUpListItemView{{
			ID: cuItemID, Project: cuChip(), Shape: "pr", Title: "Rate limiter",
			Summary: "429s are scheduled.", Resolution: "merged",
			UnseenStops: 2, TotalStops: 3, Importance: "must_know",
		}},
		TotalUnseen: 1, OldestUnseenAt: &since,
	}}
	srv := cuServer(t, store, nil)

	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items?projects="+cuProjectID+","+cuOtherID+
		"&since=2026-11-01T09%3A00%3A00Z&include_seen=true")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store", cc)
	}
	if len(store.gotFilter.ProjectIDs) != 2 || store.gotFilter.ProjectIDs[1] != cuOtherID {
		t.Errorf("projects = %v, want both ids from the csv", store.gotFilter.ProjectIDs)
	}
	if store.gotFilter.Since == nil || !store.gotFilter.Since.Equal(since) {
		t.Errorf("since = %v, want %s", store.gotFilter.Since, since)
	}
	if !store.gotFilter.IncludeSeen {
		t.Error("include_seen = false, want true")
	}
	if store.lastCaller.UserID != testPrincipal().UserID {
		t.Errorf("caller = %+v, want the session principal", store.lastCaller)
	}
	body := decodeBody(t, rec)
	item, _ := body["items"].([]any)
	if len(item) != 1 {
		t.Fatalf("items = %v, want one row", body["items"])
	}
	row := item[0].(map[string]any)
	for _, field := range []string{"id", "project", "shape", "title", "summary", "resolution",
		"updated", "unseen_stops", "total_stops", "importance", "updated_at", "created_at"} {
		if _, ok := row[field]; !ok {
			t.Errorf("item is missing %q: %v", field, row)
		}
	}
	project := row["project"].(map[string]any)
	if project["color"] != "#1f8077" || project["name"] != "Communication" {
		t.Errorf("project chip = %v", project)
	}
	if body["total_unseen"] != float64(1) {
		t.Errorf("total_unseen = %v, want 1", body["total_unseen"])
	}
}

// TestCatchUpListEmptyIsAnArray: the page's own rule is "render nothing when
// there is nothing", and an absent member is not the same answer as [].
func TestCatchUpListEmptyIsAnArray(t *testing.T) {
	t.Parallel()
	srv := cuServer(t, &fakeCatchUp{}, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Errorf("body = %s, want items as an empty array", rec.Body.String())
	}
	body := decodeBody(t, rec)
	if body["oldest_unseen_at"] != nil {
		t.Errorf("oldest_unseen_at = %v, want null with nothing unseen", body["oldest_unseen_at"])
	}
}

func TestCatchUpListRejectsBadFilters(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{}
	srv := cuServer(t, store, nil)
	for _, tc := range []struct{ name, query, want string }{
		{"project not a uuid", "?projects=not-a-uuid", "projects"},
		{"since not RFC 3339", "?since=last-tuesday", "since"},
		{"include_seen not a bool", "?include_seen=maybe", "include_seen"},
	} {
		rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items"+tc.query)
		p := cuMustProblem(t, rec, http.StatusUnprocessableEntity)
		if !strings.Contains(p.Detail, tc.want) {
			t.Errorf("%s: detail = %q, want it to name %q", tc.name, p.Detail, tc.want)
		}
	}
	if store.gotFilter.ProjectIDs != nil {
		t.Error("a refused filter reached the store")
	}
}

// TestCatchUpNotFoundNeverLeaksExistence is ADR-0014 § 3 at this surface: the
// answer to "not your project" is the answer to "no such item", and no route
// here has a 403 for a private work item.
func TestCatchUpNotFoundNeverLeaksExistence(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{itemErr: ErrCatchUpNotFound, seenErr: ErrCatchUpNotFound,
		questionErr: ErrCatchUpNotFound, replyErr: ErrCatchUpNotFound, recapErr: ErrCatchUpNotFound}
	srv := cuServer(t, store, &cuPoster{})

	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID)
	cuMustProblem(t, rec, http.StatusNotFound)
	if rec.Header().Get("Content-Type") != ProblemJSON {
		t.Errorf("content-type = %q, want problem+json", rec.Header().Get("Content-Type"))
	}
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/seen",
		CatchUpSeenBody{Version: 1, StopIDs: []string{"s1"}})
	cuMustProblem(t, rec, http.StatusNotFound)
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s1/reply",
		CatchUpReplyBody{Text: "the retry branch"})
	cuMustProblem(t, rec, http.StatusNotFound)
	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/recap")
	cuMustProblem(t, rec, http.StatusNotFound)

	// A malformed path id is a 422 refused before any store call — the store's
	// not-found answer must not be the only 404-shaped thing on this surface.
	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/items/zzz")
	cuMustProblem(t, rec, http.StatusUnprocessableEntity)
}

func TestCatchUpItemShape(t *testing.T) {
	t.Parallel()
	youSaw := 1
	store := &fakeCatchUp{item: CatchUpItemView{
		ID: cuItemID, Project: cuChip(), Shape: "issue", Title: "Retry storms",
		Summary: "Backoff is now jittered.", Resolution: "branch_ready",
		Refs: CatchUpRefsView{
			Issues:       []CatchUpNumberedRef{{Number: 41, URL: "https://github.com/o/r/issues/41"}},
			PullRequests: []CatchUpNumberedRef{{Number: 7}},
		},
		ConversationID: cuStr(cuConvID),
		Latest: &CatchUpTourView{Version: 2, Reason: "Fix landed, stop 3 added", Stops: []CatchUpStopView{
			{ID: "s1", Title: "The bug", Narrative: "It retried immediately.", Importance: "must_know",
				AddedInVersion: 1, Seen: true},
			{ID: "s3", Title: "Your call", Narrative: "The agent picked the jitter.",
				Importance: "worth_a_look", AddedInVersion: 2,
				Decision: &CatchUpDecisionView{Prompt: "Right branch?", Options: []string{"yes", "no"},
					AllowText: true}},
		}},
		History:       []CatchUpTourHeaderView{{Version: 1, Reason: "First account", StopCount: 2}},
		SeenBy:        []CatchUpSeenByView{{ID: "u-2", Name: "Bob"}},
		YouSawVersion: &youSaw,
		UnseenStops:   1, TotalStops: 2,
	}}
	srv := cuServer(t, store, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	latest := body["latest"].(map[string]any)
	stops := latest["stops"].([]any)
	first := stops[0].(map[string]any)
	if first["seen"] != true || first["added_in_version"] != float64(1) {
		t.Errorf("stop 1 = %v, want seen at version 1", first)
	}
	third := stops[1].(map[string]any)
	if third["seen"] != false {
		t.Errorf("stop 3 seen = %v, want false (it arrived in version 2)", third["seen"])
	}
	if body["you_saw_version"] != float64(1) {
		t.Errorf("you_saw_version = %v, want 1", body["you_saw_version"])
	}
	if seen := body["seen_by"].([]any); len(seen) != 1 ||
		seen[0].(map[string]any)["name"] != "Bob" {
		t.Errorf("seen_by = %v, want Bob", body["seen_by"])
	}
	if history := body["history"].([]any); len(history) != 1 {
		t.Errorf("history = %v, want the one older header", body["history"])
	}
	// Refs are objects with the SERVER's url, not the model's: a number the
	// assistant claimed becomes a link only when this layer computed it (here,
	// when the store attached one), and a ref with no repository behind it stays
	// the bare label it always was.
	refs := body["refs"].(map[string]any)
	issues := refs["issues"].([]any)
	issue := issues[0].(map[string]any)
	prjEqual(t, issue["number"], float64(41), "issue number")
	prjEqual(t, issue["url"], "https://github.com/o/r/issues/41", "server-computed issue url")
	pulls := refs["pull_requests"].([]any)
	pull := pulls[0].(map[string]any)
	prjEqual(t, pull["number"], float64(7), "pull request number")
	if _, ok := pull["url"]; ok {
		t.Errorf("a ref the store attached no repository to carries a url: %v", pull)
	}
}

func TestCatchUpSeenPayloadIsValidated(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{}
	srv := cuServer(t, store, nil)
	target := cuBase + "/api/v1/catch-up/items/" + cuItemID + "/seen"

	// A tour version is what the reader was looking at; below 1 there is no
	// such thing, and the store would mark nothing.
	for _, body := range []any{
		CatchUpSeenBody{Version: 0, StopIDs: []string{"s1"}},
		CatchUpSeenBody{Version: -3, StopIDs: []string{"s1"}},
		CatchUpSeenBody{Version: 1},
		CatchUpSeenBody{Version: 1, StopIDs: []string{}},
		CatchUpSeenBody{Version: 1, StopIDs: []string{"  "}},
		CatchUpSeenBody{Version: 1, StopIDs: []string{strings.Repeat("x", CatchUpStopIDMaxChars+1)}},
		CatchUpSeenBody{Version: 1, StopIDs: cuStops(CatchUpStopsMax + 1)},
	} {
		rec := cuPost(t, srv, target, body)
		cuMustProblem(t, rec, http.StatusUnprocessableEntity)
		if store.gotSeenVersion != 0 {
			t.Fatalf("a refused payload reached the store: %+v", store)
		}
	}

	rec := cuPost(t, srv, target, CatchUpSeenBody{Version: 2, StopIDs: []string{"s1", "s1", "s2"}})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty", rec.Body.String())
	}
	if store.gotSeenVersion != 2 || store.gotSeenItem != cuItemID {
		t.Errorf("store saw %+v", store)
	}
	if strings.Join(store.gotSeenIDs, ",") != "s1,s2" {
		t.Errorf("stop ids = %v, want the duplicates collapsed", store.gotSeenIDs)
	}
}

func cuStops(n int) []string {
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, "s"+strconv.Itoa(i))
	}
	return out
}

func TestCatchUpSeenAllScopesToMyProjects(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{}
	srv := cuServer(t, store, nil)

	// No body, no projects: "everything I belong to", which the store's own
	// empty list means.
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/seen-all", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if len(store.gotAllProjects) != 0 {
		t.Errorf("projects = %v, want none named", store.gotAllProjects)
	}
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/seen-all", CatchUpSeenAllBody{
		Projects: []string{cuProjectID}})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("named projects: status = %d (%s)", rec.Code, rec.Body)
	}
	if len(store.gotAllProjects) != 1 || store.gotAllProjects[0] != cuProjectID {
		t.Errorf("projects = %v, want the one named", store.gotAllProjects)
	}
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/seen-all", CatchUpSeenAllBody{
		Projects: []string{"nope"}})
	cuMustProblem(t, rec, http.StatusUnprocessableEntity)
}

// TestCatchUpMutationsRequireCSRF: every POST here is a state change a browser
// can be tricked into making, so the guard the rest of the surface carries is
// checked before the store is asked.
func TestCatchUpMutationsRequireCSRF(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{}
	srv := cuServer(t, store, nil)
	for _, target := range []string{
		"/api/v1/catch-up/items/" + cuItemID + "/seen",
		"/api/v1/catch-up/seen-all",
		"/api/v1/catch-up/visits",
		"/api/v1/catch-up/items/" + cuItemID + "/stops/s1/reply",
	} {
		req := httptest.NewRequest(http.MethodPost, cuBase+target, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		rec := do(t, srv, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("POST %s without a CSRF token = %d, want 403 (%s)", target, rec.Code, rec.Body)
		}
	}
	if store.gotSeenVersion != 0 || store.gotReplyItem != "" {
		t.Errorf("an unguarded write reached the store: %+v", store)
	}
}

func TestCatchUpVisitStampedAndSuggested(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{}
	srv := cuServer(t, store, nil)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/visits", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	// Fewer than two visits is no interval at all: no window to suggest.
	store.visits = []time.Time{time.Now().UTC()}
	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/visits/suggestion")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["window"] != nil {
		t.Errorf("window = %v, want null with one visit", body["window"])
	}
}

// TestCatchUpVisitWindowBands pins the inference itself: the daily reader gets
// 24h, the every-few-days reader gets 2d, and the weekly reader gets 7d rather
// than a window that hides most of what they missed.
func TestCatchUpVisitWindowBands(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	older := func(d time.Duration) time.Time { return now.Add(-d) }
	for _, tc := range []struct {
		name   string
		visits []time.Time
		want   string
	}{
		{"hourly", []time.Time{older(time.Hour), older(2 * time.Hour), older(3 * time.Hour)}, CatchUpWindowDaily},
		{"daily", []time.Time{older(2 * time.Hour), older(26 * time.Hour), older(50 * time.Hour)}, CatchUpWindowDaily},
		{"every other day", []time.Time{older(40 * time.Hour), older(88 * time.Hour), older(136 * time.Hour)}, CatchUpWindowTwoDay},
		{"three days", []time.Time{older(60 * time.Hour), older(132 * time.Hour)}, CatchUpWindowTwoDay},
		{"weekly", []time.Time{older(24 * time.Hour), older(8 * 24 * time.Hour)}, CatchUpWindowWeekly},
		{"rarer than weekly", []time.Time{older(20 * 24 * time.Hour), older(60 * 24 * time.Hour)}, CatchUpWindowWeekly},
	} {
		got := catchUpSuggestion(tc.visits, now)
		if got.Window == nil || *got.Window != tc.want {
			t.Errorf("%s: window = %v, want %s", tc.name, got.Window, tc.want)
		}
	}
	if got := catchUpSuggestion(nil, now); got.Window != nil {
		t.Errorf("no visits: window = %v, want null", *got.Window)
	}
}

func TestCatchUpRecap(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{recap: CatchUpRecapView{
		Text: "Two fixes landed; the rate limiter is yours to review.", Window: "24h",
		ProjectIDs: []string{cuProjectID}, WrittenAt: time.Now().UTC(),
	}}
	srv := cuServer(t, store, nil)
	rec := cuGet(t, srv, cuBase+"/api/v1/catch-up/recap?projects="+cuProjectID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if len(store.gotRecapWith) != 1 || store.gotRecapWith[0] != cuProjectID {
		t.Errorf("named projects = %v, want them forwarded as the coverage filter", store.gotRecapWith)
	}
	body := decodeBody(t, rec)
	if body["window"] != "24h" || !strings.Contains(body["text"].(string), "rate limiter") {
		t.Errorf("body = %v", body)
	}
	if projects, ok := body["project_ids"].([]any); !ok || len(projects) != 1 {
		t.Errorf("project_ids = %v, want the array the recap covered", body["project_ids"])
	}

	// No saved recap is a 404 problem, not an empty sentence the page would
	// render as "the assistant said nothing".
	store.recapErr = ErrCatchUpNotFound
	rec = cuGet(t, srv, cuBase+"/api/v1/catch-up/recap")
	cuMustProblem(t, rec, http.StatusNotFound)
}

// TestCatchUpReplyGoesToTheConversation is the whole seam: the text the human
// gave arrives at PostMessage unchanged, the reply row's own conversation is the
// destination (never anything the caller named), and the answer carries the turn
// the conversation store created.
func TestCatchUpReplyGoesToTheConversation(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{postConv: cuConvID, question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"retry-backoff", "main"}, AllowText: true,
	}}
	poster := &cuPoster{turnView: ConversationTurnView{ID: "turn-1", Status: "queued"}}
	srv := cuServer(t, store, poster)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: "  ship it on retry-backoff, then tell me  "})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	if len(poster.gotText) != 1 || poster.gotText[0] != "ship it on retry-backoff, then tell me" {
		t.Errorf("posted = %q, want the text, trimmed and otherwise untouched", poster.gotText)
	}
	if len(poster.gotConv) != 1 || poster.gotConv[0] != cuConvID {
		t.Errorf("conversation = %v, want the reply's own thread %s", poster.gotConv, cuConvID)
	}
	body := decodeBody(t, rec)
	if body["reply_id"] != cuReplyID || body["conversation_id"] != cuConvID ||
		body["turn_id"] != "turn-1" {
		t.Errorf("body = %v", body)
	}
}

// TestCatchUpReplyWithNoConversation is the honest dead end: the answer is
// stored, nothing is posted, and the response says so with nulls rather than
// pretending a send.
func TestCatchUpReplyWithNoConversation(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"a"}, AllowText: false}}
	poster := &cuPoster{}
	srv := cuServer(t, store, poster)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: "a"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	if len(poster.gotConv) != 0 {
		t.Errorf("posted to %v, want nothing posted at all", poster.gotConv)
	}
	body := decodeBody(t, rec)
	if body["conversation_id"] != nil || body["turn_id"] != nil {
		t.Errorf("body = %v, want null conversation and turn", body)
	}
}

// TestCatchUpReplyRefusesAnAnswerTheQuestionDidNotOffer is the ADR-0078 §
// Decision 4 rule at the HTTP edge: a beat whose box is closed only takes one of
// its own options, and the refusal stores nothing.
func TestCatchUpReplyRefusesAnAnswerTheQuestionDidNotOffer(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"retry-backoff", "main"}, AllowText: false,
	}}
	poster := &cuPoster{}
	srv := cuServer(t, store, poster)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: "whatever you think"})
	p := cuMustProblem(t, rec, http.StatusUnprocessableEntity)
	if !strings.Contains(p.Detail, "options") {
		t.Errorf("detail = %q, want it to name the options", p.Detail)
	}
	if store.gotReplyText != "" {
		t.Errorf("stored %q, want a refused answer stored nothing", store.gotReplyText)
	}
	if len(poster.gotText) != 0 {
		t.Errorf("posted %v, want nothing posted", poster.gotText)
	}

	// An option the question DID offer passes, whitespace and all around it.
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: " main "})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 for a named option (%s)", rec.Code, rec.Body)
	}
	if store.gotReplyText != "main" {
		t.Errorf("stored %q, want the trimmed option", store.gotReplyText)
	}
}

func TestCatchUpReplyTextIsBounded(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"a"}, AllowText: true}}
	srv := cuServer(t, store, &cuPoster{})
	for _, tc := range []struct{ name, text string }{
		{"empty", "   "},
		{"too long", strings.Repeat("é", CatchUpReplyMaxChars+1)},
	} {
		rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
			CatchUpReplyBody{Text: tc.text})
		p := cuMustProblem(t, rec, http.StatusUnprocessableEntity)
		if !strings.Contains(p.Detail, "text") {
			t.Errorf("%s: detail = %q, want it to name text", tc.name, p.Detail)
		}
		if store.gotReplyText != "" {
			t.Errorf("%s: stored %q, want nothing stored", tc.name, store.gotReplyText)
		}
	}
}

// TestCatchUpReplyToAQuestionThatWasNotAsked is a 404: "this item's newest story
// has no such beat" and "this beat asked nothing" are one answer, because the
// second is not information to hand a stranger (ADR-0078 § Decision 4).
func TestCatchUpReplyToAQuestionThatWasNotAsked(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{questionErr: ErrCatchUpNotFound}
	poster := &cuPoster{}
	srv := cuServer(t, store, poster)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s9/reply",
		CatchUpReplyBody{Text: "here you go"})
	cuMustProblem(t, rec, http.StatusNotFound)
	if len(poster.gotConv) != 0 {
		t.Errorf("posted to %v, want nothing posted for a question that is not there", poster.gotConv)
	}
}

// TestCatchUpReplyBusyAgentIsConflict is the conversation's own rule, unborrowed
// and unsoftened: a thread with a turn in flight answers 409 with the blocking
// turn named, exactly like POST /conversations/{id}/messages. The reply row
// stands — the human did answer — and the response says the send did not go out.
func TestCatchUpReplyBusyAgentIsConflict(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{postConv: cuConvID, question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"a"}, AllowText: true}}
	poster := &cuPoster{err: &ConversationConflict{
		Kind:           ConflictTurnInProgress,
		Detail:         "An agent is working on this conversation.",
		ConversationID: cuConvID,
		Control:        &ConversationControlView{Kind: "human", UserID: cuStr("u-2"), Version: 4},
	}}
	srv := cuServer(t, store, poster)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: "go"})
	p := cuMustProblem(t, rec, http.StatusConflict)
	if p.Type != "https://communication.dev/errors/turn-in-progress" {
		t.Errorf("type = %q, want the turn-in-progress problem", p.Type)
	}
	var full struct {
		Problem
		ActiveTurn *ConversationTurnView   `json:"active_turn"`
		Control    ConversationControlView `json:"control"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &full); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if full.Control.Version != 4 {
		t.Errorf("control = %+v, want the live control row the client must adopt", full.Control)
	}
	if store.gotReplyText != "go" {
		t.Errorf("stored %q, want the reply kept even though the send failed", store.gotReplyText)
	}
}

// TestCatchUpReplyNotControllerIsConflict: the same 409 the thread's own route
// gives when somebody else holds the lock.
func TestCatchUpReplyNotControllerIsConflict(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{postConv: cuConvID, question: &CatchUpDecisionView{
		Prompt: "Which branch?", Options: []string{"a"}, AllowText: true}}
	poster := &cuPoster{err: &ConversationConflict{
		Kind: ConflictNotController, Detail: "Dana is in control.",
		Control: &ConversationControlView{Kind: "human", UserID: cuStr("u-9"), Version: 2},
	}}
	srv := cuServer(t, store, poster)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
		CatchUpReplyBody{Text: "go"})
	p := cuMustProblem(t, rec, http.StatusConflict)
	if !strings.Contains(p.Detail, "Dana") {
		t.Errorf("detail = %q, want the store's naming of who holds the lock", p.Detail)
	}
}

// TestCatchUpStoreFailuresAre500 is the other half of the 404 rule: a store that
// is broken says so, rather than every route answering "no such item" and
// teaching the page that a project has nothing in it.
func TestCatchUpStoreFailuresAre500(t *testing.T) {
	t.Parallel()
	boom := errors.New("the pool is on fire")
	for _, tc := range []struct {
		name  string
		store *fakeCatchUp
		call  func(*testing.T, *Server) *httptest.ResponseRecorder
	}{
		{"list", &fakeCatchUp{listErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuGet(t, s, cuBase+"/api/v1/catch-up/items")
		}},
		{"item", &fakeCatchUp{itemErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuGet(t, s, cuBase+"/api/v1/catch-up/items/"+cuItemID)
		}},
		{"seen", &fakeCatchUp{seenErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuPost(t, s, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/seen",
				CatchUpSeenBody{Version: 1, StopIDs: []string{"s1"}})
		}},
		{"seen all", &fakeCatchUp{allErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuPost(t, s, cuBase+"/api/v1/catch-up/seen-all", nil)
		}},
		{"visit", &fakeCatchUp{visitErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuPost(t, s, cuBase+"/api/v1/catch-up/visits", nil)
		}},
		{"visits", &fakeCatchUp{visitsErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuGet(t, s, cuBase+"/api/v1/catch-up/visits/suggestion")
		}},
		{"recap", &fakeCatchUp{recapErr: boom}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuGet(t, s, cuBase+"/api/v1/catch-up/recap")
		}},
		{"reply", &fakeCatchUp{
			postConv: cuConvID,
			question: &CatchUpDecisionView{Prompt: "Which branch?", Options: []string{"a"}, AllowText: true},
			replyErr: boom,
		}, func(t *testing.T, s *Server) *httptest.ResponseRecorder {
			return cuPost(t, s, cuBase+"/api/v1/catch-up/items/"+cuItemID+"/stops/s3/reply",
				CatchUpReplyBody{Text: "a"})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := cuServer(t, tc.store, &cuPoster{})
			rec := tc.call(t, srv)
			cuMustProblem(t, rec, http.StatusInternalServerError)
		})
	}
}

func TestCatchUpAnonymousIsUnauthorized(t *testing.T) {
	t.Parallel()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(nil, ErrUnauthenticated))
	RegisterCatchUp(s, &fakeCatchUp{}, &cuPoster{})
	for _, target := range []string{
		"/api/v1/catch-up/items",
		"/api/v1/catch-up/items/" + cuItemID,
		"/api/v1/catch-up/recap",
		"/api/v1/catch-up/visits/suggestion",
	} {
		rec := do(t, s, request(http.MethodGet, cuBase+target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", target, rec.Code)
		}
	}
}

// TestCatchUpRecapUnconfiguredIs503: a deployment with no assistant egress has
// no recap generator, and the POST says so with the ask route's own problem —
// it never stores a sentence no model wrote, and it never 404s a client into
// thinking the endpoint is missing. (ADR-0078 § Migration shipped the read
// half first; T13b adds the browser-askable recap, which is allowed precisely
// because a recap is one reader's row, not a shared tour.)
func TestCatchUpRecapUnconfiguredIs503(t *testing.T) {
	t.Parallel()
	srv := cuServer(t, &fakeCatchUp{}, nil)
	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", map[string]string{"window": "24h"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST /catch-up/recap = %d, want 503 (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "assistant_not_configured") {
		t.Errorf("problem = %s, want degraded assistant_not_configured", rec.Body)
	}
}

// TestCatchUpRoutesAreDocumented is the contract guard for this surface, the
// same three-way check the M4 route table runs (TestM4RouteTableMatchesOpenAPI)
// restricted to its own frozen 37: the patterns registered in this file and the
// operations api/openapi.yaml declares are one set, in both directions. A route
// in code and not the document is a client that cannot know it exists; a route
// in the document and not in code is a browser that gets a 404 with "no
// endpoint" and a UI that draws a button for it.
func TestCatchUpRoutesAreDocumented(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi document: %v", err)
	}
	registered := m4RegisteredPatterns(t, "catch_up.go")
	documented := map[string]bool{}
	var current string
	for _, line := range strings.Split(string(raw), "\n") {
		if m := regexp.MustCompile(`^  (/api/v1/[^:]*):$`).FindStringSubmatch(line); m != nil {
			// Any other path closes the catch-up block: without this the first
			// non-catch-up route's own methods read as extras.
			current = ""
			if strings.HasPrefix(m[1], "/api/v1/catch-up") {
				current = m[1]
			}
			continue
		}
		if current == "" {
			continue
		}
		if m := regexp.MustCompile(`^    (get|post|put|patch|delete):$`).FindStringSubmatch(line); m != nil {
			documented[strings.ToUpper(m[1])+" "+current] = true
			continue
		}
	}
	if len(registered) != 10 {
		// ADR-0078 step 1 mounted eight; T13a adds the per-reader tour page
		// and T13b the browser-askable recap.
		t.Fatalf("catch_up.go registers %d routes, want the 10 ADR-0078 mounts: %v",
			len(registered), registered)
	}
	m4SetEqual(t, "openapi.yaml's catch-up paths vs the registered patterns", documented, registered)
}
