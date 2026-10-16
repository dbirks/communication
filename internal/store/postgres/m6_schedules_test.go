package postgres

// The M6 schedule tests are the ADR-0032 gate: every one of its promises (a
// due schedule fires exactly one run, two replicas fire it once, a disabled
// one never fires, the clock advances, missed slots fire once for the latest
// slot) is asserted against a PostgreSQL that actually ran 00006, in the
// m4_* idiom — a mocked green test never substitutes for the real claim.
//
// Fixtures come from m4_pipelines_test.go (m4Setup: org, user, project,
// pipeline, one published revision), plus one assignment row, because a
// schedule belongs to an assignment and nothing else (ADR-0032 § 2).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/events"
)

// m6Fixture is the m4 project/pipeline/revision plus one assignment and the
// store under test.
type m6Fixture struct {
	*m4Fixture
	schedules  *ScheduleStore
	assignment string
	caller     Caller
}

// m6Setup seeds an assignment pinning the fixture's published revision. The
// schedules rows are cleaned up FIRST (cleanup callbacks run LIFO, and the
// m4Fixture cleanup deletes the assignment and runs this table points at).
func m6Setup(t *testing.T) *m6Fixture {
	t.Helper()
	return m6SetupShared(t, testCtx(t), m4Setup(t).pool)
}

// m6SetupShared builds the same fixture on a pool the CALLER opened, because
// the concurrency proof needs a pool wide enough for several replicas' claims
// and create transactions to be live at once.
func m6SetupShared(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *m6Fixture {
	t.Helper()
	f := m4SetupShared(t, ctx, pool)

	var maxConcurrent any = 4
	var assignID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO assignments (project_id, pipeline_id, pinned_revision_id, max_concurrent_runs, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		f.projectID, f.pipelineID, f.revisionID, maxConcurrent, f.userID).Scan(&assignID); err != nil {
		t.Fatalf("insert assignment: %v", err)
	}
	ss := &ScheduleStore{Pool: pool, Runs: f.runs}

	t.Cleanup(func() {
		bg := context.Background()
		for _, step := range []string{
			// The outbox rows point at the journal by global_seq, so they go
			// first — the same order m4Fixture's own cleanup uses.
			`DELETE FROM outbox WHERE global_seq IN
				(SELECT global_seq FROM domain_events WHERE type = 'schedule.fired' AND project_id = $1)`,
			`DELETE FROM domain_events WHERE type = 'schedule.fired' AND project_id = $1`,
			`DELETE FROM schedules WHERE project_id = $1`,
		} {
			if _, err := pool.Exec(bg, step, f.projectID); err != nil {
				t.Errorf("schedule cleanup %q: %v", step, err)
			}
		}
	})
	return &m6Fixture{
		m4Fixture:  f,
		schedules:  ss,
		assignment: assignID,
		caller:     Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true},
	}
}

// m6At is the clock a test fires against: a fixed UTC instant on the minute,
// so a cron answer can be stated as a literal rather than derived twice.
func m6At(y int, mo time.Month, d, h, mi int) time.Time {
	return time.Date(y, mo, d, h, mi, 0, 0, time.UTC)
}

// m6Create adds a schedule whose first due slot is `next` (the tests name it
// explicitly rather than waiting for wall-clock cron to catch up).
func (f *m6Fixture) m6Create(t *testing.T, ctx context.Context, cron string, next time.Time) Schedule {
	t.Helper()
	enabled := true
	sc, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: cron, Enabled: &enabled, NextRunAt: &next, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("Create(%q): %v", cron, err)
	}
	return sc
}

func (f *m6Fixture) m6Get(t *testing.T, ctx context.Context, id string) Schedule {
	t.Helper()
	sc, err := f.schedules.GetSchedule(ctx, id)
	if err != nil {
		t.Fatalf("GetSchedule(%s): %v", id, err)
	}
	return sc
}

func (f *m6Fixture) m6RunCount(t *testing.T, ctx context.Context) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM runs WHERE assignment_id = $1::uuid`, f.assignment).Scan(&n); err != nil {
		t.Fatalf("count runs: %v", err)
	}
	return n
}

func (f *m6Fixture) m6FiredEvents(t *testing.T, ctx context.Context) []events.ScheduleFiredPayload {
	t.Helper()
	rows, err := f.pool.Query(ctx, `
		SELECT payload FROM domain_events WHERE type = $1 AND project_id = $2::uuid
		ORDER BY global_seq`, events.TypeScheduleFired, f.projectID)
	if err != nil {
		t.Fatalf("read schedule.fired rows: %v", err)
	}
	defer rows.Close()

	var out []events.ScheduleFiredPayload
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan schedule.fired payload: %v", err)
		}
		var p events.ScheduleFiredPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("decode schedule.fired payload %s: %v", raw, err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read schedule.fired rows: %v", err)
	}
	return out
}

// ------------------------------------------------------------------ CRUD

// TestScheduleCreateReadUpdate exercises the store face part 2's routes will
// sit on: a bad cron never becomes a row, an input the pinned revision would
// refuse never becomes a row, List is per project, and Update is the
// optimistic-version CAS it claims to be.
func TestScheduleCreateReadUpdate(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)

	if _, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "every tuesday", CreatedBy: f.userID,
	}); err == nil || !strings.Contains(err.Error(), "wants 5 fields") {
		t.Errorf("Create with an unparseable cron = %v, want the field-count error", err)
	}
	if _, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "0 0 30 2 *", CreatedBy: f.userID,
	}); err == nil || !errors.Is(err, ErrScheduleNotFireable) {
		t.Errorf("Create with a never-firing cron = %v, want ErrScheduleNotFireable", err)
	}
	if _, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "0 0 * * *", Inputs: json.RawMessage(`{"Not_A_Name":1}`), CreatedBy: f.userID,
	}); err == nil || !strings.Contains(err.Error(), "legal run input name") {
		t.Errorf("Create with an illegal input name = %v, want the name refusal", err)
	}
	// An assignment in somebody else's project is not found, not created.
	if _, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: "00000000-0000-4000-8000-000000000000",
		CronExpr: "0 0 * * *", CreatedBy: f.userID,
	}); !errors.Is(err, ErrScheduleNotFound) {
		t.Errorf("Create against a missing assignment = %v, want ErrScheduleNotFound", err)
	}

	sc := f.m6Create(t, ctx, "30 4 * * *", m6At(2026, 3, 10, 4, 30))
	if sc.Version != 1 || !sc.Enabled || sc.LastRunID != "" || !sc.LastRunAt.IsZero() {
		t.Errorf("fresh schedule = %+v, want version 1, enabled, never fired", sc)
	}
	if !sc.NextRunAt.Equal(m6At(2026, 3, 10, 4, 30)) {
		t.Errorf("NextRunAt = %s, want the slot the test named", sc.NextRunAt)
	}
	if got := f.m6Get(t, ctx, sc.ID); got.CronExpr != "30 4 * * *" || got.ID != sc.ID {
		t.Errorf("GetSchedule = %+v, want the row Create wrote", got)
	}
	list, err := f.schedules.ListSchedules(ctx, f.projectID)
	if err != nil || len(list) != 1 || list[0].ID != sc.ID {
		t.Fatalf("ListSchedules = (%+v, %v), want exactly the one row", list, err)
	}
	if other, err := f.schedules.ListSchedules(ctx, "00000000-0000-4000-8000-000000000000"); err != nil || len(other) != 0 {
		t.Errorf("ListSchedules(unknown project) = (%d, %v), want an empty list and no error", len(other), err)
	}

	// A stale version is refused, and refuses without touching the row.
	if _, err := f.schedules.UpdateSchedule(ctx, ScheduleUpdate{
		ID: sc.ID, ExpectedVersion: 99, CronExpr: ptrStr("0 9 * * *"),
	}); !errors.Is(err, ErrScheduleStaleVersion) {
		t.Errorf("Update at version 99 = %v, want ErrScheduleStaleVersion", err)
	}
	if got := f.m6Get(t, ctx, sc.ID); got.CronExpr != "30 4 * * *" || got.Version != 1 {
		t.Errorf("row after a refused update = %+v, want the untouched version 1", got)
	}

	updated, err := f.schedules.UpdateSchedule(ctx, ScheduleUpdate{
		ID: sc.ID, ExpectedVersion: 1, CronExpr: ptrStr("0 9 * * 1-5"),
		Inputs: ptrJSON(`{}`),
	})
	if err != nil {
		t.Fatalf("UpdateSchedule: %v", err)
	}
	if updated.Version != 2 || updated.CronExpr != "0 9 * * 1-5" {
		t.Errorf("updated = %+v, want version 2 with the new expression", updated)
	}
	// The clock follows the new expression rather than the old one's slot.
	if !updated.NextRunAt.After(m6At(2026, 3, 10, 4, 30)) {
		t.Errorf("NextRunAt after a cron change = %s, want it re-derived from the new expression", updated.NextRunAt)
	}

	off, err := f.schedules.UpdateSchedule(ctx, ScheduleUpdate{ID: sc.ID, ExpectedVersion: 2, Enabled: ptrBool(false)})
	if err != nil || off.Enabled {
		t.Fatalf("disable = (%+v, %v)", off, err)
	}
	// A disabled schedule may keep an expression the revision would refuse:
	// it is not being asked to fire, and refusing the edit would strand it.
	if _, err := f.schedules.UpdateSchedule(ctx, ScheduleUpdate{
		ID: sc.ID, ExpectedVersion: 3, Inputs: ptrJSON(`{"target":"prod"}`),
	}); err != nil {
		t.Errorf("edit while disabled = %v, want the edit to land", err)
	}
}

func ptrStr(s string) *string           { return &s }
func ptrBool(b bool) *bool              { return &b }
func ptrJSON(s string) *json.RawMessage { r := json.RawMessage(s); return &r }

// ---------------------------------------------------------------- the tick

// TestScheduleFiresOneRunWhenDue is ADR-0032's central promise: one due row,
// one tick, one run — and that run is an ordinary pinned run, not a
// scheduler's private shape.
func TestScheduleFiresOneRunWhenDue(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	now := m6At(2026, 3, 10, 8, 45)
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))

	fired, err := f.schedules.TickSchedules(ctx, now)
	if err != nil || fired != 1 {
		t.Fatalf("TickSchedules = (%d, %v), want one fire and no error", fired, err)
	}
	if n := f.m6RunCount(t, ctx); n != 1 {
		t.Fatalf("runs for the assignment = %d, want 1", n)
	}

	var (
		runID, revision, digest, plan, triggeredBy, status, assign string
	)
	if err := f.pool.QueryRow(ctx, `
		SELECT id::text, pipeline_revision_id::text, revision_digest, plan_digest,
		       COALESCE(triggered_by::text, ''), status, COALESCE(assignment_id::text, '')
		FROM runs WHERE assignment_id = $1::uuid`, f.assignment).
		Scan(&runID, &revision, &digest, &plan, &triggeredBy, &status, &assign); err != nil {
		t.Fatalf("read the fired run: %v", err)
	}
	// The digests are the revision's own (00005 stores the plan digest the
	// compiler derived alongside the revision, not a fixture's guess).
	if revision != f.revisionID || digest != f.digest || plan != m4Digest("plan-of/"+f.digest) {
		t.Errorf("fired run pinned (%s, %s, %s), want the assignment's revision %s with its own digests",
			revision, digest, plan, f.revisionID)
	}
	if assign != f.assignment {
		t.Errorf("fired run assignment = %s, want %s", assign, f.assignment)
	}
	if triggeredBy != "" {
		t.Errorf("triggered_by = %s, want NULL: a schedule fire is a system start", triggeredBy)
	}
	if status != "queued" {
		t.Errorf("fired run status = %s, want queued (the M4 driver, not the tick, moves it)", status)
	}

	got := f.m6Get(t, ctx, sc.ID)
	if got.LastRunID != runID {
		t.Errorf("last_run_id = %s, want the run the tick created (%s)", got.LastRunID, runID)
	}
	if !got.LastRunAt.Equal(m6At(2026, 3, 10, 0, 0)) {
		t.Errorf("last_run_at = %s, want the slot that fired", got.LastRunAt)
	}
	if !got.NextRunAt.Equal(m6At(2026, 3, 11, 0, 0)) {
		t.Errorf("next_run_at = %s, want 2026-03-11T00:00:00Z", got.NextRunAt)
	}
	if got.Version != 1 {
		t.Errorf("version = %d, want 1: a fire never bumps the config version", got.Version)
	}

	// run.created carries the fired run, and schedule.fired is one row
	// correlated to it with the slot in the body (ADR-0032 § 4).
	var created int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM domain_events WHERE type = $1 AND run_id = $2::uuid`,
		events.TypeRunCreated, runID).Scan(&created); err != nil || created != 1 {
		t.Errorf("run.created rows = %d (%v), want 1", created, err)
	}
	firedRows := f.m6FiredEvents(t, ctx)
	if len(firedRows) != 1 {
		t.Fatalf("schedule.fired rows = %d, want 1", len(firedRows))
	}
	p := firedRows[0]
	if p.RunID != runID || p.ScheduleID != sc.ID || p.AssignmentID != f.assignment {
		t.Errorf("schedule.fired payload = %+v, want this schedule, assignment and run", p)
	}
	if p.CronExpr != "0 0 * * *" || !p.ScheduledFor.Equal(m6At(2026, 3, 10, 0, 0)) || p.LateFireCount != 0 {
		t.Errorf("schedule.fired payload = %+v, want the on-time 00:00 slot of the stored expression", p)
	}
	var journalRun string
	if err := f.pool.QueryRow(ctx,
		`SELECT COALESCE(run_id::text, '') FROM domain_events WHERE type = $1`,
		events.TypeScheduleFired).Scan(&journalRun); err != nil || journalRun != runID {
		t.Errorf("schedule.fired run_id column = %q (%v), want %s so it reaches the run stream", journalRun, err, runID)
	}
}

// TestScheduleNotDueDoesNotFire is the other half of the due predicate: a
// slot in the future stays a promise.
func TestScheduleNotDueDoesNotFire(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 11, 0, 0))

	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 23, 59)); err != nil || fired != 0 {
		t.Fatalf("TickSchedules before the slot = (%d, %v), want no fire", fired, err)
	}
	if n := f.m6RunCount(t, ctx); n != 0 {
		t.Errorf("runs = %d, want 0", n)
	}
}

// TestScheduleDisabledNeverFires is the toggle's meaning: an overdue disabled
// schedule is not a schedule, and its clock stays where it was so the operator
// can re-enable it and see what it was about to do.
func TestScheduleDisabledNeverFires(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	now := m6At(2026, 3, 10, 8, 45)
	disabled := false
	sc, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment,
		CronExpr: "*/5 * * * *", Enabled: &disabled,
		NextRunAt: ptrTime(m6At(2026, 3, 9, 12, 0)), CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for i := 0; i < 3; i++ {
		if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 0 {
			t.Fatalf("tick %d of a disabled schedule = (%d, %v), want no fire", i, fired, err)
		}
	}
	if n := f.m6RunCount(t, ctx); n != 0 {
		t.Errorf("runs = %d, want 0 for a disabled schedule", n)
	}
	if got := f.m6Get(t, ctx, sc.ID); !got.NextRunAt.Equal(m6At(2026, 3, 9, 12, 0)) {
		t.Errorf("next_run_at = %s, want the stored slot untouched", got.NextRunAt)
	}
	if rows := f.m6FiredEvents(t, ctx); len(rows) != 0 {
		t.Errorf("schedule.fired rows = %d, want 0", len(rows))
	}
}

func ptrTime(v time.Time) *time.Time { return &v }

// TestScheduleConcurrentTicksFireOnce is the two-replica proof ADR-0032 § 4
// owes: N stores, one pool, the same `now`, every schedule due. Each schedule
// fires exactly once in total — the loser of the row lock does not wait and
// does not create a second run.
func TestScheduleConcurrentTicksFireOnce(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	// Every in-flight fire holds the claim transaction's connection while it
	// runs the create on a second one, so the "replicas" this test simulates
	// need 2 conns each — a pool at the pgxpool default would turn a
	// contention proof into a connection wait.
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	// t.Cleanup rather than defer: cleanups run after the function body's
	// defers, and the fixture's own cleanup (registered here, at setup time)
	// still has rows to delete on this pool when the test ends.
	t.Cleanup(pool.Close)

	f := m6SetupShared(t, ctx, pool)
	const replicas, schedules = 4, 4
	now := m6At(2026, 3, 10, 8, 45)
	for i := 0; i < schedules; i++ {
		f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))
	}

	stores := make([]*ScheduleStore, replicas)
	for i := range stores {
		stores[i] = &ScheduleStore{Pool: pool, Runs: f.runs}
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	counts := make([]int, replicas)
	errs := make([]error, replicas)
	for i, ss := range stores {
		wg.Add(1)
		go func(i int, ss *ScheduleStore) {
			defer wg.Done()
			<-start
			counts[i], errs[i] = ss.TickSchedules(ctx, now)
		}(i, ss)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("replica %d tick: %v", i, err)
		}
	}
	fired := 0
	for _, n := range counts {
		fired += n
	}
	if fired != schedules {
		t.Errorf("total fires = %d across %+v, want exactly %d", fired, counts, schedules)
	}
	if n := f.m6RunCount(t, ctx); n != schedules {
		t.Errorf("runs = %d, want %d: a double tick double-firing is the bug ADR-0032 exists to prevent", n, schedules)
	}
	if rows := f.m6FiredEvents(t, ctx); len(rows) != schedules {
		t.Errorf("schedule.fired rows = %d, want %d", len(rows), schedules)
	}
	all, err := f.schedules.ListSchedules(ctx, f.projectID)
	if err != nil {
		t.Fatalf("ListSchedules after the concurrent ticks: %v", err)
	}
	// Each schedule advanced exactly once (one next slot, one last run) rather
	// than once per replica that looked at it.
	for _, sc := range all {
		if !sc.NextRunAt.Equal(m6At(2026, 3, 11, 0, 0)) {
			t.Errorf("schedule %s next_run_at = %s, want one advance to 2026-03-11T00:00:00Z", sc.ID, sc.NextRunAt)
		}
		if sc.LastRunID == "" {
			t.Errorf("schedule %s never stamped last_run_id", sc.ID)
		}
	}
}

// TestScheduleClaimSkipsALockedRow isolates the SKIP LOCKED half of the
// no-double-fire argument: a schedule whose row another session holds is not
// fired by this tick at all — it does not queue, it does not double-create.
func TestScheduleClaimSkipsALockedRow(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	now := m6At(2026, 3, 10, 8, 45)
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))

	holder, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holder tx: %v", err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	var locked string
	if err := holder.QueryRow(ctx,
		`SELECT id::text FROM schedules WHERE id = $1::uuid FOR UPDATE`, sc.ID).Scan(&locked); err != nil {
		t.Fatalf("lock the schedule row: %v", err)
	}

	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 0 {
		t.Fatalf("tick against a locked row = (%d, %v), want it to skip rather than wait", fired, err)
	}
	if n := f.m6RunCount(t, ctx); n != 0 {
		t.Errorf("runs = %d, want 0 while another session holds the claim", n)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatalf("commit holder: %v", err)
	}
	// The slot was never consumed, so the next tick fires it: a slow replica
	// delays a fire, it never loses one.
	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 1 {
		t.Fatalf("tick after the lock was released = (%d, %v), want one fire", fired, err)
	}
}

// TestScheduleMissedSlotsFireOnce is the downtime rule: a day of no ticks is
// one late run for the newest slot, never a queue of reruns for every slot in
// between, and the lateness is on the journal row rather than in a log.
func TestScheduleMissedSlotsFireOnce(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	now := m6At(2026, 3, 10, 8, 45)
	// Five daily slots went by while nobody was ticking.
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 5, 0, 0))

	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 1 {
		t.Fatalf("TickSchedules after a missed run = (%d, %v), want exactly one fire", fired, err)
	}
	if n := f.m6RunCount(t, ctx); n != 1 {
		t.Fatalf("runs = %d, want 1 — the backfill ADR-0032 § 4 forbids would make it 6", n)
	}
	rows := f.m6FiredEvents(t, ctx)
	if len(rows) != 1 {
		t.Fatalf("schedule.fired rows = %d, want 1", len(rows))
	}
	if !rows[0].ScheduledFor.Equal(m6At(2026, 3, 10, 0, 0)) || rows[0].LateFireCount != 5 {
		t.Errorf("schedule.fired = %+v, want the 2026-03-10T00:00:00Z slot with late_fire_count 5", rows[0])
	}
	got := f.m6Get(t, ctx, sc.ID)
	if !got.NextRunAt.Equal(m6At(2026, 3, 11, 0, 0)) {
		t.Errorf("next_run_at = %s, want the first slot AFTER now (never a replay of the missed ones)", got.NextRunAt)
	}
	if !got.LastRunAt.Equal(m6At(2026, 3, 10, 0, 0)) {
		t.Errorf("last_run_at = %s, want the slot that fired", got.LastRunAt)
	}
	// Ticking the same instant again is a no-op: the clock moved past it.
	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 0 {
		t.Fatalf("second tick at the same instant = (%d, %v), want no fire", fired, err)
	}
}

// TestScheduleCeilingDefersTheSlot proves the refusal rule that keeps a
// scheduler honest: at the assignment's max_concurrent_runs the tick fires
// nothing AND consumes nothing, so the slot is still due when capacity frees.
// Advancing the clock on a refused fire would be the silent-downtime bug.
func TestScheduleCeilingDefersTheSlot(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	if _, err := f.pool.Exec(ctx,
		`UPDATE assignments SET max_concurrent_runs = 1 WHERE id = $1::uuid`, f.assignment); err != nil {
		t.Fatalf("lower the ceiling: %v", err)
	}
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))

	// First fire: the assignment is idle, the slot runs.
	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 8, 45)); err != nil || fired != 1 {
		t.Fatalf("first tick = (%d, %v), want one fire", fired, err)
	}
	// Second fire: the first run is still live, so the ceiling refuses it and
	// the clock stays where it was.
	now := m6At(2026, 3, 11, 0, 30)
	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 0 {
		t.Fatalf("tick at the ceiling = (%d, %v), want no fire", fired, err)
	}
	held := f.m6Get(t, ctx, sc.ID)
	if !held.NextRunAt.Equal(m6At(2026, 3, 11, 0, 0)) {
		t.Errorf("next_run_at at the ceiling = %s, want the pending slot left alone", held.NextRunAt)
	}
	if n := f.m6RunCount(t, ctx); n != 1 {
		t.Fatalf("runs = %d, want the one live run", n)
	}

	// The live run finishes; the pending slot fires on the next tick.
	if _, err := f.pool.Exec(ctx,
		`UPDATE runs SET status = 'completed', finished_at = $2 WHERE assignment_id = $1::uuid`,
		f.assignment, now); err != nil {
		t.Fatalf("complete the live run: %v", err)
	}
	if fired, err := f.schedules.TickSchedules(ctx, now); err != nil || fired != 1 {
		t.Fatalf("tick once capacity freed = (%d, %v), want one fire", fired, err)
	}
	got := f.m6Get(t, ctx, sc.ID)
	if !got.NextRunAt.Equal(m6At(2026, 3, 12, 0, 0)) {
		t.Errorf("next_run_at = %s, want the deferred slot advanced once", got.NextRunAt)
	}
	if n := f.m6RunCount(t, ctx); n != 2 {
		t.Errorf("runs = %d, want 2 (the deferred slot fired once, not twice)", n)
	}
}

// TestScheduleAssignmentDisabledLeavesSlotPending is the same refusal rule for
// an assignment switched off under a live schedule: no run, no consumed slot,
// and no journal row claiming a fire that did not happen.
func TestScheduleAssignmentDisabledLeavesSlotPending(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))
	if _, err := f.pool.Exec(ctx,
		`UPDATE assignments SET enabled = false WHERE id = $1::uuid`, f.assignment); err != nil {
		t.Fatalf("disable the assignment: %v", err)
	}

	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 8, 45)); err != nil || fired != 0 {
		t.Fatalf("tick with the assignment disabled = (%d, %v), want no fire", fired, err)
	}
	got := f.m6Get(t, ctx, sc.ID)
	if !got.NextRunAt.Equal(m6At(2026, 3, 10, 0, 0)) || got.LastRunID != "" {
		t.Errorf("schedule after a refusal = %+v, want the slot pending and no last run", got)
	}
	if rows := f.m6FiredEvents(t, ctx); len(rows) != 0 {
		t.Errorf("schedule.fired rows = %d, want 0 — nothing fired", len(rows))
	}
	// Re-enabling the assignment makes the pending slot fire, once, late.
	if _, err := f.pool.Exec(ctx,
		`UPDATE assignments SET enabled = true WHERE id = $1::uuid`, f.assignment); err != nil {
		t.Fatalf("re-enable the assignment: %v", err)
	}
	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 8, 45)); err != nil || fired != 1 {
		t.Fatalf("tick after re-enabling = (%d, %v), want one fire", fired, err)
	}
}

// m6PublishInputs publishes a second revision of the fixture pipeline whose
// compiled plan DECLARES an input, and re-pins the fixture's assignment to it.
// It goes through the real draft -> validate -> publish path (f.pipelines), so
// the schedule fires a revision the compiler produced rather than one the test
// hand-wrote — and so m4ValidateRunInputs has something to say no about.
func (f *m6Fixture) m6PublishInputs(t *testing.T, ctx context.Context, inputName string) string {
	t.Helper()
	token := migFixtureToken(t) + "/" + inputName
	digest := m4Digest("rev/inputs/" + token)
	doc := fmt.Sprintf("apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# %s\n", digest)
	canonical := json.RawMessage(fmt.Sprintf(
		`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","marker":%q}`, digest))
	plan := json.RawMessage(fmt.Sprintf(
		`{"nodes":[],"inputs":{"properties":{%q:{"type":"string"}},"required":[%q]}}`, inputName, inputName))
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("src/" + digest), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: canonical, RevisionDigest: digest,
		CompiledPlan: plan, PlanDigest: m4Digest("plan-of/" + digest),
		Validation: json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "2.0.0", DocumentText: doc,
		SchemaDigest: m4Digest("schema"), CelEnvDigest: m4Digest("celenv"),
		PublishedBy: f.userID, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}
	if _, err := f.pool.Exec(ctx,
		`UPDATE assignments SET pinned_revision_id = $2 WHERE id = $1::uuid`, f.assignment, rev.ID); err != nil {
		t.Fatalf("re-pin the assignment: %v", err)
	}
	return rev.ID
}

// TestScheduleFixedInputsReachTheRun pins the "with fixed inputs" half of
// ADR-0032 § 2: what the schedule stores is what the run's inputs are, and the
// pinned revision's own input rules gate them — the same m4ValidateRunInputs a
// manual POST /runs passes through, which is why an input the revision does not
// declare is refused when the schedule is created rather than at 03:00.
func TestScheduleFixedInputsReachTheRun(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	f.m6PublishInputs(t, ctx, "scan_scope")

	enabled := true
	next := m6At(2026, 3, 10, 0, 0)
	sc, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment, CronExpr: "0 0 * * *",
		Inputs: json.RawMessage(`{"scan_scope":"full"}`), Enabled: &enabled,
		NextRunAt: &next, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("Create with declared inputs: %v", err)
	}
	if _, err := f.schedules.Create(ctx, NewSchedule{
		ProjectID: f.projectID, AssignmentID: f.assignment, CronExpr: "0 0 * * *",
		Inputs: json.RawMessage(`{"undeclared":"yes"}`), Enabled: &enabled,
		NextRunAt: &next, CreatedBy: f.userID,
	}); err == nil || !strings.Contains(err.Error(), "inputs rejected by the pinned revision") {
		t.Errorf("Create with an undeclared input = %v, want the pinned revision's refusal", err)
	}
	if _, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 8, 45)); err != nil {
		t.Fatalf("TickSchedules: %v", err)
	}

	var value, origin string
	if err := f.pool.QueryRow(ctx, `
		SELECT ri.value::text, ri.origin FROM run_inputs ri
		JOIN runs r ON r.id = ri.run_id
		WHERE r.assignment_id = $1::uuid AND ri.name = 'scan_scope'`, f.assignment).
		Scan(&value, &origin); err != nil {
		t.Fatalf("read the fired run's input: %v", err)
	}
	if strings.Trim(value, `"`) != "full" || origin != "submitted" {
		t.Errorf("run input = (%s, %s), want \"full\" from the schedule", value, origin)
	}
	if got := f.m6Get(t, ctx, sc.ID); got.LastRunID == "" {
		t.Error("schedule never fired")
	}
}

// TestScheduleTickWithoutADueRowIsQuiet keeps the ordinary answer honest: an
// empty table, and a tick with nothing enabled, both report 0 rather than an
// error — the serve wiring in part 2 logs on error, and a quiet tick must stay
// quiet.
func TestScheduleTickWithoutADueRowIsQuiet(t *testing.T) {
	f := m6Setup(t)
	ctx := testCtx(t)
	if fired, err := f.schedules.TickSchedules(ctx, m6At(2026, 3, 10, 8, 45)); err != nil || fired != 0 {
		t.Fatalf("empty tick = (%d, %v), want (0, nil)", fired, err)
	}
	if fired, err := f.schedules.TickSchedules(ctx, time.Time{}); err != nil || fired != 0 {
		t.Fatalf("tick with a zero now = (%d, %v), want it to default to the wall clock and stay quiet", fired, err)
	}
	var bad ScheduleStore
	if _, err := bad.TickSchedules(ctx, time.Now()); err == nil {
		t.Error("TickSchedules with no pool = nil error, want a refusal")
	}
}

// --------------------------------------------------------------- migration

// TestMigrate0006ScheduleSchema asserts 00006's constraints BEHAVE, not merely
// that goose reported version 6 (the TestMigrate0005SchemaShape idiom): the
// due index is partial over enabled, a schedule cannot point at another
// project's assignment, an expression the parser could never read is not
// admissible, and a half-written fire is refused.
func TestMigrate0006ScheduleSchema(t *testing.T) {
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := m6SetupShared(t, ctx, pool)

	// The table and the columns the store's column list reads.
	var cols []string
	rows, err := pool.Query(ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'schedules'`)
	if err != nil {
		t.Fatalf("read schedules columns: %v", err)
	}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatalf("scan column name: %v", err)
		}
		cols = append(cols, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read schedules columns: %v", err)
	}
	for _, want := range []string{"id", "project_id", "assignment_id", "cron_expr", "inputs",
		"enabled", "next_run_at", "last_run_at", "last_run_id", "version", "created_by",
		"created_at", "updated_at"} {
		found := false
		for _, c := range cols {
			if c == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("schedules.%s missing after 00006 (columns: %v)", want, cols)
		}
	}

	// The tick's index: over next_run_at, and partial over enabled, so a
	// disabled schedule costs the due scan nothing.
	var indexDef string
	if err := pool.QueryRow(ctx, `
		SELECT indexdef FROM pg_indexes WHERE tablename = 'schedules' AND indexname = 'schedules_due_idx'`).
		Scan(&indexDef); err != nil {
		t.Fatalf("schedules_due_idx missing after 00006: %v", err)
	}
	if !strings.Contains(indexDef, "next_run_at") || !strings.Contains(indexDef, "WHERE enabled") {
		t.Errorf("schedules_due_idx = %s, want it keyed on next_run_at WHERE enabled", indexDef)
	}

	// next_run_at is the one due clock: NOT NULL, so "enabled but unscheduled"
	// is not a state the tick has to reason about.
	var nullable string
	if err := pool.QueryRow(ctx, `
		SELECT is_nullable FROM information_schema.columns
		WHERE table_name = 'schedules' AND column_name = 'next_run_at'`).Scan(&nullable); err != nil {
		t.Fatalf("read next_run_at nullability: %v", err)
	}
	if nullable != "NO" {
		t.Errorf("schedules.next_run_at is nullable = %s, want NO", nullable)
	}

	// The cross-project lie: a schedule in this project pointing at another
	// project's assignment. Second project, same org, same pipeline — the only
	// thing that differs is the project the assignment belongs to.
	token := migFixtureToken(t)
	var otherProject string
	if err := pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1, 'm6-other-' || $2, 'M6 other project', $3) RETURNING id`,
		f.orgID, token, f.userID).Scan(&otherProject); err != nil {
		t.Fatalf("seed second project: %v", err)
	}
	var foreignAssign string
	if err := pool.QueryRow(ctx, `
		INSERT INTO assignments (project_id, pipeline_id, pinned_revision_id, created_by)
		VALUES ($1, $2, $3, $4) RETURNING id`, otherProject, f.pipelineID, f.revisionID, f.userID).
		Scan(&foreignAssign); err != nil {
		t.Fatalf("seed a second-project assignment: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := pool.Exec(bg, `DELETE FROM assignments WHERE id = $1`, foreignAssign); err != nil {
			t.Errorf("cleanup second assignment: %v", err)
		}
		if _, err := pool.Exec(bg, `DELETE FROM projects WHERE id = $1`, otherProject); err != nil {
			t.Errorf("cleanup second project: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `
		INSERT INTO schedules (project_id, assignment_id, cron_expr, created_by, next_run_at)
		VALUES ($1, $2, '0 0 * * *', $3, now())`, f.projectID, foreignAssign, f.userID); err == nil {
		t.Error("a schedule firing another project's assignment was accepted; 00006's composite FK must refuse it")
	} else if !strings.Contains(err.Error(), "schedules_fire_in_their_assignments_project") {
		t.Errorf("cross-project insert failed with %v, want the composite FK refusal by name", err)
	}

	// The expression shape: five whitespace-separated fields, nothing else.
	for _, bad := range []string{"", "0 0 * *", "0 0 * * *\nextra", "0 0 * * * extra"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO schedules (project_id, assignment_id, cron_expr, created_by, next_run_at)
			VALUES ($1, $2, $3, $4, now())`, f.projectID, f.assignment, bad, f.userID); err == nil {
			t.Errorf("cron_expr %q was accepted; the CHECK only admits the five-field shape the store writes", bad)
		}
	}
	// Tabs between the fields are the shape Parse reads (strings.Fields) and
	// the CHECK admits; the store just never writes one, because Parse's
	// normalized String() is what lands in the column.
	tabs := "0\t0\t*\t*\t*"
	if _, err := pool.Exec(ctx, `
		INSERT INTO schedules (project_id, assignment_id, cron_expr, created_by, next_run_at)
		VALUES ($1, $2, $3, $4, now())`, f.projectID, f.assignment, tabs, f.userID); err != nil {
		t.Errorf("the CHECK refused %q: %v — five fields separated by whitespace is what it means to admit", tabs, err)
	} else {
		if _, err := pool.Exec(ctx, `
			DELETE FROM schedules WHERE project_id = $1 AND cron_expr = $2`, f.projectID, tabs); err != nil {
			t.Errorf("cleanup the tab row: %v", err)
		}
	}

	// A half-written fire: a slot stamped with no run behind it. Clearing both
	// together is the legal never-fired shape; one without the other is not.
	sc := f.m6Create(t, ctx, "0 0 * * *", m6At(2026, 3, 10, 0, 0))
	if _, err := pool.Exec(ctx,
		`UPDATE schedules SET last_run_at = now() WHERE id = $1`, sc.ID); err == nil {
		t.Error("a last_run_at with no last_run_id was accepted; schedules_last_run_is_a_pair must refuse it")
	}
	if _, err := pool.Exec(ctx,
		`UPDATE schedules SET last_run_at = NULL WHERE id = $1`, sc.ID); err != nil {
		t.Errorf("clearing both stamps (the never-fired shape) failed: %v", err)
	}
}
