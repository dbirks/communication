package postgres

// The issue-trigger surface (ADR-0056 part 2): the persistence and the
// GitHub poll that turns an issue_triggers row into a run — the "when an open
// issue in this repository for this assignment shows up, start it" intent,
// the same shape of fact a schedule is (ADR-0032) and the ADR's Decision § 5
// fixes for the fire.

// A trigger is a recurring INTENT attached to a project's pipeline
// ASSIGNMENT and one of its repositories: it fires that assignment's pinned
// revision with the template inputs the author wrote, when an open GitHub
// issue for it is opened or labelled. It is not a second execution engine —
// firing means inserting a run through RunStore.CreateRun, the exact
// committed path a manual POST /runs takes (digests, plan snapshot, run_inputs
// rows and run.created all come from that one transaction). What this file
// adds is only WHEN: a due-row claim, an idempotency key, a cursor, and the
// GitHub list that decides which issues the intent is about.

// The three rules that make a fire trustworthy, and where each lives:
//
//   - No double-fire. One run per (trigger, issue number) via the idempotency
//     key `issue-<trigger id>-<issue number>` (run_idempotency_keys), so a
//     re-poll — or a crash between the key claim and the run insert — never
//     produces a second run for the same (trigger, issue).
//   - No backfill. A trigger that was created and never fired does not
//     retro-fire: the `opened` arm only considers issues created after the
//     trigger row was created, and a disabled trigger is never due.
//   - No runaway concurrency. The fire honours the assignment's
//     max_concurrent_runs ceiling the same way route 22 does (live runs
//     counted from rows, never from a memory). At the ceiling the tick leaves
//     the trigger due and moves on: the cursor is not advanced, so the fire
//     is retried as soon as capacity frees.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/integrations/github"
	"github.com/dbirks/communication/internal/secrets"
)

// issueTriggerInputNames lists the submitted run-input names of one issue
// trigger, sorted. The issue-trigger inputs ARE the operator's template
// bindings ({{issue.number}} and friends), not a pinned revision's schema, so
// the fire admits them the way the run-create path admits its own extras.
func issueTriggerInputNames(values map[string]json.RawMessage) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// issueTriggerTickBatch caps how many due triggers one tick may handle: the
// same capped-batch rule as the schedule tick, so a table of misconfigured
// triggers cannot hold a replica's connection for an unbounded time.
const issueTriggerTickBatch = 100

// issueTriggerPollInterval is how long a trigger waits before its next poll:
// a trigger whose cursor is NULL (never polled) or older than this is due.
// The serve tick runs this pass on its own ticker.
const issueTriggerPollInterval = 60 * time.Second

// issueTriggerPollTimeout bounds ONE attempt at ONE trigger: the claim, the
// credential resolve, the GitHub list and the fire transaction together. It
// exists because the fire runs a network call and a nested create
// transaction inside an open row lock, and the 2026-10-25 lab proved what
// happens without a bound: one parked poll held the trigger row and the
// project's journal advisory lock forever — last_polled_at was never
// recorded again, the replica's ticker goroutine never returned, and every
// fenced writer queueing behind that advisory lock froze with it. A poll
// that cannot finish in this window is cut loose, its deadline cancels its
// statements, its failure lands on the row, and the tick moves on. Well
// under issueTriggerPollInterval, so a cut-loose poll cannot outlive its
// own beat.
const issueTriggerPollTimeout = 30 * time.Second

// issueTriggerFireJoinGrace is how long the tick waits for a timed-out fire
// goroutine to acknowledge its own cancellation before continuing without
// it. A fire that honours its context is already rolling back; one that
// ignores it is bounded by the poll deadline's effect on its database
// statements and by the pool's idle-in-transaction timeout, never by the
// tick.
const issueTriggerFireJoinGrace = 2 * time.Second

// issueTriggerLabelTolerance is the acceptance slack on the labeled/no-backfill
// comparison: a label event lands up to this far "before" the armed baseline
// and still fires. Two minutes absorbs the residual clock noise (the Date
// header is second-granular, arming happens once, and re-labels within a
// couple of minutes of authoring are plainly the event the trigger subscribed
// to) while an hour-old backfill label stays refused by orders of magnitude —
// the gh-loop lesson that comparing across unsynced clocks at all is how
// issue #16 got skipped.
const issueTriggerLabelTolerance = 2 * time.Minute

// maxIssueTriggerErrorLen bounds what a failed poll writes into the row's
// last_error: an operator reads it, a browser must not, and the cap keeps one
// pathological upstream message from growing the column's story forever.
const maxIssueTriggerErrorLen = 400

// ErrIssueTriggerNotFound covers a missing id, a project mismatch on List,
// and any assignment the caller's project does not own — one answer, so
// nothing here leaks another project's rows.
var ErrIssueTriggerNotFound = errors.New("postgres: issue trigger not found")

// ErrIssueTriggerStaleVersion is the optimistic-concurrency miss: the row
// moved (a config edit) since the caller read it. A fire never bumps version,
// so this only ever means "somebody else edited the trigger".
var ErrIssueTriggerStaleVersion = errors.New("postgres: issue trigger version is stale")

// ErrIssueTriggerNotFireable refuses a Create whose assignment could never
// fire (disabled, or pinned to an unpublished revision). Refusing at Create
// is the difference between "the trigger is broken" or "the trigger silently
// never ran", and a tick cannot report the first.
var ErrIssueTriggerNotFireable = errors.New("postgres: issue trigger assignment cannot fire")

// IssueTriggerStore owns the issue_triggers table and the due-row tick. A
// nil Log discards (a store built in a test must not write to stderr); Runs is
// the shared create path and defaults to one over Pool.
type IssueTriggerStore struct {
	Pool *pgxpool.Pool

	// Runs is the run-creation path the fire reuses (ADR-0056 § 5): the same
	// committed create a manual POST /runs takes.
	Runs *RunStore

	// Credentials resolves the issue_read token for a repository that has an
	// ADR-0061 GitHub credential. serve wires the replica's SecretStore; nil
	// means this replica cannot resolve any, and a credentialed repository's
	// poll then fails onto last_error rather than going anonymous silently.
	Credentials *SecretStore

	// PollTimeout overrides issueTriggerPollTimeout (tests drive it); zero
	// takes the default.
	PollTimeout time.Duration

	Log *slog.Logger
}

func (s *IssueTriggerStore) pollTimeout() time.Duration {
	if s.PollTimeout > 0 {
		return s.PollTimeout
	}
	return issueTriggerPollTimeout
}

func (s *IssueTriggerStore) runs() *RunStore {
	if s.Runs != nil {
		return s.Runs
	}
	return &RunStore{Pool: s.Pool}
}

func (s *IssueTriggerStore) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// --------------------------------------------------------------------- rows

// IssueTrigger is one issue_triggers row: the intent, its template inputs,
// and the poll bookkeeping (cursor / last polled / last error / GitHub-clock
// baseline).
type IssueTrigger struct {
	ID           string
	ProjectID    string
	AssignmentID string
	RepositoryID string
	Event        string
	Labels       []string
	Inputs       json.RawMessage
	Enabled      bool
	CursorAt     *time.Time
	LastPolledAt *time.Time
	LastError    string
	Version      int
	CreatedBy    string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	// GithubCreatedAt is created_at as measured on GitHub's clock (migration
	// 00018): the armed baseline every labeled-event comparison uses, because
	// created_at (the database clock) and a labeled event's created_at
	// (GitHub's) are not the same clock and were once ~50 s apart on one
	// healthy host. nil means "not yet armed" — the poll then degrades to
	// created_at (same tolerance) and says so at WARN.
	GithubCreatedAt *time.Time
}

// issueTriggerColumns is the read list. cursor_at, last_polled_at,
// last_error and github_created_at are nullable, so the scan goes through
// pointers; version is the config-edit counter (a fire never bumps it).
const issueTriggerColumns = `id, project_id, assignment_id, repository_id, event, labels,
	inputs::text, enabled, cursor_at, last_polled_at, last_error, version, created_by, created_at, updated_at, github_created_at`

func (s *IssueTriggerStore) scan(row pgx.Row) (IssueTrigger, error) {
	var (
		it            IssueTrigger
		inputs        string
		cursorAt      *time.Time
		lastPolled    *time.Time
		lastErr       *string
		githubCreated *time.Time
	)
	err := row.Scan(&it.ID, &it.ProjectID, &it.AssignmentID, &it.RepositoryID, &it.Event,
		&it.Labels, &inputs, &it.Enabled, &cursorAt, &lastPolled, &lastErr, &it.Version,
		&it.CreatedBy, &it.CreatedAt, &it.UpdatedAt, &githubCreated)
	if err != nil {
		return IssueTrigger{}, err
	}
	it.Inputs = json.RawMessage(inputs)
	if cursorAt != nil {
		t := cursorAt.UTC()
		it.CursorAt = &t
	}
	if lastPolled != nil {
		t := lastPolled.UTC()
		it.LastPolledAt = &t
	}
	if lastErr != nil {
		it.LastError = *lastErr
	}
	if githubCreated != nil {
		t := githubCreated.UTC()
		it.GithubCreatedAt = &t
	}
	it.CreatedAt, it.UpdatedAt = it.CreatedAt.UTC(), it.UpdatedAt.UTC()
	return it, nil
}

// ------------------------------------------------------------------- writes

// NewIssueTrigger is Create's input. Event is the fired condition
// ('opened' | 'labeled'); Labels is the any-of set (case-insensitive, empty =
// every issue); Inputs are the template values ({{issue.number}} and friends);
// Enabled is nil ⇒ enabled.
type NewIssueTrigger struct {
	ProjectID    string
	AssignmentID string
	RepositoryID string
	Event        string
	Labels       []string
	Inputs       json.RawMessage
	Enabled      *bool
	CreatedBy    string
}

// UpdateIssueTriggerInput is Update's input: the editable members, each nil
// ⇒ unchanged, plus ExpectedVersion for optimistic concurrency. A fire never
// bumps version, so a stale answer is always somebody else's edit.
type UpdateIssueTriggerInput struct {
	ID              string
	ExpectedVersion int
	AssignmentID    *string
	RepositoryID    *string
	Event           *string
	Labels          *[]string
	Inputs          *json.RawMessage
	Enabled         *bool
}

// issueTriggerEvents is the ADR-0056 § 4 vocabulary the event member carries.
var issueTriggerEvents = map[string]bool{
	"opened":  true,
	"labeled": true,
}

// issueTriggerFireable is the Create-time half of "this row will run": a
// disabled assignment or an unpublished revision can produce no run at all, and
// a trigger that cannot fire is a mis-authored intent, not a silent no-op.
func (s *IssueTriggerStore) issueTriggerFireable(pin schedulePin) error {
	if !pin.assignmentOn {
		return fmt.Errorf("%w: assignment %s is disabled", ErrIssueTriggerNotFireable, pin.assignmentID)
	}
	if pin.revStatus != "published" {
		return fmt.Errorf("%w: pinned revision %s is %s", ErrIssueTriggerNotFireable, pin.revisionID, pin.revStatus)
	}
	return nil
}

// Create inserts one issue trigger. It refuses an event outside the recorded
// vocabulary, an assignment outside the project or disabled or pinned to a
// non-published revision, and inputs the pinned revision would refuse AS A FIRE
// WOULD SEND THEM (issueTriggerInputsValid) — every one of which would otherwise
// show up as a trigger that quietly never runs.
func (s *IssueTriggerStore) Create(ctx context.Context, in NewIssueTrigger) (IssueTrigger, error) {
	if s.Pool == nil {
		return IssueTrigger{}, errors.New("postgres: issue trigger store has no pool")
	}
	if !prjValidUUID(in.ProjectID) || !prjValidUUID(in.AssignmentID) ||
		!prjValidUUID(in.RepositoryID) || !prjValidUUID(in.CreatedBy) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	if !issueTriggerEvents[in.Event] {
		return IssueTrigger{}, fmt.Errorf("postgres: issue trigger event %q is not one of opened, labeled",
			in.Event)
	}
	pin, err := scheduleScanPin(s.Pool.QueryRow(ctx, schedulePinSQL, in.AssignmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: read assignment %s pin: %w", in.AssignmentID, err)
	}
	if pin.projectID != in.ProjectID {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	if err := s.issueTriggerFireable(pin); err != nil {
		return IssueTrigger{}, err
	}
	if _, err := s.issueTriggerGitRepo(ctx, s.Pool, in.RepositoryID, in.ProjectID); err != nil {
		return IssueTrigger{}, err
	}
	values, stored, err := scheduleCleanInputs(in.Inputs)
	if err != nil {
		return IssueTrigger{}, err
	}
	if err := issueTriggerInputsValid(pin.plan, values); err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: issue trigger inputs rejected by the pinned revision: %w", err)
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	row := s.Pool.QueryRow(ctx, `
		INSERT INTO issue_triggers
			(project_id, assignment_id, repository_id, event, labels, inputs, enabled, version, created_by)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], $6::jsonb, $7, 1, $8::uuid)
		RETURNING `+issueTriggerColumns,
		in.ProjectID, in.AssignmentID, in.RepositoryID, in.Event, in.Labels, string(stored), enabled, in.CreatedBy)
	it, err := s.scan(row)
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: insert issue trigger for project %s: %w", in.ProjectID, err)
	}
	return it, nil
}

// -------------------------------------------------------------------- reads

// ListIssueTriggers returns a project's issue triggers oldest first (the
// order the UI groups them in). A project with none answers an empty slice, not
// an error — List is a read of record, and "no triggers yet" is the normal
// state until the operator names one.
func (s *IssueTriggerStore) ListIssueTriggers(ctx context.Context, projectID string) ([]IssueTrigger, error) {
	if s.Pool == nil {
		return nil, errors.New("postgres: issue trigger store has no pool")
	}
	if !prjValidUUID(projectID) {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT `+issueTriggerColumns+` FROM issue_triggers WHERE project_id = $1::uuid
		  ORDER BY created_at, id`, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list issue triggers for project %s: %w", projectID, err)
	}
	defer rows.Close()

	out := []IssueTrigger{}
	for rows.Next() {
		it, err := s.scan(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan issue trigger row: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read issue trigger rows: %w", err)
	}
	return out, nil
}

// GetIssueTrigger reads one row by id.
func (s *IssueTriggerStore) GetIssueTrigger(ctx context.Context, id string) (IssueTrigger, error) {
	if s.Pool == nil {
		return IssueTrigger{}, errors.New("postgres: issue trigger store has no pool")
	}
	if !prjValidUUID(id) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	it, err := s.scan(s.Pool.QueryRow(ctx,
		`SELECT `+issueTriggerColumns+` FROM issue_triggers WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: get issue trigger %s: %w", id, err)
	}
	return it, nil
}

// ------------------------------------------------------------------ updates

// UpdateIssueTrigger applies the editable members under optimistic
// concurrency: the UPDATE's WHERE carries the caller's version, so a lost race
// answers ErrIssueTriggerStaleVersion instead of last-writer-wins.
func (s *IssueTriggerStore) UpdateIssueTrigger(ctx context.Context, in UpdateIssueTriggerInput) (IssueTrigger, error) {
	if s.Pool == nil {
		return IssueTrigger{}, errors.New("postgres: issue trigger store has no pool")
	}
	if !prjValidUUID(in.ID) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: begin update issue trigger tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := s.scan(tx.QueryRow(ctx,
		`SELECT `+issueTriggerColumns+` FROM issue_triggers WHERE id = $1::uuid FOR UPDATE`, in.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueTrigger{}, ErrIssueTriggerNotFound
	}
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: lock issue trigger %s: %w", in.ID, err)
	}
	if in.ExpectedVersion != current.Version {
		return IssueTrigger{}, fmt.Errorf("%w: issue trigger %s is at version %d, not %d",
			ErrIssueTriggerStaleVersion, in.ID, current.Version, in.ExpectedVersion)
	}

	assignmentID, repositoryID := current.AssignmentID, current.RepositoryID
	ev, labs, inp, en := current.Event, current.Labels, current.Inputs, current.Enabled
	if in.AssignmentID != nil {
		assignmentID = *in.AssignmentID
	}
	if in.RepositoryID != nil {
		repositoryID = *in.RepositoryID
	}
	if in.Event != nil {
		ev = *in.Event
	}
	if in.Labels != nil {
		labs = *in.Labels
	}
	if in.Inputs != nil {
		inp = *in.Inputs
	}
	if in.Enabled != nil {
		en = *in.Enabled
	}

	if en {
		pin, err := scheduleScanPin(tx.QueryRow(ctx, schedulePinSQL, assignmentID))
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return IssueTrigger{}, fmt.Errorf("postgres: re-read assignment pin for issue trigger %s: %w", in.ID, err)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return IssueTrigger{}, ErrIssueTriggerNotFound
		}
		if err := s.issueTriggerFireable(pin); err != nil {
			return IssueTrigger{}, err
		}
		if _, err := s.issueTriggerGitRepo(ctx, tx, repositoryID, current.ProjectID); err != nil {
			return IssueTrigger{}, err
		}
		values, _, err := scheduleCleanInputs(inp)
		if err != nil {
			return IssueTrigger{}, err
		}
		if err := issueTriggerInputsValid(pin.plan, values); err != nil {
			return IssueTrigger{}, fmt.Errorf("postgres: issue trigger %s inputs rejected by the pinned revision: %w", in.ID, err)
		}
	}

	updated, err := s.scan(tx.QueryRow(ctx, `
		UPDATE issue_triggers
		SET assignment_id = $2::uuid, repository_id = $3::uuid, event = $4, labels = $5::text[],
		    inputs = $6::jsonb, enabled = $7, version = version + 1, updated_at = now()
		WHERE id = $1::uuid AND version = $8
		RETURNING `+issueTriggerColumns,
		in.ID, assignmentID, repositoryID, ev, labs, string(inp), en, in.ExpectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		return IssueTrigger{}, fmt.Errorf("%w: issue trigger %s moved while it was locked",
			ErrIssueTriggerStaleVersion, in.ID)
	}
	if err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: update issue trigger %s: %w", in.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueTrigger{}, fmt.Errorf("postgres: commit update issue trigger: %w", err)
	}
	return updated, nil
}

// ---------------------------------------------------------------- the tick

// TickIssueTriggers fires every enabled issue trigger whose last_polled_at is
// NULL or older than issueTriggerPollInterval at `now`, and returns how many
// RUNS it created. It is the backstop pass, not a scheduler: nothing is
// remembered between calls, every decision is re-derived from rows, so a
// replica may run it as often as it likes.
//
// The due scan is a plain read (the partial index on enabled covers the
// disabled-never-due rule); the claim is the row lock inside fireIssueTrigger.
// A row that another replica is holding is skipped, not waited for — the FOR
// UPDATE SKIP LOCKED rule the turn and attempt claims use, and the reason a
// wedged serve replica cannot stall the fleet's issue firing.
func (s *IssueTriggerStore) TickIssueTriggers(ctx context.Context, now time.Time, lister github.IssueLister) (int, error) {
	if s.Pool == nil {
		return 0, errors.New("postgres: issue trigger store has no pool")
	}
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()

	ids, err := issueTriggerDueIDs(ctx, s.Pool, now, issueTriggerTickBatch)
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
		n, err := s.fireIssueTriggerBounded(ctx, id, now, lister)
		fired += n
		if err != nil {
			errs = append(errs, fmt.Errorf("issue trigger %s: %w", id, err))
			s.logger().ErrorContext(ctx, "issue trigger tick failed for one trigger; continuing",
				slog.String("issue_trigger_id", id), slog.String("error", err.Error()))
		}
	}
	return fired, errors.Join(errs...)
}

// fireIssueTriggerBounded runs one trigger's poll under its own deadline and
// guarantees the tick returns within that deadline plus a join grace even if
// the poll's goroutine parks somewhere that ignores the cancellation.
//
// Every exit records the poll: the success path lands last_polled_at inside
// the fire transaction, and any failure — including the cut-loose timeout —
// is recorded by a separate, detached write that commits whatever the fire
// transaction's fate was. Poll bookkeeping must never depend on the success
// of the poll it describes: a trigger whose poll vanished without a trace
// (last_polled_at NULL forever, the 2026-10-25 lab) is indistinguishable
// from one that was never scheduled.
func (s *IssueTriggerStore) fireIssueTriggerBounded(ctx context.Context, id string, now time.Time, lister github.IssueLister) (int, error) {
	every := s.pollTimeout()
	fctx, fcancel := context.WithTimeout(ctx, every)

	type fireResult struct {
		n   int
		err error
	}
	// Buffered: the fire goroutine must be able to hand off its answer (and
	// release its connection) after the tick has already walked away.
	done := make(chan fireResult, 1)
	go func() {
		defer fcancel()
		n, err := s.fireIssueTrigger(fctx, id, now, lister)
		done <- fireResult{n, err}
	}()

	timer := time.NewTimer(every + issueTriggerFireJoinGrace)
	defer timer.Stop()
	select {
	case r := <-done:
		// The in-fire recorders commit on their own happy paths ((0, nil)
		// answers); anything that comes back as an error left the row
		// unrecorded, and the net below lands it.
		if r.err != nil {
			s.recordIssueTriggerPollFailed(ctx, id, now, r.err)
		}
		return r.n, r.err
	case <-timer.C:
		cause := fmt.Errorf("issue trigger poll exceeded %s and was cut loose; its deadline is spent and its rows stand as they committed them", every)
		s.recordIssueTriggerPollFailed(ctx, id, now, cause)
		return 0, cause
	case <-ctx.Done():
		// Shutdown is not a failing poll: the next replica's tick re-derives
		// everything from rows. Nothing is recorded, exactly as the interval
		// ticker that stops mid-beat records nothing.
		return 0, ctx.Err()
	}
}

// recordIssueTriggerPollFailed lands last_polled_at/last_error for a poll
// that did not (or could not) record itself. It runs on a DETACHED, bounded
// context — the failed poll's context is precisely what is no longer fit to
// write with — and its own failure is only logged: the next tick re-derives
// candidacy from the same NULL due test and tries again.
func (s *IssueTriggerStore) recordIssueTriggerPollFailed(ctx context.Context, id string, now time.Time, cause error) {
	msg := cause.Error()
	if len(msg) > maxIssueTriggerErrorLen {
		msg = msg[:maxIssueTriggerErrorLen]
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, err := s.Pool.Exec(rctx, `
		UPDATE issue_triggers SET last_polled_at = $1, last_error = $2 WHERE id = $3::uuid`,
		now, msg, id); err != nil {
		s.logger().ErrorContext(ctx, "could not record the failed issue trigger poll",
			slog.String("issue_trigger_id", id), slog.String("poll_error", cause.Error()),
			slog.String("record_error", err.Error()))
	}
}

// issueTriggerDueIDs reads the due candidates (enabled, cursor NULL or older
// than the poll interval), oldest first, capped: the same "drain across ticks
// rather than hold a lock through an unbounded scan" rule as the M4 driver's
// batch.
func issueTriggerDueIDs(ctx context.Context, pool *pgxpool.Pool, now time.Time, limit int) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT id::text FROM issue_triggers
		WHERE enabled AND (last_polled_at IS NULL OR last_polled_at <= $1)
		ORDER BY id
		LIMIT $2`, now.Add(-issueTriggerPollInterval), limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: select due issue triggers: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan due issue triggers: %w", err)
		}
		ids = append(ids, id)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read due issue triggers: %w", err)
	}
	return ids, nil
}

// ---------------------------------------------------------------- the fire

// fireIssueTrigger fires the one due trigger `id` against `lister`. The row
// was claimed by the tick's due scan and is re-checked under the lock: a row
// that a concurrent tick took between scan and lock answers (0, nil) — the
// answer for "another replica is already firing this one", not an error.
func (s *IssueTriggerStore) fireIssueTrigger(ctx context.Context, id string, now time.Time, lister github.IssueLister) (int, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("postgres: begin issue trigger fire tx: %w", err)
	}
	// The rollback must land even when the fire's own deadline is what
	// failed: rolling back with that expired context sends nothing, and an
	// uncommitted fire would keep the trigger row (and the journal advisory
	// lock its appends took) locked against every other replica's tick for
	// as long as the wedged caller keeps the connection. Fresh, bounded,
	// detached — the same rule the m4 driver's unlock follows.
	defer func() {
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer rcancel()
		_ = tx.Rollback(rctx)
	}()

	// The fire's run creates ride THIS transaction (savepoints inside it):
	// this transaction takes the project's journal advisory lock on its
	// first event append and holds it to commit, and a create-run on a
	// second connection would wait for that lock forever — a self-deadlock
	// Postgres cannot name (the holder is idle in transaction, not waiting).
	// The 2026-10-25 lab wedge is that exact cycle, fired by one poll that
	// matched two issues (docs: this file's fireIssueTrigger, gh-loop 13:48).
	ctx = withPassTx(ctx, tx)

	it, err := s.scan(tx.QueryRow(ctx, `
		SELECT `+issueTriggerColumns+` FROM issue_triggers
		WHERE id = $1::uuid AND enabled AND (last_polled_at IS NULL OR last_polled_at <= $2)
		FOR UPDATE SKIP LOCKED`, id, now.Add(-issueTriggerPollInterval)))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: claim issue trigger %s: %w", id, err)
	}

	pin, err := scheduleScanPin(tx.QueryRow(ctx, schedulePinSQL, it.AssignmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("%w: assignment %s is gone", ErrIssueTriggerNotFound, it.AssignmentID)
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: read pin for issue trigger %s: %w", id, err)
	}
	if pin.projectID != it.ProjectID {
		return 0, fmt.Errorf("%w: assignment %s is in another project", ErrIssueTriggerNotFound, it.AssignmentID)
	}
	if err := s.issueTriggerFireable(pin); err != nil {
		s.logger().WarnContext(ctx, "issue trigger is due but its assignment will not fire; left pending",
			slog.String("issue_trigger_id", id), slog.String("assignment_id", it.AssignmentID),
			slog.String("reason", err.Error()))
		// The pass still records that it looked (ADR-0063's rule: poll
		// bookkeeping never depends on the poll succeeding) — a row nobody
		// ever touches is indistinguishable from a dead replica, which is
		// exactly how the lab's second failure read as "the poller died".
		return 0, s.recordIssueTriggerDeferred(ctx, tx, id, now)
	}
	live, err := scheduleLiveRuns(ctx, tx, it.AssignmentID)
	if err != nil {
		return 0, err
	}
	if live >= pin.maxConcurrent {
		// WARN, not Debug: this deferral is the trigger's whole answer for
		// as long as the ceiling holds, and the 2026-10-25 lab's second
		// pass sat in exactly this arm for 20 minutes with no visible word
		// while its row looked frozen. The pass records last_polled_at and
		// commits (the cursor does NOT advance: the fire is retried as soon
		// as capacity frees), so the row says "alive, deferred" rather than
		// silently aging.
		s.logger().WarnContext(ctx, "issue trigger fire deferred at the assignment ceiling; the trigger stays due",
			slog.String("issue_trigger_id", id),
			slog.Int("live_runs", live), slog.Int("max_concurrent_runs", pin.maxConcurrent))
		return 0, s.recordIssueTriggerDeferred(ctx, tx, id, now)
	}
	repo, err := s.issueTriggerGitRepo(ctx, tx, it.RepositoryID, it.ProjectID)
	if err != nil {
		return 0, err
	}
	credentialID, err := issueTriggerCredentialID(ctx, tx, it.RepositoryID, it.ProjectID)
	if err != nil {
		return 0, err
	}

	ghQuery := github.IssueQuery{
		State:   github.StateOpen,
		Sort:    "updated",
		PerPage: 100,
	}
	if it.CursorAt != nil {
		ghQuery.Since = *it.CursorAt
	}
	if len(it.Labels) == 1 {
		ghQuery.Labels = it.Labels
	}
	token := ""
	if credentialID != "" {
		// ADR-0061 § 5: a credentialed repository polls AS itself. A resolve
		// failure lands on the row's last_error exactly like a failed list —
		// the trigger stays due, the tick keeps going, and the poll never
		// silently falls back to anonymous.
		token, err = s.issueTriggerToken(ctx, it.RepositoryID)
		if err != nil {
			return s.recordIssueTriggerPoll(ctx, tx, id, now, err)
		}
	}
	issues, err := lister.ListIssues(ctx, repo, ghQuery, token)
	if err != nil {
		return s.recordIssueTriggerPoll(ctx, tx, id, now, err)
	}

	// Arm the trigger on GitHub's own clock (migration 00018, ADR-0056
	// amendment): the labeled-event comparison must never pit the database's
	// clock against GitHub's — the lab's 50 s skew silently "backfilled" a
	// label applied after the trigger existed. The baseline is measured once,
	// on the first poll that can read GitHub's Date, and kept forever (COALESCE
	// below); until then (and for a lister with no clock at all) the poll
	// degrades to created_at, loudly, at WARN.
	armed := it.GithubCreatedAt
	if armed == nil {
		if clk, ok := lister.(github.IssueClock); ok {
			ghNow, cerr := clk.GithubNow(ctx, token)
			if cerr == nil {
				base := it.CreatedAt.Add(-now.Sub(ghNow))
				armed = &base
				s.logger().InfoContext(ctx, "issue trigger armed on GitHub's clock",
					slog.String("issue_trigger_id", id),
					slog.String("github_created_at", base.UTC().Format(time.RFC3339)))
			} else {
				s.logger().WarnContext(ctx, "issue trigger could not read GitHub's clock; label times will be compared against created_at until one lands",
					slog.String("issue_trigger_id", id), slog.String("error", cerr.Error()))
			}
		} else if it.Event == "labeled" {
			s.logger().WarnContext(ctx, "issue trigger's lister carries no GitHub clock; label times will be compared against created_at",
				slog.String("issue_trigger_id", id))
		}
	}
	cutoff := it.CreatedAt.Add(-issueTriggerLabelTolerance)
	if armed != nil {
		cutoff = armed.Add(-issueTriggerLabelTolerance)
	}

	fired := 0
	cursor := it.CursorAt
	// heldBack is the oldest updated_at among issues whose label evidence was
	// inconclusive; the cursor never advances past it, so GitHub's inclusive
	// `since` keeps re-offering that issue until its labeled event surfaces
	// (the events API is eventually consistent — an invisible event is not a
	// verdict).
	var heldBack *time.Time
	for _, issue := range issues {
		if it.Event == "opened" {
			// No backfill: an issue created before the trigger was authored is
			// never fired by the `opened` arm — measured on the armed clock
			// when there is one, same skew rule as the labeled arm.
			if issue.CreatedAt.IsZero() || issue.CreatedAt.Before(cutoff) {
				continue
			}
		}
		if !issueLabelsMatch(issue.Labels, it.Labels) {
			continue
		}
		if it.Event == "labeled" {
			switch verdict := issueLabelTiming(ctx, lister, s.logger(), repo, issue, it.Labels, token, cutoff, armed != nil); verdict {
			case labelVerdictUndecided:
				// The watch label is ON the issue but its labeled event is not
				// (yet) visible — GitHub's event timeline lagging, a truncated
				// read, an events outage that outlived the updated_at proxy.
				// Neither fire nor refuse: hold the cursor behind this issue
				// and retry on the next polls. #16's shape: one poll's
				// confidence was permanent silence.
				s.logger().DebugContext(ctx, "issue trigger's label timeline is not conclusive yet; holding the cursor for a retry",
					slog.String("issue_trigger_id", id), slog.Int("issue_number", issue.Number))
				if heldBack == nil || issue.UpdatedAt.Before(*heldBack) {
					t := issue.UpdatedAt
					heldBack = &t
				}
				continue
			case labelVerdictStale:
				// Decisively no-backfill (ADR-0056 amendment of 2026-10-25): a
				// watched-label event is visible and predates the armed
				// baseline. The cursor moves past it — a NEW label bumps
				// updated_at past the cursor and returns the issue to a later
				// listing on its merits.
				s.logger().DebugContext(ctx, "issue trigger skipped an issue whose watched label predates the trigger",
					slog.String("issue_trigger_id", id), slog.Int("issue_number", issue.Number))
				if cursor == nil || issue.UpdatedAt.After(*cursor) {
					t := issue.UpdatedAt
					cursor = &t
				}
				continue
			case labelVerdictFresh:
				// fall through to the fire below
			}
		}
		n, ferr := s.fireIssue(ctx, tx, it, pin, repo, issue)
		if ferr != nil {
			return 0, ferr
		}
		fired += n
		if cursor == nil || issue.UpdatedAt.After(*cursor) {
			t := issue.UpdatedAt
			cursor = &t
		}
	}
	if heldBack != nil && (cursor == nil || heldBack.Before(*cursor)) {
		cursor = heldBack
	}

	var cursorArg any = cursor
	if cursor != nil {
		cursorArg = *cursor
	}
	var armedArg any
	if armed != nil {
		armedArg = *armed
	}
	if _, err := tx.Exec(ctx, `
		UPDATE issue_triggers
		SET cursor_at = $1, last_polled_at = $2, last_error = '',
		    github_created_at = COALESCE(github_created_at, $4::timestamptz)
		WHERE id = $3::uuid`, cursorArg, now, id, armedArg); err != nil {
		return 0, fmt.Errorf("postgres: advance issue trigger %s: %w", id, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("postgres: commit issue trigger fire %s: %w", id, err)
	}
	if fired > 0 {
		s.logger().InfoContext(ctx, "issue trigger fired",
			slog.String("issue_trigger_id", id),
			slog.Int("runs_created", fired),
			slog.String("every", issueTriggerPollInterval.String()))
	}
	return fired, nil
}

// fireIssue creates the run for one (trigger, issue) pair: the same committed
// create a manual POST /runs takes, stamped with the issue start's trigger
// fact and the `issue-<trigger id>-<number>` idempotency key (ADR-0056 § 5), and
// appends issue_trigger.fired in that same transaction. A replay under the
// same key (crash between key claim and run insert) returns without writing —
// the stored run is the answer — and writes no second event. A replay whose
// rendered inputs changed (the issue was edited after the fire, so the key
// comes back with a different request sha) is DONE too: ADR-0056's amendment
// of 2026-10-25 skips it with a debug log instead of surfacing
// ErrIdempotencyMismatch, so one edited issue can never jam the whole poll.
func (s *IssueTriggerStore) fireIssue(ctx context.Context, tx pgx.Tx, it IssueTrigger, pin schedulePin, repo github.Repository, issue github.Issue) (int, error) {
	key := "issue-" + it.ID + "-" + fmt.Sprint(issue.Number)
	values, _, err := scheduleCleanInputs(it.Inputs)
	if err != nil {
		return 0, err
	}
	rendered, err := renderIssueInputs(values, issue)
	if err != nil {
		return 0, err
	}
	inputs, err := m4ValidateRunInputs(pin.plan, rendered, issueTriggerInputNames(rendered)...)
	if err != nil {
		return 0, fmt.Errorf("postgres: issue trigger %s inputs no longer valid: %w", it.ID, err)
	}

	newRun := NewRun{
		OrganizationID:     pin.organizationID,
		ProjectID:          it.ProjectID,
		PipelineID:         pin.pipelineID,
		PipelineRevisionID: pin.revisionID,
		AssignmentID:       it.AssignmentID,
		RevisionDigest:     pin.revisionDigest,
		PlanDigest:         pin.planDigest,
		PlanSnapshot:       pin.plan,
		PoliciesSnapshot:   m4PoliciesSnapshot(pin.plan, pin.budgetOver),
		Depth:              0,
		TriggeredBy:        "", // NULL: a system start, exactly as 00005 models it
		TriggerKind:        "issue",
		TriggerRef:         repo.String() + "#" + fmt.Sprint(issue.Number),
		// ADR-0064: the issue's own title is the run's banner — the trigger
		// already fetched it to render the inputs; the store clamps it to the
		// column bound rather than losing the run over a 259-character title.
		Title: issue.Title,
		// ADR-0062: the issue_triggers row this fire came from — the author
		// whose name its agent turns carry is this row's created_by.
		TriggerID:    it.ID,
		RepositoryID: it.RepositoryID,
		Inputs:       inputs,
		Key:          key,
		RequestSHA:   scheduleRequestSHA(key, pin.revisionID, rendered),
		Event: &RunEvent{
			Type: events.TypeRunCreated, ActorKind: events.ActorKindSystem, ActorID: "system",
			Payload: events.RunCreatedPayload{
				ProjectID:      it.ProjectID,
				PipelineID:     pin.pipelineID,
				RevisionID:     pin.revisionID,
				RevisionDigest: pin.revisionDigest,
				PlanDigest:     pin.planDigest,
				DigestScope:    pin.digestScope,
				AssignmentID:   it.AssignmentID,
				InputNames:     m4InputNames(inputs),
			},
		},
	}

	api := APIRunStore{Runs: s.runs()}
	run, created, err := api.createRunPinned(ctx, newRun)
	if errors.Is(err, ErrIdempotencyMismatch) {
		// ADR-0056 amendment (2026-10-25): an already-fired (trigger, issue)
		// pair is DONE. GitHub's `since` is inclusive, so an edit that moves
		// title/body returns the issue to the poll with rendered inputs — and
		// a request sha — that differ from the fire's. That replay is skipped
		// (no second run, no second event) and the caller's loop still
		// advances the cursor past it; the mismatch error would abort the poll
		// before the cursor moves and jam this trigger forever. Every other
		// idempotency caller (POST /runs, schedules) keeps the 409 answer.
		s.logger().DebugContext(ctx, "issue trigger re-saw an already-fired issue with changed inputs; skipping the replay",
			slog.String("issue_trigger_id", it.ID),
			slog.String("idempotency_key", key),
			slog.Int("issue_number", issue.Number))
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: fire issue %s#%d: %w", repo.String(), issue.Number, err)
	}
	if !created {
		return 0, nil // replay: the stored run is the answer, no second event
	}
	if _, err := AppendEvent(ctx, tx, events.New{
		Type:           events.TypeIssueTriggerFired,
		OrganizationID: pin.organizationID,
		ProjectID:      it.ProjectID,
		RunID:          run.ID,
		Actor:          events.Actor{Kind: events.ActorKindSystem, ID: "system"},
		Payload: events.IssueTriggerFiredPayload{
			ProjectID:    it.ProjectID,
			TriggerID:    it.ID,
			AssignmentID: it.AssignmentID,
			RunID:        run.ID,
			IssueNumber:  issue.Number,
			IssueURL:     issue.HTMLURL,
		},
	}); err != nil {
		return 0, err
	}
	return 1, nil
}

// issueLabelsMatch decides whether an issue's labels satisfy a trigger's any-of
// rule (ADR-0056 § 5): the intersection with the trigger's set, case-insensitive,
// is non-empty, and a trigger with no labels at all fires on every issue (an
// explicit "watch everything" the author chose).
func issueLabelsMatch(issueLabels []string, triggerLabels []string) bool {
	if len(triggerLabels) == 0 {
		return true
	}
	if len(issueLabels) == 0 {
		return false
	}
	wanted := map[string]bool{}
	for _, l := range triggerLabels {
		wanted[strings.ToLower(l)] = true
	}
	for _, l := range issueLabels {
		if wanted[strings.ToLower(l)] {
			return true
		}
	}
	return false
}

// renderIssueInputs fills a trigger's fixed inputs with the fired issue's
// values: the `{{issue.*}}` placeholders of the ADR's template vocabulary
// (number, title, body, url, labels = comma list). A string input without
// placeholders passes through untouched; a non-string value is not a template
// and is handed to the pinned revision as-is.
//
// The one exception (ADR-0056 amendment of 2026-10-25): a string that is
// EXACTLY one placeholder renders TYPED, so `issue_number: "{{issue.number}}"`
// reaches an input the pinned revision declares `integer` as a JSON number
// instead of a quoted string. Mixed text (`"#{{issue.number}}"`) is prose with
// a hole in it and stays a string, and so does every other member — number is
// the only non-string fact GitHub's issue object carries.
func renderIssueInputs(values map[string]json.RawMessage, issue github.Issue) (map[string]json.RawMessage, error) {
	out := make(map[string]json.RawMessage, len(values))
	for name, raw := range values {
		var str string
		if err := json.Unmarshal(raw, &str); err == nil {
			if whole := issueTemplateWholeValue.FindStringSubmatch(str); whole != nil {
				if typed, ok := typedIssuePlaceholder(whole[1], issue); ok {
					out[name] = typed
					continue
				}
			}
			out[name] = json.RawMessage(strconv.Quote(renderIssueTemplate(str, issue)))
			continue
		}
		out[name] = raw
	}
	return out, nil
}

// typedIssuePlaceholder is the typed arm of the whole-placeholder rule: of the
// ADR's five members, `number` is the only one that is not a string, so it is
// the only one with a typed rendering. An unknown member answers !ok and the
// caller quotes it, which leaves `{{issue.footprint}}` visible to the author
// exactly as it always was.
func typedIssuePlaceholder(member string, issue github.Issue) (json.RawMessage, bool) {
	switch member {
	case "number":
		return json.RawMessage(strconv.Itoa(issue.Number)), true
	default:
		return nil, false
	}
}

// issueTemplatePlaceholder is the ADR-0056 § 5 template vocabulary: the
// `{{issue.<member>}}` placeholders a trigger's inputs may carry.
var issueTemplatePlaceholder = regexp.MustCompile(`\{\{issue\.([a-z]+)\}\}`)

// issueTemplateWholeValue matches an input whose entire string is one
// placeholder. Both anchors are the rule: unanchored, `"#{{issue.number}}"`
// would render as the number 42 and lose the `#` its author typed.
var issueTemplateWholeValue = regexp.MustCompile(`\A\{\{issue\.([a-z]+)\}\}\z`)

// issueTriggerSampleIssue is the fixed issue Create/Update validate template
// inputs against — the sample a fire is projected onto, so the pinned revision
// judges the RENDERED value (`42`) and not the placeholder text
// (`"{{issue.number}}"`). Its members carry values a type check can tell apart
// (the one number, the strings that are not), so binding `{{issue.title}}` to
// an integer input is refused here rather than at the first fire, and a stored
// row keeps the raw template text either way.
func issueTriggerSampleIssue() github.Issue {
	return github.Issue{
		Number:  1,
		Title:   "sample",
		Body:    "sample",
		HTMLURL: "https://github.com/o/r/issues/1",
		Labels:  []string{"sample"},
	}
}

// issueTriggerInputsValid is the Create/Update input gate: render against the
// sample issue, then run the SAME validator a manual POST /runs passes. The
// fire (fireIssue) reaches for the same code path with the real issue, which
// is why create-time acceptance and fire-time acceptance cannot disagree.
func issueTriggerInputsValid(plan json.RawMessage, values map[string]json.RawMessage) error {
	rendered, err := renderIssueInputs(values, issueTriggerSampleIssue())
	if err != nil {
		return err
	}
	if _, err := m4ValidateRunInputs(plan, rendered, issueTriggerInputNames(rendered)...); err != nil {
		return err
	}
	return nil
}

// renderIssueTemplate resolves one placeholder family against the fired issue.
func renderIssueTemplate(tmpl string, issue github.Issue) string {
	return issueTemplatePlaceholder.ReplaceAllStringFunc(tmpl, func(m string) string {
		switch {
		case strings.Contains(m, "issue.number"):
			return fmt.Sprint(issue.Number)
		case strings.Contains(m, "issue.title"):
			return issue.Title
		case strings.Contains(m, "issue.body"):
			return issue.Body
		case strings.Contains(m, "issue.url"):
			return issue.HTMLURL
		case strings.Contains(m, "issue.labels"):
			return strings.Join(issue.Labels, ",")
		}
		return m
	})
}

// issueQueryRower is what both a pool and a transaction satisfy: the row
// query both answer, with pgx v5's error-less signature.
type issueQueryRower interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// issueTriggerGitRepo reads the repository a trigger fires: the owner/name
// GitHub's anonymous issue list addresses. A row the caller may not see is the
// not-found sentinel, and a git URL that is not github.com is the not-a-GitHub
// error ADR-0031's reader already answers with. Both the Create/Update paths
// (a trigger that can never fire) and the fire itself (inside its tx) go through
// here, so the same parse answers both.
func (s *IssueTriggerStore) issueTriggerGitRepo(ctx context.Context, q issueQueryRower, repositoryID, projectID string) (github.Repository, error) {
	var name, gitURL string
	if err := q.QueryRow(ctx, `
		SELECT name, git_url FROM repositories
		WHERE id = $1::uuid AND project_id = $2::uuid`, repositoryID, projectID).Scan(&name, &gitURL); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return github.Repository{}, fmt.Errorf("%w: repository %s is gone", ErrIssueTriggerNotFound, repositoryID)
		}
		return github.Repository{}, fmt.Errorf("postgres: read issue trigger repository %s: %w", repositoryID, err)
	}
	repo, err := github.ParseRepository(gitURL)
	if err != nil {
		return github.Repository{}, err
	}
	_ = name
	return repo, nil
}

// issueTriggerCredentialID reads the repository's ADR-0061 credential id
// ("" = none) inside the fire's transaction, beside the git-repo read it
// belongs to.
func issueTriggerCredentialID(ctx context.Context, q issueQueryRower, repositoryID, projectID string) (string, error) {
	var credentialID string
	if err := q.QueryRow(ctx, `
		SELECT COALESCE(credential_secret_id::text, '') FROM repositories
		WHERE id = $1::uuid AND project_id = $2::uuid`, repositoryID, projectID).Scan(&credentialID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("%w: repository %s is gone", ErrIssueTriggerNotFound, repositoryID)
		}
		return "", fmt.Errorf("postgres: read issue trigger credential %s: %w", repositoryID, err)
	}
	return credentialID, nil
}

// issueTriggerToken resolves the issue_read bearer token for one trigger
// poll. The audit actor is "system": this is the platform polling its own
// tracker, not a human click and not an agent.
func (s *IssueTriggerStore) issueTriggerToken(ctx context.Context, repositoryID string) (string, error) {
	if s.Credentials == nil {
		return "", fmt.Errorf("%w: this replica has no secret store wired, so a credentialed repository cannot poll anonymously either", ErrRepositoryCredential)
	}
	return s.Credentials.ResolveRepositoryCredential(ctx, repositoryID, secrets.ConsumerIssueRead, "system")
}

// recordIssueTriggerDeferred is the deferral arms' bookkeeping: the pass
// looked at this trigger, so last_polled_at says so and commits, while the
// cursor and last_error stay exactly as they were (the fire is retried from
// the same position as soon as the deferral lifts). It runs on the fire's own
// transaction — nothing was read that could fail — and a failed record here
// is a warning, not a lost fire: the due test re-derives everything.
func (s *IssueTriggerStore) recordIssueTriggerDeferred(ctx context.Context, tx pgx.Tx, id string, now time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE issue_triggers SET last_polled_at = $1 WHERE id = $2::uuid`, now, id); err != nil {
		return fmt.Errorf("postgres: record deferred issue trigger %s poll: %w", id, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit deferred issue trigger %s poll: %w", id, err)
	}
	return nil
}

// labelVerdict is the `labeled` arm's three-valued answer for one issue.
type labelVerdict int

const (
	// labelVerdictFresh: a watched label's labeled event is visible at or
	// after the armed baseline (minus the tolerance) — fire.
	labelVerdictFresh labelVerdict = iota
	// labelVerdictStale: the timeline decisively shows every watched-label
	// event predating the baseline — refuse, and the cursor may pass.
	labelVerdictStale
	// labelVerdictUndecided: the issue carries a watched label but no
	// labeled event for it is visible (the events API is eventually
	// consistent, or the read was truncated) — do not fire, do not refuse,
	// and do NOT let the cursor pass. Issue #16 of the gh-loop is what an
	// over-confident verdict here costs: one poll's guess became silence
	// forever.
	labelVerdictUndecided
)

// issueLabelTiming answers the `labeled` arm's no-backfill question on
// GitHub's own clock: was any of the trigger's watched labels APPLIED to this
// issue at or after `cutoff` (the armed GitHub-clock baseline minus the
// tolerance)? The issue's event timeline is the witness
// (GET /repos/{o}/{r}/issues/{n}/events); where the timeline cannot be read
// at all — a lister without that capability, or a failed event read — the
// ADR amendment's degraded answer is updated_at against the same cutoff: an
// edit can over-fire through it, but a pre-trigger label never can, since
// applying the label is itself an update. A labeled event that names no
// label is matched against nothing but time — GitHub always names the
// label on labeled events, and an unnamed one is the generic yes its
// timestamp proves.
func issueLabelTiming(ctx context.Context, lister github.IssueLister, log *slog.Logger,
	repo github.Repository, issue github.Issue, watch []string, token string, cutoff time.Time, armed bool) labelVerdict {
	fallback := func(reason error) labelVerdict {
		if reason != nil {
			log.WarnContext(ctx, "issue trigger could not read an issue's label timeline; deciding from updated_at",
				slog.String("issue_url", issue.HTMLURL), slog.String("error", reason.Error()))
		}
		if !issue.UpdatedAt.IsZero() && !issue.UpdatedAt.Before(cutoff) {
			return labelVerdictFresh
		}
		if !armed {
			// A "before" measured against an un-armed baseline is a guess
			// about clock skew, and the gh-loop's #16 is what that guess
			// costs. Retry after the baseline lands.
			return labelVerdictUndecided
		}
		return labelVerdictStale
	}
	el, ok := lister.(github.IssueEventLister)
	if !ok {
		return fallback(nil)
	}
	events, err := el.ListIssueEvents(ctx, repo, issue.Number, token)
	if err != nil {
		return fallback(err)
	}
	sawWatchedLabel := false
	for _, ev := range events {
		if ev.Event != "labeled" {
			continue
		}
		if ev.LabelName != "" && !issueLabelsMatch([]string{ev.LabelName}, watch) {
			continue
		}
		sawWatchedLabel = true
		if !ev.CreatedAt.Before(cutoff) {
			return labelVerdictFresh
		}
	}
	if !sawWatchedLabel {
		// The label is on the issue NOW but its event is not in the timeline
		// yet: no verdict, hold, retry.
		return labelVerdictUndecided
	}
	if !armed {
		return labelVerdictUndecided
	}
	return labelVerdictStale
}

// recordIssueTriggerPoll is the shared answer for a poll that failed — a
// credential that would not resolve or a GitHub list that did not land: the
// honest half of "never crash the tick". The failure is recorded on the row
// (bounded message), the trigger stays due for the next beat, the tick
// answers (0, nil) and keeps going.
func (s *IssueTriggerStore) recordIssueTriggerPoll(ctx context.Context, tx pgx.Tx, id string, now time.Time, cause error) (int, error) {
	msg := cause.Error()
	if len(msg) > maxIssueTriggerErrorLen {
		msg = msg[:maxIssueTriggerErrorLen]
	}
	if _, uerr := tx.Exec(ctx, `
		UPDATE issue_triggers SET last_polled_at = $1, last_error = $2 WHERE id = $3::uuid`,
		now, msg, id); uerr != nil {
		return 0, fmt.Errorf("postgres: record issue trigger %s poll failure: %w", id, uerr)
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return 0, fmt.Errorf("postgres: commit issue trigger fire %s: %w", id, cerr)
	}
	s.logger().ErrorContext(ctx, "issue trigger poll failed",
		slog.String("issue_trigger_id", id), slog.String("error", cause.Error()))
	return 0, nil
}

// ------------------------------------------- api.IssueTriggerStore adapter

var _ api.IssueTriggerStore = APIIssueTriggerStore{}

// APIIssueTriggerStore exposes issue triggers as api.IssueTriggerStore. It
// rides the committed IssueTriggerStore's pool and statements; the row's
// semantics (event vocabulary, label bounds, fireability, template inputs, the
// poll bookkeeping) are IssueTriggerStore's, already tested against real
// Postgres. What is added here is the caller: a visibility check folded into
// every read, and a maintainership check folded into the write, so a handler
// that forgot its role gate still cannot move a row it may not see.
type APIIssueTriggerStore struct {
	S *IssueTriggerStore
}

func (a APIIssueTriggerStore) store() (*IssueTriggerStore, error) {
	if a.S == nil {
		return nil, errors.New("postgres: APIIssueTriggerStore has no store")
	}
	if _, err := m4Pool(a.S.Pool, "APIIssueTriggerStore"); err != nil {
		return nil, err
	}
	return a.S, nil
}

// apiIssueTriggerColumns is issueTriggerColumns qualified for the scoped join
// below (x = issue_triggers), plus the caller's role on the owning project —
// the same COALESCE the assignment surface uses, so an org admin reads
// "maintainer" without a membership row and the handler's PATCH gate has one
// source.
const apiIssueTriggerColumns = `x.id::text, x.project_id::text, x.assignment_id::text, x.repository_id::text,
	x.event, x.labels, x.inputs::text, x.enabled, x.cursor_at, x.last_polled_at, x.last_error, x.version,
	x.created_by::text, x.created_at, x.updated_at, lf.last_run_id, lf.last_fired_at,
	COALESCE(m.role, CASE WHEN $3::boolean THEN 'maintainer' ELSE '' END)`

// apiIssueTriggerScope is the FROM/WHERE visibility half: the caller's
// organization, and either admin or a membership. Every issue-trigger query
// here splices it and adds its own id/project predicate LAST (parameter
// numbering in the fragments above assumes $1 user, $2 org, $3 admin).
const apiIssueTriggerScope = `
	FROM issue_triggers x
	JOIN projects p ON p.id = x.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// apiIssueTriggerLastFired is the ADR-0060 read-side answer for one issue
// trigger: the newest run that fired it (trigger_kind = 'issue' through the
// `issue-<trigger id>-<number>` idempotency key the fire writes, ADR-0056 §5) —
// its run id and its creation time. One LATERAL subquery per trigger row, so
// the list answers without N+1 and without trusting a stored cursor.
const apiIssueTriggerLastFired = `
	LEFT JOIN LATERAL (
		SELECT r.id::text AS last_run_id, r.created_at AS last_fired_at
		FROM run_idempotency_keys k
		JOIN runs r ON r.id = k.run_id
		WHERE k.project_id = x.project_id::uuid
		  AND k.key LIKE 'issue-' || x.id::text || '-%'
		ORDER BY r.created_at DESC
		LIMIT 1
	) lf ON TRUE`

// apiIssueTriggerJoined is the FROM clause of the read queries: the scoped
// issue_triggers row plus the caller's project membership, then the ADR-0060
// last-fired LATERAL. Parameter numbering assumes $1 user, $2 org, $3 admin.
const apiIssueTriggerJoined = `
	FROM issue_triggers x
	JOIN projects p ON p.id = x.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	` + apiIssueTriggerLastFired + `
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

func (a APIIssueTriggerStore) scanIssueTrigger(row pgx.Row) (api.IssueTriggerView, error) {
	var (
		v          api.IssueTriggerView
		inputs     string
		cursorAt   *time.Time
		lastPolled *time.Time
		lastErr    *string
		lastRunID  *string
		lastFired  *time.Time
	)
	err := row.Scan(&v.ID, &v.ProjectID, &v.AssignmentID, &v.RepositoryID, &v.Event,
		&v.Labels, &inputs, &v.Enabled, &cursorAt, &lastPolled, &lastErr, &v.Version,
		&v.CreatedBy, &v.CreatedAt, &v.UpdatedAt, &lastRunID, &lastFired, &v.MyRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.IssueTriggerView{}, api.ErrIssueTriggerNotFound
	}
	if err != nil {
		return api.IssueTriggerView{}, fmt.Errorf("postgres: scan api issue trigger: %w", err)
	}
	v.Inputs = json.RawMessage(inputs)
	if cursorAt != nil {
		t := cursorAt.UTC()
		v.CursorAt = &t
	}
	if lastPolled != nil {
		t := lastPolled.UTC()
		v.LastPolledAt = &t
	}
	if lastErr != nil {
		v.LastError = *lastErr
	}
	if lastFired != nil {
		t := lastFired.UTC()
		v.LastFiredAt = &t
	}
	if lastRunID != nil {
		v.LastRunID = lastRunID
	}
	return v, nil
}

// ListProjectIssueTriggers is the project list, oldest first (the UI's
// grouping order). An invisible project yields the empty slice — the handler
// has already gated the read; this predicate is what keeps a mistyped
// projectID from answering another tenant's rows.
func (a APIIssueTriggerStore) ListProjectIssueTriggers(ctx context.Context, c api.Caller, projectID string) ([]api.IssueTriggerView, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+apiIssueTriggerColumns+apiIssueTriggerJoined+`
		  AND x.project_id = $4::uuid
		ORDER BY x.created_at, x.id`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: api list issue triggers: %w", err)
	}
	defer rows.Close()
	out := []api.IssueTriggerView{}
	for rows.Next() {
		v, err := a.scanIssueTrigger(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetIssueTrigger is the PATCH route's read: caller-scoped, and it carries
// MyRole so the handler can apply the maintainer gate without a second round
// trip (assignment PATCH's shape).
func (a APIIssueTriggerStore) GetIssueTrigger(ctx context.Context, c api.Caller, issueTriggerID string) (api.IssueTriggerView, error) {
	s, err := a.store()
	if err != nil {
		return api.IssueTriggerView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.IssueTriggerView{}, err
	}
	return a.scanIssueTrigger(s.Pool.QueryRow(ctx, `SELECT `+apiIssueTriggerColumns+apiIssueTriggerJoined+`
		  AND x.id = $4::uuid`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, issueTriggerID))
}

// CreateIssueTrigger is the project POST. The row's semantics — event
// vocabulary, label bounds, repository must be GitHub, fireability, template
// inputs against the pinned revision — are IssueTriggerStore.Create's, unchanged;
// this method adds only the caller's right to touch the project at all (the
// CreateAssignment predicate's shape: visible to the caller's org, admin or
// member) and the created_by stamp.
func (a APIIssueTriggerStore) CreateIssueTrigger(ctx context.Context, c api.Caller, projectID string,
	in api.IssueTriggerCreateInput) (api.IssueTriggerView, error) {
	s, err := a.store()
	if err != nil {
		return api.IssueTriggerView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.IssueTriggerView{}, err
	}
	var ok bool
	err = s.Pool.QueryRow(ctx, `
		SELECT true
		FROM projects p
		LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
		WHERE p.id = $2::uuid AND p.organization_id = $3::uuid
		  AND ($4::boolean OR m.user_id IS NOT NULL)`,
		cc.UserID, projectID, cc.OrganizationID, cc.IsOrgAdmin).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.IssueTriggerView{}, api.ErrIssueTriggerNotFound
	}
	if err != nil {
		return api.IssueTriggerView{}, fmt.Errorf("postgres: api resolve issue trigger project: %w", err)
	}
	// ADR-0060: a trigger on a repository-scoped assignment must watch that
	// same repository — the mismatch is a 422 refusal, never a silently
	// mis-firing trigger.
	var assignmentRepositoryID string
	if err := s.Pool.QueryRow(ctx, `
		SELECT COALESCE(repository_id::text, '') FROM assignments
		WHERE id = $1::uuid AND project_id = $2::uuid`, in.AssignmentID, projectID).Scan(&assignmentRepositoryID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return api.IssueTriggerView{}, api.ErrIssueTriggerNotFound
		}
		return api.IssueTriggerView{}, fmt.Errorf("postgres: api resolve issue trigger assignment: %w", err)
	}
	if assignmentRepositoryID != "" && in.RepositoryID != assignmentRepositoryID {
		return api.IssueTriggerView{}, api.ErrIssueTriggerRepositoryMismatch
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	sc, err := s.Create(ctx, NewIssueTrigger{
		ProjectID:    projectID,
		AssignmentID: in.AssignmentID,
		RepositoryID: in.RepositoryID,
		Event:        in.Event,
		Labels:       in.Labels,
		Inputs:       in.Inputs,
		Enabled:      &enabled,
		CreatedBy:    cc.UserID,
	})
	if err != nil {
		return api.IssueTriggerView{}, issueTriggerAPIErr(err)
	}
	return issueTriggerViewOf(sc, ""), nil
}

// UpdateIssueTrigger is the PATCH write. The maintainer gate is SQL here, not
// only in the handler: the scoped read requires role = maintainer (or admin),
// so a row the caller can see but must not edit answers the same 404 as
// nonsense — the handler's 403 is the polite arm of the same fact. The
// optimistic version rides UpdateIssueTrigger unchanged.
func (a APIIssueTriggerStore) UpdateIssueTrigger(ctx context.Context, c api.Caller, issueTriggerID string,
	in api.IssueTriggerPatchInput) (api.IssueTriggerView, error) {
	s, err := a.store()
	if err != nil {
		return api.IssueTriggerView{}, err
	}
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return api.IssueTriggerView{}, err
	}
	var found bool
	err = s.Pool.QueryRow(ctx, `SELECT true`+apiIssueTriggerScope+`
		  AND x.id = $4::uuid AND ($3::boolean OR m.role = 'maintainer')`,
		cc.UserID, cc.OrganizationID, cc.IsOrgAdmin, issueTriggerID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.IssueTriggerView{}, api.ErrIssueTriggerNotFound
	}
	if err != nil {
		return api.IssueTriggerView{}, fmt.Errorf("postgres: api check issue trigger write scope: %w", err)
	}
	sc, err := s.UpdateIssueTrigger(ctx, UpdateIssueTriggerInput{
		ID:              issueTriggerID,
		ExpectedVersion: in.Version,
		AssignmentID:    in.AssignmentID,
		RepositoryID:    in.RepositoryID,
		Event:           in.Event,
		Labels:          in.Labels,
		Inputs:          in.Inputs,
		Enabled:         in.Enabled,
	})
	if err != nil {
		return api.IssueTriggerView{}, issueTriggerAPIErr(err)
	}
	lastRunID, lastFired, err := a.issueTriggerLastFired(ctx, issueTriggerID)
	if err != nil {
		return api.IssueTriggerView{}, err
	}
	out := issueTriggerViewOf(sc, "")
	out.LastRunID = lastRunID
	out.LastFiredAt = lastFired
	return out, nil
}

// issueTriggerLastFired reads one issue trigger's last-fired run (the newest
// run with trigger_kind = 'issue' fired by it, via the idempotency key the fire
// writes). Null when the trigger never fired.
func (a APIIssueTriggerStore) issueTriggerLastFired(ctx context.Context, issueTriggerID string) (*string, *time.Time, error) {
	s, err := a.store()
	if err != nil {
		return nil, nil, err
	}
	var projectID string
	if err := s.Pool.QueryRow(ctx, `
		SELECT project_id::text FROM issue_triggers WHERE id = $1::uuid`, issueTriggerID).Scan(&projectID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, api.ErrIssueTriggerNotFound
		}
		return nil, nil, fmt.Errorf("postgres: read issue trigger %s: %w", issueTriggerID, err)
	}
	var lastRunID string
	var lastFired time.Time
	if err := s.Pool.QueryRow(ctx, `
		SELECT r.id::text, r.created_at
		FROM run_idempotency_keys k
		JOIN runs r ON r.id = k.run_id
		WHERE k.project_id = $1::uuid
		  AND k.key LIKE 'issue-' || $2::text || '-%'
		ORDER BY r.created_at DESC
		LIMIT 1`, projectID, issueTriggerID).Scan(&lastRunID, &lastFired); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("postgres: read last fired run of issue trigger %s: %w", issueTriggerID, err)
	}
	id := lastRunID
	return &id, &lastFired, nil
}

// issueTriggerAPIErr translates the issue-trigger store's facts into the
// API's sentinels; everything else stays a plain error and answers 500 (never a
// database message to a browser).
func issueTriggerAPIErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrIssueTriggerNotFound):
		return api.ErrIssueTriggerNotFound
	case errors.Is(err, ErrIssueTriggerStaleVersion):
		return api.ErrIssueTriggerStaleVersion
	case errors.Is(err, ErrIssueTriggerNotFireable):
		return api.ErrIssueTriggerNotFireable
	default:
		return err
	}
}

// issueTriggerViewOf flattens an IssueTrigger row into the wire shape.
func issueTriggerViewOf(it IssueTrigger, role string) api.IssueTriggerView {
	v := api.IssueTriggerView{
		ID: it.ID, ProjectID: it.ProjectID, AssignmentID: it.AssignmentID,
		RepositoryID: it.RepositoryID, Event: it.Event, Labels: it.Labels,
		Inputs: it.Inputs, Enabled: it.Enabled, Version: it.Version,
		CreatedBy: it.CreatedBy, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, MyRole: role,
	}
	if it.CursorAt != nil {
		t := *it.CursorAt
		v.CursorAt = &t
	}
	if it.LastPolledAt != nil {
		t := *it.LastPolledAt
		v.LastPolledAt = &t
	}
	v.LastError = it.LastError
	return v
}
