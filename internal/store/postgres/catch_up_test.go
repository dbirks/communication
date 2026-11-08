package postgres

// ADR-0078 (docs/adr/ADR-0078-catch-up-work-items-and-tours.md): the catch-up
// store, against a real PostgreSQL. What is proven here is the data rule, not a
// model. In order: the shared/seen split that the whole page rests on — a tour
// rewritten as version 2 leaves a reader caught up on the beats they had read
// and badges the item UPDATED for exactly the new ones; "mark all seen"; every
// read and write gated on project membership, so a non-member sees nothing and
// cannot even learn the item exists; the tour version number chosen by the
// database under real concurrency (no gaps, no ties); a decision reply stored
// with the work item's own conversation and refused on a stop that asked
// nothing; the recap and visit caches; and projects.color as a checked palette
// rather than an arbitrary colour.
//
// These tests skip unless COMMUNICATION_TEST_DATABASE_URL is set; CI runs them
// against PostgreSQL 18 (see .github/workflows/ci.yml), which is the only way
// any of the above is actually known.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

func cuStore(f *cnvFixture) *CatchUpStore { return &CatchUpStore{Pool: f.pool} }

// cuStop is one beat of a tour. addedIn 0 means "the version being written",
// which is what the store stamps; a positive value is a carried-over beat
// declaring where it came from.
func cuStop(id, kind string, importance domain.CatchUpImportance, addedIn int) domain.CatchUpStop {
	return domain.CatchUpStop{
		ID: id, Title: "Stop " + id, Kind: kind, Importance: importance,
		Narrative:      "The agent found the cause and shipped the fix.",
		AddedInVersion: addedIn,
	}
}

// cuItem writes one work item as `user` and returns its id.
func cuItem(t *testing.T, f *cnvFixture, user, title string) string {
	t.Helper()
	item, err := cuStore(f).UpsertWorkItem(f.ctx(), f.caller(user), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: domain.CatchUpShapePR, Title: title,
		Summary: "The rate limiter now schedules 429s.", Resolution: domain.CatchUpResolutionMerged,
		Refs: domain.CatchUpRefs{PRNumbers: []int{7}, CommitSHAs: []string{"deadbeef"}},
	})
	if err != nil {
		t.Fatalf("upsert work item %q: %v", title, err)
	}
	if item.ID == "" {
		t.Fatalf("upsert work item %q returned no id", title)
	}
	return item.ID
}

// cuAppend writes one tour version about work no single run owns (the store's
// own no-run path) and returns its number.
func cuAppend(t *testing.T, f *cnvFixture, user, itemID, reason string,
	stops ...domain.CatchUpStop) int {
	t.Helper()
	v, err := cuStore(f).AppendTourVersion(f.ctx(), f.caller(user), itemID, "", reason, stops)
	if err != nil {
		t.Fatalf("append tour version to %s: %v", itemID, err)
	}
	return v.Version
}

// cuAppendRun is the generator's path: appending the version is also what
// CLAIMS the run, so the same call that tells the story takes the run off the
// list of runs still owed one (ADR-0078 § Grouping).
func cuAppendRun(t *testing.T, f *cnvFixture, user, itemID, runID, reason string,
	stops ...domain.CatchUpStop) int {
	t.Helper()
	v, err := cuStore(f).AppendTourVersion(f.ctx(), f.caller(user), itemID, runID, reason, stops)
	if err != nil {
		t.Fatalf("append tour version to %s: %v", itemID, err)
	}
	return v.Version
}

// cuList is the page's default read: unseen only, no lower bound.
func cuList(t *testing.T, f *cnvFixture, user string, projectIDs []string,
	since *time.Time, includeSeen bool) []domain.CatchUpListItem {
	t.Helper()
	items, err := cuStore(f).ListUnseenWorkItems(f.ctx(), f.caller(user), projectIDs, since,
		includeSeen)
	if err != nil {
		t.Fatalf("list unseen for %s: %v", user, err)
	}
	return items
}

func cuByID(items []domain.CatchUpListItem, id string) (domain.CatchUpListItem, bool) {
	for _, it := range items {
		if it.ID == id {
			return it, true
		}
	}
	return domain.CatchUpListItem{}, false
}

// cuForeignProject is a SECOND project of the same organization that none of the
// fixture's users is a member of — the set a caller must not be able to widen by
// naming it. Its cleanup is registered before cnvSetup's, so it runs first
// (LIFO) and the shared fixture never has to know it existed.
func cuForeignProject(t *testing.T, f *cnvFixture) string {
	t.Helper()
	var id string
	f.queryRow(t, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, 'cu-other-' || $2, 'Catch up foreign fixture', $3::uuid)
		RETURNING id::text`, f.orgID, migFixtureToken(t), f.alice).into(t, &id)
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM memberships WHERE project_id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup foreign project memberships: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM projects WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup foreign project: %v", err)
		}
	})
	return id
}

// TestCatchUpSeenUnseenAcrossTourVersions is the product rule in one test: the
// story is shared, the reading is not, and a rewrite must neither resurrect what
// was read nor hide what is new.
func TestCatchUpSeenUnseenAcrossTourVersions(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)

	// An item with no tour yet is not presentable: there is no story to have
	// read, so it appears in nobody's list while GetWorkItem still finds it.
	tourless := cuItem(t, f, f.alice, "Work without a story")
	if items := cuList(t, f, f.alice, nil, nil, false); len(items) != 0 {
		t.Errorf("a tour-less work item is listed: %+v", items)
	}
	view, err := store.GetWorkItem(f.ctx(), f.caller(f.alice), tourless)
	if err != nil {
		t.Fatalf("get tour-less work item: %v", err)
	}
	if view.Latest != nil || view.LatestVersion != 0 || len(view.History) != 0 {
		t.Errorf("tour-less item reported a tour: %+v", view)
	}

	item := cuItem(t, f, f.alice, "Rate limiter landed")
	v1 := cuAppend(t, f, f.alice, item, "Found the cause",
		cuStop("s1", "BUG · CAUSE FOUND", domain.CatchUpImportanceMustKnow, 0),
		cuStop("s2", "UI CHANGE", domain.CatchUpImportanceWorthLook, 0))
	if v1 != 1 {
		t.Fatalf("first tour version = %d, want 1", v1)
	}

	got, ok := cuByID(cuList(t, f, f.alice, nil, nil, false), item)
	if !ok {
		t.Fatalf("nothing unseen after the first tour")
	}
	if got.UnseenStops != 2 || got.Updated {
		t.Errorf("fresh tour = %d unseen / updated %v, want 2 unseen / not updated",
			got.UnseenStops, got.Updated)
	}
	if got.Refs.PRNumbers == nil || got.Refs.PRNumbers[0] != 7 ||
		got.Refs.CommitSHAs[0] != "deadbeef" {
		t.Errorf("refs did not survive the round trip: %+v", got.Refs)
	}

	// Reading both beats empties the list, and the same read with includeSeen
	// reports the item with nothing outstanding.
	marked, err := store.MarkStopsSeen(f.ctx(), f.caller(f.alice), item, 1, []string{"s1", "s2"})
	if err != nil || marked != 2 {
		t.Fatalf("mark s1,s2 seen = %d / %v", marked, err)
	}
	if items := cuList(t, f, f.alice, nil, nil, false); len(items) != 0 {
		t.Errorf("a fully-read item is still unseen: %+v", items)
	}
	seenItem, ok := cuByID(cuList(t, f, f.alice, nil, nil, true), item)
	if !ok || seenItem.UnseenStops != 0 || seenItem.Updated {
		t.Errorf("includeSeen read = %+v, want the item with 0 unseen and no update", seenItem)
	}

	// The story moves: s1 is carried, s2 is dropped, s3 is new.
	v2 := cuAppend(t, f, f.alice, item, "Fix landed, stop 3 added",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 1),
		cuStop("s3", "YOUR CALL", domain.CatchUpImportanceWorthLook, 0))
	if v2 != 2 {
		t.Fatalf("second tour version = %d, want 2", v2)
	}
	got, ok = cuByID(cuList(t, f, f.alice, nil, nil, false), item)
	if !ok {
		t.Fatalf("the rewritten tour did not come back as unseen")
	}
	if !got.Updated {
		t.Errorf("a tour newer than what the reader saw is not UPDATED: %+v", got)
	}
	if got.UnseenStops != 1 {
		t.Errorf("unseen after the rewrite = %d, want 1 (only s3; s1 was read in v1)",
			got.UnseenStops)
	}

	// A reader who never saw v1 owes every beat of v2 and is not "updated".
	bob, ok := cuByID(cuList(t, f, f.bob, nil, nil, false), item)
	if !ok {
		t.Fatalf("bob was never told about the item at all")
	}
	if bob.UnseenStops != 2 || bob.Updated {
		t.Errorf("bob sees %d unseen / updated %v, want 2 unseen and no update",
			bob.UnseenStops, bob.Updated)
	}

	// Marking a stop that is not in that version marks nothing: the ids are read
	// out of the tour document, not taken on faith.
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.bob), item, 2, []string{"nope"}); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("marking an unknown stop = %v, want ErrCatchUpNotFound", err)
	}
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.bob), item, 9, []string{"s1"}); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("marking a tour version that does not exist = %v, want ErrCatchUpNotFound", err)
	}

	// Who has finished the story.
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.alice), item, 2, []string{"s3"}); err != nil {
		t.Fatalf("alice marks s3: %v", err)
	}
	readers, err := store.SeenBy(f.ctx(), f.caller(f.alice), item)
	if err != nil {
		t.Fatalf("seen-by: %v", err)
	}
	if len(readers) != 1 || readers[0].UserID != f.alice {
		t.Fatalf("seen-by = %+v, want alice alone (bob has not finished v2)", readers)
	}
	if readers[0].DisplayName == "" || readers[0].SeenAt.IsZero() {
		t.Errorf("seen-by carries no name or time: %+v", readers[0])
	}

	// A third version that drops s1 and s3 and adds s4: alice's earlier reads
	// cannot be resurrected, and the new beat alone is owed again.
	cuAppend(t, f, f.alice, item, "Follow-up",
		cuStop("s4", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))
	got, ok = cuByID(cuList(t, f, f.alice, nil, nil, false), item)
	if !ok || got.UnseenStops != 1 || !got.Updated || got.LatestVersion != 3 {
		t.Errorf("after v3 = %+v, want 1 unseen, updated, latest 3", got)
	}

	view, err = store.GetWorkItem(f.ctx(), f.caller(f.bob), item)
	if err != nil {
		t.Fatalf("get work item: %v", err)
	}
	if view.Latest == nil || view.Latest.Version != 3 || view.LatestVersion != 3 {
		t.Fatalf("latest tour = %+v / %d, want version 3", view.Latest, view.LatestVersion)
	}
	if len(view.History) != 3 {
		t.Fatalf("history has %d headers, want 3: %+v", len(view.History), view.History)
	}
	if view.History[0].Version != 1 || view.History[2].Version != 3 {
		t.Errorf("history is not oldest-first: %+v", view.History)
	}
	if view.History[0].StopCount != 2 || view.History[0].Reason != "Found the cause" {
		t.Errorf("version 1's header = %+v, want 2 stops and the reason it was written with",
			view.History[0])
	}
	if got := view.Latest.Stops; len(got) != 1 || got[0].ID != "s4" || got[0].AddedInVersion != 3 {
		t.Errorf("latest stops = %+v, want the stamped s4", view.Latest.Stops)
	}
	if view.Latest.Stops[0].Narrative == "" {
		t.Errorf("the latest stop lost its narrative: %+v", view.Latest.Stops[0])
	}
}

// TestCatchUpStopEvidenceRoundTrip proves the tour's opaque members survive:
// evidence arrives as model-written JSON with keys the server does not own, and
// the read must hand back what was stored.
func TestCatchUpStopEvidenceRoundTrip(t *testing.T) {
	f := cnvSetup(t)
	item := cuItem(t, f, f.alice, "Evidence carried")
	stop := cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0)
	stop.Evidence = []domain.CatchUpEvidence{
		{Type: domain.CatchUpEvidenceDiff, Fields: map[string]any{"path": "internal/rate/limiter.go"}},
		{Type: domain.CatchUpEvidenceLog, Fields: map[string]any{"turn": float64(3)}},
	}
	cuAppend(t, f, f.alice, item, "First telling", stop)

	view, err := cuStore(f).GetWorkItem(f.ctx(), f.caller(f.alice), item)
	if err != nil {
		t.Fatalf("get work item: %v", err)
	}
	ev := view.Latest.Stops[0].Evidence
	if len(ev) != 2 {
		t.Fatalf("%d pieces of evidence, want 2", len(ev))
	}
	if ev[0].Type != domain.CatchUpEvidenceDiff || ev[0].Fields["path"] != "internal/rate/limiter.go" {
		t.Errorf("diff evidence = %+v, want its own path back", ev[0])
	}
	if ev[1].Type != domain.CatchUpEvidenceLog || ev[1].Fields["turn"] != float64(3) {
		t.Errorf("log evidence = %+v, want its own turn back", ev[1])
	}
}

// TestCatchUpMarkAllSeen is the "catch me up" button: it clears the caller's own
// list and nobody else's, and it does not resurrect a beat the caller had read.
func TestCatchUpMarkAllSeen(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	first := cuItem(t, f, f.alice, "One")
	second := cuItem(t, f, f.alice, "Two")
	cuAppend(t, f, f.alice, first, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))
	cuAppend(t, f, f.alice, second, "Told once",
		cuStop("s2", "UI CHANGE", domain.CatchUpImportanceWorthLook, 0),
		cuStop("s3", "ROUTINE", domain.CatchUpImportanceRoutine, 0))

	if items := cuList(t, f, f.alice, nil, nil, false); len(items) != 2 {
		t.Fatalf("%d unseen before mark-all, want 2", len(items))
	}
	marked, err := store.MarkAllSeen(f.ctx(), f.caller(f.alice), nil)
	if err != nil {
		t.Fatalf("mark all seen: %v", err)
	}
	if marked != 3 {
		t.Errorf("mark-all marked %d stops, want the 3 the two tours hold", marked)
	}
	if items := cuList(t, f, f.alice, nil, nil, false); len(items) != 0 {
		t.Errorf("mark-all left alice reading: %+v", items)
	}
	if items := cuList(t, f, f.bob, nil, nil, false); len(items) != 2 {
		t.Errorf("mark-all leaked to bob: %d unseen, want his own 2", len(items))
	}

	// Mark-all recorded version 1. A version 2 that carries s1 must leave s1 read
	// for alice (GREATEST-merge semantics) while owing her only the new beat.
	cuAppend(t, f, f.alice, first, "Rewritten",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 1),
		cuStop("s9", "YOUR CALL", domain.CatchUpImportanceMustKnow, 0))
	got, ok := cuByID(cuList(t, f, f.alice, nil, nil, false), first)
	if !ok || got.UnseenStops != 1 || !got.Updated {
		t.Errorf("after mark-all then a rewrite = %+v, want 1 unseen and updated", got)
	}

	// Naming a project the caller is not in cannot widen the set: the foreign
	// project's item stays out of alice's list even when asked for by id.
	other := cuForeignProject(t, f)
	foreign := cuStore(f)
	foreignItem, err := foreign.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: other, Shape: domain.CatchUpShapePush, Title: "Not alice's",
		Summary: "Somebody else's project.", Resolution: domain.CatchUpResolutionOpen,
	})
	if !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("writing into a project alice is not in = %v / %+v, want ErrCatchUpNotFound",
			err, foreignItem)
	}
}

// TestCatchUpMembershipScoping: a non-member of the project — inside the
// organization or out of it — sees nothing, names nothing, and is never told
// which of those two reasons it was.
func TestCatchUpMembershipScoping(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	item := cuItem(t, f, f.alice, "Members only")
	cuAppend(t, f, f.alice, item, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))

	// A viewer is a member: carl owes the same read alice owes.
	for _, user := range []string{f.bob, f.carl} {
		if items := cuList(t, f, user, nil, nil, false); len(items) != 1 {
			t.Errorf("member %s sees %d items, want the one", user, len(items))
		}
	}

	for name, user := range map[string]string{"outsider": f.outsider, "other org": f.mallory} {
		if items := cuList(t, f, user, nil, nil, true); len(items) != 0 {
			t.Errorf("%s sees %d items, want none: %+v", name, len(items), items)
		}
		c := f.caller(user)
		if _, err := store.GetWorkItem(f.ctx(), c, item); !errors.Is(err, domain.ErrCatchUpNotFound) {
			t.Errorf("%s read the work item: %v", name, err)
		}
		if _, err := store.MarkStopsSeen(f.ctx(), c, item, 1, []string{"s1"}); !errors.Is(err, domain.ErrCatchUpNotFound) {
			t.Errorf("%s marked a stop seen: %v", name, err)
		}
		if _, err := store.AppendTourVersion(f.ctx(), c, item, "", "Not theirs",
			[]domain.CatchUpStop{cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 1)}); !errors.Is(err, domain.ErrCatchUpNotFound) {
			t.Errorf("%s appended a tour version: %v", name, err)
		}
		if _, err := store.SeenBy(f.ctx(), c, item); !errors.Is(err, domain.ErrCatchUpNotFound) {
			t.Errorf("%s read the roster: %v", name, err)
		}
		if _, err := store.InsertDecisionReply(f.ctx(), c, item, "s1", "ship it"); !errors.Is(err, domain.ErrCatchUpNotFound) {
			t.Errorf("%s answered a decision: %v", name, err)
		}
		if n, err := store.MarkAllSeen(f.ctx(), c, nil); err != nil || n != 0 {
			t.Errorf("%s marked %d stops seen: %v", name, n, err)
		}
	}

	// The stranger's own attempt cannot be laundered through the project filter
	// either: naming the fixture project as a stranger yields the empty list,
	// and naming a project the caller IS in still cannot reach the other one.
	other := cuForeignProject(t, f)
	if items := cuList(t, f, f.outsider, []string{f.project}, nil, true); len(items) != 0 {
		t.Errorf("an outsider named the project directly and got %+v", items)
	}
	if items := cuList(t, f, f.alice, []string{f.project, other}, nil, true); len(items) != 1 {
		t.Errorf("naming a foreign project alongside her own changed alice's list: %+v", items)
	}

	// A work item that does not exist and one that is not the caller's are the
	// same error, so the store cannot be probed for ids.
	if _, err := store.GetWorkItem(f.ctx(), f.caller(f.alice),
		"00000000-0000-7000-8000-0000000000ff"); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("a gone work item = %v, want ErrCatchUpNotFound", err)
	}
	if _, err := store.ListUnseenWorkItems(f.ctx(), f.caller(f.alice),
		[]string{"not-a-uuid"}, nil, false); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("a malformed project id = %v, want ErrCatchUpValidation", err)
	}
}

// TestCatchUpVersionAtomicity drives the race the schema exists for: five appends
// to one item at once must produce 2,3,4,5,6 — no ties and no gaps, because a
// gap would mean a version a reader could never have been shown.
func TestCatchUpVersionAtomicity(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	item := cuItem(t, f, f.alice, "Contended tour")
	cuAppend(t, f, f.alice, item, "First telling",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))

	const writers = 5
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		versions []int
		errs     []error
	)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			ctx := f.ctx()
			_, err := store.AppendTourVersion(ctx, f.caller(f.alice), item, "",
				"Concurrent telling", []domain.CatchUpStop{
					cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 1),
					cuStop("sx", "UI CHANGE", domain.CatchUpImportanceWorthLook, 0),
				})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			versions = append(versions, n)
		}(i)
	}
	wg.Wait()
	if len(errs) > 0 {
		t.Fatalf("concurrent appends failed: %v (and %d more)", errs[0], len(errs)-1)
	}
	var head int
	f.queryRow(t, `SELECT max (version) FROM catchup_tour_versions WHERE work_item_id = $1::uuid`,
		item).into(t, &head)
	if head != writers+1 {
		t.Errorf("highest version = %d, want %d — the losers' retries did not land",
			head, writers+1)
	}
	count := 0
	f.queryRow(t, `SELECT count(*) FROM catchup_tour_versions WHERE work_item_id = $1::uuid`,
		item).into(t, &count)
	if count != writers+1 {
		t.Errorf("%d versions for %d+1 appends, want no gaps", count, writers)
	}
	// Every version number exists exactly once: the primary key is the arbiter,
	// and the store's retry is what keeps that invisible to the writer.
	for v := 1; v <= writers+1; v++ {
		var n int
		f.queryRow(t, `SELECT count(*) FROM catchup_tour_versions
			WHERE work_item_id = $1::uuid AND version = $2::int`, item, v).into(t, &n)
		if n != 1 {
			t.Errorf("version %d appears %d times, want once", v, n)
		}
	}
}

// TestCatchUpDecisionReply is the plain-text half of the design: the reply is
// stored with the WORK ITEM's conversation, never one the caller named, and only
// for a stop that actually asked.
func TestCatchUpDecisionReply(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	const conversation = "00000000-0000-7000-8000-0000000000aa"
	conv := conversation
	item, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: domain.CatchUpShapeIssue, Title: "Which branch?",
		Summary: "The fix needs a home.", Resolution: domain.CatchUpResolutionBranchReady,
		ConversationID: &conv,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	asking := cuStop("s1", "YOUR CALL", domain.CatchUpImportanceMustKnow, 0)
	asking.Decision = &domain.CatchUpDecision{
		Prompt:  "Which branch should this land on?",
		Options: []string{"main", "the release branch", "your call"}, AllowText: true,
	}
	quiet := cuStop("s2", "UI CHANGE", domain.CatchUpImportanceWorthLook, 0)
	cuAppend(t, f, f.alice, item.ID, "Asking", asking, quiet)

	reply, err := store.InsertDecisionReply(f.ctx(), f.caller(f.bob), item.ID, "s1",
		"  ship it to main, the release branch is frozen  ")
	if err != nil {
		t.Fatalf("insert decision reply: %v", err)
	}
	if reply.Text != "ship it to main, the release branch is frozen" {
		t.Errorf("reply text = %q, want it stored trimmed", reply.Text)
	}
	if reply.ConversationID == nil || *reply.ConversationID != conversation {
		t.Errorf("reply conversation = %v, want the work item's own %s",
			reply.ConversationID, conversation)
	}
	if reply.UserID != f.bob || reply.StopID != "s1" || reply.CreatedAt.IsZero() {
		t.Errorf("reply lost its owner, stop or time: %+v", reply)
	}
	var stored, storedConv string
	f.queryRow(t, `SELECT "text", coalesce (conversation_id::text, '')
		FROM catchup_decision_replies WHERE id = $1::uuid`, reply.ID).
		into(t, &stored, &storedConv)
	if stored != reply.Text || storedConv != conversation {
		t.Errorf("stored reply = %q / %q, want %q / %q",
			stored, storedConv, reply.Text, conversation)
	}

	// A stop that asked nothing is not answerable, and neither is a stop that is
	// not in the latest version.
	if _, err := store.InsertDecisionReply(f.ctx(), f.caller(f.bob), item.ID, "s2",
		"answering a statement"); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("reply to a stop with no decision = %v, want ErrCatchUpNotFound", err)
	}
	if _, err := store.InsertDecisionReply(f.ctx(), f.caller(f.bob), item.ID, "gone",
		"answering nothing"); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("reply to an unknown stop = %v, want ErrCatchUpNotFound", err)
	}
	if _, err := store.InsertDecisionReply(f.ctx(), f.caller(f.bob), item.ID, "s1", "   "); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("blank reply = %v, want ErrCatchUpValidation", err)
	}
	var rows int
	f.queryRow(t, `SELECT count(*) FROM catchup_decision_replies WHERE work_item_id = $1::uuid`,
		item.ID).into(t, &rows)
	if rows != 1 {
		t.Errorf("%d replies stored, want the one valid one", rows)
	}

	// Work with no conversation still records the reply: the question was asked
	// and the answer is a fact, it simply has nowhere to go yet.
	orphan := cuItem(t, f, f.alice, "No thread")
	cuAppend(t, f, f.alice, orphan, "Asking again", asking)
	orphanReply, err := store.InsertDecisionReply(f.ctx(), f.caller(f.alice), orphan, "s1",
		"main")
	if err != nil {
		t.Fatalf("reply on work with no conversation: %v", err)
	}
	if orphanReply.ConversationID != nil {
		t.Errorf("orphan reply invented a conversation: %v", *orphanReply.ConversationID)
	}
}

// TestCatchUpRecapAndVisits is the per-user cache: one reader's recap is never
// another's, and the visits the window suggestion is inferred from are the
// caller's own.
func TestCatchUpRecapAndVisits(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	if _, err := store.LatestRecap(f.ctx(), f.caller(f.alice)); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("a first-time reader's recap = %v, want ErrCatchUpNotFound", err)
	}
	saved, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text:   "Two agents shipped the rate limiter. One pushed docs. Nothing needed you.",
		Window: "24h", ProjectIDs: []string{f.project},
	})
	if err != nil {
		t.Fatalf("save recap: %v", err)
	}
	latest, err := store.LatestRecap(f.ctx(), f.caller(f.alice))
	if err != nil {
		t.Fatalf("latest recap: %v", err)
	}
	if latest.ID != saved.ID || latest.Text != saved.Text || latest.Window != "24h" {
		t.Errorf("latest recap = %+v, want the one just saved (%+v)", latest, saved)
	}
	if len(latest.ProjectIDs) != 1 || latest.ProjectIDs[0] != f.project {
		t.Errorf("recap covered %v, want the fixture project", latest.ProjectIDs)
	}
	// Regenerating keeps the old row (it is the generator's evaluation data) and
	// the newer one is what reads back.
	again, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text: "One agent pushed docs since you asked.", Window: "7d",
	})
	if err != nil {
		t.Fatalf("second recap: %v", err)
	}
	if again.ID == saved.ID {
		t.Errorf("regeneration overwrote the earlier recap")
	}
	latest, err = store.LatestRecap(f.ctx(), f.caller(f.alice))
	if err != nil {
		t.Fatalf("latest recap after regeneration: %v", err)
	}
	if latest.Window != "7d" {
		t.Errorf("latest window = %q, want the newest recap", latest.Window)
	}
	if _, err := store.LatestRecap(f.ctx(), f.caller(f.bob)); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("bob read alice's recap: %v", err)
	}
	if _, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text: "  ", Window: "24h",
	}); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("blank recap = %v, want ErrCatchUpValidation", err)
	}

	before, err := store.RecentVisits(f.ctx(), f.caller(f.alice))
	if err != nil {
		t.Fatalf("recent visits: %v", err)
	}
	if len(before) != 0 {
		t.Fatalf("%d visits before any were recorded", len(before))
	}
	for i := 0; i < 3; i++ {
		if err := store.RecordVisit(f.ctx(), f.caller(f.alice)); err != nil {
			t.Fatalf("record visit: %v", err)
		}
	}
	visits, err := store.RecentVisits(f.ctx(), f.caller(f.alice))
	if err != nil {
		t.Fatalf("recent visits: %v", err)
	}
	if len(visits) != 3 {
		t.Errorf("%d visits, want 3", len(visits))
	}
	for i := 1; i < len(visits); i++ {
		if visits[i].After(visits[i-1]) {
			t.Errorf("visits are not newest-first: %v", visits)
			break
		}
	}
	if others, err := store.RecentVisits(f.ctx(), f.caller(f.bob)); err != nil || len(others) != 0 {
		t.Errorf("bob's visits = %v / %v, want none of alice's", others, err)
	}
}

// TestCatchUpWorkItemIdentity and the write-path bounds: the run id is the
// re-grouping key, an explicit id is a revision of that one row, and nonsense is
// refused before anything reaches the table.
func TestCatchUpWorkItemIdentity(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	run := "00000000-0000-7000-8000-0000000000bb"
	runID := run

	first, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: domain.CatchUpShapePush, Title: "Commits on main",
		Summary: "Three commits, no PR.", Resolution: domain.CatchUpResolutionMerged,
		SourceRunID: &runID,
	})
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	second, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: domain.CatchUpShapePush, Title: "Commits on main",
		Summary:     "Three commits, no PR; the third is the fix.",
		Resolution:  domain.CatchUpResolutionMerged,
		SourceRunID: &runID,
	})
	if err != nil {
		t.Fatalf("re-describing the same run: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("the same run produced two work items: %s then %s", first.ID, second.ID)
	}
	var rows int
	f.queryRow(t, `SELECT count(*) FROM catchup_work_items WHERE project_id = $1::uuid`,
		f.project).into(t, &rows)
	if rows != 1 {
		t.Errorf("%d work items for one run, want one", rows)
	}

	// An explicit id is a revision of THAT row; an id that names nothing is not a
	// licence to create one.
	rev := domain.CatchUpWorkItem{
		ID: first.ID, ProjectID: f.project, Shape: domain.CatchUpShapePush,
		Title: "Commits on main (revised)", Summary: "The fix landed.",
		Resolution: domain.CatchUpResolutionMerged,
	}
	revised, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), rev)
	if err != nil {
		t.Fatalf("revise by id: %v", err)
	}
	if revised.ID != first.ID || revised.UpdatedAt.Before(first.UpdatedAt) {
		t.Errorf("revision = %+v, want the same id with the clock moved", revised)
	}
	var title string
	f.queryRow(t, `SELECT title FROM catchup_work_items WHERE id = $1::uuid`, first.ID).
		into(t, &title)
	if title != "Commits on main (revised)" {
		t.Errorf("stored title = %q, want the revision", title)
	}
	var storedRun *string
	f.queryRow(t, `SELECT source_run_id::text FROM catchup_work_items WHERE id = $1::uuid`,
		first.ID).into(t, &storedRun)
	if storedRun == nil || *storedRun != run {
		t.Errorf("provenance moved: %v, want the run it was born with", storedRun)
	}
	ghost := rev
	ghost.ID = "00000000-0000-7000-8000-0000000000cc"
	if _, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), ghost); !errors.Is(err, domain.ErrCatchUpNotFound) {
		t.Errorf("revising a work item that does not exist = %v, want ErrCatchUpNotFound", err)
	}
	f.queryRow(t, `SELECT count(*) FROM catchup_work_items WHERE project_id = $1::uuid`,
		f.project).into(t, &rows)
	if rows != 1 {
		t.Errorf("a refused revision left %d work items, want the one that was there", rows)
	}

	// Validation happens before the database, so a model that invents a shape
	// cannot write it at all.
	if _, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: "release", Title: "t", Summary: "s",
		Resolution: domain.CatchUpResolutionOpen,
	}); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("unknown shape = %v, want ErrCatchUpValidation", err)
	}
	if _, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: f.project, Shape: domain.CatchUpShapePR, Title: "  padded  ",
		Summary: "s", Resolution: domain.CatchUpResolutionOpen,
	}); err != nil {
		t.Errorf("padded title refused: %v", err)
	}
	var padded string
	f.queryRow(t, `SELECT title FROM catchup_work_items WHERE project_id = $1::uuid
		AND shape = 'pr'`, f.project).into(t, &padded)
	if padded != "padded" {
		t.Errorf("stored title = %q, want the trimmed form the CHECK requires", padded)
	}

	item := cuItem(t, f, f.alice, "Bad stops")
	if _, err := store.AppendTourVersion(f.ctx(), f.caller(f.alice), item, "", "",
		[]domain.CatchUpStop{cuStop("s1", "k", domain.CatchUpImportanceMustKnow, 0)}); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("blank reason = %v, want ErrCatchUpValidation", err)
	}
	if _, err := store.AppendTourVersion(f.ctx(), f.caller(f.alice), item, "", "Duplicated",
		[]domain.CatchUpStop{
			cuStop("s1", "k", domain.CatchUpImportanceMustKnow, 0),
			cuStop("s1", "k", domain.CatchUpImportanceWorthLook, 0),
		}); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("repeated stop id = %v, want ErrCatchUpValidation", err)
	}
	if _, err := store.AppendTourVersion(f.ctx(), f.caller(f.alice), item, "", "Empty",
		nil); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("a tour with no stops = %v, want ErrCatchUpValidation", err)
	}
	if _, err := store.AppendTourVersion(f.ctx(), f.caller(f.alice), item, "", "A tour",
		[]domain.CatchUpStop{cuStop("s1", "k", domain.CatchUpImportanceMustKnow, 0)}); err != nil {
		t.Errorf("the valid append after three refusals: %v", err)
	}
	// The refusals wrote nothing: the first accepted version is still 1.
	var head int
	f.queryRow(t, `SELECT coalesce (max (version), 0) FROM catchup_tour_versions
		WHERE work_item_id = $1::uuid`, item).into(t, &head)
	if head != 1 {
		t.Errorf("%d tour versions after three refusals, want the one accepted append", head)
	}
}

// TestCatchUpSinceFilter proves "since T" filters on the work having moved, and
// that appending a tour version is what moves it.
func TestCatchUpSinceFilter(t *testing.T) {
	f := cnvSetup(t)
	item := cuItem(t, f, f.alice, "Recently moved")
	cuAppend(t, f, f.alice, item, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))

	if items := cuList(t, f, f.alice, nil, timePtr(time.Now().Add(time.Hour)), false); len(items) != 0 {
		t.Errorf("a window entirely in the future returned %+v", items)
	}
	if items := cuList(t, f, f.alice, nil, timePtr(time.Now().Add(-time.Hour)), false); len(items) != 1 {
		t.Errorf("work from the last hour was not listed: %+v", items)
	}
	// Reading every stop does not move the work: a reader's own clicks must not
	// put the item back on the list for someone else filtering by time.
	if _, err := cuStore(f).MarkAllSeen(f.ctx(), f.caller(f.alice), nil); err != nil {
		t.Fatalf("mark all seen: %v", err)
	}
	var moved bool
	f.queryRow(t, `SELECT updated_at > now() - interval '30 seconds' FROM catchup_work_items
		WHERE id = $1::uuid`, item).into(t, &moved)
	if !moved {
		t.Errorf("updated_at is not the recent write: %v", moved)
	}
	if items := cuList(t, f, f.alice, nil, timePtr(time.Now().Add(time.Hour)), true); len(items) != 0 {
		t.Errorf("includeSeen leaked items outside the window: %+v", items)
	}
}

func timePtr(t time.Time) *time.Time { return &t }

// TestCatchUpProjectColorCheck is the palette as a database fact: a project's
// colour is one of eight or nothing at all, and the reads fall back without
// writing anything.
func TestCatchUpProjectColorCheck(t *testing.T) {
	f := cnvSetup(t)
	ctx := f.ctx()

	// NULL is the unset state, and it must read back as unset so the fallback
	// can tell "no choice" from "a choice".
	var color *string
	f.queryRow(t, `SELECT color FROM projects WHERE id = $1::uuid`, f.project).into(t, &color)
	if color != nil {
		t.Errorf("a fresh project already has a colour: %q", *color)
	}
	if got := domain.CatchUpProjectColorOr(f.project, ""); got == "" ||
		!domain.ValidCatchUpProjectColor(got) {
		t.Errorf("the fallback %q is not a palette colour", got)
	}

	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`UPDATE projects SET color = NULL WHERE id = $1::uuid`, f.project); err != nil {
			t.Errorf("restore the project's colour: %v", err)
		}
	})
	for _, want := range domain.CatchUpProjectPalette {
		if _, err := f.pool.Exec(ctx,
			`UPDATE projects SET color = $1 WHERE id = $2::uuid`, want, f.project); err != nil {
			t.Errorf("palette colour %q refused: %v", want, err)
		}
		var stored string
		f.queryRow(t, `SELECT color FROM projects WHERE id = $1::uuid`, f.project).
			into(t, &stored)
		if stored != want {
			t.Errorf("stored colour = %q, want %q", stored, want)
		}
	}

	// The state hues the design refused are refused by the table, not by a
	// component: green is "merged" on this screen, so it cannot also be a
	// project.
	for _, bad := range []string{"#ff0000", "#00ff00", "green", "#6a4bc4 ", "6a4bc4", "#6a4bc"} {
		_, err := f.pool.Exec(ctx, `UPDATE projects SET color = $1 WHERE id = $2::uuid`,
			bad, f.project)
		if err == nil {
			t.Errorf("colour %q was stored, want the CHECK to refuse it", bad)
			continue
		}
		if !strings.Contains(err.Error(), "projects_color_check") {
			t.Errorf("colour %q error = %v, want the CHECK named", bad, err)
		}
	}
	// Whatever the refusals tried, the column is still one of the eight.
	var final string
	f.queryRow(t, `SELECT color FROM projects WHERE id = $1::uuid`, f.project).into(t, &final)
	if !domain.ValidCatchUpProjectColor(final) || final == "" {
		t.Errorf("projects.color ended at %q, want a palette colour", final)
	}
}

// TestCatchUpCorruptStopsFailTheRead: a tour document that is no longer a tour is
// corruption, and a reader is better served an error than half a story.
func TestCatchUpCorruptStopsFailTheRead(t *testing.T) {
	f := cnvSetup(t)
	item := cuItem(t, f, f.alice, "Hand-edited tour")
	cuAppend(t, f, f.alice, item, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))

	// A stop with no importance is unrepresentable by accident (the write path
	// checked it), so reaching for the read is the only way to make one — and the
	// read must notice.
	f.exec(t, `UPDATE catchup_tour_versions
		SET stops = '[{"id":"s1","title":"t","narrative":"n","importance":"critical"}]'::jsonb
		WHERE work_item_id = $1::uuid`, item)
	if _, err := cuStore(f).GetWorkItem(f.ctx(), f.caller(f.alice), item); err == nil {
		t.Fatalf("a tour with an unknown importance was served")
	} else if !strings.Contains(err.Error(), "catchup tour stops") {
		t.Errorf("error = %v, want it to name the tour stops", err)
	}

	// An empty stop array is refused by the TABLE, so no writer — not even a
	// migration or a hand-edited row — can leave a tour with nothing to read.
	if _, err := f.pool.Exec(f.ctx(),
		`UPDATE catchup_tour_versions SET stops = '[]'::jsonb WHERE work_item_id = $1::uuid`,
		item); err == nil {
		t.Fatalf("a tour with zero stops was stored, want the CHECK to refuse it")
	} else if !strings.Contains(err.Error(), "catchup_tour_versions_stops_check") {
		t.Errorf("empty stops error = %v, want the CHECK named", err)
	}
	// A document that is not an array at all is the same refusal.
	if _, err := f.pool.Exec(f.ctx(),
		`UPDATE catchup_tour_versions SET stops = '{"id":"s1"}'::jsonb WHERE work_item_id = $1::uuid`,
		item); err == nil {
		t.Fatalf("a stop object stored as an object, want the CHECK to refuse it")
	}
}

// TestCatchUpSeenStateCascades says the quiet part of the schema out loud: a
// work item's tour, its readers' state and its replies all belong to the project,
// and deleting the project deletes them rather than orphaning them.
func TestCatchUpSeenStateCascades(t *testing.T) {
	f := cnvSetup(t)
	store := cuStore(f)
	item := cuItem(t, f, f.alice, "Doomed")
	cuAppend(t, f, f.alice, item, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.alice), item, 1, []string{"s1"}); err != nil {
		t.Fatalf("mark seen: %v", err)
	}
	// A throwaway project so the fixture's own rows survive the cascade check.
	other := cuForeignProject(t, f)
	f.exec(t, `INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')`, other, f.alice)
	doomed, err := store.UpsertWorkItem(f.ctx(), f.caller(f.alice), domain.CatchUpWorkItem{
		ProjectID: other, Shape: domain.CatchUpShapePR, Title: "Cascades",
		Summary: "Goes with the project.", Resolution: domain.CatchUpResolutionOpen,
	})
	if err != nil {
		t.Fatalf("upsert into the throwaway project: %v", err)
	}
	// The run this item's story is told about is a run of somebody else's
	// project — which is exactly why `catchup_work_item_runs.run_id` carries no
	// foreign key: a pruned run must not take the record of what it did, and
	// the item's own cascade must still take the link.
	cuAppendRun(t, f, f.alice, doomed.ID,
		"00000000-0000-7000-8000-0000000000dd", "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.alice), doomed.ID, 1,
		[]string{"s1"}); err != nil {
		t.Fatalf("mark the throwaway item seen: %v", err)
	}
	if _, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text: "One item, already gone.", Window: "24h", ProjectIDs: []string{other},
	}); err != nil {
		t.Fatalf("save the throwaway recap: %v", err)
	}
	count := func(q string, args ...any) int {
		var n int
		f.queryRow(t, q, args...).into(t, &n)
		return n
	}
	if count(`SELECT count(*) FROM catchup_seen_stops WHERE work_item_id = $1::uuid`,
		doomed.ID) == 0 {
		t.Fatalf("the throwaway item has no seen state to cascade")
	}

	// The throwaway project's own cleanup runs LIFO before cnvSetup's, so the
	// project row going here is what must take every catch-up row with it.
	if _, err := f.pool.Exec(f.ctx(), `DELETE FROM memberships WHERE project_id = $1::uuid`,
		other); err != nil {
		t.Fatalf("drop the throwaway membership: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx(), `DELETE FROM projects WHERE id = $1::uuid`,
		other); err != nil {
		t.Fatalf("delete the throwaway project: %v", err)
	}
	if left := count(`SELECT count(*) FROM catchup_work_items WHERE project_id = $1::uuid`,
		other); left != 0 {
		t.Errorf("%d work items outlived their project", left)
	}
	if left := count(`SELECT count(*) FROM catchup_tour_versions WHERE work_item_id = $1::uuid`,
		doomed.ID); left != 0 {
		t.Errorf("%d tour versions outlived their work item", left)
	}
	if left := count(`SELECT count(*) FROM catchup_decision_replies WHERE work_item_id = $1::uuid`,
		doomed.ID); left != 0 {
		t.Errorf("%d replies outlived their work item", left)
	}
	// 00029's link table has no foreign key on the run, so the ONLY thing that
	// can clean it is the item's own cascade — and an orphaned link would say a
	// gone item still owed a story.
	if left := count(`SELECT count(*) FROM catchup_work_item_runs WHERE work_item_id = $1::uuid`,
		doomed.ID); left != 0 {
		t.Errorf("%d run links outlived their work item", left)
	}
	// The fixture's own item is untouched by any of that.
	if left := count(`SELECT count(*) FROM catchup_seen_stops WHERE work_item_id = $1::uuid`,
		item); left == 0 {
		t.Errorf("the cascade reached into the fixture project's seen state")
	}

	// And a reader going takes that reader's personal state with them: seen rows,
	// visits and recaps are facts about a person, and a row beside an absent
	// subject is a fact about nothing.
	// The fixture's OWN item, not the throwaway one: that project is already
	// cascaded away at this point, and marking a gone item seen would prove
	// nothing about a reader's rows. Bob is a member of the fixture project, so
	// this is the membership-scoped write the cascade below is about.
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.bob), item, 1,
		[]string{"s1"}); err != nil {
		t.Fatalf("mark the fixture item seen as bob: %v", err)
	}
	if _, err := store.SaveRecap(f.ctx(), f.caller(f.bob), domain.CatchUpRecap{
		Text: "bob's own summary", Window: "7d", ProjectIDs: []string{other},
	}); err != nil {
		t.Fatalf("save bob's recap: %v", err)
	}
	if err := store.RecordVisit(f.ctx(), f.caller(f.bob)); err != nil {
		t.Fatalf("record bob's visit: %v", err)
	}
	// A reader is out-referenced by their memberships (00001 puts no cascade on
	// that table, and it is right not to: losing membership is losing a seat, not
	// a person), so the seat goes first and the person second — which is what
	// cnvFixture.delete does for the whole fixture, and what the reader-cascade
	// below is actually about: catchup's own rows follow the reader, memberships
	// never do.
	f.exec(t, `DELETE FROM memberships WHERE user_id = $1::uuid`, f.bob)
	if _, err := f.pool.Exec(f.ctx(), `DELETE FROM users WHERE id = $1::uuid`,
		f.bob); err != nil {
		t.Fatalf("delete a reader: %v", err)
	}
	f.extra = append(f.extra, f.bob) // the fixture's cleanup deletes by id
	for _, q := range []string{
		`SELECT count(*) FROM catchup_seen_stops WHERE user_id = $1::uuid`,
		`SELECT count(*) FROM catchup_visits WHERE user_id = $1::uuid`,
		`SELECT count(*) FROM catchup_recaps WHERE user_id = $1::uuid`,
	} {
		if left := count(q, f.bob); left != 0 {
			t.Errorf("%d rows outlived their reader (%s)", left, q)
		}
	}
}

// --- the generator's candidate read (T13a) --------------------------------

// TestCatchUpGeneratorCandidates proves the one statement that decides which
// runs are owed a story: terminal + recent + no tour that already covers the
// run's newest move. A running run, a run older than the window, and an item
// whose newest tour was written AFTER the run finished are all absent; a run
// that moved again after its tour comes back WITH the head stops a rewrite
// must inherit ids from; and a named project can only narrow the answer.
func TestCatchUpGeneratorCandidates(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	gen := APICatchUpGenerator{S: &CatchUpStore{Pool: f.pool}}
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	storeCaller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}

	insertRun := func(status string, finishedAgo time.Duration, runProject string) string {
		var id string
		var err error
		if status == "completed" || status == "failed" || status == "cancelled" {
			err = f.pool.QueryRow(ctx, `
				INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
				                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
				                  status, failed_cause, finished_at)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
				        $7, CASE WHEN $7 = 'failed' THEN 'agent_error' ELSE NULL END,
				        now() - $8::interval)
				RETURNING id`, f.orgID, runProject, f.pipelineID, f.revisionID, f.digest,
				f.planDigest, status, fmt.Sprintf("%d seconds", int(finishedAgo.Seconds()))).Scan(&id)
		} else {
			err = f.pool.QueryRow(ctx, `
				INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
				                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
				                  status)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, $7)
				RETURNING id`, f.orgID, runProject, f.pipelineID, f.revisionID, f.digest,
				f.planDigest, status).Scan(&id)
		}
		if err != nil {
			t.Fatalf("insert %s run: %v", status, err)
		}
		return id
	}
	owned := func(ids []string, id string) bool {
		for _, got := range ids {
			if got == id {
				return true
			}
		}
		return false
	}
	candRuns := func(cands []api.CatchUpCandidateView) []string {
		out := make([]string, 0, len(cands))
		for _, c := range cands {
			out = append(out, c.RunID)
		}
		return out
	}

	fresh := insertRun("completed", time.Hour, f.projectID)
	stale := insertRun("failed", 8*24*time.Hour, f.projectID) // outside the 7d window
	live := insertRun("running", 0, f.projectID)              // not terminal

	cands, err := gen.CatchUpCandidates(ctx, caller, nil, 7*24*time.Hour, 10)
	if err != nil {
		t.Fatalf("candidates: %v", err)
	}
	if runs := candRuns(cands); !owned(runs, fresh) || owned(runs, stale) || owned(runs, live) {
		t.Fatalf("candidates = %v, want only the fresh terminal run (stale=%s live=%s)", runs, stale, live)
	}

	// The work item lands — an item with no tour is NOT a claim: the run is
	// still owed a story, because the item's title alone tells nobody what
	// happened (ADR-0078 § Grouping).
	runID := fresh
	item, err := (&CatchUpStore{Pool: f.pool}).UpsertWorkItem(ctx, storeCaller, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapePR, Title: "Fresh work",
		Summary: "Told soon.", Resolution: domain.CatchUpResolutionOpen,
		SourceRunID: &runID,
	})
	if err != nil {
		t.Fatalf("upsert the work item: %v", err)
	}
	if cands, err = gen.CatchUpCandidates(ctx, caller, nil, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("candidates again: %v", err)
	} else if runs := candRuns(cands); !owned(runs, fresh) {
		t.Fatalf("an untoured item dropped its candidate run: %v", runs)
	}

	// A tour written for the run now (>= finished_at) is the claim that tells
	// it: the candidate is gone, and the run is on the item's record.
	if _, err := (&CatchUpStore{Pool: f.pool}).AppendTourVersion(ctx, storeCaller, item.ID, fresh,
		"Told once", []domain.CatchUpStop{cuStop("s1", "UI CHANGE", domain.CatchUpImportanceMustKnow, 0)}); err != nil {
		t.Fatalf("append the tour: %v", err)
	}
	var claims int
	if err := f.pool.QueryRow(ctx, `SELECT count(*)::integer FROM catchup_work_item_runs
		WHERE work_item_id = $1::uuid AND run_id = $2::uuid`, item.ID, fresh).Scan(&claims); err != nil {
		t.Fatalf("read the claim row: %v", err)
	}
	if claims != 1 {
		t.Fatalf("%d claim rows for the run that was told, want the one the append wrote", claims)
	}
	if cands, err = gen.CatchUpCandidates(ctx, caller, nil, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("post-tour candidates: %v", err)
	} else if runs := candRuns(cands); owned(runs, fresh) {
		t.Fatalf("a tour that covers the run did not clear the candidate: %v", runs)
	}

	// The run moves again (a new terminal attempt pushes finished_at): the
	// item is owed a rewrite, and the candidate carries the head stops whose
	// ids and introducing versions the rewrite must be able to inherit.
	if _, err := f.pool.Exec(ctx,
		`UPDATE runs SET finished_at = now() WHERE id = $1::uuid`, fresh); err != nil {
		t.Fatalf("move the run: %v", err)
	}
	cands, err = gen.CatchUpCandidates(ctx, caller, nil, 7*24*time.Hour, 10)
	if err != nil {
		t.Fatalf("moved-run candidates: %v", err)
	}
	var found *api.CatchUpCandidateView
	for i := range cands {
		if cands[i].RunID == fresh {
			found = &cands[i]
		}
	}
	if found == nil {
		t.Fatalf("a run that moved after its tour did not re-arm: %v", candRuns(cands))
	}
	if found.ItemID != item.ID || found.TourHead != 1 || len(found.HeadStops) != 1 ||
		found.HeadStops[0].ID != "s1" || found.HeadStops[0].AddedInVersion != 1 {
		t.Fatalf("candidate carries no rewritable head: %+v", *found)
	}

	// A named project can only narrow, and a stranger's list is empty.
	other := cuForeignProjectM4(t, f)
	if cands, err = gen.CatchUpCandidates(ctx, caller, []string{other}, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("narrowed candidates: %v", err)
	} else if len(cands) != 0 {
		t.Fatalf("naming a project widened the answer: %v", candRuns(cands))
	}
	if cands, err = gen.CatchUpCandidates(ctx, caller, []string{f.projectID}, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("project-named candidates: %v", err)
	} else if !owned(candRuns(cands), fresh) {
		t.Fatalf("naming the caller's own project dropped its candidate: %v", candRuns(cands))
	}
	if cands, err := gen.CatchUpCandidates(ctx, api.Caller{UserID: f.userID,
		OrganizationID: "00000000-0000-4000-8000-000000000000"}, nil, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("foreign-org candidates: %v", err)
	} else if len(cands) != 0 {
		t.Fatalf("another organization saw candidates: %v", candRuns(cands))
	}
}

// TestCatchUpGrouping is the grouping rule against a real PostgreSQL: two
// finished runs whose refs name the same issue are ONE piece of work — one
// work item, claimed by both runs, its refs the union of what each run named,
// its tour a second version whose carried-over beats keep the ids (and the
// introducing versions) the reader already has, with only the new beat owed.
// A run that names no number keeps its own item, and a group key is only
// unique inside a project.
func TestCatchUpGrouping(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := &CatchUpStore{Pool: f.pool}
	gen := APICatchUpGenerator{S: store}
	sc := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}

	insertRun := func(label string) string {
		var id string
		if err := f.pool.QueryRow(ctx, `
			INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
			                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
			                  status, failed_cause, finished_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
			        'failed', 'agent_error', now() - interval '30 minutes')
			RETURNING id`, f.orgID, f.projectID, f.pipelineID, f.revisionID,
			f.digest, f.planDigest).Scan(&id); err != nil {
			t.Fatalf("insert %s run: %v", label, err)
		}
		return id
	}
	runsOf := func(cands []api.CatchUpCandidateView) []string {
		out := make([]string, 0, len(cands))
		for _, c := range cands {
			out = append(out, c.RunID)
		}
		return out
	}
	owns := func(runs []string, id string) bool {
		for _, r := range runs {
			if r == id {
				return true
			}
		}
		return false
	}

	// The template run, then the fix run — the same issue, two runs, which is
	// the case the run-identity key used to split into two stories.
	failed, fix := insertRun("failed"), insertRun("fix")
	key := domain.CatchUpGroupKey("repository-uuid", 42, 7, failed)
	if key != "issue:repository-uuid:42" {
		t.Fatalf("group key = %q, want the issue's key", key)
	}
	if got := domain.CatchUpGroupKey("repository-uuid", 0, 7, fix); got != "pr:repository-uuid:7" {
		t.Fatalf("pr group key = %q, want the PR's key", got)
	}
	if got := domain.CatchUpGroupKey("", 42, 0, fix); got != "run:"+fix {
		t.Fatalf("numberless key = %q, want the run itself", got)
	}

	// Version 1 of the issue's item, told by the failed run.
	item, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapeIssue, Title: "Checkout went red",
		Summary: "Red, and not yet fixed.", Resolution: domain.CatchUpResolutionRunFailed,
		Refs:        domain.CatchUpRefs{IssueNumbers: []int{42}, CommitSHAs: []string{"aaa1111"}},
		SourceRunID: &failed, GroupKey: key,
	})
	if err != nil {
		t.Fatalf("upsert the issue item: %v", err)
	}
	if v := cuAppendM4(t, store, sc, item.ID, failed, "The run failed",
		domain.CatchUpStop{ID: "why-red", Title: "The test was red on a timeout",
			Narrative: "It timed out twice.", Importance: domain.CatchUpImportanceMustKnow}); v != 1 {
		t.Fatalf("first tour version = %d, want 1", v)
	}

	// The fix run is still owed a story — a claim from ANOTHER run does not
	// cover it — and its refs name the same piece of work.
	cands, err := gen.CatchUpCandidates(ctx, api.Caller{UserID: f.userID, OrganizationID: f.orgID,
		IsOrgAdmin: true}, []string{f.projectID}, 7*24*time.Hour, 10)
	if err != nil {
		t.Fatalf("candidates: %v", err)
	}
	if runs := runsOf(cands); !owns(runs, fix) || owns(runs, failed) {
		t.Fatalf("candidates = %v, want only the untold fix run (failed=%s)", runs, failed)
	}

	// The grouping read: the item the key names, with the head a rewrite
	// inherits. The second run's item is the FIRST run's item.
	head, found, err := gen.CatchUpItemForGroup(ctx, api.Caller{UserID: f.userID,
		OrganizationID: f.orgID, IsOrgAdmin: true}, f.projectID, key)
	// (the key is project-scoped: see the second-project check below)
	if err != nil || !found {
		t.Fatalf("group read = %v / %v, want the issue's item", found, err)
	}
	if head.ItemID != item.ID || head.TourHead != 1 || len(head.HeadStops) != 1 ||
		head.HeadStops[0].ID != "why-red" || head.HeadStops[0].AddedInVersion != 1 {
		t.Fatalf("group head = %+v, want the first run's item and tour", head)
	}
	if _, found, err := gen.CatchUpItemForGroup(ctx, api.Caller{UserID: f.userID,
		OrganizationID: "00000000-0000-4000-8000-000000000000", IsOrgAdmin: true},
		f.projectID, key); err != nil || found {
		t.Errorf("another organization saw the group: %v / %v", found, err)
	}

	// The fix run rewrites THAT item: the same id back, the refs unioned, the
	// run taken as the item's latest, and a second tour version whose carried
	// beat keeps version 1 while the fix is the only new stop.
	again, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapeIssue, Title: "Checkout went red",
		Summary: "Red, then green.", Resolution: domain.CatchUpResolutionBranchReady,
		Refs:        domain.CatchUpRefs{PRNumbers: []int{7}, CommitSHAs: []string{"bbb2222"}},
		SourceRunID: &fix, GroupKey: key,
	})
	if err != nil {
		t.Fatalf("regroup the fix run: %v", err)
	}
	if again.ID != item.ID {
		t.Fatalf("two runs on one issue wrote %s and %s, want ONE work item", item.ID, again.ID)
	}
	// The merge ran on the way in, so what the store echoes is the union — and
	// what the reader is served must be the union too.
	if got := again.Refs; len(got.IssueNumbers) != 1 || got.IssueNumbers[0] != 42 ||
		len(got.PRNumbers) != 1 || got.PRNumbers[0] != 7 ||
		len(got.CommitSHAs) != 2 || got.CommitSHAs[0] != "aaa1111" || got.CommitSHAs[1] != "bbb2222" {
		t.Errorf("merged refs = %+v, want both runs' claims", got)
	}
	if v := cuAppendM4(t, store, sc, item.ID, fix, "Fix landed after the failed run",
		domain.CatchUpStop{ID: "why-red", Title: "The test was red on a timeout",
			Narrative: "Still the cause.", Importance: domain.CatchUpImportanceMustKnow,
			AddedInVersion: 1},
		domain.CatchUpStop{ID: "fix-landed", Title: "The fix landed in PR #7",
			Narrative: "The retry shipped it.", Importance: domain.CatchUpImportanceMustKnow}); v != 2 {
		t.Fatalf("rewrite tour version = %d, want 2", v)
	}
	view, err := store.GetWorkItem(ctx, sc, item.ID)
	if err != nil {
		t.Fatalf("read the grouped item: %v", err)
	}
	if len(view.Refs.CommitSHAs) != 2 || len(view.Refs.IssueNumbers) != 1 ||
		len(view.Refs.PRNumbers) != 1 {
		t.Errorf("served refs = %+v, want the union of both runs", view.Refs)
	}
	if view.SourceRunID == nil || *view.SourceRunID != fix {
		t.Errorf("source_run_id = %v, want the latest run of the item", view.SourceRunID)
	}
	if view.LatestVersion != 2 || len(view.History) != 2 ||
		view.History[1].Reason != "Fix landed after the failed run" {
		t.Errorf("history = %+v, want the two versions with what changed", view.History)
	}
	if view.Latest == nil || len(view.Latest.Stops) != 2 ||
		view.Latest.Stops[0].AddedInVersion != 1 || view.Latest.Stops[1].AddedInVersion != 2 {
		t.Errorf("served tour = %+v, want the carried beat at v1 and the fix at v2", view.Latest)
	}

	// Both runs are on the item's record, and neither is owed a story now.
	var claimed []string
	rows, err := f.pool.Query(ctx, `
		SELECT run_id::text FROM catchup_work_item_runs WHERE work_item_id = $1::uuid
		ORDER BY run_id::text`, item.ID)
	if err != nil {
		t.Fatalf("read the item's runs: %v", err)
	}
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			t.Fatalf("scan the item's runs: %v", err)
		}
		claimed = append(claimed, r)
	}
	rows.Close()
	if len(claimed) != 2 {
		t.Fatalf("%v claimed by the item, want both runs", claimed)
	}
	if cands, err := gen.CatchUpCandidates(ctx, api.Caller{UserID: f.userID,
		OrganizationID: f.orgID, IsOrgAdmin: true}, []string{f.projectID},
		7*24*time.Hour, 10); err != nil {
		t.Fatalf("post-rewrite candidates: %v", err)
	} else if runs := runsOf(cands); owns(runs, fix) || owns(runs, failed) {
		t.Fatalf("a told piece of work came back as owed: %v", runs)
	}

	// A run that named no number keeps its own item: its key is itself, so no
	// existing story is rewritten by it.
	alone := insertRun("no refs")
	aloneKey := domain.CatchUpGroupKey("", 0, 0, alone)
	solo, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapePush, Title: "Commits on main",
		Summary: "Three commits, no PR.", Resolution: domain.CatchUpResolutionMerged,
		SourceRunID: &alone, GroupKey: aloneKey,
	})
	if err != nil {
		t.Fatalf("upsert the runless item: %v", err)
	}
	if solo.ID == item.ID {
		t.Fatal("a run with no refs was grouped into somebody else's item")
	}
	if _, found, err := gen.CatchUpItemForGroup(ctx, api.Caller{UserID: f.userID,
		OrganizationID: f.orgID, IsOrgAdmin: true}, f.projectID, "issue:repository-uuid:999"); err != nil || found {
		t.Errorf("an unused group key answered %v / %v, want not found", found, err)
	}

	// The key is unique INSIDE a project: the same issue in another of the
	// caller's projects is a different piece of work.
	second := cuSecondProjectM4(t, f)
	other, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: second, Shape: domain.CatchUpShapeIssue, Title: "Same issue, other project",
		Summary: "Another project's #42.", Resolution: domain.CatchUpResolutionOpen,
		GroupKey: key,
	})
	if err != nil {
		t.Fatalf("the same key in another project: %v", err)
	}
	if other.ID == item.ID {
		t.Fatal("a group key reached across projects")
	}

	// And an item with no grouping key at all still behaves the way it always
	// did: re-describing the same run updates it rather than doubling it.
	repeat := insertRun("repeat")
	repeatID := repeat
	firstPass, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapePush, Title: "Ungrouped",
		Summary: "No key at all.", Resolution: domain.CatchUpResolutionNoCode,
		SourceRunID: &repeatID,
	})
	if err != nil {
		t.Fatalf("ungrouped upsert: %v", err)
	}
	secondPass, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapePush, Title: "Ungrouped, retold",
		Summary: "Still no key.", Resolution: domain.CatchUpResolutionNoCode,
		SourceRunID: &repeatID,
	})
	if err != nil {
		t.Fatalf("ungrouped re-describe: %v", err)
	}
	if secondPass.ID != firstPass.ID {
		t.Errorf("ungrouped run wrote %s then %s, want one item", firstPass.ID, secondPass.ID)
	}

	// A nonsense key is refused before the database, like every other field
	// the model could reach.
	if _, err := store.UpsertWorkItem(ctx, sc, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapeIssue, Title: "Bad key",
		Summary: "Invented.", Resolution: domain.CatchUpResolutionOpen,
		GroupKey: "totally-made-up",
	}); !errors.Is(err, domain.ErrCatchUpValidation) {
		t.Errorf("group key %q = %v, want ErrCatchUpValidation", "totally-made-up", err)
	}
}

// cuAppendM4 appends one tour version (claiming runID) with the store's own
// race-safe append, from the m4 fixture whose caller type is the api's.
func cuAppendM4(t *testing.T, s *CatchUpStore, c Caller, itemID, runID, reason string,
	stops ...domain.CatchUpStop) int {
	t.Helper()
	v, err := s.AppendTourVersion(testCtx(t), c, itemID, runID, reason, stops)
	if err != nil {
		t.Fatalf("append tour version to %s: %v", itemID, err)
	}
	return v.Version
}

// cuSecondProjectM4 is a project of the same organization the caller IS a
// member of — the other half of "unique inside a project", which a foreign
// project cannot show (the write would be refused before the index saw it).
func cuSecondProjectM4(t *testing.T, f *m4Fixture) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'cu-second-' || substr(md5(random()::text), 1, 10), 'CU second', $2)
		RETURNING id`, f.orgID, f.userID).Scan(&id); err != nil {
		t.Fatalf("insert second project: %v", err)
	}
	if _, err := f.pool.Exec(testCtx(t),
		`INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')`,
		id, f.userID); err != nil {
		t.Fatalf("join the caller to the second project: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg, `DELETE FROM catchup_work_items WHERE project_id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup second project items: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM memberships WHERE project_id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup second project memberships: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM projects WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup second project: %v", err)
		}
	})
	return id
}

func cuForeignProjectM4(t *testing.T, f *m4Fixture) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'cu-foreign-' || substr(md5(random()::text), 1, 10), 'CU foreign', $2)
		RETURNING id`, f.orgID, f.userID).Scan(&id); err != nil {
		t.Fatalf("insert foreign project: %v", err)
	}
	// `created_by` is an FK to THIS user, and the shared m4Fixture cleanup
	// deletes only its own project before deleting the user — so a project
	// made here outlives the row that may drop it (CI run 42442085565:
	// projects_created_by_fkey). t.Cleanup is LIFO, and the fixture registered
	// its own cleanup first, so registering one here deletes this project
	// BEFORE the fixture gets to the user.
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM projects WHERE id = $1::uuid`, id); err != nil {
			t.Errorf("cleanup foreign project %s: %v", id, err)
		}
	})
	return id
}
