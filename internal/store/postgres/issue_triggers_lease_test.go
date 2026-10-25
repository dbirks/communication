package postgres

// Lease-stuck lab regression, B half (gh-loop 2026-10-25, trigger
// 01a17351-7fd7): one tick fired issue #11 and then parked forever — a
// second matching issue's create-run opened its own transaction behind the
// journal advisory lock the fire's own transaction already held — so the
// fire never committed (last_polled_at stayed NULL), the ticker goroutine
// never returned, the replica stopped polling entirely, and every other
// replica's due claim skipped the locked row WITHOUT recording anything.
// Issue #12 got its label 70 minutes later and nothing ever looked.
//
// The three properties these tests pin against real Postgres:
//   - every poll records last_polled_at (and last_error when it failed);
//   - the tick is bounded per trigger (issueTriggerPollTimeout /
//     PollTimeout) and keeps looping after an errored or hung poll; and
//   - a poll that matches MULTIPLE issues fires them all — the lab's
//     self-deadlock shape, now impossible because the run create rides the
//     fire's own transaction as a savepoint.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// itPollState reads the poll bookkeeping the operator sees.
func itPollState(t *testing.T, ctx context.Context, f *itFixture, id string) (sql.NullTime, sql.NullString) {
	t.Helper()
	var polled sql.NullTime
	var lastErr sql.NullString
	if err := f.pool.QueryRow(ctx,
		`SELECT last_polled_at, last_error FROM issue_triggers WHERE id = $1::uuid`, id).
		Scan(&polled, &lastErr); err != nil {
		t.Fatalf("read trigger poll state: %v", err)
	}
	return polled, lastErr
}

// waitTick runs one TickIssueTriggers and fails if it does not return: the
// lab's tick never came back, and "never returns" must read as a failure,
// never as a hanging test.
func waitTick(t *testing.T, ctx context.Context, f *itFixture, now time.Time, lister github.IssueLister, budget time.Duration) (int, error) {
	t.Helper()
	type res struct {
		n   int
		err error
	}
	ch := make(chan res, 1)
	go func() {
		n, err := f.triggers.TickIssueTriggers(ctx, now, lister)
		ch <- res{n, err}
	}()
	select {
	case r := <-ch:
		return r.n, r.err
	case <-time.After(budget):
		t.Fatalf("TickIssueTriggers did not return within %s — the tick is wedged again", budget)
		return 0, nil
	}
}

// blockingLister hangs until its caller's context ends (the shape of a
// GitHub whose TCP connection goes quiet), then answers with the context
// error — exactly what the wired github client does on a deadline.
type blockingLister struct{}

func (blockingLister) ListIssues(ctx context.Context, _ github.Repository, _ github.IssueQuery, _ string) ([]github.Issue, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// TestIssueTriggerPollSetsLastPolled: a completed poll lands last_polled_at
// on the row even when nothing matched — the bookkeeping answers "we looked"
// independently of whether the look found anything.
func TestIssueTriggerPollSetsLastPolled(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	before, _ := itPollState(t, ctx, f, trigger.ID)
	if before.Valid {
		t.Fatalf("fresh trigger already polled (%v)", before.Time)
	}

	now := time.Now().UTC()
	lister := newITIssueLister([]itWireIssue{{Number: 1, Title: "No matching label", State: "open",
		CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z",
		Labels: []itWireLabel{{Name: "documentation"}}}}, nil)
	defer lister.Close()
	if fired, err := f.triggers.TickIssueTriggers(ctx, now, lister); err != nil || fired != 0 {
		t.Fatalf("tick = (%d, %v), want no fire and no error", fired, err)
	}

	polled, lastErr := itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL after a successful poll: an operator cannot tell this trigger from a dead one")
	}
	if polled.Time.UTC().Truncate(time.Microsecond) != now.Truncate(time.Microsecond) {
		t.Fatalf("last_polled_at = %v, want the tick's now (%v)", polled.Time, now)
	}
	if lastErr.Valid && lastErr.String != "" {
		t.Fatalf("last_error = %q after a clean poll", lastErr.String)
	}
}

// TestIssueTriggerTwoMatchingIssuesFireInOnePoll is the lab's exact fire:
// two open issues already carry the watched label, the (cursor-less) first
// poll lists both, and the trigger must fire BOTH runs and commit the poll —
// all inside one fire transaction. Before the fix the second create-run
// opened its own transaction and waited on the project journal advisory lock
// the fire's first append had already taken: the same goroutine, its own
// lock, forever. The run rows vanished with the wedged transaction, and the
// fleet wedged behind it (the fired run's attempt never began, and the
// lease-expiry recovery never got the row lock).
func TestIssueTriggerTwoMatchingIssuesFireInOnePoll(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"},
		json.RawMessage(`{"prompt":"Goal: {{issue.title}}"}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	mk := func(n int) itWireIssue {
		// Labeled after the trigger was authored — the no-backfill rule
		// (ADR-0056 amendment) skips pre-trigger labels, pinned by
		// TestIssueTriggerLabeledNeverBackfillsPreTriggerLabel; this test is
		// about ONE poll matching TWO issues (the lab's self-deadlock shape).
		at := trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339)
		return itWireIssue{Number: n, Title: "Ship it", State: "open",
			HTMLURL:   "https://github.com/octo/widgets/issues/" + strconv.Itoa(n),
			CreatedAt: at, UpdatedAt: at,
			Labels: []itWireLabel{{Name: "comm:go"}}}
	}
	lister := newITIssueLister([]itWireIssue{mk(11), mk(12)}, nil)
	defer lister.Close()

	now := time.Now().UTC()
	fired, terr := waitTick(t, ctx, f, now, lister, 60*time.Second)
	if terr != nil {
		t.Fatalf("tick: %v", terr)
	}
	if fired != 2 {
		t.Fatalf("fired = %d, want both matching issues in one poll", fired)
	}
	for _, ref := range []string{"octo/widgets#11", "octo/widgets#12"} {
		runID, kind := itIssueRunFor(t, ctx, f, ref)
		if kind != "issue" || runID == "" {
			t.Fatalf("%s did not fire a run (run %q kind %q)", ref, runID, kind)
		}
	}
	polled, lastErr := itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL after a fired poll")
	}
	if lastErr.Valid && lastErr.String != "" {
		t.Fatalf("last_error = %q after a clean poll", lastErr.String)
	}
}

// TestIssueTriggerHungPollIsCutLooseAndRecordedAndTickKeepsGoing is the lab
// tick's full afterlife in one test: a poll whose GitHub call goes quiet is
// abandoned at the per-poll bound (the tick RETURNS, the fire's row locks
// are released by its bounded rollback, and last_polled_at/last_error land
// in a separate committed write); the next poll's error (a hard list
// failure) is recorded the same way; and by the third beat a healthy lister
// is firing again. The poller keeps looping, and every poll reports.
func TestIssueTriggerHungPollIsCutLooseAndRecordedAndTickKeepsGoing(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	// 2 s: the hang itself is what the bound must catch, and a race-build's
	// claim-and-record statements need room the 150 ms of a fast build could
	// spare. The bound assertion below (15 s) still fails loudly if the cut-
	// loose machinery ever stops holding.
	f.triggers.PollTimeout = 2 * time.Second
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	labeledAfter := trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339)
	issues := []itWireIssue{{Number: 11, Title: "Go go", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/11",
		CreatedAt: labeledAfter, UpdatedAt: labeledAfter,
		Labels: []itWireLabel{{Name: "comm:go"}}}}

	// Beat 1: the hang. The tick must come back bounded, and the row must
	// say it looked and failed.
	hungStart := time.Now()
	fired, terr := waitTick(t, ctx, f, time.Now().UTC(), blockingLister{}, 30*time.Second)
	hung := time.Since(hungStart)
	if fired != 0 {
		t.Fatalf("hung tick fired %d runs, want 0", fired)
	}
	if terr == nil {
		t.Fatal("hung tick reported success; the abandoned poll is a failure")
	}
	if hung > 15*time.Second {
		t.Fatalf("hung tick took %s; the per-poll bound (PollTimeout + join grace) is not holding", hung)
	}
	polled, lastErr := itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL after a cut-loose poll — a hung poll must still report")
	}
	if !lastErr.Valid || lastErr.String == "" {
		t.Fatalf("last_error = %v after a cut-loose poll, want a bounded cause", lastErr)
	}
	// The abandoned fire may not leave its row locks behind: the next
	// claim must see the trigger row free (a still-held FOR UPDATE would
	// SKIP it and no replica could ever poll it again — the lab's silence).
	claimCtx, ccancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ccancel()
	lockTx, err := f.pool.Begin(claimCtx)
	if err != nil {
		t.Fatalf("begin claim check: %v", err)
	}
	var got string
	scanErr := lockTx.QueryRow(claimCtx,
		`SELECT id::text FROM issue_triggers WHERE id = $1::uuid FOR UPDATE SKIP LOCKED`, trigger.ID).Scan(&got)
	_ = lockTx.Rollback(claimCtx)
	if scanErr != nil {
		t.Fatalf("the abandoned fire still holds the trigger row: %v", scanErr)
	}

	// Beat 2: a hard list error is recorded and the trigger stays due (the
	// in-fire recorder commits its own answer, (0, nil) — "never crash the
	// tick" — so the tick itself stays healthy here too).
	errLister := failingLister{err: errors.New("github: 404 repository not found")}
	fired, terr = waitTick(t, ctx, f, time.Now().Add(30*time.Minute).UTC(), errLister, 30*time.Second)
	if fired != 0 || terr != nil {
		t.Fatalf("erroring tick = (%d, %v), want no fire and a recorded, continuing tick", fired, terr)
	}
	polled, lastErr = itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid || !lastErr.Valid || lastErr.String == "" {
		t.Fatalf("erroring poll recorded (%v, %v), want last_polled_at and a cause", polled, lastErr)
	}

	// Beat 3: with the clock past the interval, a healthy poll fires.
	lister := newITIssueLister(issues, nil)
	defer lister.Close()
	fired, terr = waitTick(t, ctx, f, time.Now().Add(time.Hour).UTC(), lister, 60*time.Second)
	if terr != nil {
		t.Fatalf("healthy tick after the hung one: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("fired = %d, want issue #11 to fire on the beat after the hang", fired)
	}
	if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#11"); kind != "issue" {
		t.Fatal("the post-hang fire left no run")
	}
	polled, lastErr = itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at lost after the recovery poll")
	}
	if lastErr.Valid && lastErr.String != "" {
		t.Fatalf("last_error = %q after a clean poll, want cleared", lastErr.String)
	}
}

// failingLister answers every poll with an immediate hard error.
type failingLister struct{ err error }

func (l failingLister) ListIssues(context.Context, github.Repository, github.IssueQuery, string) ([]github.Issue, error) {
	return nil, l.err
}

// issuesOnlyLister hides the timeline capability: it forwards the list and
// refuses to BE an IssueEventLister, forcing the store's declared fallback
// (updated_at as the label-time proxy).
type issuesOnlyLister struct{ inner *itIssueLister }

func (l issuesOnlyLister) ListIssues(ctx context.Context, repo github.Repository, q github.IssueQuery, token string) ([]github.Issue, error) {
	return l.inner.ListIssues(ctx, repo, q, token)
}

// TestIssueTriggerLabeledNeverBackfillsPreTriggerLabel is the gh-loop
// 2026-10-25 second failure (D): the trigger was created 15:57:03 and its
// FIRST poll — no cursor, no `since`, every labeled issue returned — fired
// EIGHT runs for issues labeled hours earlier, because the `labeled` arm
// asked only "does the issue carry the label NOW". ADR-0056 §5's no-backfill
// sentence sat on the `opened` arm; the amendment of 2026-10-25 gives the
// same rule to `labeled`: a label event at or after the trigger's own
// created_at, or it is old news.
//
// The fake serves the strongest skew: issue #11 carries comm:go and was
// EDITED after the trigger existed (updated_at is fresh — the listing hands
// it to every poll), but its label was applied BEFORE the trigger was
// authored; issue #15's label lands after. Only #15 may fire.
func TestIssueTriggerLabeledNeverBackfillsPreTriggerLabel(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	oldLabel := trigger.CreatedAt.Add(-time.Hour).Format(time.RFC3339)
	freshEdit := trigger.CreatedAt.Add(2 * time.Hour).Format(time.RFC3339)
	newLabel := trigger.CreatedAt.Add(30 * time.Minute).UTC().Truncate(time.Second).Format(time.RFC3339)
	issues := []itWireIssue{
		{Number: 11, Title: "Old label, fresh edit", State: "open",
			HTMLURL:   "https://github.com/octo/widgets/issues/11",
			CreatedAt: oldLabel, UpdatedAt: freshEdit,
			Labels: []itWireLabel{{Name: "comm:go"}}},
		{Number: 15, Title: "Labeled after", State: "open",
			HTMLURL:   "https://github.com/octo/widgets/issues/15",
			CreatedAt: newLabel, UpdatedAt: newLabel,
			Labels: []itWireLabel{{Name: "comm:go"}}},
	}
	lister := newITIssueListerLabeledAt(issues, func(it itWireIssue) string {
		if it.Number == 11 {
			return oldLabel // labeled before the trigger existed
		}
		return newLabel
	})
	defer lister.Close()

	fired, terr := waitTick(t, ctx, f, time.Now().UTC(), lister, 60*time.Second)
	if terr != nil {
		t.Fatalf("tick: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("fired = %d, want exactly issue #15 — #11's label predates the trigger (ADR-0056 amendment)", fired)
	}
	if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#15"); kind != "issue" {
		t.Fatalf("the post-trigger label did not fire")
	}
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE trigger_ref = 'octo/widgets#11'`).Scan(&n); err != nil {
		t.Fatalf("count #11 runs: %v", err)
	}
	if n != 0 {
		t.Fatalf("a pre-trigger label fired %d run(s): the backfill is the defect this amendment exists for", n)
	}
	polled, lastErr := itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL after the poll")
	}
	if lastErr.Valid && lastErr.String != "" {
		t.Fatalf("last_error = %q after a clean poll", lastErr.String)
	}
}

// TestIssueTriggerLabeledFallbackWithoutTimelineIsUpdatedAt: when the lister
// carries no timeline (the capability assertion fails — the store's declared
// degraded answer, recorded by the ADR amendment), the gate is
// updated_at >= created_at: #11 was last touched before the trigger existed
// and must not fire; #15 was labeled and updated after it, and must.
func TestIssueTriggerLabeledFallbackWithoutTimelineIsUpdatedAt(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	stale := trigger.CreatedAt.Add(-30 * time.Minute).Format(time.RFC3339)
	fresh := trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339)
	inner := newITIssueLister([]itWireIssue{
		{Number: 11, Title: "Touched before", State: "open",
			HTMLURL:   "https://github.com/octo/widgets/issues/11",
			CreatedAt: stale, UpdatedAt: stale,
			Labels: []itWireLabel{{Name: "comm:go"}}},
		{Number: 15, Title: "Touched after", State: "open",
			HTMLURL:   "https://github.com/octo/widgets/issues/15",
			CreatedAt: fresh, UpdatedAt: fresh,
			Labels: []itWireLabel{{Name: "comm:go"}}},
	}, nil)
	defer inner.Close()

	fired, terr := waitTick(t, ctx, f, time.Now().UTC(), issuesOnlyLister{inner}, 60*time.Second)
	if terr != nil {
		t.Fatalf("tick: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("fired = %d, want only the updated-at-or-after issue", fired)
	}
	if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#15"); kind != "issue" {
		t.Fatal("the fresh issue did not fire on the fallback gate")
	}
}

// TestIssueTriggerEveryPassRecordsLastPolled is the C arm end to end: five
// beats in a row — a HUNG poll cut loose at the per-poll timeout, an ERRORED
// poll, a clean no-match poll, a firing poll, and a poll DEFERRED AT THE
// ASSIGNMENT CEILING (the lab's silent 20-minute freeze: seven waiting_human
// runs against a max_concurrent_runs of 1, deferred at Debug level, recorded
// nowhere, read as a dead poller). Every beat returns, every beat advances
// last_polled_at, the ceiling deferral says so at WARN and fires nothing, and
// no beat wedges the loop.
func TestIssueTriggerEveryPassRecordsLastPolled(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	var logs bytes.Buffer
	// 2 s: the hung beat (beat 1) is bounded by this, and the commit beat of
	// a race-build journal append must not lose to it.
	f.triggers.PollTimeout = 2 * time.Second
	f.triggers.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	labeled := trigger.CreatedAt.Add(time.Hour)

	// Beat 1: the hang.
	if _, terr := waitTick(t, ctx, f, time.Now().UTC(), blockingLister{}, 30*time.Second); terr == nil {
		t.Fatal("the hung tick reported success")
	}
	prev := mustPollTime(t, ctx, f, trigger.ID)

	// Beat 2: the hard error.
	if fired, terr := waitTick(t, ctx, f, prev.Add(time.Minute), failingLister{err: errors.New("github: 403 rate limited")}, 30*time.Second); fired != 0 || terr != nil {
		t.Fatalf("errored tick = (%d, %v)", fired, terr)
	}
	prev = mustPollTimeAfter(t, ctx, f, trigger.ID, prev)

	// Beat 3: clean, nothing matches (wrong label).
	if fired, terr := waitTick(t, ctx, f, prev.Add(time.Minute), newITIssueLister([]itWireIssue{
		{Number: 3, Title: "docs", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/3",
			CreatedAt: labeled.Format(time.RFC3339), UpdatedAt: labeled.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "docs"}}},
	}, nil), 30*time.Second); fired != 0 || terr != nil {
		t.Fatalf("no-match tick = (%d, %v)", fired, terr)
	}
	prev = mustPollTimeAfter(t, ctx, f, trigger.ID, prev)

	// Beat 4: a match fires.
	if fired, terr := waitTick(t, ctx, f, prev.Add(time.Minute), newITIssueLister([]itWireIssue{
		{Number: 11, Title: "go", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/11",
			CreatedAt: labeled.Format(time.RFC3339), UpdatedAt: labeled.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "comm:go"}}},
	}, nil), 30*time.Second); fired != 1 || terr != nil {
		t.Fatalf("firing tick = (%d, %v)", fired, terr)
	}
	prev = mustPollTimeAfter(t, ctx, f, trigger.ID, prev)

	// Beat 5: the ceiling. The beat-4 run is still queued; drop the ceiling
	// to one and the fire must defer — visibly (WARN) and recorded — while
	// the loop itself stays green and a NEW issue in the same beat fires
	// nothing.
	if _, err := f.pool.Exec(ctx, `UPDATE assignments SET max_concurrent_runs = 1 WHERE id = $1::uuid`, f.assignment); err != nil {
		t.Fatalf("tighten the ceiling: %v", err)
	}
	later := labeled.Add(time.Hour)
	if fired, terr := waitTick(t, ctx, f, prev.Add(time.Minute), newITIssueLister([]itWireIssue{
		{Number: 12, Title: "go too", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/12",
			CreatedAt: later.Format(time.RFC3339), UpdatedAt: later.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "comm:go"}}},
	}, nil), 30*time.Second); fired != 0 || terr != nil {
		t.Fatalf("ceiling tick = (%d, %v), want a green deferred pass", fired, terr)
	}
	prev = mustPollTimeAfter(t, ctx, f, trigger.ID, prev)
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE trigger_ref = 'octo/widgets#12'`).Scan(&n); err != nil {
		t.Fatalf("count #12 runs: %v", err)
	}
	if n != 0 {
		t.Fatal("the ceiling deferral still fired a run")
	}
	if text := logs.String(); !strings.Contains(text, "issue trigger fire deferred at the assignment ceiling") {
		t.Fatalf("the ceiling deferral must speak at WARN (the lab read silence as death), got:\n%s", text)
	}
	if text := logs.String(); !strings.Contains(text, `"level":"WARN"`) || !strings.Contains(text, "issue trigger tick failed") {
		t.Fatalf("a failed pass must be logged at WARN and continued, got:\n%s", text)
	}
}

func mustPollTime(t *testing.T, ctx context.Context, f *itFixture, id string) time.Time {
	t.Helper()
	polled, _ := itPollState(t, ctx, f, id)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL where a pass promised to record it")
	}
	return polled.Time.UTC()
}

func mustPollTimeAfter(t *testing.T, ctx context.Context, f *itFixture, id string, prev time.Time) time.Time {
	t.Helper()
	now := mustPollTime(t, ctx, f, id)
	if !now.After(prev) {
		t.Fatalf("last_polled_at did not advance: %v -> %v", prev, now)
	}
	return now
}
