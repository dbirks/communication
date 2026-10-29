package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
)

// The properties below are the reason migration 00002 exists. A global_seq is
// an IDENTITY value consumed at INSERT time, so two transactions can commit in
// the opposite order to the one in which they consumed sequence values — and a
// stream reader that remembers "the highest sequence I sent" would then skip
// the late committer forever, silently, because LISTEN told it nothing.
// Only a real PostgreSQL can show this, so these are integration tests
// (AGENTS.md: a mocked green test never substitutes for an integration test).

// evtInsertJournalRow writes one domain_events row outside AppendEvent — no
// advisory lock, no outbox row — so a test can hold a sequence value in an
// open transaction. It returns the sequence the row consumed.
func evtInsertJournalRow(ctx context.Context, tx pgx.Tx, orgID, projectID, eventType string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO domain_events (type, organization_id, project_id, actor_kind, actor_id)
		VALUES ($1, $2::uuid, $3::uuid, 'human', 'evt-test')
		RETURNING global_seq`,
		eventType, orgID, projectID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("postgres: test insert domain event: %w", err)
	}
	return seq, nil
}

// TestEventsAfterDeliversLateCommitterInOrder is the gap-safety proof: seq N+1
// commits while the transaction holding seq N is still open, and the reader
// must refuse to advance past N rather than skip it.
func TestEventsAfterDeliversLateCommitterInOrder(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Gapless", "gapless")

	// The project itself already appended project.created; everything below is
	// measured against that cursor, so "nothing new" means nothing new.
	base, err := store.EventsAfter(ctx, p.ID, 0, 10)
	if err != nil || len(base) != 1 {
		t.Fatalf("baseline journal = %v, %v; want the project.created row", evtSummary(base), err)
	}
	cursor := base[0].GlobalSeq

	// A transaction that will commit last consumes the lower sequence value.
	early, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin first tx: %v", err)
	}
	defer func() { _ = early.Rollback(ctx) }()
	seqLow, err := evtInsertJournalRow(ctx, early, orgID, p.ID, events.TypeRepositoryAdded)
	if err != nil {
		t.Fatalf("insert in held tx: %v", err)
	}

	afterLow, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin second tx: %v", err)
	}
	seqHigh, err := evtInsertJournalRow(ctx, afterLow, orgID, p.ID, events.TypeProjectMemberUpdated)
	if err != nil {
		t.Fatalf("insert in second tx: %v", err)
	}
	if err := afterLow.Commit(ctx); err != nil {
		t.Fatalf("commit second tx: %v", err)
	}
	if seqHigh != seqLow+1 {
		t.Fatalf("sequence values %d and %d are not adjacent; the test must commit N+1 before N",
			seqLow, seqHigh)
	}

	// The higher row is committed and visible, the lower one is not. A naive
	// "global_seq > 0" reader would emit it here and never come back for N.
	naive, err := evtNaiveEventsAfter(ctx, store, p.ID, cursor)
	if err != nil {
		t.Fatalf("naive read: %v", err)
	}
	if len(naive) != 1 || naive[0].GlobalSeq != seqHigh {
		t.Fatalf("naive reader saw %v, want exactly the committed seq %d (this is the gap the safe reader must avoid)",
			evtSummary(naive), seqHigh)
	}

	got, err := store.EventsAfter(ctx, p.ID, cursor, 10)
	if err != nil {
		t.Fatalf("EventsAfter while a lower seq is in flight: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("EventsAfter = %v, want nothing until seq %d is settled", evtSummary(got), seqLow)
	}

	if err := early.Commit(ctx); err != nil {
		t.Fatalf("commit held tx: %v", err)
	}

	// One poll interval of the safe reader's snapshot: the withheld row is now
	// determined and both rows must arrive in sequence order.
	var delivered []events.Envelope
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		delivered, err = store.EventsAfter(ctx, p.ID, cursor, 10)
		if err != nil {
			t.Fatalf("EventsAfter after commit: %v", err)
		}
		if len(delivered) == 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(delivered) != 2 {
		t.Fatalf("EventsAfter after commit = %v, want both seq %d and %d",
			evtSummary(delivered), seqLow, seqHigh)
	}
	if delivered[0].GlobalSeq != seqLow || delivered[1].GlobalSeq != seqHigh {
		t.Errorf("delivered %v, want [%d %d] in order", evtSummary(delivered), seqLow, seqHigh)
	}
	// Resuming from the first delivered row must not re-send it, and must not
	// have lost anything either.
	tail, err := store.EventsAfter(ctx, p.ID, delivered[0].GlobalSeq, 10)
	if err != nil {
		t.Fatalf("EventsAfter(cursor): %v", err)
	}
	if len(tail) != 1 || tail[0].GlobalSeq != seqHigh {
		t.Errorf("tail = %v, want only seq %d", evtSummary(tail), seqHigh)
	}
}

// TestAppendEventSerializesAppendsPerProject is the writer-side half of the
// guarantee: with the advisory lock AppendEvent takes, a project's second
// append cannot even consume a sequence value until the first has committed,
// so commit order cannot disagree with sequence order for that project.
func TestAppendEventSerializesAppendsPerProject(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := testCtx(t)
	a, _, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Ordered", "ordered")

	first, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin first tx: %v", err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	envFirst, err := AppendEvent(ctx, first, events.New{
		Type:           events.TypeRepositoryAdded,
		OrganizationID: orgID,
		ProjectID:      p.ID,
		Actor:          events.Human(a),
		Payload:        map[string]any{"name": "first"},
	})
	if err != nil {
		t.Fatalf("AppendEvent in held tx: %v", err)
	}

	base, err := store.EventsAfter(ctx, p.ID, 0, 10)
	if err != nil || len(base) != 1 {
		t.Fatalf("baseline journal = %v, %v; want the project.created row", evtSummary(base), err)
	}
	cursor := base[0].GlobalSeq

	type result struct {
		env events.Envelope
		err error
	}
	done := make(chan result, 1)
	go func() {
		// The goroutine uses a context that cannot be cancelled by the test's
		// cleanup: it is waiting on a lock and must survive until it finishes.
		tx, err := store.Pool.Begin(context.Background())
		if err != nil {
			done <- result{err: err}
			return
		}
		env, err := AppendEvent(context.Background(), tx, events.New{
			Type:           events.TypeRepositoryAdded,
			OrganizationID: orgID,
			ProjectID:      p.ID,
			Actor:          events.Human(a),
			Payload:        map[string]any{"name": "second"},
		})
		if err != nil {
			_ = tx.Rollback(context.Background())
			done <- result{err: err}
			return
		}
		if err := tx.Commit(context.Background()); err != nil {
			done <- result{err: err}
			return
		}
		done <- result{env: env}
	}()

	// The second append is blocked on the first transaction, so the stream sees
	// nothing at all — including the row the first transaction already inserted.
	select {
	case res := <-done:
		t.Fatalf("second AppendEvent finished while the first transaction was open: %+v", res)
	case <-time.After(500 * time.Millisecond):
	}
	if got, err := store.EventsAfter(ctx, p.ID, cursor, 10); err != nil || len(got) != 0 {
		t.Fatalf("EventsAfter during serialization = %v, %v; want nothing", evtSummary(got), err)
	}

	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit first tx: %v", err)
	}
	var second events.Envelope
	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("second AppendEvent: %v", res.err)
		}
		second = res.env
	case <-time.After(10 * time.Second):
		t.Fatal("second AppendEvent never unblocked")
	}
	if second.GlobalSeq != envFirst.GlobalSeq+1 {
		t.Errorf("second append got seq %d, want %d (one after the first)",
			second.GlobalSeq, envFirst.GlobalSeq+1)
	}

	got, err := store.EventsAfter(ctx, p.ID, cursor, 10)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("EventsAfter = %v, want both appends", evtSummary(got))
	}
	if got[0].GlobalSeq != envFirst.GlobalSeq || got[1].GlobalSeq != second.GlobalSeq {
		t.Errorf("delivered %v, want [%d %d]: the commit order must match the sequence order",
			evtSummary(got), envFirst.GlobalSeq, second.GlobalSeq)
	}
}

// TestVisibleEventsAfterHidesForeignProject is the SSE route's authorization
// boundary at the store level: a non-member gets the same answer as for a
// project that does not exist, so the journal cannot be walked by cursor.
func TestVisibleEventsAfterHidesForeignProject(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := journalCtx(t)
	a, b, _, _ := prjUsers(t, store, orgID)
	p := prjCreateProject(t, store, a, orgID, "Private", "private")

	// Every read below is the journal's one-shot read, so every one of them is
	// behind the gap-safety horizon until that horizon passes the row
	// CreateProject appended (ADR-0014 §9).
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p.ID)

	if _, err := store.VisibleEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID}, p.ID, 0, 10); !errors.Is(err, ErrProjectNotFound) {
		t.Errorf("non-member VisibleEventsAfter = %v, want ErrProjectNotFound", err)
	}
	got, err := store.VisibleEventsAfter(ctx, Caller{UserID: a, OrganizationID: orgID}, p.ID, 0, 10)
	if err != nil {
		t.Fatalf("member VisibleEventsAfter: %v", err)
	}
	if len(got) != 1 || got[0].Type != events.TypeProjectCreated {
		t.Errorf("member VisibleEventsAfter = %v, want the project.created row", evtSummary(got))
	}
	// An organization admin with no membership sees everything (ADR-0014 §3).
	if got, err := store.VisibleEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID, IsOrgAdmin: true}, p.ID, 0, 10); err != nil || len(got) != 1 {
		t.Errorf("org admin VisibleEventsAfter = %v, %v; want one event", evtSummary(got), err)
	}
}

// TestEventWakeSignalsSubscribers proves the LISTEN path: the trigger's
// pg_notify reaches a subscriber through the shared connection, and stopping a
// subscription does not disturb the others.
func TestEventWakeSignalsSubscribers(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer pool.Close()

	var orgID string
	if err := pool.QueryRow(ctx,
		"SELECT id FROM organizations WHERE slug = 'default'").Scan(&orgID); err != nil {
		t.Fatalf("seed org lookup: %v", err)
	}

	w := NewEventWake(url, nil)
	defer w.Close()

	subCtx, cancelSub := context.WithCancel(ctx)
	defer cancelSub()
	first, stopFirst, err := w.Watch(subCtx)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	defer stopFirst()
	second, stopSecond, err := w.Watch(subCtx)
	if err != nil {
		t.Fatalf("Watch second: %v", err)
	}
	stopSecond()
	// A stopped subscription's channel is closed rather than left dangling, so a
	// stream that is still selecting on it wakes up and finishes.
	select {
	case _, open := <-second:
		if open {
			t.Error("stopped subscription still delivered a wake-up")
		}
	default:
		t.Error("stopped subscription's channel was not closed")
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO domain_events (type, organization_id, actor_kind, actor_id)
		VALUES ('project.created', $1, 'human', 'wake-test')`, orgID); err != nil {
		t.Fatalf("insert: %v", err)
	}

	select {
	case <-first:
	case <-time.After(15 * time.Second):
		t.Fatal("no wake-up after insert; LISTEN fan-out is broken")
	}
	// The second subscription was stopped, so it must not receive on a closed
	// channel and the first must still work for the next event.
	if _, err := pool.Exec(ctx, `
		INSERT INTO domain_events (type, organization_id, actor_kind, actor_id)
		VALUES ('project.created', $1, 'human', 'wake-test')`, orgID); err != nil {
		t.Fatalf("insert 2: %v", err)
	}
	select {
	case <-first:
	case <-time.After(15 * time.Second):
		t.Fatal("no wake-up for the surviving subscriber")
	}
}

// TestEventWakeStopsWithContext: cancelling the stream's context must end its
// subscription, which is how a disconnected browser releases the slot.
func TestEventWakeStopsWithContext(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)
	w := NewEventWake(url, nil)
	defer w.Close()

	subCtx, cancel := context.WithCancel(ctx)
	ch, stop, err := w.Watch(subCtx)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	defer stop()
	cancel()

	select {
	case _, open := <-ch:
		if open {
			t.Fatal("wake channel delivered after its context was cancelled")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("wake channel was not closed when its context ended")
	}
}

// evtNaiveEventsAfter is the reader the safe query replaces, kept here so the
// test can show the gap it would have produced rather than assert it in prose.
func evtNaiveEventsAfter(ctx context.Context, s *ProjectStore, projectID string, after int64) ([]events.Envelope, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+prjEventColumns+`
		FROM domain_events
		WHERE project_id = $1::uuid AND global_seq > $2
		ORDER BY global_seq`, projectID, after)
	if err != nil {
		return nil, err
	}
	return evtScanEvents(rows, 10)
}

// evtSummary renders sequences only, so a failure says where the stream
// diverged without dumping payloads.
func evtSummary(evs []events.Envelope) []int64 {
	out := make([]int64, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.GlobalSeq)
	}
	return out
}

// TestOrgEventsAfterRestrictsToVisibleProjects pins the org stream's
// permission predicate inside the SQL (ADR-0048 §4): a member sees only the
// projects of their organization they belong to, an org admin sees every
// project of the organization, project-less (org-scoped) rows are out of
// scope, and the resume cursor orders the multiplexed rows globally.
func TestOrgEventsAfterRestrictsToVisibleProjects(t *testing.T) {
	store, orgID := prjFixture(t)
	ctx := journalCtx(t)
	a, b, otherOrgID, otherUser := prjUsers(t, store, orgID)
	p1 := prjCreateProject(t, store, a, orgID, "One", "org-one")
	p2 := prjCreateProject(t, store, b, orgID, "Two", "org-two")

	// Same gate as every other read in this file: the multiplexed stream may not
	// emit a row the watermark has not admitted yet, and each count below is
	// asserted from one read.
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p1.ID)
	waitJournalReadable(t, store.Pool, "e.project_id = $1::uuid", p2.ID)

	// a is a member of p1 only: p2's rows must be absent, not 404.
	got, err := store.OrgEventsAfter(ctx, Caller{UserID: a, OrganizationID: orgID}, 0, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter (member a): %v", err)
	}
	if len(got) != 1 || got[0].ProjectID != p1.ID {
		t.Errorf("member a saw %v (projects %v), want only p1's row",
			evtSummary(got), evtProjects(got))
	}

	// b is a member of p2 only.
	got, err = store.OrgEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID}, 0, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter (member b): %v", err)
	}
	if len(got) != 1 || got[0].ProjectID != p2.ID {
		t.Errorf("member b saw %v, want only p2's row", evtProjects(got))
	}

	// An org admin with no membership in p1 sees both, oldest first.
	got, err = store.OrgEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID, IsOrgAdmin: true}, 0, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter (org admin): %v", err)
	}
	if len(got) != 2 || got[0].ProjectID != p1.ID || got[1].ProjectID != p2.ID ||
		got[0].GlobalSeq >= got[1].GlobalSeq {
		t.Errorf("org admin saw %v (projects %v), want p1 then p2 in global order",
			evtSummary(got), evtProjects(got))
	}

	// A project-less (org-scoped) row is out of scope of the org stream: the
	// multiplexer carries project events only (ADR-0048 §4).
	if _, err := store.Pool.Exec(ctx, `
		INSERT INTO domain_events (type, organization_id, project_id, actor_kind, actor_id)
		VALUES ('agent.profile.created', $1::uuid, NULL, 'human', 'evt-test')`, orgID); err != nil {
		t.Fatalf("insert project-less row: %v", err)
	}
	got, err = store.OrgEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID, IsOrgAdmin: true}, 0, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter after org-scoped row: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("org admin saw %d rows after a project-less insert, want still 2", len(got))
	}

	// The resume cursor is the shared global_seq: resuming above the first
	// row replays exactly the rest.
	cursor := got[0].GlobalSeq
	got, err = store.OrgEventsAfter(ctx, Caller{UserID: b, OrganizationID: orgID, IsOrgAdmin: true}, cursor, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter resume: %v", err)
	}
	if len(got) != 1 || got[0].GlobalSeq != cursor+1 {
		t.Errorf("resume at %d saw %v, want only seq %d", cursor, evtSummary(got), cursor+1)
	}

	// A caller from another organization sees nothing of this organization:
	// the predicate is scoped by organization, not just by membership.
	got, err = store.OrgEventsAfter(ctx, Caller{UserID: otherUser, OrganizationID: otherOrgID, IsOrgAdmin: true}, 0, 100)
	if err != nil {
		t.Fatalf("OrgEventsAfter (other org): %v", err)
	}
	if len(got) != 0 {
		t.Errorf("other-organization caller saw %v, want nothing", evtProjects(got))
	}
}

// evtProjects renders row project ids (and a dash for project-less rows) so a
// failure says which project leaked through the predicate.
func evtProjects(evs []events.Envelope) []string {
	out := make([]string, 0, len(evs))
	for _, e := range evs {
		if e.ProjectID == "" {
			out = append(out, "-")
			continue
		}
		out = append(out, e.ProjectID)
	}
	return out
}
