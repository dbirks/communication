package postgres

// ADR-0056 § 5, 2026-11-04 amendment — the busy-repository regression. The
// gh-loop of 2026-11-04 (Actions run 41815322185) left ~141 open issues
// labeled comm:go on the throwaway repo, and the trigger's single unfiltered
// page could never reach a NEW issue inside its 30 s poll bound:
// last_error read "issue trigger poll bound of 30s spent mid-listing:
// context deadline exceeded" on every beat and the cursor never moved, so
// every poll restarted from the top of the same backlog. These tests pin the
// rule against real Postgres with a fake GitHub that answers the listing the
// way the real endpoint does: server-side labels, updated desc, per_page 100,
// pages, and an inclusive since.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/integrations/github"
)

// TestIssueTriggerBusyBacklogFiresTheNewIssueInOnePoll is the report's own
// scenario: 300 open issues already carry the watched label (every gh-loop
// run files two and never closed any) and one NEW issue lands. The poll must
// list with the label server-side, page through the backlog oldest-updated
// last, skip the 300 pre-trigger labels cheaply, and fire the new one —
// within ONE poll, inside the bound.
func TestIssueTriggerBusyBacklogFiresTheNewIssueInOnePoll(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	// The backlog: 300 labeled issues, each edited well after the trigger
	// existed (so the updated-desc listing offers all of them) but labeled
	// well BEFORE it (the no-backfill verdict is stale for every one of
	// them). One new issue lands last.
	backlog := trigger.CreatedAt.Add(30 * time.Minute).UTC().Truncate(time.Second)
	var issues []itWireIssue
	for n := 1; n <= 300; n++ {
		issues = append(issues, itWireIssue{
			Number: n, Title: fmt.Sprintf("Loop ticket %d", n), State: "open",
			HTMLURL:   fmt.Sprintf("https://github.com/octo/widgets/issues/%d", n),
			CreatedAt: backlog.Format(time.RFC3339), UpdatedAt: backlog.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "comm:go"}},
		})
	}
	fresh := trigger.CreatedAt.Add(40 * time.Minute).UTC().Truncate(time.Second)
	issues = append(issues, itWireIssue{
		Number: 301, Title: "The new one", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/301",
		CreatedAt: fresh.Format(time.RFC3339), UpdatedAt: fresh.Format(time.RFC3339),
		Labels: []itWireLabel{{Name: "comm:go"}},
	})
	preTrigger := trigger.CreatedAt.Add(-time.Hour).UTC().Truncate(time.Second)
	lister := newITIssueListerLabeledAt(issues, func(it itWireIssue) string {
		if it.Number == 301 {
			return fresh.Format(time.RFC3339)
		}
		return preTrigger.Format(time.RFC3339)
	})
	defer lister.Close()

	now := time.Now().UTC()
	fired, terr := waitTick(t, ctx, f, now, lister, 120*time.Second)
	if terr != nil {
		t.Fatalf("tick: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("fired = %d, want exactly 1 (issue #301; the 300 backfill labels never fire)", fired)
	}
	runID, kind := itIssueRunFor(t, ctx, f, "octo/widgets#301")
	if kind != "issue" || runID == "" {
		t.Fatalf("issue #301 did not fire a run (run %q kind %q)", runID, kind)
	}
	var total int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE trigger_kind = 'issue'`).Scan(&total); err != nil {
		t.Fatalf("count issue runs: %v", err)
	}
	if total != 1 {
		t.Fatalf("issue runs = %d, want exactly 1", total)
	}
	// The cursor advanced past the whole backlog to the new issue's update.
	var cursor time.Time
	if err := f.pool.QueryRow(ctx,
		`SELECT cursor_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&cursor); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if !cursor.Equal(fresh) {
		t.Errorf("cursor = %v, want the fired issue's updated_at %v", cursor, fresh)
	}

	// The listing was the bounded shape: the label filter server-side,
	// newest-updated first, explicit direction, paged at 100 — 301 issues
	// answered in four pages, not one unbounded list.
	if len(lister.queries) != 4 {
		t.Fatalf("list requests = %d, want 4 pages of 100 for a 301-issue listing", len(lister.queries))
	}
	first := lister.queries[0]
	if got := first.Get("labels"); got != "comm:go" {
		t.Errorf("labels = %q, want the trigger's label server-side", got)
	}
	if got := first.Get("state"); got != "open" {
		t.Errorf("state = %q, want open", got)
	}
	if got := first.Get("sort"); got != "updated" {
		t.Errorf("sort = %q, want updated", got)
	}
	if got := first.Get("direction"); got != "desc" {
		t.Errorf("direction = %q, want desc", got)
	}
	if got := first.Get("per_page"); got != "100" {
		t.Errorf("per_page = %q, want 100", got)
	}
	if got := first.Get("since"); got == "" {
		t.Error("since missing: the poll must re-open from a bound, never list unbounded")
	}
	for i, wantPage := range []string{"", "2", "3", "4"} {
		if got := lister.queries[i].Get("page"); got != wantPage {
			t.Errorf("list request %d: page = %q, want %q", i+1, got, wantPage)
		}
	}
}

// itBoundedPagingLister drives the bound-spent path deterministically: page 1
// (numbers 1..100) answers immediately with STALE label evidence, page 2
// (numbers 201..215, the fresh label) answers after a short delay and its
// per-issue timeline reads each cost eventDelay — so the poll's bound
// expires somewhere inside page 2, mid-decision.
type itBoundedPagingLister struct {
	page2Delay time.Duration
	eventDelay time.Duration
	clock      time.Time
	page1      []github.Issue
	page2      []github.Issue
	staleEvent time.Time
	freshEvent time.Time
}

// GithubNow arms the trigger on a known clock so the stale issues resolve to
// a decisive Stale verdict (the cursor advances past them) rather than an
// undetermined hold, keeping the bound test's cursor assertion about the
// fresh issues alone.
func (l *itBoundedPagingLister) GithubNow(ctx context.Context, _ string) (time.Time, error) {
	return l.clock, nil
}

func (l *itBoundedPagingLister) ListIssues(ctx context.Context, _ github.Repository, q github.IssueQuery, _ string) ([]github.Issue, error) {
	if q.Page > 1 {
		select {
		case <-time.After(l.page2Delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return l.page2, nil
	}
	return l.page1, nil
}

func (l *itBoundedPagingLister) ListIssueEvents(ctx context.Context, _ github.Repository, number int, _ string) ([]github.IssueEvent, error) {
	if number > 100 && l.eventDelay > 0 {
		select {
		case <-time.After(l.eventDelay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ev := l.staleEvent
	if number > 100 {
		ev = l.freshEvent
	}
	return []github.IssueEvent{{Event: "labeled", CreatedAt: ev, LabelName: "comm:go"}}, nil
}

func itBoundedPagingIssues(now time.Time) (*itBoundedPagingLister, []string) {
	// Page 1: 100 stale issues (full page, so the poll must request page 2).
	page1 := make([]github.Issue, 0, 100)
	var refs []string
	for n := 1; n <= 100; n++ {
		page1 = append(page1, github.Issue{
			Number: n, Title: fmt.Sprintf("Stale %d", n), State: "open",
			HTMLURL:   fmt.Sprintf("https://github.com/octo/widgets/issues/%d", n),
			CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: now.Add(-time.Minute),
			Labels: []string{"comm:go"},
		})
	}
	// Page 2: 15 fresh issues, a short page, with distinct updated_ats so the
	// cursor's progress is meaningful.
	page2 := make([]github.Issue, 0, 15)
	for n := 201; n <= 215; n++ {
		i := n - 201
		page2 = append(page2, github.Issue{
			Number: n, Title: fmt.Sprintf("Fresh %d", n), State: "open",
			HTMLURL:   fmt.Sprintf("https://github.com/octo/widgets/issues/%d", n),
			CreatedAt: now.Add(-30 * time.Second), UpdatedAt: now.Add(-30*time.Second + time.Duration(i)*time.Second),
			Labels: []string{"comm:go"},
		})
		refs = append(refs, fmt.Sprintf("octo/widgets#%d", n))
	}
	return &itBoundedPagingLister{
		page2Delay: 100 * time.Millisecond,
		clock:      now.UTC(),
		page1:      page1,
		page2:      page2,
		staleEvent: now.Add(-time.Hour),
		freshEvent: now.Add(-10 * time.Second),
	}, refs
}

// TestIssueTriggerBoundSpentCommitsProgressAndResumes is the second half of
// the report's rule: a poll that spends its bound mid-listing still fires
// what it saw, commits its cursor, and the NEXT poll continues from there —
// no issue fires twice, no beat restarts from the top of the backlog.
func TestIssueTriggerBoundSpentCommitsProgressAndResumes(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	// 1.5 s against page-2 timeline reads that each cost 250 ms: the bound
	// is guaranteed to expire inside page 2 (15 reads need 3 s) and is
	// guaranteed to survive page 1 (100 fast timeline reads).
	f.triggers.PollTimeout = 1500 * time.Millisecond
	// The fixture assignment caps concurrent runs at 4; raise it so the
	// per-page ceiling check never defers beat 2 mid-listing (this test is
	// about the bound, not the ceiling).
	if _, err := f.pool.Exec(ctx, `UPDATE assignments SET max_concurrent_runs = 8 WHERE id = $1`, f.assignment); err != nil {
		t.Fatalf("raise the ceiling: %v", err)
	}
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	now := time.Now().UTC()
	slow, refs := itBoundedPagingIssues(now)
	slow.eventDelay = 250 * time.Millisecond

	// Beat 1: the bound spends somewhere inside page 2. Whatever it fires
	// is COMMITTED with the cursor; the beat reports failure with the bound
	// named, and last_error keeps that precise cause.
	fired1, terr := waitTick(t, ctx, f, now, slow, 30*time.Second)
	if terr == nil {
		t.Fatalf("beat 1 reported success; the bound-spent poll is a failing beat, not a green one")
	}
	if !strings.Contains(terr.Error(), "bound") {
		t.Fatalf("beat 1 error %q does not name the poll bound", terr)
	}
	if fired1 >= 15 {
		t.Fatalf("beat 1 fired %d, want fewer than the 15 fresh issues (the bound must have cut it off)", fired1)
	}
	polled, lastErr := itPollState(t, ctx, f, trigger.ID)
	if !polled.Valid {
		t.Fatal("last_polled_at is NULL after a bound-spent poll")
	}
	if !lastErr.Valid || lastErr.String == "" {
		t.Fatal("last_error empty after a bound-spent poll: the operator cannot see that progress was made")
	}
	var cursor *time.Time
	if err := f.pool.QueryRow(ctx,
		`SELECT cursor_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&cursor); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if cursor == nil {
		t.Fatal("cursor did not advance on the bound-spent beat: the next poll would restart from the top")
	}

	// Beat 2: a healthy lister resumes. The re-offered issues skip cheaply
	// (their idempotency keys are committed), the rest fire, and the beat
	// ends green with last_error cleared.
	fast, _ := itBoundedPagingIssues(now)
	fired2, terr := waitTick(t, ctx, f, now.Add(90*time.Second), fast, 30*time.Second)
	if terr != nil {
		t.Fatalf("beat 2: %v", terr)
	}
	total := fired1 + fired2
	if total != 15 {
		t.Fatalf("fired across both beats = %d (beat1 %d + beat2 %d), want exactly the 15 fresh issues", total, fired1, fired2)
	}
	if fired2 == 0 {
		t.Fatal("beat 2 fired nothing: the resume is what the bound-spent beat promised")
	}
	for _, ref := range refs {
		var n int
		if err := f.pool.QueryRow(ctx,
			`SELECT count(*) FROM runs WHERE trigger_ref = $1`, ref).Scan(&n); err != nil {
			t.Fatalf("count runs for %s: %v", ref, err)
		}
		if n != 1 {
			t.Errorf("%s fired %d runs, want exactly one across the two beats", ref, n)
		}
	}
	_, lastErr = itPollState(t, ctx, f, trigger.ID)
	if lastErr.Valid && lastErr.String != "" {
		t.Errorf("last_error = %q after the resuming green beat, want cleared", lastErr.String)
	}
	var finalCursor sql.NullTime
	if err := f.pool.QueryRow(ctx,
		`SELECT cursor_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).Scan(&finalCursor); err != nil {
		t.Fatalf("read final cursor: %v", err)
	}
	if !finalCursor.Valid || !finalCursor.Time.After(*cursor) {
		t.Errorf("final cursor = %v, want advanced past beat 1's %v", finalCursor, cursor)
	}
}

// TestIssueTriggerFirstPollBindsSinceToTheNoBackfillBaseline pins the first
// poll's listing bound: with no cursor yet, `since` rides the armed
// no-backfill baseline, so an issue last updated long before the trigger
// existed is not even OFFERED — the busy-repo backlog stays out of every
// listing while the new issue is not.
func TestIssueTriggerFirstPollBindsSinceToTheNoBackfillBaseline(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	old := trigger.CreatedAt.Add(-time.Hour).UTC().Truncate(time.Second)
	fresh := trigger.CreatedAt.Add(time.Hour).UTC().Truncate(time.Second)
	lister := newITIssueLister([]itWireIssue{
		{Number: 3, Title: "Ancient", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/3",
			CreatedAt: old.Format(time.RFC3339), UpdatedAt: old.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "comm:go"}}},
		{Number: 7, Title: "New", State: "open", HTMLURL: "https://github.com/octo/widgets/issues/7",
			CreatedAt: fresh.Format(time.RFC3339), UpdatedAt: fresh.Format(time.RFC3339),
			Labels: []itWireLabel{{Name: "comm:go"}}},
	}, nil)
	defer lister.Close()
	lister.labeledAt = func(it itWireIssue) string {
		if it.Number == 7 {
			return fresh.Format(time.RFC3339)
		}
		return old.Format(time.RFC3339)
	}

	fired, terr := waitTick(t, ctx, f, time.Now().UTC(), lister, 60*time.Second)
	if terr != nil || fired != 1 {
		t.Fatalf("tick = (%d, %v), want the new issue only", fired, terr)
	}
	if len(lister.queries) != 1 {
		t.Fatalf("list requests = %d, want one short page", len(lister.queries))
	}
	since, err := time.Parse(time.RFC3339, lister.queries[0].Get("since"))
	if err != nil {
		t.Fatalf("since = %q, want an ISO 8601 bound", lister.queries[0].Get("since"))
	}
	// The ancient issue (updated an hour before the trigger) is not offered:
	// the bound sits at or after its update.
	if old.After(since) {
		t.Errorf("since = %v is before the ancient issue's update %v: the backlog rode the first listing", since, old)
	}
	if fresh.Before(since) {
		t.Errorf("since = %v excludes the new issue's update %v", since, fresh)
	}
}
