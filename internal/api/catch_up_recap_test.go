package api

// T13b at the HTTP layer: POST /catch-up/recap. The recap is the one narrative
// on the catch-up surface a browser may ask for, and these tests pin WHY it is
// allowed where a tour route is not (a recap is one reader's row), plus what
// the route promises: the caller's own unseen items go to the model and
// nothing else, an answer that names a title the block never showed stores
// NOTHING, an empty page costs no completion, the assistant throttle covers the
// route, and an unconfigured deployment says 503 instead of writing prose.

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/assistant"
)

// cuRecapModel is the fake completion. It records the prompt it was handed,
// which is the only way to ask from this layer "what did the model get told" —
// the block is the trust boundary, so what is IN it is the contract.
type cuRecapModel struct {
	answer    string
	fail      *assistant.Failure
	gotCalls  int
	gotSystem string
	gotUser   string
}

func (m *cuRecapModel) CompleteText(_ context.Context, system, user string) (string, *assistant.Failure) {
	m.gotCalls++
	m.gotSystem, m.gotUser = system, user
	if m.fail != nil {
		return "", m.fail
	}
	return m.answer, nil
}

// cuRecapList is the served list: three items of two projects, one must_know
// with a beat that asks and one routine with none.
func cuRecapList() CatchUpItemList {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	return CatchUpItemList{
		Items: []CatchUpListItemView{
			{ID: cuItemID, Project: cuChip(), Shape: "pr", Title: "Rate limiter lands",
				Importance: "must_know", UnseenStops: 1, TotalStops: 1, UpdatedAt: now},
			{ID: cuOtherID, Project: CatchUpProjectChip{ID: cuOtherID, Name: "Docs", Color: "#3b6ea5"},
				Shape: "push", Title: "Typo sweep", Importance: "routine",
				UnseenStops: 0, TotalStops: 2, UpdatedAt: now.Add(-time.Hour)},
		},
		TotalUnseen: 2,
	}
}

type cuRecapTourStore struct {
	*fakeCatchUp
	byID map[string]CatchUpItemView
}

func (f *cuRecapTourStore) GetCatchUpItem(_ context.Context, _ Caller,
	itemID string) (CatchUpItemView, error) {
	if view, ok := f.byID[itemID]; ok {
		return view, nil
	}
	return CatchUpItemView{}, ErrCatchUpNotFound
}

func cuRecapServer(t *testing.T, store CatchUpStore, model *cuRecapModel) *Server {
	t.Helper()
	s := newTestServerWith(t,
		Config{ReplicaName: "replica-a", Version: "1.2.3", PublicURL: cuBase},
		nil, fakeReadiness{expected: 1}, principalAuth(testPrincipal(), nil))
	var gen CatchUpRecapGenerator
	if model != nil {
		gen = assistant.NewCatchUpRecapGenerator(assistant.CatchUpRecapDeps{Model: model})
	}
	RegisterCatchUp(s, store, nil, WithRecapGenerator(gen))
	return s
}

func cuRecapStores() *cuRecapTourStore {
	return &cuRecapTourStore{
		fakeCatchUp: &fakeCatchUp{list: cuRecapList(), recapWrittenAt: time.Unix(1762500000, 0).UTC()},
		byID: map[string]CatchUpItemView{
			cuItemID: {
				ID: cuItemID, Project: cuChip(), Title: "Rate limiter lands",
				Latest: &CatchUpTourView{Version: 1, Stops: []CatchUpStopView{{
					ID: "s1", Title: "Which branch?", Importance: "must_know",
					Kind: "YOUR CALL", Decision: &CatchUpDecisionView{Prompt: "keep it?"},
				}}},
			},
		},
	}
}

func TestCatchUpRecapHappyPathSavesAndReturns(t *testing.T) {
	t.Parallel()
	store := cuRecapStores()
	model := &cuRecapModel{answer: `{"text":"Look at \"Rate limiter lands\" first — it is waiting on your branch call. \"Typo sweep\" can wait."}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap",
		map[string]any{"projects": []string{cuProjectID}, "window": "24h"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if body["text"] != `Look at "Rate limiter lands" first — it is waiting on your branch call. "Typo sweep" can wait.` {
		t.Errorf("text = %v", body["text"])
	}
	if body["window"] != "24h" {
		t.Errorf("window = %v, want the requested 24h", body["window"])
	}
	if ids, _ := body["project_ids"].([]any); len(ids) != 1 || ids[0] != cuProjectID {
		t.Errorf("project_ids = %v, want the named project", body["project_ids"])
	}
	if body["written_at"] == nil || body["written_at"] == "" {
		t.Errorf("written_at missing: %v", body)
	}
	if store.recapWrites != 1 || store.gotRecapWrite.Text == "" {
		t.Fatalf("stored = %+v, want exactly one recap row", store.gotRecapWrite)
	}
	if model.gotCalls != 1 {
		t.Errorf("model calls = %d, want exactly one", model.gotCalls)
	}
	// What the model was SHOWN is the trust boundary: the caller's own titles,
	// numbered, and the beat that asks.
	for _, want := range []string{"Rate limiter lands", "Typo sweep", "\"n\": 1", "\"asks\": true", "<DATA>"} {
		if !strings.Contains(model.gotUser, want) {
			t.Errorf("the DATA block carries no %q:\n%s", want, model.gotUser)
		}
	}
	if !strings.Contains(store.gotFilter.ProjectIDs[0], cuProjectID) {
		t.Errorf("the read was not scoped to the named project: %v", store.gotFilter.ProjectIDs)
	}
	if store.gotFilter.Since == nil {
		t.Error("window 24h must reach the read as a since bound")
	}
}

func TestCatchUpRecapEmptyIsDeterministicAndCostsNoCompletion(t *testing.T) {
	t.Parallel()
	store := &fakeCatchUp{list: CatchUpItemList{Items: []CatchUpListItemView{}, TotalUnseen: 0},
		recapWrittenAt: time.Unix(1762500000, 0).UTC()}
	model := &cuRecapModel{answer: `{"text":"Something the model invented about the backlog."}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", map[string]any{})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	if model.gotCalls != 0 {
		t.Errorf("model calls = %d, want 0: an empty page is a fact, not a question", model.gotCalls)
	}
	if got := decodeBody(t, rec)["text"]; got != assistant.CatchUpRecapEmptyText {
		t.Errorf("text = %v, want %q", got, assistant.CatchUpRecapEmptyText)
	}
	if store.recapWrites != 1 {
		t.Errorf("writes = %d, want the empty answer stored too", store.recapWrites)
	}
	// No window named is the page's own question: the unseen read, no clock.
	if store.gotFilter.Since != nil {
		t.Errorf("since = %v, want nil for the default unseen window", store.gotFilter.Since)
	}
}

func TestCatchUpRecapInventedTitleRefusesAndStoresNothing(t *testing.T) {
	t.Parallel()
	store := cuRecapStores()
	model := &cuRecapModel{answer: `{"text":"Start with \"Ship the dark theme\" — it is the must-know one."}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", map[string]any{"window": "7d"})
	// The status the assistant's other text-only paths use for an answer that
	// fails validation: 502, cause named in `degraded`.
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "malformed_completion") {
		t.Errorf("problem = %s, want degraded malformed_completion", rec.Body)
	}
	if store.recapWrites != 0 {
		t.Errorf("writes = %d, want NOTHING stored for a refused answer", store.recapWrites)
	}
	// The invented title is model output: refused, and not echoed back.
	if strings.Contains(rec.Body.String(), "Ship the dark theme") {
		t.Errorf("the refusal echoed the invented title: %s", rec.Body)
	}
}

func TestCatchUpRecapOverLongTextStoresNothing(t *testing.T) {
	t.Parallel()
	store := cuRecapStores()
	long := strings.Repeat("a", 601)
	model := &cuRecapModel{answer: `{"text":"` + long + `"}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body %s)", rec.Code, rec.Body)
	}
	if store.recapWrites != 0 {
		t.Errorf("writes = %d, want nothing stored", store.recapWrites)
	}
}

func TestCatchUpRecapIsThrottledPerPrincipal(t *testing.T) {
	s, _ := newThrottledTestServer(t, RateLimits{Assistant: LimitSpec{PerMinute: 60, Burst: 1}})
	store := cuRecapStores()
	model := &cuRecapModel{answer: `{"text":"Look at \"Rate limiter lands\" first."}`}
	RegisterCatchUp(s, store, nil, WithRecapGenerator(
		assistant.NewCatchUpRecapGenerator(assistant.CatchUpRecapDeps{Model: model})))

	if rec := cuPost(t, s, cuBase+"/api/v1/catch-up/recap", nil); rec.Code != http.StatusCreated {
		t.Fatalf("first recap = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	rec := cuPost(t, s, cuBase+"/api/v1/catch-up/recap", nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second recap = %d, want 429 (body %s)", rec.Code, rec.Body)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 carries no Retry-After")
	}
	if model.gotCalls != 1 {
		t.Errorf("model calls = %d, want the throttled call to have cost nothing", model.gotCalls)
	}
	if store.recapWrites != 1 {
		t.Errorf("writes = %d, want one", store.recapWrites)
	}
}

func TestCatchUpRecapRejectsJunkBeforeTheModel(t *testing.T) {
	t.Parallel()
	store := cuRecapStores()
	model := &cuRecapModel{answer: `{"text":"x"}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", map[string]any{"window": "yesterday"})
	if p := cuMustProblem(t, rec, http.StatusUnprocessableEntity); !strings.Contains(p.Detail, "window") {
		t.Errorf("problem = %+v, want a 422 naming window", p)
	}
	rec = cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", map[string]any{"projects": []string{"nope"}})
	if p := cuMustProblem(t, rec, http.StatusUnprocessableEntity); !strings.Contains(p.Detail, "projects") {
		t.Errorf("problem = %+v, want a 422 naming projects", p)
	}
	if model.gotCalls != 0 {
		t.Errorf("model calls = %d, want a refused request to cost no completion", model.gotCalls)
	}
	if store.recapWrites != 0 {
		t.Errorf("writes = %d, want nothing stored", store.recapWrites)
	}
}

// The empty-body and no-body shapes are the page's two calls; both are "my
// projects, everything unseen".
func TestCatchUpRecapEmptyBodyIsTheDefaultScope(t *testing.T) {
	t.Parallel()
	store := cuRecapStores()
	model := &cuRecapModel{answer: `{"text":"Look at \"Rate limiter lands\" first."}`}
	srv := cuRecapServer(t, store, model)

	rec := cuPost(t, srv, cuBase+"/api/v1/catch-up/recap", nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec)
	if ids, _ := body["project_ids"].([]any); len(ids) != 0 {
		t.Errorf("project_ids = %v, want the empty array (nothing was scoped)", body["project_ids"])
	}
	if body["window"] != CatchUpWindowUnseen {
		t.Errorf("window = %v, want unseen", body["window"])
	}
}
