package postgres

// Lease-stuck lab, pass 3 (gh-loop 3, d702384): issue #16 never fired. Its
// `labeled` event read 16:50:55Z on GitHub's clock while the trigger's
// created_at read 16:51:36 on the lab's — and the lab's clock was ~50 s AHEAD
// of GitHub's (`date -u` 17:10:50 against GitHub's `Date: 17:10:00` at the
// same moment). The pass-2 rule compared those two timestamps across clocks
// and "backfill-refused" a label that GitHub itself says came after — then
// advanced the cursor past it for good. The fix arms each trigger on GitHub's
// own clock (the Date header, persisted as github_created_at by migration
// 00018) and refuses to treat an invisible label event as a verdict at all.

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// TestIssueTriggerLabelVerdictsUseGithubsClock runs the same trigger against
// a fake GitHub whose clock is dialled 60 s behind, 60 s ahead, and 600 s
// behind the lab. In every skew: the label applied a moment ago ON GITHUB'S
// CLOCK fires, and the label an hour older does not — whatever the naive
// cross-clock comparison would have said. The 600 s case is the discriminator
// the 2-minute tolerance cannot pass: without arming, #16's event lands 10
// minutes "before" created_at and would be backfill-refused forever.
func TestIssueTriggerLabelVerdictsUseGithubsClock(t *testing.T) {
	for _, skew := range []struct {
		name    string
		ghDrift time.Duration // GitHub's clock minus the lab's
	}{
		{"lab 60s ahead of GitHub (the measured shape)", -60 * time.Second},
		{"lab 60s behind GitHub", +60 * time.Second},
		{"lab 600s ahead of GitHub (beyond any tolerance)", -600 * time.Second},
	} {
		t.Run(skew.name, func(t *testing.T) {
			ctx := testCtx(t)
			f := itSetup(t)
			f.itDropTriggers(t, ctx)
			trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
			if err != nil {
				t.Fatalf("itIssueFires: %v", err)
			}
			fresh := itWireIssue{Number: 16, Title: "Just labeled", State: "open",
				HTMLURL:   "https://github.com/octo/widgets/issues/16",
				CreatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339),
				UpdatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339),
				Labels:    []itWireLabel{{Name: "comm:go"}}}
			old := itWireIssue{Number: 12, Title: "Labeled long ago", State: "open",
				HTMLURL:   "https://github.com/octo/widgets/issues/12",
				CreatedAt: trigger.CreatedAt.Add(-2 * time.Hour).Format(time.RFC3339),
				UpdatedAt: trigger.CreatedAt.Add(time.Hour).Format(time.RFC3339), // edited later; updated_at is fresh
				Labels:    []itWireLabel{{Name: "comm:go"}}}
			lister := newITIssueLister([]itWireIssue{old, fresh}, nil)
			defer lister.Close()
			lister.githubDate = func() time.Time { return time.Now().Add(skew.ghDrift) }
			// Event times are GitHub-clock facts: "seconds ago as GitHub
			// counts", and "an hour ago as GitHub counts".
			lister.labeledAt = func(it itWireIssue) string {
				ago := 2 * time.Second
				if it.Number == 12 {
					ago = time.Hour
				}
				return time.Now().Add(skew.ghDrift).Add(-ago).UTC().Truncate(time.Second).Format(time.RFC3339)
			}

			fired, terr := waitTick(t, ctx, f, time.Now().UTC(), lister, 60*time.Second)
			if terr != nil {
				t.Fatalf("tick: %v", terr)
			}
			if fired != 1 {
				var runs int
				if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE trigger_ref = 'octo/widgets#16'`).Scan(&runs); err != nil {
					t.Fatalf("count #16 runs: %v", err)
				}
				t.Fatalf("fired = %d (#16 runs=%d), want the fresh label to fire across the skew", fired, runs)
			}
			if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#16"); kind != "issue" {
				t.Fatal("the fresh post-arming label did not fire")
			}
			var oldRuns int
			if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE trigger_ref = 'octo/widgets#12'`).Scan(&oldRuns); err != nil {
				t.Fatalf("count #12 runs: %v", err)
			}
			if oldRuns != 0 {
				t.Fatalf("the hour-old label fired %d run(s); arming must not widen the backfill window", oldRuns)
			}

			// The baseline landed, on GitHub's clock.
			var githubCreated time.Time
			if err := f.pool.QueryRow(ctx,
				`SELECT github_created_at FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).
				Scan(&githubCreated); err != nil {
				t.Fatalf("read github_created_at: %v", err)
			}
			// baseline = created_at shifted ONTO GitHub's clock: a GitHub
			// running 60 s behind lands the trigger's instant 60 s earlier
			// on GitHub's ruler.
			want := trigger.CreatedAt.Add(skew.ghDrift)
			if d := githubCreated.Sub(want); d < -5*time.Second || d > 5*time.Second {
				t.Fatalf("github_created_at = %v, want ≈ %v (created_at shifted by the skew); off by %v", githubCreated, want, d)
			}
		})
	}
}

// TestIssueTriggerInvisibleLabelEventHoldsCursorAndFiresLate pins the
// eventual-consistency arm: the first poll sees issue #16 CARRYING comm:go
// but its labeled event is not in the timeline yet. The trigger must not
// fire on "it's on the issue", must not backfill-refuse it, and — the part
// that bit #16 — must not advance the cursor past it. When the event surfaces
// a poll later, the issue is still inside `since` and the fire lands.
func TestIssueTriggerInvisibleLabelEventHoldsCursorAndFiresLate(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	at := trigger.CreatedAt.Add(5 * time.Minute).UTC().Truncate(time.Second).Format(time.RFC3339)
	issue := itWireIssue{Number: 16, Title: "Half-timeline", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/16",
		CreatedAt: at, UpdatedAt: at,
		Labels: []itWireLabel{{Name: "comm:go"}}}
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	var visible atomic.Bool
	lister.labeledAt = func(itWireIssue) string {
		if !visible.Load() {
			return "" // the events API has not caught up
		}
		return at
	}

	// Poll 1: the label is on the issue, the event is nowhere.
	now := time.Now().UTC()
	fired, terr := waitTick(t, ctx, f, now, lister, 60*time.Second)
	if terr != nil || fired != 0 {
		t.Fatalf("first tick = (%d, %v), want a green hold", fired, terr)
	}
	var cursor *time.Time
	var polled time.Time
	var lastErr *string
	if err := f.pool.QueryRow(ctx,
		`SELECT cursor_at, last_polled_at, last_error FROM issue_triggers WHERE id = $1::uuid`, trigger.ID).
		Scan(&cursor, &polled, &lastErr); err != nil {
		t.Fatalf("read the trigger row: %v", err)
	}
	if cursor != nil && cursor.After(issueUpdatedAt(t, at)) {
		t.Fatalf("the cursor advanced to %v PAST an issue whose label event was invisible — that is the permanent skip #16 died of (held at or behind its updated_at is the rule; GitHub's since is inclusive)", cursor)
	}
	if lastErr != nil && *lastErr != "" {
		t.Fatalf("last_error = %q on a green hold", *lastErr)
	}

	// Poll 2 (a minute later, the event surfaced): fires, cursor moves.
	visible.Store(true)
	fired, terr = waitTick(t, ctx, f, now.Add(time.Minute), lister, 60*time.Second)
	if terr != nil {
		t.Fatalf("second tick: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("late-visible label fired %d, want 1", fired)
	}
	if _, kind := itIssueRunFor(t, ctx, f, "octo/widgets#16"); kind != "issue" {
		t.Fatal("the late-visible label never fired")
	}
}

// TestIssueTriggerLabelJustBeforeTheArmedBaselineStillFires is the tolerance
// regression in the armed world: a label landing 45 s "before" created_at by
// the naive comparison is inside the 2-minute acceptance slack, and arming
// must not have made the gate stricter than the amendment promises.
func TestIssueTriggerLabelJustBeforeTheArmedBaselineStillFires(t *testing.T) {
	ctx := testCtx(t)
	f := itSetup(t)
	f.itDropTriggers(t, ctx)
	trigger, err := f.itIssueFires(ctx, "labeled", []string{"comm:go"}, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("itIssueFires: %v", err)
	}
	at := trigger.CreatedAt.Add(-45 * time.Second).UTC().Truncate(time.Second).Format(time.RFC3339)
	issue := itWireIssue{Number: 16, Title: "Skewed", State: "open",
		HTMLURL:   "https://github.com/octo/widgets/issues/16",
		CreatedAt: at, UpdatedAt: at,
		Labels: []itWireLabel{{Name: "comm:go"}}}
	lister := newITIssueLister([]itWireIssue{issue}, nil)
	defer lister.Close()
	// The lab runs 60 s ahead; the label landed 45 s "before" created_at by
	// the naive comparison — inside the 2-minute tolerance, so this one is a
	// regression check that arming did not BREAK the tolerant path.
	lister.githubDate = func() time.Time { return time.Now().Add(-60 * time.Second) }
	lister.labeledAt = func(itWireIssue) string { return at }

	fired, terr := waitTick(t, ctx, f, time.Now().UTC(), lister, 60*time.Second)
	if terr != nil {
		t.Fatalf("tick: %v", terr)
	}
	if fired != 1 {
		t.Fatalf("fired = %d, want the tolerant armed comparison to fire", fired)
	}
}

// issueUpdatedAt parses the fixture's updated_at for the hold assertion.
func issueUpdatedAt(t *testing.T, at string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, at)
	if err != nil {
		t.Fatalf("parse %q: %v", at, err)
	}
	return v.UTC()
}
