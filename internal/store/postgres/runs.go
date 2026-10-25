package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RunStore is the M4 execution ledger's persistence face (ADR-0023,
// docs/m4-contract.md § 1): runs that pin a revision and its plan, node
// executions on two paths through one state machine, and attempts as the
// single claim unit for worker work.
//
// The claim/lease/fence machinery is ADR-0016's, reused verbatim in shape:
// FOR UPDATE SKIP LOCKED over queued attempts, a fencing token drawn from
// attempt_fencing_seq at claim time only, and every attempt-scoped write
// fenced on (attempt, worker, token) with the journal append in the same
// transaction. Control-plane node kinds (ADR-0023 § 3) never take an attempt
// and the DB CHECK refuses even marking them leased — the advancer moves them
// pending → ready → succeeded through SetNodeStatus.
//
// Event payloads are caller-supplied: the payload structs live in
// internal/events (owned by the events slice), and the dependency rule keeps
// this package from inventing a second vocabulary. runAppendTx stamps the
// three correlation columns (contract § 1) on every row it writes.
type RunStore struct {
	Pool *pgxpool.Pool

	// LeaseTTL is the lease this store hands out at claim time; zero uses
	// runDefaultLeaseTTL (30 s, ADR-0023 § 4).
	LeaseTTL time.Duration
}

// runDefaultLeaseTTL is ADR-0023 § 4's lease: 30 s, renewed every 10 s.
const runDefaultLeaseTTL = 30 * time.Second

// Run-domain errors. Callers map ErrConflict to 409 (CAS misses, duplicate
// idempotency keys with a different body, second live gate); ErrLeaseLost is
// the worker's "I am dead, stop writing" signal (12 case 3).
var (
	// ErrRunNotFound covers runs, node executions, attempts and approvals.
	ErrRunNotFound = errors.New("postgres: run object not found")

	// ErrLeaseLost means the fence rejected the writer: another owner holds
	// the attempt now, or the row is terminal. A stale worker treats this as
	// fatal for the attempt loop and stops writing (ADR-0016 § 3).
	ErrLeaseLost = errors.New("postgres: attempt lease is no longer held")

	// ErrIdempotencyMismatch is the 12-case-1 409: the same project-scoped
	// key was presented with a different request body hash. The stored run
	// is NOT touched; the API reports the mismatch.
	ErrIdempotencyMismatch = errors.New("postgres: idempotency key already used with a different request")

	// ErrRunNotTransitionable refuses a run move the state machine has no
	// edge for (e.g. terminal → anything).
	ErrRunNotTransitionable = errors.New("postgres: run status transition is not allowed")
)

// Run is a pinned execution of one published revision (01 invariant 1):
// the digests and snapshots copied at creation, never re-resolved (12
// case 11). Empty string is NULL for the nullable uuid/text members.
type Run struct {
	ID                 string
	OrganizationID     string
	ProjectID          string
	PipelineID         string
	PipelineRevisionID string
	AssignmentID       string
	// SourceConversationID (ADR-0053) is the thread the run was started
	// from; empty string is NULL (an ordinary run).
	SourceConversationID string
	RevisionDigest       string
	PlanDigest           string
	PlanSnapshot         json.RawMessage
	PoliciesSnapshot     json.RawMessage
	RepoSnapshot         json.RawMessage
	Status               string
	FailedCause          string
	PausedReason         string
	CancelRequestedAt    *time.Time
	Depth                int
	ParentRunID          string
	TriggeredBy          string
	WorkerAffinity       string
	WorkerVolumeID       string
	Priority             int
	ExpressionEvals      int
	CreatedAt            time.Time
	StartedAt            *time.Time
	FinishedAt           *time.Time

	// Trigger (ADR-0056) is how this run was started: 'manual', 'schedule',
	// 'issue' or 'thread'. Empty string is the honest default a pre-trigger
	// writer still carries after the 00012 backfill ('manual'); a schedule fire
	// names its schedule in TriggerRef, an issue start its `owner/repo#<n>`.
	TriggerKind string
	// TriggerRef names the trigger: the schedule id for 'schedule', the
	// `owner/repo#<number>` for 'issue'; empty for 'manual' and 'thread' (a
	// thread start keeps source_conversation_id, ADR-0053).
	TriggerRef string
	// TriggerID (ADR-0062) is the primary key of the trigger table that fired
	// this run: schedules.id for 'schedule', issue_triggers.id for 'issue';
	// empty for 'manual'/'thread' and propagated to children along with kind
	// and ref. It is the row the unattended agent turn's submitter is read
	// from — the trigger's author authorised the automation.
	TriggerID string
	// RepositoryID (ADR-0060) is the repository this run works on; empty string
	// is NULL (the run started against no named repository — a project-wide
	// intent or a resolved inputs.repository).
	RepositoryID string
	// AgentProfileVersion (ADR-0058) is the profile version this run was pinned
	// to at creation — the version its source conversation carried when the run
	// was started from a thread, or the creation default for a direct start. It
	// is the conversation's pin inherited by the run, never re-resolved.
	AgentProfileVersion int
}

// NodeExecution is one runtime occurrence of a node in a run, identified by
// its text path key (01 invariant 6): /implement, /build_until_verified[2]/review.
type NodeExecution struct {
	ID                string
	RunID             string
	NodeID            string
	Kind              string
	NodeInstanceKey   string
	ScopeKey          string
	ExecutionLocation string
	Status            string
	Outputs           json.RawMessage // nil until written
	Outcome           string
	ErrorClass        string
	FailedCause       string
	ArtifactRefs      json.RawMessage
	DependsOn         json.RawMessage
	AttemptCount      int
	AttemptLimit      int
	InFlight          int
	WaitingReason     string
	CreatedAt         time.Time
	ReadyAt           *time.Time
	FinishedAt        *time.Time
}

// Attempt is one claim of worker work for a node execution. The lease triple
// (WorkerID, LeaseExpiresAt, FencingToken) is what every fenced write
// compares; queued attempts carry none of it (the DB refuses the lie).
type Attempt struct {
	ID                string
	NodeExecutionID   string
	RunID             string
	AttemptNumber     int
	Status            string
	ErrorClass        string
	Detail            string
	OutputErrors      json.RawMessage
	WorkerID          string
	LeaseExpiresAt    *time.Time
	FencingToken      int64
	ScheduledAt       time.Time
	DeadlineAt        *time.Time
	CancelRequestedAt *time.Time
	Outputs           json.RawMessage
	OutputsDigest     string
	ArtifactRefs      json.RawMessage
	Overrides         json.RawMessage
	RetryContext      json.RawMessage
	ConversationID    string
	TurnID            string
	CreatedAt         time.Time
	StartedAt         *time.Time
	FinishedAt        *time.Time
}

// RunEvent is one journal append correlated to the run ledger. The three
// ids come from the store's context (the row being written), never from the
// caller, so a worker cannot forge correlation (contract § 3).
type RunEvent struct {
	Type      string
	ActorKind string
	ActorID   string
	Payload   any
}

func (s *RunStore) leaseTTL() time.Duration {
	if s.LeaseTTL > 0 {
		return s.LeaseTTL
	}
	return runDefaultLeaseTTL
}

// ------------------------------------------------------------------- runs

const runColumns = `id, organization_id, project_id, pipeline_id, pipeline_revision_id,
	COALESCE(assignment_id::text, ''), COALESCE(source_conversation_id::text, ''),
	revision_digest, plan_digest, plan_snapshot, policies_snapshot,
	repo_snapshot, status, failed_cause, paused_reason, cancel_requested_at, depth,
	COALESCE(parent_run_id::text, ''), COALESCE(triggered_by::text, ''),
	COALESCE(worker_affinity::text, ''), worker_volume_id,
	priority, expression_evaluations, created_at, started_at, finished_at,
	COALESCE(trigger_kind, ''), COALESCE(trigger_ref, ''), COALESCE(trigger_id::text, ''),
	COALESCE(repository_id::text, ''), agent_profile_version`

func (s *RunStore) scanRun(row pgx.Row) (Run, error) {
	var (
		r                 Run
		plan, polic, repo []byte
		cause, paused     *string
		volume            *string
		cancelled         *time.Time
		started, finished *time.Time
	)
	err := row.Scan(&r.ID, &r.OrganizationID, &r.ProjectID, &r.PipelineID, &r.PipelineRevisionID,
		&r.AssignmentID, &r.SourceConversationID, &r.RevisionDigest, &r.PlanDigest, &plan, &polic, &repo,
		&r.Status, &cause, &paused, &cancelled, &r.Depth,
		&r.ParentRunID, &r.TriggeredBy, &r.WorkerAffinity, &volume,
		&r.Priority, &r.ExpressionEvals, &r.CreatedAt, &started, &finished,
		&r.TriggerKind, &r.TriggerRef, &r.TriggerID, &r.RepositoryID, &r.AgentProfileVersion)
	if err != nil {
		return Run{}, err
	}
	r.PlanSnapshot, r.PoliciesSnapshot, r.RepoSnapshot = plan, polic, repo
	r.FailedCause, r.PausedReason = derefStr(cause), derefStr(paused)
	r.WorkerVolumeID = derefStr(volume)
	r.CancelRequestedAt, r.StartedAt, r.FinishedAt = cancelled, started, finished
	return r, nil
}

// NewRun is the CreateRun input: everything the API resolved and pinned in
// one transaction (contract § 2.1 route 22). The caller supplies the pinned
// digests and snapshots verbatim from the revision row — the store copies,
// it never resolves, so a scheduler bug cannot disagree with the validator
// (ADR-0023 § 2).
type NewRun struct {
	OrganizationID     string
	ProjectID          string
	PipelineID         string
	PipelineRevisionID string
	AssignmentID       string // "" ⇒ NULL (direct revision start)
	// SourceConversationID (ADR-0053) names the thread this run was started
	// from; "" ⇒ NULL.
	SourceConversationID string
	RevisionDigest       string
	PlanDigest           string
	PlanSnapshot         json.RawMessage
	PoliciesSnapshot     json.RawMessage
	RepoSnapshot         json.RawMessage // "" ⇒ []
	Priority             int
	Depth                int
	ParentRunID          string
	TriggeredBy          string // "" ⇒ NULL (child or system start)
	// Trigger (ADR-0056) is how this run was started: 'manual', 'schedule',
	// 'issue' or 'thread'. Empty string is the honest default a pre-trigger
	// writer still carries after the 00012 backfill ('manual'); a schedule fire
	// names its schedule in TriggerRef, an issue start its `owner/repo#<n>`.
	TriggerKind string
	// TriggerRef names the trigger: the schedule id for 'schedule', the
	// `owner/repo#<number>` for 'issue'; empty for 'manual' and 'thread' (a
	// thread start keeps source_conversation_id, ADR-0053).
	TriggerRef string
	// TriggerID (ADR-0062) is the firing trigger row's primary key
	// (schedules.id / issue_triggers.id); empty for 'manual'/'thread'. A child
	// inherits it with the kind and ref.
	TriggerID string
	// RepositoryID (ADR-0060) is the repository this run works on; empty string
	// is NULL (the run started against no named repository — a project-wide
	// intent or a resolved inputs.repository).
	RepositoryID string
	// Inputs are validated against spec.inputs by the caller; the store
	// writes one run_inputs row per entry.
	Inputs map[string]RunInput
	// ArtifactIDs (ADR-0053) are attached to the run by reference inside the
	// create transaction (artifacts.run_id); "" rows and foreign rows were
	// refused before the transaction.
	ArtifactIDs []string
	// Idempotency (12 case 1, ADR-0023 § 12): when Key is non-empty the
	// create is guarded by run_idempotency_keys. Same key + same SHA returns
	// the stored run (Created=false); same key, different SHA is
	// ErrIdempotencyMismatch.
	Key        string
	RequestSHA string
	// Event, when non-nil, is appended in the create transaction with the
	// run correlation columns (run.created, contract § 3 row 1).
	Event *RunEvent
}

// RunInput is one declared pipeline input, already validated/coerced: the
// value bindings read, plus where it came from.
type RunInput struct {
	Value  json.RawMessage
	Origin string // submitted|default|override ("" ⇒ submitted)
}

// CreateRun inserts the run, its validated inputs and its idempotency key in
// one transaction: the run either exists pinned, with every input row and
// the key claiming it, or nothing happened. A duplicate idempotency key is
// resolved against the stored request hash, never by silently updating.
//
// Inside an advancer pass it rides that pass's transaction instead (see
// withPassTx): a child run a pipeline.invoke starts is one fact with the
// parent's node-execution rows, and on a second connection its parent_run_id
// foreign key would wait for the pass that is waiting for it.
func (s *RunStore) CreateRun(ctx context.Context, in NewRun) (run Run, created bool, err error) {
	if tx, ok := passTx(ctx); ok {
		return s.createRunTx(ctx, tx, in)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Run{}, false, fmt.Errorf("postgres: begin create run tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, created, err = s.createRunTx(ctx, tx, in)
	if err != nil {
		return Run{}, false, err
	}
	if !created {
		// Idempotent replay: the stored run is the answer and the ephemeral
		// insert this transaction made must NOT survive — the deferred rollback
		// discards it, exactly as CreateRun did before the pass-tx refactor.
		return run, false, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, false, fmt.Errorf("postgres: commit create run: %w", err)
	}
	return run, true, nil
}

// createRunTx is CreateRun's body on a transaction the caller owns.
func (s *RunStore) createRunTx(ctx context.Context, tx pgx.Tx, in NewRun) (run Run, created bool, err error) {
	// ADR-0058: a run pins the profile version its source conversation carried at
	// creation; a direct start pins the creation default. The conversation is the
	// resolution root, so the run inherits the pin rather than re-resolving it.
	agentProfileVersion := 1
	if in.SourceConversationID != "" {
		if err := tx.QueryRow(ctx, `
			SELECT agent_profile_version FROM conversations WHERE id = $1::uuid`,
			in.SourceConversationID).Scan(&agentProfileVersion); err != nil {
			return Run{}, false, fmt.Errorf("postgres: read source conversation %s for the profile version: %w", in.SourceConversationID, err)
		}
	}
	if run, err = s.scanRun(tx.QueryRow(ctx, `
		INSERT INTO runs
			(organization_id, project_id, pipeline_id, pipeline_revision_id, assignment_id,
				source_conversation_id, revision_digest, plan_digest, plan_snapshot,
				policies_snapshot, repo_snapshot, depth, parent_run_id, triggered_by, priority,
				trigger_kind, trigger_ref, trigger_id, repository_id, agent_profile_version)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULLIF($5, '')::uuid,
		        NULLIF($6, '')::uuid, $7, $8, $9::jsonb, $10::jsonb,
		        COALESCE(NULLIF($11, '')::jsonb, '[]'::jsonb),
		        $12, NULLIF($13, '')::uuid, NULLIF($14, '')::uuid, $15,
		        COALESCE(NULLIF($16, ''), 'manual'), NULLIF($17, '')::text, NULLIF($20, '')::uuid, NULLIF($18, '')::uuid, $19)
		RETURNING `+runColumns,
		in.OrganizationID, in.ProjectID, in.PipelineID, in.PipelineRevisionID, in.AssignmentID,
		in.SourceConversationID, in.RevisionDigest, in.PlanDigest,
		string(orEmptyJSON(in.PlanSnapshot)), string(orEmptyJSON(in.PoliciesSnapshot)),
		string(in.RepoSnapshot),
		in.Depth, in.ParentRunID, in.TriggeredBy, in.Priority, in.TriggerKind, in.TriggerRef, in.RepositoryID, agentProfileVersion, in.TriggerID)); err != nil {
		return Run{}, false, fmt.Errorf("postgres: insert run for project %s: %w", in.ProjectID, err)
	}

	for name, input := range in.Inputs {
		origin := input.Origin
		if origin == "" {
			origin = "submitted"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO run_inputs (run_id, name, value, origin)
			VALUES ($1::uuid, $2, $3::jsonb, $4)`,
			run.ID, name, string(orEmptyJSON(input.Value)), origin); err != nil {
			return Run{}, false, fmt.Errorf("postgres: insert input %q for run %s: %w", name, run.ID, err)
		}
	}

	if in.Key != "" {
		var newRunID string
		err := tx.QueryRow(ctx, `
			INSERT INTO run_idempotency_keys (project_id, key, run_id, request_sha256)
			VALUES ($1::uuid, $2, $3::uuid, $4)
			ON CONFLICT (project_id, key) DO NOTHING
			RETURNING run_id::text`,
			in.ProjectID, in.Key, run.ID, in.RequestSHA).Scan(&newRunID)
		if errors.Is(err, pgx.ErrNoRows) {
			// The key was taken concurrently or previously: the winner's run
			// is the answer, unless the body disagrees (409 arm).
			var winner, sha string
			if err := tx.QueryRow(ctx, `
				SELECT run_id::text, request_sha256 FROM run_idempotency_keys
				WHERE project_id = $1::uuid AND key = $2`, in.ProjectID, in.Key).
				Scan(&winner, &sha); err != nil {
				return Run{}, false, fmt.Errorf("postgres: read idempotency key: %w", err)
			}
			if sha != in.RequestSHA {
				return Run{}, false, ErrIdempotencyMismatch
			}
			stored, err := s.scanRun(tx.QueryRow(ctx, `
				SELECT `+runColumns+` FROM runs WHERE id = $1::uuid`, winner))
			if err != nil {
				return Run{}, false, fmt.Errorf("postgres: read idempotent run %s: %w", winner, err)
			}
			return stored, false, nil
		}
		if err != nil {
			return Run{}, false, fmt.Errorf("postgres: claim idempotency key %q: %w", in.Key, err)
		}
	}

	if in.Event != nil {
		if _, err := runAppendTx(ctx, tx, run.ID, "", "", *in.Event); err != nil {
			return Run{}, false, err
		}
	}
	return run, true, nil
}

// GetRun reads one run — on the pass's transaction when the caller is inside
// one, so a child row this pass created but has not committed yet is visible to
// the parent's next poll rather than reporting a missing child.
func (s *RunStore) GetRun(ctx context.Context, id string) (Run, error) {
	r, err := s.scanRun(runOn(ctx, s.Pool).QueryRow(ctx, `
		SELECT `+runColumns+` FROM runs WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrRunNotFound
	}
	if err != nil {
		return Run{}, fmt.Errorf("postgres: get run %s: %w", id, err)
	}
	return r, nil
}

// ListProjectRuns returns a project's runs, newest first (route 21). The
// filters are the read-side narrowing the task's run-list surface needs: an
// optional trigger kind (ADR-0056, validated by the handler) keeps only the
// runs that were started by that kind, and an optional repository_id /
// assignment_id pair keeps only the runs of one repository or one pin (ADR-0060).
// An empty filter value is the no-filter answer.
func (s *RunStore) ListProjectRuns(ctx context.Context, projectID, trigger, repositoryID, assignmentID string) ([]Run, error) {
	where := `WHERE project_id = $1::uuid`
	args := []any{projectID}
	argN := 2
	if trigger != "" {
		where += fmt.Sprintf(`
  AND trigger_kind = $%d::text`, argN)
		args = append(args, trigger)
		argN++
	}
	if repositoryID != "" {
		where += fmt.Sprintf(`
  AND repository_id = $%d::uuid`, argN)
		args = append(args, repositoryID)
		argN++
	}
	if assignmentID != "" {
		where += fmt.Sprintf(`
  AND assignment_id = $%d::uuid`, argN)
		args = append(args, assignmentID)
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+runColumns+` FROM runs
		`+where+` ORDER BY created_at DESC, id DESC`, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: list runs for project %s: %w", projectID, err)
	}
	defer rows.Close()
	var out []Run
	for rows.Next() {
		r, err := s.scanRun(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan run: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RunStatusInput is the SetRunStatus payload: only the fields the target
// status may carry. The DB refuses the rest (terminal_timestamped,
// terminal_cause, paused_reasoned); the switch below refuses vocabulary
// mistakes before Postgres sees them.
type RunStatusInput struct {
	Status       string
	FailedCause  string
	PausedReason string
	Event        *RunEvent
}

var runTerminalStatuses = map[string]bool{
	"completed": true, "failed": true, "cancelled": true, "interrupted": true,
}

// SetRunStatus moves a run's status in one transaction with its journal
// append. started_at is stamped on the first move out of queued/preparing;
// finished_at belongs to the terminal write and only to it
// (runs_terminal_timestamped is an equality).
func (s *RunStore) SetRunStatus(ctx context.Context, runID string, in RunStatusInput) (Run, error) {
	switch in.Status {
	case "queued", "preparing", "running", "waiting_human", "paused",
		"completed", "failed", "cancelled", "interrupted":
	default:
		return Run{}, fmt.Errorf("%w: unknown run status %q", ErrRunNotTransitionable, in.Status)
	}
	if in.Status == "paused" && in.PausedReason == "" {
		return Run{}, fmt.Errorf("%w: paused requires a reason (runs_paused_reasoned)", ErrRunNotTransitionable)
	}
	if runTerminalStatuses[in.Status] &&
		(in.Status == "failed" || in.Status == "interrupted") && in.FailedCause == "" {
		return Run{}, fmt.Errorf("%w: %s requires a failed_cause (runs_terminal_cause)",
			ErrRunNotTransitionable, in.Status)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Run{}, fmt.Errorf("postgres: begin run status tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	r, err := s.scanRun(tx.QueryRow(ctx, `
		SELECT `+runColumns+` FROM runs WHERE id = $1::uuid FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrRunNotFound
	}
	if err != nil {
		return Run{}, fmt.Errorf("postgres: lock run %s: %w", runID, err)
	}
	if runTerminalStatuses[r.Status] {
		return Run{}, fmt.Errorf("%w: run %s is already %s", ErrRunNotTransitionable, runID, r.Status)
	}
	var (
		finished string
		started  = "started_at"
	)
	term := runTerminalStatuses[in.Status]
	if term {
		finished = "now()"
	} else {
		finished = "finished_at"
	}
	if !term && r.StartedAt == nil && in.Status != "queued" && in.Status != "preparing" && in.Status != "paused" {
		started = "COALESCE(started_at, now())"
	}
	r, err = s.scanRun(tx.QueryRow(ctx, fmt.Sprintf(`
		UPDATE runs
		SET status = $2,
		    failed_cause = NULLIF($3, ''),
		    paused_reason = NULLIF($4, ''),
		    started_at = %s,
		    finished_at = %s
		WHERE id = $1::uuid
		RETURNING `+runColumns, started, finished),
		runID, in.Status, in.FailedCause, in.PausedReason))
	if err != nil {
		return Run{}, fmt.Errorf("postgres: set run %s status %s: %w", runID, in.Status, err)
	}
	if in.Event != nil {
		if _, err := runAppendTx(ctx, tx, r.ID, "", "", *in.Event); err != nil {
			return Run{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("postgres: commit run status: %w", err)
	}
	return r, nil
}

// RequestCancel sets cancel_requested_at (route 30's first half: the API
// only flags; the advancer cascades). Re-flagging keeps the first request.
func (s *RunStore) RequestCancel(ctx context.Context, runID string, event *RunEvent) (Run, error) {
	var r Run
	err := s.withRunLock(ctx, runID, func(ctx context.Context, tx pgx.Tx, run Run) error {
		var err error
		r, err = s.scanRun(tx.QueryRow(ctx, `
			UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, now())
			WHERE id = $1::uuid
			RETURNING `+runColumns, runID))
		if err != nil {
			return fmt.Errorf("postgres: request cancel run %s: %w", runID, err)
		}
		if event != nil {
			_, err = runAppendTx(ctx, tx, run.ID, "", "", *event)
		}
		return err
	})
	return r, err
}

// SetRunAffinity is the one-way door ADR-0023 § 4 calls affinity: the worker
// that prepared the run's workspace sets it, in that preparation
// transaction's shape, and it is never re-evaluated. A row that already has
// an affinity is left untouched and reports false — the second worker's
// claim to the same run is a refusal, not an overwrite.
func (s *RunStore) SetRunAffinity(ctx context.Context, runID, workerID, volumeID string) (bool, error) {
	if volumeID == "" {
		return false, fmt.Errorf("postgres: run affinity requires a volume id (runs_affinity_is_a_pair)")
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE runs SET worker_affinity = $2::uuid, worker_volume_id = $3
		WHERE id = $1::uuid AND worker_affinity IS NULL`, runID, workerID, volumeID)
	if err != nil {
		return false, fmt.Errorf("postgres: set affinity for run %s: %w", runID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// BumpExpressionEvaluations adds n to the run's counter (the advancer's
// per-run cap bookkeeping, contract § 6) and returns the new total.
func (s *RunStore) BumpExpressionEvaluations(ctx context.Context, runID string, n int) (int, error) {
	if n < 0 {
		return 0, fmt.Errorf("postgres: expression evaluation delta must be >= 0")
	}
	var total int
	err := s.Pool.QueryRow(ctx, `
		UPDATE runs SET expression_evaluations = expression_evaluations + $2
		WHERE id = $1::uuid RETURNING expression_evaluations`, runID, n).Scan(&total)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrRunNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: bump expression evaluations on run %s: %w", runID, err)
	}
	return total, nil
}

// withRunLock is the single-transaction shape every run-scoped mutation
// shares: lock the run row, act, commit. Inside an advancer pass the pass's own
// transaction is the only one that may write the row (see withPassTx), so the
// lock is taken there and the CALLER commits.
func (s *RunStore) withRunLock(ctx context.Context, runID string, fn func(context.Context, pgx.Tx, Run) error) error {
	if pass, ok := passTx(ctx); ok {
		run, err := s.scanRun(pass.QueryRow(ctx, `
			SELECT `+runColumns+` FROM runs WHERE id = $1::uuid FOR UPDATE`, runID))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRunNotFound
		}
		if err != nil {
			return fmt.Errorf("postgres: lock run %s in the pass: %w", runID, err)
		}
		return fn(ctx, pass, run)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin run tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := s.scanRun(tx.QueryRow(ctx, `
		SELECT `+runColumns+` FROM runs WHERE id = $1::uuid FOR UPDATE`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRunNotFound
	}
	if err != nil {
		return fmt.Errorf("postgres: lock run %s: %w", runID, err)
	}
	if err := fn(ctx, tx, run); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
