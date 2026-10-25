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

	Log *slog.Logger
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
// and the poll bookkeeping (cursor / last polled / last error).
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
}

// issueTriggerColumns is the read list. cursor_at, last_polled_at and
// last_error are nullable, so the scan goes through pointers; version is the
// config-edit counter (a fire never bumps it).
const issueTriggerColumns = `id, project_id, assignment_id, repository_id, event, labels,
	inputs::text, enabled, cursor_at, last_polled_at, last_error, version, created_by, created_at, updated_at`

func (s *IssueTriggerStore) scan(row pgx.Row) (IssueTrigger, error) {
	var (
		it         IssueTrigger
		inputs     string
		cursorAt   *time.Time
		lastPolled *time.Time
		lastErr    *string
	)
	err := row.Scan(&it.ID, &it.ProjectID, &it.AssignmentID, &it.RepositoryID, &it.Event,
		&it.Labels, &inputs, &it.Enabled, &cursorAt, &lastPolled, &lastErr, &it.Version,
		&it.CreatedBy, &it.CreatedAt, &it.UpdatedAt)
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
// non-published revision, and inputs the pinned revision would refuse — every
// one of which would otherwise show up as a trigger that quietly never runs.
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
	if _, err := m4ValidateRunInputs(pin.plan, values, issueTriggerInputNames(values)...); err != nil {
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
		if _, err := m4ValidateRunInputs(pin.plan, values, issueTriggerInputNames(values)...); err != nil {
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
		n, err := s.fireIssueTrigger(ctx, id, now, lister)
		fired += n
		if err != nil {
			errs = append(errs, fmt.Errorf("issue trigger %s: %w", id, err))
			s.logger().ErrorContext(ctx, "issue trigger tick failed for one trigger; continuing",
				slog.String("issue_trigger_id", id), slog.String("error", err.Error()))
		}
	}
	return fired, errors.Join(errs...)
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
	defer func() { _ = tx.Rollback(ctx) }()

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
		return 0, nil
	}
	live, err := scheduleLiveRuns(ctx, tx, it.AssignmentID)
	if err != nil {
		return 0, err
	}
	if live >= pin.maxConcurrent {
		s.logger().DebugContext(ctx, "issue trigger fire deferred at the assignment ceiling",
			slog.String("issue_trigger_id", id),
			slog.Int("live_runs", live), slog.Int("max_concurrent_runs", pin.maxConcurrent))
		return 0, nil
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

	fired := 0
	cursor := it.CursorAt
	for _, issue := range issues {
		if it.Event == "opened" {
			// No backfill: an issue created before the trigger was authored is
			// never fired by the `opened` arm.
			if issue.CreatedAt.IsZero() || !issue.CreatedAt.After(it.CreatedAt) {
				continue
			}
		}
		if !issueLabelsMatch(issue.Labels, it.Labels) {
			continue
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

	var cursorArg any = cursor
	if cursor != nil {
		cursorArg = *cursor
	}
	if _, err := tx.Exec(ctx, `
		UPDATE issue_triggers
		SET cursor_at = $1, last_polled_at = $2, last_error = ''
		WHERE id = $3::uuid`, cursorArg, now, id); err != nil {
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
// the stored run is the answer — and writes no second event.
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
		RepositoryID:       it.RepositoryID,
		Inputs:             inputs,
		Key:                key,
		RequestSHA:         scheduleRequestSHA(key, pin.revisionID, rendered),
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
func renderIssueInputs(values map[string]json.RawMessage, issue github.Issue) (map[string]json.RawMessage, error) {
	out := make(map[string]json.RawMessage, len(values))
	for name, raw := range values {
		var str string
		if err := json.Unmarshal(raw, &str); err == nil {
			out[name] = json.RawMessage(strconv.Quote(renderIssueTemplate(str, issue)))
			continue
		}
		out[name] = raw
	}
	return out, nil
}

// issueTemplatePlaceholder is the ADR-0056 § 5 template vocabulary: the
// `{{issue.<member>}}` placeholders a trigger's inputs may carry.
var issueTemplatePlaceholder = regexp.MustCompile(`\{\{issue\.([a-z]+)\}\}`)

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
