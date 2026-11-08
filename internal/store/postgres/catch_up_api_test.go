package postgres

// APICatchUpStore (ADR-0078 § Migration, "the routes") against a real
// PostgreSQL. The store's own tests prove the data rule; these prove the three
// things the adapter exists to add and nothing else: the project chip (a NULL
// colour served as the deterministic pick by project id, never as an empty
// string), the per-reader view of a shared tour (a beat carried into a new
// version is still read, the beat the rewrite added is not, and
// `you_saw_version` is the version this reader last recorded anything at), and
// the refusal that is audited against the project it was refused in while the
// wire answer stays the same 404 a deleted row gets.
//
// These tests skip unless COMMUNICATION_TEST_DATABASE_URL is set; CI runs them
// on PostgreSQL 18, which is the only way any of it is actually known.

import (
	"errors"
	"testing"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

// cuAPI is the api-facing adapter with the same ProjectStore serve.go hands it
// for audit denials.
func cuAPI(f *cnvFixture) APICatchUpStore {
	return APICatchUpStore{S: cuStore(f), Denials: &ProjectStore{Pool: f.pool}}
}

func cuCaller(f *cnvFixture, user string) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.orgID}
}

// cuElseOrgCaller is mallory as she actually is: a different organization
// entirely, not a member of this one pretending to be one.
func cuElseOrgCaller(f *cnvFixture, user string) api.Caller {
	return api.Caller{UserID: user, OrganizationID: f.elseOrg}
}

// cuTour is a two-beat story: one must_know and one worth_a_look, so "the top
// importance of the newest version" has an answer that is not the first one.
func cuTour() []domain.CatchUpStop {
	return []domain.CatchUpStop{
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceWorthLook, 0),
		cuStop("s2", "UI CHANGE", domain.CatchUpImportanceMustKnow, 0),
	}
}

func cuAsked(id string) domain.CatchUpStop {
	s := cuStop(id, "YOUR CALL", domain.CatchUpImportanceMustKnow, 0)
	s.Decision = &domain.CatchUpDecision{
		Prompt:  "Which branch should this have gone to?",
		Options: []string{"retry-backoff", "main"}, AllowText: false,
	}
	return s
}

// cuDeniedCount counts the audit rows one action wrote against one project —
// the ADR-0014 § 3 half of a 404 that a client never sees.
func cuDeniedCount(t *testing.T, f *cnvFixture, project, action string) int {
	t.Helper()
	var n int
	f.queryRow(t, `SELECT count(*) FROM audit_events WHERE project_id = $1::uuid
		AND action = $2 AND outcome = 'denied'`, project, action).into(t, &n)
	return n
}

func TestCatchUpAPIListChipAndShape(t *testing.T) {
	f := cnvSetup(t)
	a := cuAPI(f)
	item := cuItem(t, f, f.alice, "Rate limiter")
	cuAppend(t, f, f.alice, item, "Told once", cuTour()...)

	// projects.color is NULL here: the chip must carry the deterministic pick
	// by project id, which is the same answer on every replica and after a
	// rename, and is why nothing was backfilled.
	wantColor := domain.CatchUpProjectColor(f.project)
	list, err := a.ListCatchUpItems(f.ctx(), cuCaller(f, f.alice), api.CatchUpListFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("items = %d, want the one", len(list.Items))
	}
	got := list.Items[0]
	if got.ID != item || got.Project.ID != f.project || got.Project.Name == "" {
		t.Errorf("row = %+v, want the item and a named project", got)
	}
	if got.Project.Color != wantColor {
		t.Errorf("color = %q, want the palette fallback %q", got.Project.Color, wantColor)
	}
	if got.TotalStops != 2 || got.UnseenStops != 2 {
		t.Errorf("stops = %d total / %d unseen, want 2 and 2", got.TotalStops, got.UnseenStops)
	}
	if got.Importance != string(domain.CatchUpImportanceMustKnow) {
		t.Errorf("importance = %q, want the tour's TOP importance (must_know)", got.Importance)
	}
	if list.TotalUnseen != 1 || list.OldestUnseenAt == nil {
		t.Errorf("totals = %d / %v, want 1 and a timestamp", list.TotalUnseen, list.OldestUnseenAt)
	}
	if list.Items[0].UpdatedAt.IsZero() || list.Items[0].CreatedAt.IsZero() {
		t.Error("the row's own clocks are missing")
	}

	// A chosen colour is never overridden by the fallback.
	f.exec(t, `UPDATE projects SET color = '#2f6f9a' WHERE id = $1::uuid`, f.project)
	list, err = a.ListCatchUpItems(f.ctx(), cuCaller(f, f.alice), api.CatchUpListFilter{})
	if err != nil {
		t.Fatalf("list after the colour was chosen: %v", err)
	}
	if list.Items[0].Project.Color != "#2f6f9a" {
		t.Errorf("color = %q, want the maintainer's choice", list.Items[0].Project.Color)
	}

	// include_seen keeps the caught-up item and the totals stop counting it:
	// the badge is what is owed, not what is on the page.
	if _, err := cuStore(f).MarkStopsSeen(f.ctx(), f.caller(f.alice), item, 1,
		[]string{"s1", "s2"}); err != nil {
		t.Fatalf("mark both beats seen: %v", err)
	}
	list, err = a.ListCatchUpItems(f.ctx(), cuCaller(f, f.alice),
		api.CatchUpListFilter{IncludeSeen: true})
	if err != nil {
		t.Fatalf("list with include_seen: %v", err)
	}
	if len(list.Items) != 1 || list.TotalUnseen != 0 || list.OldestUnseenAt != nil {
		t.Errorf("seen row = %+v, totals %d/%v, want the item kept and nothing owed",
			list.Items, list.TotalUnseen, list.OldestUnseenAt)
	}
}

// TestCatchUpAPIItemSeenFlags is the shared-story / private-reading split at the
// HTTP shape: alice read version 1, version 2 carried s1 and added s3, so she
// owes exactly one beat of the two, and the beat she read is STILL read.
func TestCatchUpAPIItemSeenFlags(t *testing.T) {
	f := cnvSetup(t)
	a, store := cuAPI(f), cuStore(f)
	item := cuItem(t, f, f.alice, "Rewritten")
	cuAppend(t, f, f.alice, item, "First account",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0))
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.alice), item, 1, []string{"s1"}); err != nil {
		t.Fatalf("mark s1 seen at v1: %v", err)
	}
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.bob), item, 1, []string{"s1"}); err != nil {
		t.Fatalf("mark s1 seen as bob: %v", err)
	}
	cuAppend(t, f, f.alice, item, "Fix landed, stop 3 added",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 1),
		cuStop("s3", "UI CHANGE", domain.CatchUpImportanceWorthLook, 0))

	view, err := a.GetCatchUpItem(f.ctx(), cuCaller(f, f.alice), item)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Latest == nil || view.Latest.Version != 2 || len(view.Latest.Stops) != 2 {
		t.Fatalf("latest = %+v, want version 2 with two beats", view.Latest)
	}
	byID := map[string]api.CatchUpStopView{}
	for _, s := range view.Latest.Stops {
		byID[s.ID] = s
	}
	if !byID["s1"].Seen || byID["s1"].AddedInVersion != 1 {
		t.Errorf("s1 = %+v, want read and stamped as arriving in version 1", byID["s1"])
	}
	if byID["s3"].Seen || byID["s3"].AddedInVersion != 2 {
		t.Errorf("s3 = %+v, want unseen and stamped as version 2", byID["s3"])
	}
	if view.UnseenStops != 1 || view.TotalStops != 2 {
		t.Errorf("owes %d of %d, want 1 of 2", view.UnseenStops, view.TotalStops)
	}
	if view.YouSawVersion == nil || *view.YouSawVersion != 1 {
		t.Errorf("you_saw_version = %v, want 1 (the version she last recorded anything at)",
			view.YouSawVersion)
	}
	// The roster is "who finished the NEWEST version": neither reader has.
	if len(view.SeenBy) != 0 {
		t.Errorf("seen_by = %+v, want nobody while s3 is owed", view.SeenBy)
	}
	if len(view.History) != 2 || view.History[0].Version != 1 || view.History[1].Version != 2 {
		t.Errorf("history = %+v, want both version headers oldest first", view.History)
	}
	if view.Project.Color == "" || view.Project.Name == "" {
		t.Errorf("chip = %+v, want a name and a colour", view.Project)
	}

	// Bob finishes v2: he joins the roster, alice (who still owes s3) does not.
	if _, err := store.MarkStopsSeen(f.ctx(), f.caller(f.bob), item, 2, []string{"s3"}); err != nil {
		t.Fatalf("bob reads s3: %v", err)
	}
	view, err = a.GetCatchUpItem(f.ctx(), cuCaller(f, f.alice), item)
	if err != nil {
		t.Fatalf("get after bob caught up: %v", err)
	}
	if len(view.SeenBy) != 1 || view.SeenBy[0].ID != f.bob || view.SeenBy[0].Name == "" {
		t.Errorf("seen_by = %+v, want bob alone, by name", view.SeenBy)
	}

	// A reader who never marked anything has no version at all — which is what
	// makes NEW and UPDATED two different badges rather than one guess.
	fresh, err := a.GetCatchUpItem(f.ctx(), cuCaller(f, f.carl), item)
	if err != nil {
		t.Fatalf("get as carl: %v", err)
	}
	if fresh.YouSawVersion != nil {
		t.Errorf("you_saw_version = %v, want null for a reader who never marked a beat",
			*fresh.YouSawVersion)
	}
	if fresh.UnseenStops != 2 {
		t.Errorf("carl owes %d, want both beats", fresh.UnseenStops)
	}
}

// TestCatchUpAPIForeignReadIsFourOhFourAndAudited is the whole ADR-0014 § 3
// shape on this surface: the wire answer is the 404 a deleted item gets, and the
// audit row — which is the only half that knows which project was refused — is
// written by the adapter, because the handler has no project to name.
func TestCatchUpAPIForeignReadIsFourOhFourAndAudited(t *testing.T) {
	f := cnvSetup(t)
	a := cuAPI(f)
	item := cuItem(t, f, f.alice, "Members only")
	cuAppend(t, f, f.alice, item, "Told once", cuTour()...)

	for name, c := range map[string]api.Caller{
		"outsider":  cuCaller(f, f.outsider),
		"other org": cuElseOrgCaller(f, f.mallory),
	} {
		if _, err := a.GetCatchUpItem(f.ctx(), c, item); !errors.Is(err, api.ErrCatchUpNotFound) {
			t.Errorf("%s read the item: %v, want ErrCatchUpNotFound", name, err)
		}
		if _, err := a.CatchUpStopQuestion(f.ctx(), c, item, "s1"); !errors.Is(err, api.ErrCatchUpNotFound) {
			t.Errorf("%s read a beat: %v, want ErrCatchUpNotFound", name, err)
		}
		if err := a.MarkCatchUpStopsSeen(f.ctx(), c, item, 1, []string{"s1"}); !errors.Is(err, api.ErrCatchUpNotFound) {
			t.Errorf("%s marked seen: %v, want ErrCatchUpNotFound", name, err)
		}
	}
	// Both strangers' attempts are auditable against the project they were
	// aimed at: the row that says "not yours to see" knows the project, and the
	// 404 that must not explain itself does not carry it (ADR-0014 § 3). Two
	// callers, one read each, at least two rows.
	if n := cuDeniedCount(t, f, f.project, "catchup.item.read"); n < 2 {
		t.Errorf("%d denial rows for two refused reads, want at least one per attempt", n)
	}

	// A guessed id writes nothing: there is no project to audit against, and a
	// caller-chosen uuid does not belong in the ledger.
	before := cuDeniedCount(t, f, f.project, "catchup.item.read")
	if _, err := a.GetCatchUpItem(f.ctx(), cuCaller(f, f.outsider),
		"00000000-0000-7000-8000-0000000000fe"); !errors.Is(err, api.ErrCatchUpNotFound) {
		t.Errorf("a guessed id = %v, want ErrCatchUpNotFound", err)
	}
	if after := cuDeniedCount(t, f, f.project, "catchup.item.read"); after != before {
		t.Errorf("a guessed id wrote %d more denials, want 0", after-before)
	}
}

// TestCatchUpAPIStopQuestion is the reply route's read: the question a beat
// asked, and one not-found answer for every way a reply can be aimed at nothing.
func TestCatchUpAPIStopQuestion(t *testing.T) {
	f := cnvSetup(t)
	a := cuAPI(f)
	item := cuItem(t, f, f.alice, "Your call")
	cuAppend(t, f, f.alice, item, "Told once",
		cuStop("s1", "BUG · FIXED", domain.CatchUpImportanceMustKnow, 0),
		cuAsked("s2"))

	q, err := a.CatchUpStopQuestion(f.ctx(), cuCaller(f, f.alice), item, "s2")
	if err != nil {
		t.Fatalf("question: %v", err)
	}
	if q == nil || q.AllowText || len(q.Options) != 2 || q.Options[0] != "retry-backoff" {
		t.Errorf("question = %+v, want the two labels the beat offered, no free text", q)
	}
	for _, tc := range []struct{ what, stop string }{
		{"a beat that asked nothing", "s1"},
		{"a beat that is not in the newest tour", "s9"},
	} {
		if _, err := a.CatchUpStopQuestion(f.ctx(), cuCaller(f, f.alice), item, tc.stop); !errors.Is(err, api.ErrCatchUpNotFound) {
			t.Errorf("%s = %v, want ErrCatchUpNotFound", tc.what, err)
		}
	}

	// The reply itself: stored with the conversation the WORK ITEM names, and
	// the question's own options are what the route (not this layer) checks.
	withChat := cuItem(t, f, f.alice, "With a thread")
	cuAppend(t, f, f.alice, withChat, "Told once",
		cuStop("quiet", "UI CHANGE", domain.CatchUpImportanceRoutine, 0), cuAsked("d1"))
	record, err := a.InsertCatchUpDecisionReply(f.ctx(), cuCaller(f, f.alice), withChat, "d1", "main")
	if err != nil {
		t.Fatalf("reply: %v", err)
	}
	if record.ID == "" || record.Text != "main" || record.StopID != "d1" {
		t.Errorf("record = %+v, want the trimmed text stored with its beat", record)
	}
	if record.ConversationID != nil {
		t.Errorf("conversation = %v, want none: the work item named no thread", *record.ConversationID)
	}
	// A beat that asked nothing stores nothing, and says so with the same 404
	// the missing beat gets: the store's own write is the authority there, and
	// a reply that reached no listener would be a record of a send that never
	// had a question behind it.
	if _, err := a.InsertCatchUpDecisionReply(f.ctx(), cuCaller(f, f.alice), withChat,
		"quiet", "an answer in search of a question"); !errors.Is(err, api.ErrCatchUpNotFound) {
		t.Errorf("a beat with no decision = %v, want ErrCatchUpNotFound", err)
	}
	var stored int
	f.queryRow(t, `SELECT count(*) FROM catchup_decision_replies WHERE work_item_id = $1::uuid`,
		withChat).into(t, &stored)
	if stored != 1 {
		t.Errorf("%d replies stored, want the one the asking beat received", stored)
	}
}

// TestCatchUpAPIRecapOverlap is the personal read with the projects the caller
// named applied as COVERAGE: one row per reader, so "the recap for what is on my
// screen" is the newest row that touches those projects, and a recap that
// covered a different one is not it.
func TestCatchUpAPIRecapOverlap(t *testing.T) {
	f := cnvSetup(t)
	a, store := cuAPI(f), cuStore(f)
	other := cuForeignProject(t, f)
	f.exec(t, `INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, 'maintainer')`, other, f.alice)

	if _, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text: "About the fixture project only.", Window: "24h", ProjectIDs: []string{f.project},
	}); err != nil {
		t.Fatalf("save the fixture recap: %v", err)
	}
	if _, err := store.SaveRecap(f.ctx(), f.caller(f.alice), domain.CatchUpRecap{
		Text: "The newest one, about the other project.", Window: "7d", ProjectIDs: []string{other},
	}); err != nil {
		t.Fatalf("save the newer recap: %v", err)
	}

	// No projects named: the newest row, whatever it covered.
	got, err := a.LatestCatchUpRecap(f.ctx(), cuCaller(f, f.alice), nil)
	if err != nil {
		t.Fatalf("latest recap: %v", err)
	}
	if got.Text != "The newest one, about the other project." || got.Window != "7d" {
		t.Errorf("recap = %+v, want the newest row", got)
	}
	// Named to the project the NEWER row did not cover: the older row answers,
	// because coverage is what the filter asks about, not recency alone.
	got, err = a.LatestCatchUpRecap(f.ctx(), cuCaller(f, f.alice), []string{f.project})
	if err != nil {
		t.Fatalf("recap for the fixture project: %v", err)
	}
	if got.Text != "About the fixture project only." {
		t.Errorf("recap = %q, want the row whose coverage touches the named project", got.Text)
	}
	// A project the reader is not in contributes nothing: naming it alongside
	// one that no recap covers is the same not-found as no recap at all.
	foreign := cuForeignProject(t, f)
	if _, err := a.LatestCatchUpRecap(f.ctx(), cuCaller(f, f.bob),
		[]string{foreign}); !errors.Is(err, api.ErrCatchUpNotFound) {
		t.Errorf("a recap read naming a project bob is not in = %v, want ErrCatchUpNotFound", err)
	}
	// bob has never had one at all.
	if _, err := a.LatestCatchUpRecap(f.ctx(), cuCaller(f, f.bob), nil); !errors.Is(err, api.ErrCatchUpNotFound) {
		t.Errorf("bob's own read = %v, want ErrCatchUpNotFound", err)
	}
}

// TestCatchUpAPITourShapeFollowsTheNewestVersion guards the one thing a
// two-statement list read can get wrong: the unseen count and the beat count
// must describe the SAME tour version, or a row says "2 of 5 unseen" out of two
// different stories. Writing version 2 between the two statements would show up
// here as a total that does not match what the reader owes.
func TestCatchUpAPITourShapeFollowsTheNewestVersion(t *testing.T) {
	f := cnvSetup(t)
	a := cuAPI(f)
	item := cuItem(t, f, f.alice, "Steady story")
	cuAppend(t, f, f.alice, item, "First account", cuTour()...)

	list, err := a.ListCatchUpItems(f.ctx(), cuCaller(f, f.alice), api.CatchUpListFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if list.Items[0].TotalStops != 2 || list.Items[0].UnseenStops != 2 {
		t.Errorf("row = %+v, want 2 of 2", list.Items[0])
	}
	// A tour written for some OTHER item must not move this row's shape.
	second := cuItem(t, f, f.alice, "The other story")
	cuAppend(t, f, f.alice, second, "Three beats",
		cuStop("a", "k", domain.CatchUpImportanceRoutine, 0),
		cuStop("b", "k", domain.CatchUpImportanceRoutine, 0),
		cuStop("c", "k", domain.CatchUpImportanceRoutine, 0))
	list, err = a.ListCatchUpItems(f.ctx(), cuCaller(f, f.alice), api.CatchUpListFilter{IncludeSeen: true})
	if err != nil {
		t.Fatalf("list with a second item: %v", err)
	}
	byID := map[string]api.CatchUpListItemView{}
	for _, it := range list.Items {
		byID[it.ID] = it
	}
	if byID[item].TotalStops != 2 || byID[second].TotalStops != 3 {
		t.Errorf("shapes = %d and %d, want 2 and 3 — each item counted its own tour",
			byID[item].TotalStops, byID[second].TotalStops)
	}
	if byID[second].Importance != string(domain.CatchUpImportanceRoutine) {
		t.Errorf("second item importance = %q, want routine (its own top beat)",
			byID[second].Importance)
	}
	if byID[item].UnseenStops != 2 || byID[second].UnseenStops != 3 {
		t.Errorf("unseen = %d / %d, want both stories owed in full (2 and 3)",
			byID[item].UnseenStops, byID[second].UnseenStops)
	}
	if list.TotalUnseen != 2 || list.OldestUnseenAt == nil {
		t.Errorf("totals = %d / %v, want two items owed and a timestamp",
			list.TotalUnseen, list.OldestUnseenAt)
	}
}
