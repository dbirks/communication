package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// ------------------------------------------------------------- attempt rows

const runAttemptColumns = `id, node_execution_id, run_id, attempt_number, status,
	error_class, detail, output_errors, COALESCE(worker_id::text, ''), lease_expires_at, fencing_token,
	scheduled_at, deadline_at, cancel_requested_at, outputs, outputs_digest,
	artifact_refs, overrides, retry_context, COALESCE(conversation_id::text, ''),
	COALESCE(turn_id::text, ''),
	created_at, started_at, finished_at`

func (s *RunStore) scanAttempt(row pgx.Row) (Attempt, error) {
	var (
		a                   Attempt
		errClass            *string
		detail              *string
		outErrors           []byte
		worker              *string
		digest              *string
		refs                []byte
		overrides, retryCtx []byte
		conv, turn          *string
		outputs             []byte
	)
	err := row.Scan(&a.ID, &a.NodeExecutionID, &a.RunID, &a.AttemptNumber, &a.Status,
		&errClass, &detail, &outErrors, &worker, &a.LeaseExpiresAt, &a.FencingToken,
		&a.ScheduledAt, &a.DeadlineAt, &a.CancelRequestedAt, &outputs, &digest,
		&refs, &overrides, &retryCtx, &conv, &turn,
		&a.CreatedAt, &a.StartedAt, &a.FinishedAt)
	if err != nil {
		return Attempt{}, err
	}
	a.ErrorClass, a.Detail = derefStr(errClass), derefStr(detail)
	a.OutputErrors = outErrors
	a.WorkerID = derefStr(worker)
	a.Outputs, a.OutputsDigest = outputs, derefStr(digest)
	a.ArtifactRefs, a.Overrides, a.RetryContext = refs, overrides, retryCtx
	a.ConversationID, a.TurnID = derefStr(conv), derefStr(turn)
	return a, nil
}

// NewAttempt is the advancer's re-queue input (contract § 5.1 step 4): the
// first attempt carries ScheduledAt = now, a retry carries the COMPUTED
// backoff landing time so an API restart mid-backoff does not restart the
// backoff (ADR-0023 § 7).
type NewAttempt struct {
	NodeExecutionID string
	AttemptNumber   int
	ScheduledAt     time.Time // zero ⇒ now()
	DeadlineAt      time.Time // zero ⇒ NULL (node timeoutSeconds)
	Overrides       json.RawMessage
	RetryContext    json.RawMessage
}

// QueueAttempt inserts a queued attempt — unowned by construction
// (attempts_queued_unowned) — under the node's row lock, so the unique
// (node_execution_id, attempt_number) cannot race with itself.
//
// The attempt ledger: node_executions.attempt_count is the number of
// attempts the node has, i.e. max(attempts.attempt_number) (contract § 7.1
// C1e: a single-attempt node reads 1). The ENGINE owns that column — it
// bumps it when it queues (runtime queueAttempt) and persists it absolutely
// (updateNodeTx). This seam exists for writers outside an engine pass (test
// fixtures, the retry/queue paths reached without a hydrated advancer), so it
// maintains the same invariant itself: GREATEST, never +1, so an attempt this
// store counts can never be counted twice by the engine's absolute write.
func (s *RunStore) QueueAttempt(ctx context.Context, in NewAttempt) (Attempt, error) {
	if in.AttemptNumber < 1 {
		return Attempt{}, fmt.Errorf("postgres: attempt_number must be >= 1, got %d", in.AttemptNumber)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Attempt{}, fmt.Errorf("postgres: begin queue attempt tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var runID string
	if err := tx.QueryRow(ctx, `
		SELECT run_id::text FROM node_executions WHERE id = $1::uuid FOR UPDATE`,
		in.NodeExecutionID).Scan(&runID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Attempt{}, ErrRunNotFound
		}
		return Attempt{}, fmt.Errorf("postgres: lock node execution %s: %w", in.NodeExecutionID, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE node_executions
		SET attempt_count = GREATEST(attempt_count, $2) WHERE id = $1::uuid`,
		in.NodeExecutionID, in.AttemptNumber); err != nil {
		return Attempt{}, fmt.Errorf("postgres: count attempt n%d on node %s: %w",
			in.AttemptNumber, in.NodeExecutionID, err)
	}
	a, err := s.scanAttempt(tx.QueryRow(ctx, `
		INSERT INTO attempts
			(node_execution_id, run_id, attempt_number, scheduled_at, deadline_at,
			 overrides, retry_context)
		VALUES ($1::uuid, $2::uuid, $3, COALESCE($4::timestamptz, now()), $5::timestamptz,
		        NULLIF($6, '')::jsonb, NULLIF($7, '')::jsonb)
		RETURNING `+runAttemptColumns,
		in.NodeExecutionID, runID, in.AttemptNumber, nullableTime(in.ScheduledAt),
		nullableTime(in.DeadlineAt), string(in.Overrides), string(in.RetryContext)))
	if err != nil {
		if pipUniqueErr(err) != nil {
			return Attempt{}, ErrConflict
		}
		return Attempt{}, fmt.Errorf("postgres: queue attempt n%d for node %s: %w",
			in.AttemptNumber, in.NodeExecutionID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Attempt{}, fmt.Errorf("postgres: commit queue attempt: %w", err)
	}
	return a, nil
}

// GetAttempt reads one attempt. Note: browser-facing projections must drop
// worker_id / fencing_token / lease_expires_at (ADR-0016 § 8, route 32);
// this read is the control plane's, which is allowed to see them.
func (s *RunStore) GetAttempt(ctx context.Context, id string) (Attempt, error) {
	a, err := s.scanAttempt(s.Pool.QueryRow(ctx, `
		SELECT `+runAttemptColumns+` FROM attempts WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Attempt{}, ErrRunNotFound
	}
	if err != nil {
		return Attempt{}, fmt.Errorf("postgres: get attempt %s: %w", id, err)
	}
	return a, nil
}

// ListNodeAttempts returns a node execution's attempts, oldest first (route
// 25's attempt list; "repeated attempts append, not overwrite").
func (s *RunStore) ListNodeAttempts(ctx context.Context, nodeExecutionID string) ([]Attempt, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+runAttemptColumns+` FROM attempts
		WHERE node_execution_id = $1::uuid ORDER BY attempt_number, id`, nodeExecutionID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list attempts for node %s: %w", nodeExecutionID, err)
	}
	defer rows.Close()
	var out []Attempt
	for rows.Next() {
		a, err := s.scanAttempt(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan attempt: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------- claim

// AttemptClaim is the fenced triple plus everything the worker needs to run
// the attempt without a second read of mutable state.
type AttemptClaim struct {
	AttemptID         string
	NodeExecutionID   string
	RunID             string
	ProjectID         string
	OrganizationID    string
	NodeID            string
	NodeInstanceKey   string
	ScopeKey          string
	Kind              string
	ExecutionLocation string
	AttemptNumber     int
	WorkerID          string
	FencingToken      int64
	RevisionDigest    string
	PlanDigest        string
	WorkerVolumeID    string // the run's volume, "" until affinity is set
	DeadlineAt        *time.Time
	Overrides         json.RawMessage
	RetryContext      json.RawMessage
}

// runClaimPredicate is the ADR-0023 § 4 claim predicate, written once and
// shared by the locked pick and the fencing-token guard below so the two can
// never disagree about what "claimable" means.
const runClaimPredicate = `
		  a2.status = 'queued' AND a2.scheduled_at <= now()
		  AND r.status = 'running'
		  AND wr.status = 'online' AND wr.active_attempts < wr.capacity
		  AND (r.worker_affinity IS NULL OR r.worker_affinity = $1::uuid)`

// runClaimSQL is ADR-0023 § 4's claim statement, mirrored: FOR UPDATE SKIP
// LOCKED over queued attempts whose run is 'running', gated on worker
// liveness and capacity, affinity-bound, tie-broken by
// (priority DESC, scheduled_at, id), token drawn from attempt_fencing_seq at
// claim time only. The joined columns the worker needs travel through the
// sub-select (an UPDATE ... FROM can only RETURN from the target and the
// FROM alias), which is the ADR's `RETURNING a.*, ne.node_instance_key,
// r.revision_digest, r.plan_digest` made executable. migrate_test.go pins
// this shape against the real DB.
//
// The token is drawn ONCE PER CLAIM (contract § 4 step 2, § 7 C3c): a
// volatile function written straight into SET is evaluated per row — measured
// on Postgres 18, `SET fencing_token = nextval(...)` drew one value per
// claimed row — so the draw lives in a MATERIALIZED CTE that yields exactly
// one row, guarded by an EXISTS over the same predicate so a claim that wins
// nothing never spends a token. Every row of one batch then shares one token,
// max(fencing_token) tracks the claim count, and a replacement claim always
// carries a strictly greater token (`12` case 3).
const runClaimSQL = `
	WITH tok AS MATERIALIZED (
		SELECT nextval('attempt_fencing_seq') AS token
		WHERE EXISTS (
			SELECT 1
			FROM attempts a2
			JOIN node_executions ne ON ne.id = a2.node_execution_id
			JOIN runs r            ON r.id = ne.run_id
			JOIN workers wr        ON wr.id = $1::uuid
			WHERE ` + runClaimPredicate + `
		)
	)
	UPDATE attempts a
	SET status = 'leased',
	    worker_id = w.worker_id,
	    lease_expires_at = now() + make_interval(secs => $2::double precision),
	    fencing_token = tok.token
	FROM (
		SELECT a2.id AS attempt_id, $1::uuid AS worker_id,
		       ne.node_id, ne.node_instance_key, ne.kind, ne.execution_location,
		       ne.scope_key,
		       r.project_id, r.organization_id, r.worker_volume_id,
		       r.revision_digest, r.plan_digest
		FROM attempts a2
		JOIN node_executions ne ON ne.id = a2.node_execution_id
		JOIN runs r            ON r.id = ne.run_id
		JOIN workers wr        ON wr.id = $1::uuid
		WHERE ` + runClaimPredicate + `
		ORDER BY r.priority DESC, a2.scheduled_at, a2.id
		FOR UPDATE OF a2 SKIP LOCKED
		LIMIT $3::int
	) w, tok
	WHERE a.id = w.attempt_id
	RETURNING a.id, a.node_execution_id, a.run_id, a.attempt_number,
	          a.worker_id::text, a.fencing_token, a.deadline_at, a.overrides, a.retry_context,
	          w.node_id, w.node_instance_key, w.kind, w.execution_location, w.scope_key,
	          w.project_id::text, w.organization_id::text, w.worker_volume_id,
	          w.revision_digest, w.plan_digest`

// ClaimAttempts wins up to limit queued attempts for workerID in one
// transaction: the workers row is locked first so active_attempts accounting
// cannot double-spend capacity between two claims by the same worker
// (ADR-0023 § 4's predicate reads wr.active_attempts < wr.capacity — that
// read is only meaningful under the row lock), then the pinned claim runs,
// then each leased attempt's node execution moves ready → leased and the
// worker's active_attempts rises by exactly what was claimed. The claim does
// NOT touch attempt_count: the attempt was already counted when the engine
// queued it (docs/m4-live-findings.md P1 — counting it here too halved every
// retry budget, because the advancer gates the retry on attempt_count <
// attempt_limit). SKIP LOCKED is a queue, not exactly-once: the fencing
// triple, not the claim, is what makes a stale write rejectable.
func (s *RunStore) ClaimAttempts(ctx context.Context, workerID string, limit int) ([]AttemptClaim, error) {
	if limit <= 0 {
		return nil, nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("postgres: begin claim tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var capacity, active int
	err = tx.QueryRow(ctx, `
		SELECT capacity, active_attempts FROM workers WHERE id = $1::uuid FOR UPDATE`,
		workerID).Scan(&capacity, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrRunNotFound // no such worker
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: lock worker %s: %w", workerID, err)
	}
	if free := capacity - active; free < limit {
		limit = free
	}
	if limit <= 0 {
		return nil, nil
	}

	rows, err := tx.Query(ctx, runClaimSQL, workerID, s.leaseTTL().Seconds(), limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: claim attempts for %s: %w", workerID, err)
	}
	var claims []AttemptClaim
	for rows.Next() {
		var (
			c                   AttemptClaim
			workerCol           *string
			deadline            *time.Time
			overrides, retryCtx []byte
			volume              *string
		)
		if err := rows.Scan(&c.AttemptID, &c.NodeExecutionID, &c.RunID, &c.AttemptNumber,
			&workerCol, &c.FencingToken, &deadline, &overrides, &retryCtx,
			&c.NodeID, &c.NodeInstanceKey, &c.Kind, &c.ExecutionLocation, &c.ScopeKey,
			&c.ProjectID, &c.OrganizationID, &volume,
			&c.RevisionDigest, &c.PlanDigest); err != nil {
			rows.Close()
			return nil, fmt.Errorf("postgres: scan claimed attempt: %w", err)
		}
		c.WorkerID = derefStr(workerCol)
		c.DeadlineAt = deadline
		c.Overrides, c.RetryContext = overrides, retryCtx
		c.WorkerVolumeID = derefStr(volume)
		claims = append(claims, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: read claimed attempts: %w", err)
	}
	if len(claims) == 0 {
		return nil, nil
	}

	for _, c := range claims {
		tag, err := tx.Exec(ctx, `
			UPDATE node_executions
			SET status = 'leased',
			    ready_at = COALESCE(ready_at, now())
			WHERE id = $1::uuid AND status = 'ready' AND execution_location = 'worker'`,
			c.NodeExecutionID)
		if err != nil {
			return nil, fmt.Errorf("postgres: lease node execution %s: %w", c.NodeExecutionID, err)
		}
		if tag.RowsAffected() == 0 {
			// An attempt only exists for a ready worker-kind node; a
			// disagreement is data corruption, not a race to tolerate.
			return nil, fmt.Errorf("postgres: claimed attempt %s belongs to a node that is not ready", c.AttemptID)
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workers SET active_attempts = active_attempts + $2 WHERE id = $1::uuid`,
		workerID, len(claims)); err != nil {
		return nil, fmt.Errorf("postgres: account %d claims on worker %s: %w", len(claims), workerID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("postgres: commit claims: %w", err)
	}
	return claims, nil
}

// ------------------------------------------------------------------- fence

// runFenceSELECT locks the attempt row and returns its current triple and
// status. Every fenced write starts here — the row lock plus the
// in-transaction comparison is what makes "the dead owner's write cannot
// land even partially" true (ADR-0016 § 9, reused verbatim for attempts).
const runFenceSELECT = `
	SELECT worker_id::text, fencing_token, status
	FROM attempts WHERE id = $1::uuid FOR UPDATE`

func runCheckFence(ctx context.Context, tx pgx.Tx, c AttemptClaim, requireLive bool) error {
	var owner *string
	var token int64
	var status string
	err := tx.QueryRow(ctx, runFenceSELECT, c.AttemptID).Scan(&owner, &token, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return fmt.Errorf("postgres: fence attempt %s: %w", c.AttemptID, err)
	}
	if derefStr(owner) != c.WorkerID || token != c.FencingToken {
		return ErrLeaseLost
	}
	if requireLive && status != "leased" && status != "running" {
		return ErrLeaseLost
	}
	return nil
}

// runWithFencedTx runs fn inside a transaction that has proven the triple,
// committing on success.
func (s *RunStore) runWithFencedTx(ctx context.Context, c AttemptClaim, requireLive bool, fn func(context.Context, pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin fenced attempt tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := runCheckFence(ctx, tx, c, requireLive); err != nil {
		return err
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RenewAttemptLease extends the deadline strictly on the current triple.
// Zero affected rows is ErrLeaseLost. It also refreshes the paired turn's
// lease in the SAME statement set — ADR-0023 § 4's two-lease rule: "the
// attempt renewal renews the turn in the same statement, so a turn lease can
// never expire while its attempt is alive."
func (s *RunStore) RenewAttemptLease(ctx context.Context, c AttemptClaim) error {
	ttl := s.leaseTTL().Seconds()
	return s.runWithFencedTx(ctx, c, true, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE attempts
			SET lease_expires_at = now() + make_interval(secs => $4::double precision)
			WHERE id = $1 AND worker_id = $2 AND fencing_token = $3
			  AND status IN ('leased', 'running')`,
			c.AttemptID, c.WorkerID, c.FencingToken, ttl)
		if err != nil {
			return fmt.Errorf("postgres: renew attempt %s: %w", c.AttemptID, err)
		}
		if tag.RowsAffected() == 0 {
			return ErrLeaseLost
		}
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_turns
			SET lease_expires_at = now() + make_interval(secs => $2::double precision)
			WHERE node_attempt_id = $1 AND status IN ('leased', 'running')`,
			c.AttemptID, ttl); err != nil {
			return fmt.Errorf("postgres: renew paired turn for attempt %s: %w", c.AttemptID, err)
		}
		return nil
	})
}

// BeginAttempt moves the claimed attempt leased→running and appends its
// event under the fence (contract § 4 step 5's persistence half: verify
// already happened, this row is the durable record that work started).
func (s *RunStore) BeginAttempt(ctx context.Context, c AttemptClaim, event RunEvent) error {
	return s.runWithFencedTx(ctx, c, true, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE attempts SET status = 'running', started_at = COALESCE(started_at, now())
			WHERE id = $1`, c.AttemptID); err != nil {
			return fmt.Errorf("postgres: begin attempt %s: %w", c.AttemptID, err)
		}
		_, err := runAppendTx(ctx, tx, c.RunID, c.NodeExecutionID, c.AttemptID, event)
		return err
	})
}

// CancelRequested reports whether a cancel has been requested for this
// still-owned, non-terminal attempt (contract § 4 step 11's read on the
// renewal tick). No matching row means we are stale.
func (s *RunStore) CancelRequested(ctx context.Context, c AttemptClaim) (time.Time, bool, error) {
	var at *time.Time
	err := s.Pool.QueryRow(ctx, `
		SELECT cancel_requested_at FROM attempts
		WHERE id = $1 AND worker_id = $2 AND fencing_token = $3
		  AND status IN ('leased', 'running')`,
		c.AttemptID, c.WorkerID, c.FencingToken).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, ErrLeaseLost
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("postgres: read cancel flag attempt %s: %w", c.AttemptID, err)
	}
	if at == nil {
		return time.Time{}, false, nil
	}
	return *at, true, nil
}

// AttemptFinish is the boundary write (contract § 4 step 10): the attempt's
// terminal row, its node execution's mirror, the checkpoint record, and the
// events, all under one fence. Status must be terminal for the attempt; the
// vocabulary mirrors the CHECKs so a caller mistake names itself before
// Postgres sees it.
type AttemptFinish struct {
	Status          string // succeeded | failed | cancelled | interrupted
	ErrorClass      string
	Detail          string
	OutputErrors    json.RawMessage
	Outputs         json.RawMessage // required for succeeded (01 invariant 4)
	OutputsDigest   string
	ArtifactRefs    json.RawMessage
	NodeStatus      string // "" ⇒ mirror the attempt status (both enums share the names)
	NodeOutcome     string
	NodeFailedCause string
	Checkpoint      *NewCheckpoint
	Events          []RunEvent
	// CloseTurnReason names why an INTERRUPTED attempt stopped, and is the
	// reason carried into the paired turn's conversation.turn.interrupted after
	// the same M2 vocabulary mapping as before (a reason with no M2 word closes
	// the row only, because the wave that owns that vocabulary — ADR-0016 § 5's
	// takeover machinery — also owns its event). Every terminal write closes
	// its paired turn regardless of this field (closeAttemptTurnTx): the turn
	// must never outlive the attempt that owns it, in any arm.
	CloseTurnReason string
}

// FinishAttempt writes the honest terminal under the fence and decrements
// the owning worker's active_attempts in the same transaction — "decrement
// only after the attempt's terminal write commits" (contract § 4 step 1).
// A stale token returns ErrLeaseLost and lands NOTHING (12 case 3).
func (s *RunStore) FinishAttempt(ctx context.Context, c AttemptClaim, in AttemptFinish) error {
	switch in.Status {
	case "succeeded", "failed", "cancelled", "interrupted":
	default:
		return fmt.Errorf("postgres: %q is not a terminal attempt status", in.Status)
	}
	nodeStatus := in.NodeStatus
	if nodeStatus == "" {
		nodeStatus = in.Status
	}
	switch nodeStatus {
	case "succeeded", "failed", "cancelled", "interrupted":
	case "ready":
		// A failed or interrupted attempt returns its node to `ready` and the
		// ADVANCER decides retry vs terminal from rows (ADR-0023 § 5, reused
		// verbatim from the runtime engine's failLocked/Interrupt): a worker
		// terminal write must not silently terminalize the node. `ready`
		// therefore carries no finished_at — the node is not done.
	default:
		return fmt.Errorf("postgres: %q is not a node status an attempt close may write", nodeStatus)
	}
	return s.runWithFencedTx(ctx, c, true, func(ctx context.Context, tx pgx.Tx) error {
		if in.Status == "succeeded" && len(in.Outputs) == 0 {
			// attempts_succeeded_has_outputs: {} is a valid envelope, nil is not.
			return fmt.Errorf("postgres: cannot finish attempt %s succeeded without outputs", c.AttemptID)
		}
		if in.Status == "failed" && in.ErrorClass == "" {
			return fmt.Errorf("postgres: cannot finish attempt %s failed without an error_class", c.AttemptID)
		}
		if in.Status == "succeeded" && in.Outputs == nil {
			in.Outputs = json.RawMessage("{}")
		}
		if _, err := tx.Exec(ctx, `
			UPDATE attempts
			SET status = $2, finished_at = now(),
			    error_class    = NULLIF($3, ''),
			    detail         = LEFT(NULLIF($4, ''), 512),
			    output_errors  = COALESCE(NULLIF($5, '')::jsonb, '[]'::jsonb),
			    outputs        = COALESCE(NULLIF($6, '')::jsonb, outputs),
			    outputs_digest = NULLIF($7, ''),
			    artifact_refs  = COALESCE(NULLIF($8, '')::jsonb, artifact_refs)
			WHERE id = $1`,
			c.AttemptID, in.Status, in.ErrorClass, in.Detail, string(in.OutputErrors),
			string(in.Outputs), in.OutputsDigest, string(in.ArtifactRefs)); err != nil {
			return fmt.Errorf("postgres: finish attempt %s as %s: %w", c.AttemptID, in.Status, err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE node_executions
			SET status = $2,
			    finished_at = CASE WHEN $2 IN ('succeeded','failed','skipped',
			                                   'cancelled','interrupted')
			                       THEN now() ELSE finished_at END,
			    outcome = COALESCE(NULLIF($3, ''), outcome),
			    error_class = COALESCE(NULLIF($4, ''), error_class),
			    failed_cause = COALESCE(NULLIF($5, ''), failed_cause),
			    outputs = CASE WHEN $6::text <> '' THEN $6::jsonb ELSE outputs END,
			    artifact_refs = COALESCE(NULLIF($7, '')::jsonb, artifact_refs)
			WHERE id = $1::uuid`,
			c.NodeExecutionID, nodeStatus, in.NodeOutcome, in.ErrorClass, in.NodeFailedCause,
			string(in.Outputs), string(in.ArtifactRefs)); err != nil {
			return fmt.Errorf("postgres: close node execution %s as %s: %w", c.NodeExecutionID, nodeStatus, err)
		}
		if in.Checkpoint != nil {
			if err := s.insertCheckpointTx(ctx, tx, c, *in.Checkpoint); err != nil {
				return err
			}
		}
		// § 4 step 10 pairs with step 6's turn row and step 12's event: the
		// attempt's terminal row and its turn's terminal write are ONE
		// transaction, in every arm.
		if err := closeAttemptTurnTx(ctx, tx, c, in); err != nil {
			return err
		}
		// § 4 step 1: the slot the claim took comes back in THIS transaction,
		// never on a later tick — runCheckFence proved the attempt was
		// leased/running, so this is the transition's exactly-once release.
		if err := releaseWorkerSlotTx(ctx, tx, c.AttemptID); err != nil {
			return err
		}
		for _, ev := range in.Events {
			if _, err := runAppendTx(ctx, tx, c.RunID, c.NodeExecutionID, c.AttemptID, ev); err != nil {
				return err
			}
		}
		return nil
	})
}

// ------------------------------------------- worker capacity accounting

// attemptTerminalStatuses mirrors the attempts.status CHECK's terminal arm
// (contract § 1). A queued/leased/running attempt HOLDS one slot on its
// worker's capacity; a terminal one holds none — which is exactly what exit
// gates C3/C9a measure (`workers.active_attempts` must equal the ledger of
// non-terminal attempts per worker).
var attemptTerminalStatuses = map[string]bool{
	"succeeded": true, "failed": true, "cancelled": true, "interrupted": true,
}

// attemptStatusTerminal reports whether an attempt status releases capacity.
// The empty status and every non-terminal status answer false.
func attemptStatusTerminal(status string) bool { return attemptTerminalStatuses[status] }

// releaseWorkerSlotTx gives back the ONE capacity slot an attempt holds on its
// owning worker, inside the caller's transaction (ADR-0023 § 4 step 1: the
// decrement rides the attempt's terminal write). Every path that terminalizes an
// attempt owes this call — the worker's own boundary commit is only the common
// one; the reconciler's lease interrupt, a run cancel's cascade, a human
// takeover's hand-off and a control-plane failure all end the attempt's claim on
// the worker too. A slot that is never released permanently mutes the claim
// predicate `wr.active_attempts < wr.capacity` (runClaimPredicate above): the
// worker is online with free capacity in every operator's view and can never
// claim again.
//
// Exactly-once is the CALLER's proof, not this statement's: it only fires for a
// transition whose PREVIOUS status was non-terminal, which the fenced worker
// commit establishes under `FOR UPDATE` (runCheckFence refuses a terminal
// attempt) and the engine's write-back establishes against its hydration
// snapshot, taken under the run row lock. The `active_attempts > 0` guard is the
// backstop that keeps a mis-call from going negative (workers active_attempts
// CHECK), and a worker row that is already gone releases nothing.
//
// The worker is read from the attempt row itself, so the slot always goes back
// to the worker that was counted at claim time — never to a caller's memory of
// who owned the attempt.
func releaseWorkerSlotTx(ctx context.Context, tx pgx.Tx, attemptID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE workers w SET active_attempts = w.active_attempts - 1
		FROM attempts a
		WHERE a.id = $1::uuid AND w.id = a.worker_id AND w.active_attempts > 0`,
		attemptID); err != nil {
		return fmt.Errorf("postgres: release attempt slot for attempt %s: %w", attemptID, err)
	}
	return nil
}

// ---------------------------------------------------------- paired turn

// attemptTurnCloseShape is the paired turn's honest terminal write derived from
// the attempt's own terminal write: status, the stop_reason column value, and
// the conversation.turn.<terminal> event it owes (contract § 4 step 12).
type attemptTurnCloseShape struct {
	Status    string
	Stop      string // "" -> NULL (the DB forbids a stop reason on interrupted)
	EventType string
	Payload   any
	Journal   bool // false: close the row only, the vocabulary belongs elsewhere
}

// attemptTurnCloseFor maps an attempt terminal onto the turn terminal. The
// turn's status/stop-reason/event vocabulary is M2's (internal/events owns it);
// succeeded is the only rename (attempt 'succeeded' -> turn 'completed'). No
// caller carries the harness ACP stopReason across the attempt boundary
// (internal/worker attemptport.go's CompleteAttempt has no such parameter), so
// completed/failed/cancelled write a NULL stop_reason rather than inventing one
// — the CHECK only forbids a stop reason on 'interrupted'.
func attemptTurnCloseFor(c AttemptClaim, turnID, convID string, in AttemptFinish) attemptTurnCloseShape {
	switch in.Status {
	case "succeeded":
		return attemptTurnCloseShape{Status: events.TurnStatusCompleted, Journal: true,
			EventType: events.TypeConversationTurnCompleted,
			Payload: events.TurnCompletedPayload{
				ConversationID: convID, TurnID: turnID, WorkerID: c.WorkerID,
				FencingToken: c.FencingToken,
			}}
	case "failed":
		return attemptTurnCloseShape{Status: events.TurnStatusFailed, Journal: true,
			EventType: events.TypeConversationTurnFailed,
			Payload: events.TurnFailedPayload{
				ConversationID: convID, TurnID: turnID, WorkerID: c.WorkerID,
				FencingToken: c.FencingToken, Message: attemptBounded(in.Detail, 512),
			}}
	case "cancelled":
		return attemptTurnCloseShape{Status: events.TurnStatusCancelled, Journal: true,
			EventType: events.TypeConversationTurnCancelled,
			Payload: events.TurnCancelledPayload{
				ConversationID: convID, TurnID: turnID, WorkerID: c.WorkerID,
				FencingToken: c.FencingToken,
			}}
	default: // interrupted
		// § 4 step 12 pairs node.attempt.interrupted with
		// conversation.turn.interrupted in the SAME transaction. The reason
		// vocabulary is M2's closed set; a reason with no M2 word (e.g.
		// human_takeover, whose machinery journals its own pair) closes the row
		// only rather than forking the vocabulary.
		reason, ok := attemptTurnInterruptReason(in.CloseTurnReason)
		if !ok {
			return attemptTurnCloseShape{Status: events.TurnStatusInterrupted}
		}
		return attemptTurnCloseShape{Status: events.TurnStatusInterrupted, Journal: true,
			EventType: events.TypeConversationTurnInterrupted,
			Payload: events.TurnInterruptedPayload{
				ConversationID: convID, TurnID: turnID, WorkerID: c.WorkerID,
				FencingToken: c.FencingToken, Reason: reason,
			}}
	}
}

// closeAttemptTurnTx closes the attempt's paired non-terminal turn inside the
// SAME fenced transaction as the attempt's terminal row. A terminal attempt
// whose turn is still live is precisely the moment the retry enqueue refusal is
// manufactured: conversation_turns_one_active_idx rejects the next attempt's
// turn on the same conversation, and agentturn_seams.go's refusal names this
// writer as the debtor. There is therefore never an instant where the attempt is
// terminal and its turn is not.
//
// Only the turn stamped with this attempt's node_attempt_id is touched — a
// human turn on the same conversation belongs to M2's turn loop (TurnStore.
// FinishTurn), and an attempt with no paired turn (a non-agent node) is a no-op.
func closeAttemptTurnTx(ctx context.Context, tx pgx.Tx, c AttemptClaim, in AttemptFinish) error {
	var turnID, convID, turnOrg, turnProject string
	err := tx.QueryRow(ctx, `
		SELECT t.id::text, COALESCE(t.conversation_id::text, ''),
		       r.organization_id::text, r.project_id::text
		FROM conversation_turns t
		JOIN attempts a2 ON a2.id = t.node_attempt_id
		JOIN runs r ON r.id = a2.run_id
		WHERE t.node_attempt_id = $1::uuid AND t.status IN ('queued', 'leased', 'running')`,
		c.AttemptID).Scan(&turnID, &convID, &turnOrg, &turnProject)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil // no live paired turn: nothing to close and nothing to journal
	case err != nil:
		return fmt.Errorf("postgres: find paired turn for attempt %s: %w", c.AttemptID, err)
	}
	cl := attemptTurnCloseFor(c, turnID, convID, in)
	if _, err := tx.Exec(ctx, `
		UPDATE conversation_turns
		SET status = $2, finished_at = now(), stop_reason = NULLIF($3, '')
		WHERE id = $1::uuid`, turnID, cl.Status, cl.Stop); err != nil {
		return fmt.Errorf("postgres: close paired turn %s for attempt %s as %s: %w",
			turnID, c.AttemptID, cl.Status, err)
	}
	if !cl.Journal || convID == "" {
		return nil
	}
	_, err = trnAppendTx(ctx, tx, turnOrg, turnProject, convID, worker.TurnEvent{
		Type:      cl.EventType,
		ActorKind: events.ActorKindWorker,
		ActorID:   c.WorkerID,
		Payload:   cl.Payload,
	})
	return err
}

// ------------------------------------------------------------- checkpoints

// NewCheckpoint is D-009's durable boundary record (ADR-0023 § 6). Paths are
// not admitted anywhere in this shape: volume_id + workspace_id is M3's
// honest identity.
type NewCheckpoint struct {
	InputsDigest  string
	OutputsDigest string
	ArtifactRefs  json.RawMessage
	RepoStates    json.RawMessage
	WorkspaceID   string
	VolumeID      string
	PlanDigest    string
}

func (s *RunStore) insertCheckpointTx(ctx context.Context, tx pgx.Tx, c AttemptClaim, in NewCheckpoint) error {
	if in.VolumeID == "" {
		return fmt.Errorf("postgres: checkpoint without a volume_id is unrepresentable (D-024 is same-volume only)")
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO run_checkpoints
			(run_id, node_execution_id, attempt_id, inputs_digest, outputs_digest,
			 artifact_refs, repo_states, workspace_id, volume_id, worker_id, plan_digest)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
		        COALESCE(NULLIF($6, '')::jsonb, '[]'::jsonb),
		        COALESCE(NULLIF($7, '')::jsonb, '[]'::jsonb),
		        $8::uuid, $9, $10::uuid, $11)`,
		c.RunID, c.NodeExecutionID, c.AttemptID, in.InputsDigest, in.OutputsDigest,
		string(in.ArtifactRefs), string(in.RepoStates), in.WorkspaceID, in.VolumeID,
		c.WorkerID, in.PlanDigest)
	if err != nil {
		return fmt.Errorf("postgres: write checkpoint for attempt %s: %w", c.AttemptID, err)
	}
	return nil
}

// ListRunCheckpoints returns a run's boundary records (route 27's rows).
func (s *RunStore) ListRunCheckpoints(ctx context.Context, runID string) ([]CheckpointRecord, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT rc.node_execution_id::text, ne.node_instance_key, rc.attempt_id::text,
		       rc.inputs_digest, rc.outputs_digest, rc.artifact_refs, rc.repo_states,
		       rc.workspace_id::text, rc.volume_id, rc.worker_id::text, rc.plan_digest, rc.created_at
		FROM run_checkpoints rc
		JOIN node_executions ne ON ne.id = rc.node_execution_id
		WHERE rc.run_id = $1::uuid ORDER BY rc.created_at, rc.node_execution_id`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list checkpoints for run %s: %w", runID, err)
	}
	defer rows.Close()
	var out []CheckpointRecord
	for rows.Next() {
		var (
			cp          CheckpointRecord
			refs, repos []byte
		)
		if err := rows.Scan(&cp.NodeExecutionID, &cp.NodeInstanceKey, &cp.AttemptID,
			&cp.InputsDigest, &cp.OutputsDigest, &refs, &repos,
			&cp.WorkspaceID, &cp.VolumeID, &cp.WorkerID, &cp.PlanDigest, &cp.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan checkpoint: %w", err)
		}
		cp.ArtifactRefs, cp.RepoStates = refs, repos
		out = append(out, cp)
	}
	return out, rows.Err()
}

// CheckpointRecord is a read of one run_checkpoints row, joined with the
// node key it belongs to.
type CheckpointRecord struct {
	NodeExecutionID string
	NodeInstanceKey string
	AttemptID       string
	InputsDigest    string
	OutputsDigest   string
	ArtifactRefs    json.RawMessage
	RepoStates      json.RawMessage
	WorkspaceID     string
	VolumeID        string
	WorkerID        string
	PlanDigest      string
	CreatedAt       time.Time
}

// attemptTurnInterruptReason maps an attempt-level interrupt reason onto
// M2's closed conversation-turn reason vocabulary (internal/events owns that
// set; this store may not widen it). ok=false means "close the row, journal
// nothing": the reason belongs to a machinery that emits its own turn-side
// pair (ADR-0016 § 5's takeover), and inventing a reason word here would be
// a vocabulary fork, not a mapping.
func attemptTurnInterruptReason(reason string) (string, bool) {
	switch reason {
	case "worker_shutdown", "process_group_kill_timeout":
		return events.InterruptShutdown, true
	case "lease_expired":
		return events.InterruptLeaseExpired, true
	case "worker_gone":
		return events.InterruptWorkerGone, true
	default:
		return "", false
	}
}

// nullableTime maps a zero time.Time to SQL NULL.
func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
