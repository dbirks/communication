package postgres

// Every journal read in this package carries the gap-safety filter of Accepted
// ADR-0014 §9:
//
//	 AND e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
//
// A committed row is therefore not immediately readable: it stays hidden until
// the snapshot watermark has moved past the transaction that wrote it. That is
// deliberate — it is what stops a reader from skipping a late committer — and
// the product contract matches it: a reader (the SSE handler) polls, and a row
// held back by the horizon is delayed, never lost.
//
// The watermark is cluster-global, not database-global. pg_snapshot_xmin is the
// oldest transaction id still in progress anywhere in the cluster, so an open
// write transaction in ANY database — a sibling `go test` binary under
// `-p 4 ./...`, another copy of this suite in its own scratch database, a stray
// session — holds it behind every commit that followed. A test that writes
// events and reads the journal ONCE then asserts on rows that are merely
// not-yet-admitted: it fails ("events = 0 ([]), want project.created + 2
// repository.added", "returned 3 rows, want 4") while nothing in this repository
// is broken.
//
// waitJournalReadable closes that window without touching the read path: after
// the test's writes have committed and before the one-shot read it asserts on,
// block until the horizon has passed the newest transaction id this test wrote.
// The assertions are unchanged; only when the read happens is.
//
// If the horizon never passes, the rows really are lost, and the failure says so
// with the live watermark and every transaction open on the server — the same
// dump migOpenTransactionReport produces for the replay tests.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// journalHorizonBound is how long a test waits for the cluster horizon to pass
// its own writes before calling it a bug. Generous on purpose: under
// `-p 4 ./...` a sibling binary's transaction can hold the watermark for
// many seconds at a time — long enough that anything measured in seconds is a
// timeout, not a bound (this suite's own gap-safety tests hold one open for as
// long as it takes to prove a reader refuses to advance past it), and a tight
// bound would reinstate the flake this exists to remove.
const journalHorizonBound = 2 * time.Minute

// journalHorizonPoll is how often to ask. The watermark advances the moment the
// pinning transaction ends, so polling is cheap and a short interval costs
// nothing when the cluster is quiet.
const journalHorizonPoll = 25 * time.Millisecond

// journalQueryTimeout bounds one horizon probe, never the wait itself.
const journalQueryTimeout = 10 * time.Second

// journalCtx is testCtx for a test that may have to wait out the cluster
// horizon: testCtx's 30s budget does not cover sitting on another session's
// open transaction, and a context that expires during the wait would make the
// assertion after it fail on a deadline instead of reporting what it saw.
func journalCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), journalHorizonBound+3*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

// journalWriteState is what the journal says right now about a set of rows.
type journalWriteState struct {
	rows    int64  // matching rows visible to a plain read (every one is committed)
	maxXid  string // highest tx_id among them, in xid8 text form
	xmin    string // the gap-safety horizon at the moment of the probe
	blocked bool   // a matching row is still at or behind that horizon
}

// journalWriteStateOf reads the state of the journal rows matching `where` — a
// predicate over domain_events aliased e, with $1.. bound to args. The probe
// deliberately does not use the gap-safety filter itself: a committed row's
// tx_id is known the instant it commits even while the horizon still hides the
// row from a stream read, and that difference is exactly what a test has to wait
// out rather than mistake for data loss.
func journalWriteStateOf(ctx context.Context, pool *pgxpool.Pool, where string, args ...any) (journalWriteState, error) {
	var st journalWriteState
	err := pool.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE(max(e.tx_id)::text, '0'),
		       pg_snapshot_xmin(pg_current_snapshot())::text,
		       COALESCE(bool_or(e.tx_id >= pg_snapshot_xmin(pg_current_snapshot())), false)
		FROM domain_events e
		WHERE `+where, args...).Scan(&st.rows, &st.maxXid, &st.xmin, &st.blocked)
	return st, err
}

// waitHorizonPast blocks until pg_snapshot_xmin(pg_current_snapshot()) has moved
// past xid (xid8 text form), i.e. until every row that transaction — and every
// row written before it — passes the journal's gap-safety filter. Postgres does
// the comparison in xid8 terms, so it agrees with the `<` in the production
// predicate; the watermark only moves forward, so the read that follows cannot
// fall back behind it again.
func waitHorizonPast(t *testing.T, pool *pgxpool.Pool, xid string) {
	t.Helper()

	bound := journalHorizonBound
	// Never wait past the test binary's own deadline: running `go test` out of
	// time turns a diagnosable report into a panic and a goroutine dump.
	if deadline, ok := t.Deadline(); ok {
		if until := time.Until(deadline) - 30*time.Second; until < bound {
			bound = until
		}
		if bound < time.Second {
			bound = time.Second
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), bound+journalQueryTimeout)
	defer cancel()

	deadline := time.Now().Add(bound)
	var xmin string
	for {
		probeCtx, cancelProbe := context.WithTimeout(ctx, journalQueryTimeout)
		var past bool
		err := pool.QueryRow(probeCtx, `
			SELECT pg_snapshot_xmin(pg_current_snapshot())::text,
			       pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8`, xid).Scan(&xmin, &past)
		cancelProbe()
		if err != nil {
			t.Fatalf("waiting for the journal horizon to pass tx %s: %v", xid, err)
		}
		if past {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("journal horizon never passed tx %s: waited %s with pg_current_snapshot xmin=%s.\n"+
				"Rows this test committed but cannot read back through the gap-safety filter of ADR-0014 §9 "+
				"are only explainable by a transaction holding the cluster-wide watermark; the dump below "+
				"says which it is — with none open, this is a real read-path bug.\n%s",
				xid, bound, xmin, migOpenTransactionReport(context.Background(), pool))
		}
		time.Sleep(journalHorizonPoll)
	}
}

// waitJournalReadable is what a test calls between its commits and the single
// journal read it asserts on: it blocks until every row matching `where` is on
// the readable side of the gap-safety horizon, so the one-shot read that
// follows sees what the test wrote no matter what else the cluster is doing.
//
//	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p.ID)
//	evs, err := store.EventsAfter(ctx, p.ID, 0, 0)
func waitJournalReadable(t *testing.T, pool *pgxpool.Pool, where string, args ...any) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), journalQueryTimeout)
	st, err := journalWriteStateOf(ctx, pool, where, args...)
	cancel()
	if err != nil {
		t.Fatalf("reading the journal watermark for `%s`: %v", where, err)
	}
	if st.rows == 0 {
		// Nothing to wait for because nothing is there: the test's own writes
		// never reached the journal, which no horizon will ever fix.
		t.Fatalf("no domain_events row matches `%s` (xmin=%s); the rows this test is about "+
			"to read back are missing from the journal, not merely withheld\n%s",
			where, st.xmin, migOpenTransactionReport(context.Background(), pool))
	}
	if !st.blocked {
		return // the common case: the cluster is quiet and the horizon has passed
	}
	t.Logf("waiting for the journal horizon: %d row(s) in scope, newest tx_id=%s, xmin=%s",
		st.rows, st.maxXid, st.xmin)
	waitHorizonPast(t, pool, st.maxXid)
}
