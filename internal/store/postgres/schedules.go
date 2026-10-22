package postgres

// M6 schedule triggers (ADR-0032): the persistence and the tick for "a
// security workflow that runs on a schedule" (communication-spec/07's
// cron-like trigger, 11-build-roadmap.md M6).
//
// A schedule is a recurring INTENT attached to a project's pipeline
// ASSIGNMENT: it fires that assignment's pinned revision with fixed inputs.
// It is not a second execution engine — firing means inserting a run through
// RunStore.CreateRun, the exact committed path a manual POST /runs takes
// (digests, plan snapshot, run_inputs rows and run.created all come from that
// one transaction). What this file adds is only WHEN: a due-row claim, an
// idempotency key, and an advance of next_run_at.
//
// The three rules that make a fire trustworthy, and where each lives:
//
//   - No double-fire. Two replicas (or two ticks of one replica) claim due
//     rows with FOR UPDATE SKIP LOCKED, the m4driver/turns idiom: the loser
//     of the row lock does not wait and does not fire. And the key
//     `schedule-<schedule id>-<fired slot>` (run_idempotency_keys) is the
//     backstop: a schedule that reserves a slot and then crashes before
//     stamping last_run_* re-presents the same slot on its next tick, and
//     CreateRun answers with the run that already exists instead of a second
//     one. See the ADR § 4 for why the key separator is a dash.
//   - No backfill. A replica that was down for a day fires ONCE, for the
//     latest missed slot, and sets next_run_at to the first slot after now
//     (ADR-0032 § 4). A missed fire is an observation for the operator,
//     carried as schedule.fired's late_fire_count, never a queue of reruns.
//   - No runaway concurrency. The fire honours the assignment's
//     max_concurrent_runs ceiling the same way route 22 does (live runs
//     counted from rows, never from a memory). At the ceiling the tick leaves
//     the row due and moves on: the slot is still pending, and the missed
//     rule above collapses the backlog the moment capacity frees.
//
// One transaction per row per fire: it locks the schedule row, refuses
// anything the row itself says is not fireable (disabled, assignment
// disabled or unpublished), then advances next_run_at and stamps last_run_*
// and appends schedule.fired. The run insert is the one step that is NOT in
// that transaction — CreateRun owns its own — and it is made between the lock
// and the commit, so the row lock is what serializes two replicas and the
// idempotency key is what makes a crash between the two commits harmless.
//
// The tick is not wired into serve yet (part 2): it belongs beside the M4
// driver's Run loop in cmd/communication's serve path, on its own ticker.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/pipelines/schedule"
)

// ScheduleStore owns the schedules table and the due-row tick. A nil Log
// discards (a store built in a test must not write to stderr); Runs is the
// shared create path and defaults to one over Pool.
type ScheduleStore struct {
	Pool *pgxpool.Pool

	// Runs is the run-creation path ADR-0032 insists on reusing. Production
	// and tests leave it nil and get &RunStore{Pool: s.Pool}.
	Runs *RunStore

	Log *slog.Logger
}

// scheduleTickBatch caps how many due rows one tick may handle: the same
// capped-batch rule as the M4 driver, so a table of misconfigured schedules
// cannot hold a replica's connection for an unbounded time.
const scheduleTickBatch = 100

// ErrScheduleNotFound covers a missing id, a project mismatch on List, and
// any assignment the caller's project does not own — one answer, so nothing
// here leaks another project's rows.
var ErrScheduleNotFound = errors.New("postgres: schedule not found")

// ErrScheduleStaleVersion is the optimistic-concurrency miss: the row moved
// (a config edit) since the caller read it. A scheduled fire never bumps
// version, so this only ever means "somebody else edited the schedule".
var ErrScheduleStaleVersion = errors.New("postgres: schedule version is stale")

// ErrScheduleNotFireable refuses a Create whose assignment could never fire:
// disabled, or pinned to a revision that is not published. Refusing at Create
// is the difference between "the schedule is broken" and "the schedule
// silently never ran", and a scheduler cannot report the first.
var ErrScheduleNotFireable = errors.New("postgres: schedule assignment cannot fire")

func (s *ScheduleStore) runs() *RunStore {
	if s.Runs != nil {
		return s.Runs
	}
	return &RunStore{Pool: s.Pool}
}

func (s *ScheduleStore) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// --------------------------------------------------------------------- rows

// Schedule is one schedules row: the expression as its author wrote it, the
// derived clock (next_run_at), and the record of the last fire.
type Schedule struct {
	ID           string
	ProjectID    string
	AssignmentID string
	CronExpr     string
	Inputs       json.RawMessage
	Enabled      bool
	NextRunAt    time.Time
	LastRunAt    time.Time // zero ⇒ never fired
	LastRunID    string    // "" ⇒ never fired
	Version      int
	CreatedBy    string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// scheduleColumns is the read list. next_run_at is NOT NULL (00006), so the
// scan needs no pointer for the due clock; the last_run pair does.
const scheduleColumns = `id, project_id, assignment_id, cron_expr, inputs::text, enabled,
	next_run_at, last_run_at, COALESCE(last_run_id::text, ''), version, created_by,
	created_at, updated_at`

func (s *ScheduleStore) scan(row pgx.Row) (Schedule, error) {
	var (
		sc        Schedule
		inputs    string
		lastRunAt *time.Time
	)
	err := row.Scan(&sc.ID, &sc.ProjectID, &sc.AssignmentID, &sc.CronExpr, &inputs,
		&sc.Enabled, &sc.NextRunAt, &lastRunAt, &sc.LastRunID, &sc.Version,
		&sc.CreatedBy, &sc.CreatedAt, &sc.UpdatedAt)
	if err != nil {
		return Schedule{}, err
	}
	sc.Inputs = json.RawMessage(inputs)
	sc.LastRunAt = derefTime(lastRunAt)
	sc.CreatedAt, sc.UpdatedAt = sc.CreatedAt.UTC(), sc.UpdatedAt.UTC()
	sc.NextRunAt, sc.LastRunAt = sc.NextRunAt.UTC(), sc.LastRunAt.UTC()
	return sc, nil
}

// derefTime flattens a nullable timestamp to the zero time, the same way
// runs.go's derefStr flattens a nullable text.
func derefTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return t.UTC()
}

// NewSchedule is Create's input. CronExpr is stored verbatim (normalized to
// single spaces, which is what Parse reports back) and never cached in a
// parsed form. NextRunAt is an override for tests and backfills: nil derives
// the first slot from the expression and now. Enabled is nil ⇒ enabled.
type NewSchedule struct {
	ProjectID    string
	AssignmentID string
	CronExpr     string
	Inputs       json.RawMessage
	Enabled      *bool
	NextRunAt    *time.Time
	CreatedBy    string
}

// ScheduleUpdate is Update's input: the three members the API will expose in
// part 2, each nil ⇒ unchanged. ExpectedVersion is the caller's read version;
// a miss answers ErrScheduleStaleVersion rather than last-writer-wins.
type ScheduleUpdate struct {
	ID              string
	ExpectedVersion int
	CronExpr        *string
	Inputs          *json.RawMessage
	Enabled         *bool
}

// schedulePin is the assignment's identity as the fire needs it — read once
// per Create/Update and once again per fire, never cached: ADR-0023 § 2's
// rule that the store copies what a revision says rather than re-deriving it.
type schedulePin struct {
	assignmentID   string
	organizationID string
	projectID      string
	pipelineID     string
	revisionID     string
	revisionDigest string
	planDigest     string
	digestScope    string
	plan           json.RawMessage
	budgetOver     json.RawMessage
	maxConcurrent  int
	assignmentOn   bool
	revStatus      string
}

// schedulePinSQL reads the assignment's pin plus the project's organization.
// No caller visibility predicate: this runs on a tick, where the schedule row
// IS the grant that was checked when a human created it.
const schedulePinSQL = `
	SELECT a.id::text, p.organization_id::text, a.project_id::text, a.pipeline_id::text,
	       a.pinned_revision_id::text, a.enabled, a.max_concurrent_runs,
	       a.budget_overrides::text, r.revision_digest, r.plan_digest,
	       r.digest_scope, r.compiled_plan::text, r.status
	FROM assignments a
	JOIN projects p            ON p.id = a.project_id
	JOIN pipeline_revisions r  ON r.id = a.pinned_revision_id
	WHERE a.id = $1::uuid`

func scheduleScanPin(q pgx.Row) (schedulePin, error) {
	var pin schedulePin
	err := q.Scan(&pin.assignmentID, &pin.organizationID, &pin.projectID, &pin.pipelineID,
		&pin.revisionID, &pin.assignmentOn, &pin.maxConcurrent,
		&pin.budgetOver, &pin.revisionDigest, &pin.planDigest,
		&pin.digestScope, &pin.plan, &pin.revStatus)
	return pin, err
}

// ------------------------------------------------------------- input shape

// scheduleInputName is 00005's run_inputs name CHECK restated in Go, so a bad
// name is refused when a schedule is written rather than discovered as a
// failing insert on every fire.
var scheduleInputName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// scheduleCleanInputs normalizes a schedule's fixed inputs into the map the
// shared run-input validator reads plus the JSON the row stores. An empty
// input is {}. Anything that is not a flat object of legal names is a
// programming or authoring error, never a partial row.
func scheduleCleanInputs(raw json.RawMessage) (map[string]json.RawMessage, json.RawMessage, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return map[string]json.RawMessage{}, json.RawMessage(`{}`), nil
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
		return nil, nil, fmt.Errorf("postgres: schedule inputs must be a JSON object: %w", err)
	}
	if out == nil {
		out = map[string]json.RawMessage{}
	}
	for name := range out {
		if !scheduleInputName.MatchString(name) {
			return nil, nil, fmt.Errorf(
				"postgres: schedule input %q is not a legal run input name (^[a-z][a-z0-9_]{0,62}$)", name)
		}
	}
	stored, err := json.Marshal(out)
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: encode schedule inputs: %w", err)
	}
	return out, json.RawMessage(stored), nil
}

// ------------------------------------------------------------------- writes

// Create inserts one schedule. It refuses an expression that cannot parse or
// cannot fire, an assignment outside the project or disabled or pinned to a
// non-published revision, and inputs the pinned revision would refuse — every
// one of which would otherwise show up as a schedule that quietly never runs.
func (s *ScheduleStore) Create(ctx context.Context, in NewSchedule) (Schedule, error) {
	if s.Pool == nil {
		return Schedule{}, errors.New("postgres: schedule store has no pool")
	}
	if !prjValidUUID(in.ProjectID) || !prjValidUUID(in.AssignmentID) || !prjValidUUID(in.CreatedBy) {
		return Schedule{}, ErrScheduleNotFound
	}
	cron, err := schedule.Parse(in.CronExpr)
	if err != nil {
		return Schedule{}, err
	}
	pin, err := scheduleScanPin(s.Pool.QueryRow(ctx, schedulePinSQL, in.AssignmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, ErrScheduleNotFound
	}
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: read assignment %s pin: %w", in.AssignmentID, err)
	}
	if pin.projectID != in.ProjectID {
		return Schedule{}, ErrScheduleNotFound
	}
	if err := scheduleFireable(pin); err != nil {
		return Schedule{}, err
	}
	values, stored, err := scheduleCleanInputs(in.Inputs)
	if err != nil {
		return Schedule{}, err
	}
	if _, err := m4ValidateRunInputs(pin.plan, values); err != nil {
		return Schedule{}, fmt.Errorf("postgres: schedule inputs rejected by the pinned revision: %w", err)
	}
	next, err := scheduleFirstRun(cron, time.Now(), in.NextRunAt)
	if err != nil {
		return Schedule{}, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	row := s.Pool.QueryRow(ctx, `
		INSERT INTO schedules
			(project_id, assignment_id, cron_expr, inputs, enabled, next_run_at,
			 last_run_at, last_run_id, version, created_by)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, NULL, NULL, 1, $7::uuid)
		RETURNING `+scheduleColumns,
		in.ProjectID, in.AssignmentID, cron.String(), string(stored), enabled, next, in.CreatedBy)
	sc, err := s.scan(row)
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: insert schedule for project %s: %w", in.ProjectID, err)
	}
	return sc, nil
}

// scheduleFireable is the Create-time half of "this row will run": a disabled
// assignment or an unpublished revision can produce no run at all, and a
// cron expression with no next occurrence inside the search bound is a
// mis-authored calendar (Feb 30), not a schedule.
func scheduleFireable(pin schedulePin) error {
	if !pin.assignmentOn {
		return fmt.Errorf("%w: assignment %s is disabled", ErrScheduleNotFireable, pin.assignmentID)
	}
	if pin.revStatus != "published" {
		return fmt.Errorf("%w: pinned revision %s is %s", ErrScheduleNotFireable, pin.revisionID, pin.revStatus)
	}
	return nil
}

// scheduleFirstRun derives the clock a new (or re-cronned, or re-enabled)
// schedule starts from. An explicit NextRunAt is honoured verbatim so a test
// or an operator backfill can name the slot; otherwise it is the next slot
// after now, and an expression with none is refused.
func scheduleFirstRun(cron schedule.Cron, now time.Time, override *time.Time) (time.Time, error) {
	if override != nil {
		return override.UTC(), nil
	}
	next := cron.Next(now.UTC())
	if next.IsZero() {
		return time.Time{}, fmt.Errorf(
			"%w: cron expression %q has no occurrence in the next twelve years", ErrScheduleNotFireable, cron.String())
	}
	return next, nil
}

// -------------------------------------------------------------------- reads

// GetSchedule reads one row by id.
func (s *ScheduleStore) GetSchedule(ctx context.Context, id string) (Schedule, error) {
	if s.Pool == nil {
		return Schedule{}, errors.New("postgres: schedule store has no pool")
	}
	if !prjValidUUID(id) {
		return Schedule{}, ErrScheduleNotFound
	}
	sc, err := s.scan(s.Pool.QueryRow(ctx,
		`SELECT `+scheduleColumns+` FROM schedules WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, ErrScheduleNotFound
	}
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: get schedule %s: %w", id, err)
	}
	return sc, nil
}

// ListSchedules returns a project's schedules oldest first (the order the
// UI's assignment rows group in). A project with none answers an empty
// slice, not an error — List is a read of record, and "no schedules yet" is
// the product's normal state.
func (s *ScheduleStore) ListSchedules(ctx context.Context, projectID string) ([]Schedule, error) {
	if s.Pool == nil {
		return nil, errors.New("postgres: schedule store has no pool")
	}
	if !prjValidUUID(projectID) {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+scheduleColumns+` FROM schedules WHERE project_id = $1::uuid
		  ORDER BY created_at, id`, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list schedules for project %s: %w", projectID, err)
	}
	defer rows.Close()

	out := []Schedule{}
	for rows.Next() {
		sc, err := s.scan(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan schedule row: %w", err)
		}
		out = append(out, sc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read schedule rows: %w", err)
	}
	return out, nil
}

// ------------------------------------------------------------------ updates

// UpdateSchedule applies the editable members (cron, inputs, enabled) under
// optimistic concurrency: the UPDATE's WHERE carries the caller's version, so
// a lost race answers ErrScheduleStaleVersion instead of silently overwriting.
//
// The clock is recomputed whenever the expression changes or a disabled
// schedule comes back: re-enabling is a decision made NOW, so its next fire
// is the next slot after now, not a backlog of slots that expired while it was
// off. Re-enabling never fires late on purpose — the missed-slot rule belongs
// to a schedule that was supposed to be running.
func (s *ScheduleStore) UpdateSchedule(ctx context.Context, in ScheduleUpdate) (Schedule, error) {
	if s.Pool == nil {
		return Schedule{}, errors.New("postgres: schedule store has no pool")
	}
	if !prjValidUUID(in.ID) {
		return Schedule{}, ErrScheduleNotFound
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: begin update schedule tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := s.scan(tx.QueryRow(ctx,
		`SELECT `+scheduleColumns+` FROM schedules WHERE id = $1::uuid FOR UPDATE`, in.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, ErrScheduleNotFound
	}
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: lock schedule %s: %w", in.ID, err)
	}
	if in.ExpectedVersion != current.Version {
		return Schedule{}, fmt.Errorf("%w: schedule %s is at version %d, not %d",
			ErrScheduleStaleVersion, in.ID, current.Version, in.ExpectedVersion)
	}

	expr, inputs := current.CronExpr, current.Inputs
	if in.CronExpr != nil {
		expr = *in.CronExpr
	}
	if in.Inputs != nil {
		inputs = *in.Inputs
	}
	enabled := current.Enabled
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	cron, err := schedule.Parse(expr)
	if err != nil {
		return Schedule{}, err
	}
	values, stored, err := scheduleCleanInputs(inputs)
	if err != nil {
		return Schedule{}, err
	}
	pin, err := scheduleScanPin(tx.QueryRow(ctx, schedulePinSQL, current.AssignmentID))
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, fmt.Errorf("postgres: re-read assignment pin for schedule %s: %w", in.ID, err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// The assignment is gone (it can only be gone if somebody deleted it
		// under the FK, which the FK should make impossible): the schedule
		// cannot be validated any more, so it cannot be edited either.
		return Schedule{}, ErrScheduleNotFound
	}
	if enabled {
		// Only an enabled schedule has to be able to fire: a disabled one may
		// keep an expression whose revision has since been deprecated, and
		// refusing the edit would make it undeletable by the API that owns it.
		if err := scheduleFireable(pin); err != nil {
			return Schedule{}, err
		}
		if _, err := m4ValidateRunInputs(pin.plan, values); err != nil {
			return Schedule{}, fmt.Errorf("postgres: schedule inputs rejected by the pinned revision: %w", err)
		}
	}

	next := current.NextRunAt
	if expr != current.CronExpr || (in.Enabled != nil && enabled && !current.Enabled) {
		if next, err = scheduleFirstRun(cron, time.Now(), nil); err != nil {
			return Schedule{}, err
		}
	}

	updated, err := s.scan(tx.QueryRow(ctx, `
		UPDATE schedules
		SET cron_expr = $2, inputs = $3::jsonb, enabled = $4, next_run_at = $5,
		    version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $6
		RETURNING `+scheduleColumns,
		in.ID, cron.String(), string(stored), enabled, next, in.ExpectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		// Two edits in one transaction window: the row moved under the lock
		// we already hold, which cannot happen — so this is the stale case
		// wearing a different hat, and the caller re-reads either way.
		return Schedule{}, fmt.Errorf("%w: schedule %s moved while it was locked",
			ErrScheduleStaleVersion, in.ID)
	}
	if err != nil {
		return Schedule{}, fmt.Errorf("postgres: update schedule %s: %w", in.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Schedule{}, fmt.Errorf("postgres: commit update schedule: %w", err)
	}
	return updated, nil
}

// ---------------------------------------------------------------- the tick

// TickSchedules fires every schedule due at `now` and returns how many RUNS
// it created. It is the backstop pass, not a scheduler: nothing is remembered
// between calls, every decision is re-derived from rows, so a replica may run
// it as often as it likes and a replica that was asleep for a day costs one
// late fire rather than a backlog.
//
// The due scan is a plain read (the partial index on next_run_at); the claim
// is the row lock inside fireSchedule. A row that another replica is holding
// is skipped, not waited for — the FOR UPDATE SKIP LOCKED rule the turn and
// attempt claims use, and the reason a wedged serve replica cannot stall the
// fleet's schedule firing.
func (s *ScheduleStore) TickSchedules(ctx context.Context, now time.Time) (int, error) {
	if s.Pool == nil {
		return 0, errors.New("postgres: schedule store has no pool")
	}
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()

	ids, err := scheduleDueIDs(ctx, s.Pool, now, scheduleTickBatch)
	if err != nil {
		return 0, err
	}
	var (
		fired int
		errs  []error
	)
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		n, err := s.fireSchedule(ctx, id, now)
		fired += n
		if err != nil {
			errs = append(errs, fmt.Errorf("schedule %s: %w", id, err))
			s.logger().ErrorContext(ctx, "schedule tick failed for one schedule; continuing",
				slog.String("schedule_id", id), slog.String("error", err.Error()))
		}
	}
	return fired, errors.Join(errs...)
}

// scheduleDueIDs reads the due candidates oldest first, capped: the same
// "drain across ticks rather than hold a lock through an unbounded scan" rule
// as the M4 driver's batch.
func scheduleDueIDs(ctx context.Context, pool *pgxpool.Pool, now time.Time, limit int) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT id::text FROM schedules
		WHERE enabled AND next_run_at <= $1
		ORDER BY next_run_at, id
		LIMIT $2`, now, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: select due schedules: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan due schedules: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read due schedules: %w", err)
	}
	return ids, nil
}

// fireSchedule fires one schedule slot. The schedule row is locked with
// SKIP LOCKED, so the answer for "another replica is already firing this one"
// is (0, nil) — not an error, because from this replica's seat nothing went
// wrong. The row's own columns are re-checked under the lock (enabled, still
// due, assignment fireable, ceiling free); a refusal NEVER advances
// next_run_at, so a slot deferred by a full assignment is fired as soon as
// capacity frees, and the missed-slot rule collapses whatever piled up behind
// it into one run.
func (s *ScheduleStore) fireSchedule(ctx context.Context, id string, now time.Time) (int, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("postgres: begin schedule fire tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sc, err := s.scan(tx.QueryRow(ctx, `
		SELECT `+scheduleColumns+` FROM schedules
		WHERE id = $1::uuid AND enabled AND next_run_at <= $2
		FOR UPDATE SKIP LOCKED`, id, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: claim schedule %s: %w", id, err)
	}

	cron, err := schedule.Parse(sc.CronExpr)
	if err != nil {
		// A row the parser refuses cannot be advanced (there is no next to
		// compute) and cannot be fired. It stays due and every tick says so;
		// the fix is an operator editing the expression, not a retry.
		return 0, err
	}
	pin, err := scheduleScanPin(tx.QueryRow(ctx, schedulePinSQL, sc.AssignmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("%w: assignment %s is gone", ErrScheduleNotFound, sc.AssignmentID)
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: read pin for schedule %s: %w", id, err)
	}
	if err := scheduleFireable(pin); err != nil {
		s.logger().WarnContext(ctx, "schedule is due but its assignment will not fire; slot left pending",
			slog.String("schedule_id", id),
			slog.String("assignment_id", sc.AssignmentID),
			slog.String("reason", err.Error()))
		return 0, nil
	}
	live, err := scheduleLiveRuns(ctx, tx, sc.AssignmentID)
	if err != nil {
		return 0, err
	}
	if live >= pin.maxConcurrent {
		s.logger().DebugContext(ctx, "schedule slot deferred at the assignment ceiling",
			slog.String("schedule_id", id),
			slog.Int("live_runs", live),
			slog.Int("max_concurrent_runs", pin.maxConcurrent))
		return 0, nil
	}

	// The slot being fired: the latest one that came due, with everything
	// older counted rather than replayed (ADR-0032 § 4). lateFireCount is the
	// honest "we were down" number the journal row carries.
	slot, late := scheduleLatestDueSlot(sc.NextRunAt, now, cron)
	key := scheduleIdempotencyKey(sc.ID, slot)

	values, _, err := scheduleCleanInputs(sc.Inputs)
	if err != nil {
		return 0, err
	}
	inputs, err := m4ValidateRunInputs(pin.plan, values)
	if err != nil {
		return 0, fmt.Errorf("postgres: schedule %s inputs no longer valid: %w", id, err)
	}

	newRun := NewRun{
		OrganizationID:     pin.organizationID,
		ProjectID:          sc.ProjectID,
		PipelineID:         pin.pipelineID,
		PipelineRevisionID: pin.revisionID,
		AssignmentID:       sc.AssignmentID,
		RevisionDigest:     pin.revisionDigest,
		PlanDigest:         pin.planDigest,
		PlanSnapshot:       pin.plan,
		PoliciesSnapshot:   m4PoliciesSnapshot(pin.plan, pin.budgetOver),
		Depth:              0,
		TriggeredBy:        "", // NULL: a system start, exactly as 00005 models it
		// ADR-0056: the fire is a 'schedule' start and names the trigger it
		// came from; a retried slot replays the same row, keeping this trigger.
		TriggerKind: "schedule",
		TriggerRef:  sc.ID,
		Inputs:      inputs,
		Key:         key,
		RequestSHA:  scheduleRequestSHA(key, pin.revisionID, values),
		Event: &RunEvent{
			Type: events.TypeRunCreated, ActorKind: events.ActorKindSystem, ActorID: "system",
			Payload: events.RunCreatedPayload{
				ProjectID:      sc.ProjectID,
				PipelineID:     pin.pipelineID,
				RevisionID:     pin.revisionID,
				RevisionDigest: pin.revisionDigest,
				PlanDigest:     pin.planDigest,
				DigestScope:    pin.digestScope,
				AssignmentID:   sc.AssignmentID,
				InputNames:     m4InputNames(inputs),
			},
		},
	}

	// The create is route 22's own write transaction — run, run_inputs rows,
	// the idempotency key and run.created, or nothing. It runs while this
	// transaction still holds the schedule row: the lock is what keeps a
	// second replica off this row, and the key is what makes a crash between
	// the two commits harmless (the retry re-presents the same slot and gets
	// the run that already exists, created=false, no second run).
	api := APIRunStore{Runs: s.runs()}
	run, _, err := api.createRunPinned(ctx, newRun)
	if err != nil {
		return 0, fmt.Errorf("postgres: fire schedule %s: %w", id, err)
	}

	next := cron.Next(now)
	if next.IsZero() {
		// The expression has no slot left inside the search bound. Store the
		// fire and stop the clock at the slot we just ran: leaving it due
		// would refire it forever.
		next = slot
	}
	if _, err := tx.Exec(ctx, `
		UPDATE schedules
		SET next_run_at = $2, last_run_at = $3, last_run_id = $4::uuid
		WHERE id = $1::uuid`, sc.ID, next, slot, run.ID); err != nil {
		return 0, fmt.Errorf("postgres: advance schedule %s: %w", id, err)
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeScheduleFired,
		OrganizationID: pin.organizationID,
		ProjectID:      sc.ProjectID,
		RunID:          run.ID,
		Actor:          events.Actor{Kind: events.ActorKindSystem, ID: "system"},
		Payload: events.ScheduleFiredPayload{
			ProjectID:     sc.ProjectID,
			ScheduleID:    sc.ID,
			AssignmentID:  sc.AssignmentID,
			RunID:         run.ID,
			CronExpr:      sc.CronExpr,
			ScheduledFor:  slot,
			LateFireCount: late,
		},
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("postgres: commit schedule fire %s: %w", id, err)
	}
	s.logger().InfoContext(ctx, "schedule fired",
		slog.String("schedule_id", sc.ID),
		slog.String("run_id", run.ID),
		slog.String("slot", slot.Format(time.RFC3339)),
		slog.Int("late_fire_count", late))
	return 1, nil
}

// ------------------------------------------------------------ fire helpers

// scheduleLiveRuns counts the runs blocking a fire: the SAME predicate
// route 22 counts (m4api_runs_write.go's ceiling), restated here because the
// tick has no caller to authorize and every layer of its decision must be
// honest. Two numbers that disagree would mean a schedule could outrun a
// manual start's ceiling — which is exactly what the assignment's
// max_concurrent_runs exists to prevent.
func scheduleLiveRuns(ctx context.Context, tx pgx.Tx, assignmentID string) (int, error) {
	var live int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM runs
		WHERE assignment_id = $1::uuid
		  AND status IN ('queued','preparing','running','waiting_human','paused')`,
		assignmentID).Scan(&live); err != nil {
		return 0, fmt.Errorf("postgres: count active runs of assignment %s: %w", assignmentID, err)
	}
	return live, nil
}

// scheduleMissedScanCap bounds the missed-slot walk. It is paranoia, not
// policy: a minutely expression down for a year is ~526k steps, and the cap
// says "report the lateness you counted" rather than "loop until the tick
// that was supposed to take milliseconds takes minutes".
const scheduleMissedScanCap = 100000

// scheduleLatestDueSlot walks from the stored next_run_at up to the newest
// slot at or before now, and returns that slot plus how many earlier slots it
// skipped. One fire, one number, no replay of the hours nobody watched
// (ADR-0032 § 4).
func scheduleLatestDueSlot(from, now time.Time, cron schedule.Cron) (time.Time, int) {
	slot, late := from.UTC(), 0
	for late < scheduleMissedScanCap {
		next := cron.Next(slot)
		if next.IsZero() || next.After(now) {
			return slot, late
		}
		slot, late = next, late+1
	}
	return slot, late
}

// scheduleIdempotencyKey is ADR-0032 § 4's "a double tick cannot double-fire"
// spelling: the schedule plus the fired slot, so the SAME slot maps to the
// same key for 24 h (run_idempotency_keys' TTL) and every other slot maps to
// its own.
//
// The separator is a dash, not the colon the ADR's prose and the wishlist
// sketch used, because 00005 pins the key grammar to
// ^[A-Za-z0-9._-]{1,128}$ and a colon is a CHECK violation waiting on the
// first fire. The slot is compact-RFC3339 in UTC for the same reason: the
// colons of the long form are illegal too.
func scheduleIdempotencyKey(scheduleID string, slot time.Time) string {
	return "schedule-" + scheduleID + "-" + slot.UTC().Format("20060102T150405Z")
}

// scheduleRequestSHA is the key's body hash: it covers the pin and the fixed
// inputs, so a replay of the same fire matches (created=false, the stored
// run) and a DIFFERENT body under the same key is the 409-arm mismatch rather
// than a silent overwrite. json.Marshal sorts map keys, which is what makes
// the hash independent of the order inputs were written in.
func scheduleRequestSHA(key, revisionID string, inputs map[string]json.RawMessage) string {
	body, err := json.Marshal(inputs)
	if err != nil {
		body = []byte("{}")
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{key, revisionID, string(body)}, "\n")))
	return hex.EncodeToString(sum[:])
}
