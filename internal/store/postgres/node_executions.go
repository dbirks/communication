package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------- node rows

const runNodeColumns = `id, run_id, node_id, kind, node_instance_key, scope_key,
	execution_location, status, outputs, outcome, error_class, failed_cause,
	artifact_refs, depends_on, attempt_count, attempt_limit, in_flight,
	waiting_reason, created_at, ready_at, finished_at`

func (s *RunStore) scanNode(row pgx.Row) (NodeExecution, error) {
	var (
		n               NodeExecution
		outputs         []byte
		cause, outcome  *string
		errClass, wait  *string
		refs, depends   []byte
		ready, finished *time.Time
	)
	err := row.Scan(&n.ID, &n.RunID, &n.NodeID, &n.Kind, &n.NodeInstanceKey, &n.ScopeKey,
		&n.ExecutionLocation, &n.Status, &outputs, &outcome, &errClass, &cause,
		&refs, &depends, &n.AttemptCount, &n.AttemptLimit, &n.InFlight,
		&wait, &n.CreatedAt, &ready, &finished)
	if err != nil {
		return NodeExecution{}, err
	}
	n.Outputs = outputs
	n.Outcome, n.ErrorClass, n.FailedCause = derefStr(outcome), derefStr(errClass), derefStr(cause)
	n.WaitingReason = derefStr(wait)
	n.ArtifactRefs, n.DependsOn = refs, depends
	n.ReadyAt, n.FinishedAt = ready, finished
	return n, nil
}

// NewNodeExecution is the advancer's row-creation input. The key grammar and
// the two-path CHECK live in the schema; the store validates the vocabulary
// that would otherwise waste a round trip.
type NewNodeExecution struct {
	RunID             string
	NodeID            string
	Kind              string
	NodeInstanceKey   string
	ScopeKey          string // "" ⇒ '/'
	ExecutionLocation string // worker | control_plane
	DependsOn         json.RawMessage
	AttemptLimit      int // 0 ⇒ 1
}

// InsertNodeExecution creates a pending node execution (contract § 5.1: the
// advancer materializes rows; readiness is derived, never assumed). Two rows
// sharing one (run_id, node_instance_key) — the loop/fan-out identity of
// ADR-0023 § 1 — is ErrConflict.
func (s *RunStore) InsertNodeExecution(ctx context.Context, in NewNodeExecution) (NodeExecution, error) {
	if in.ExecutionLocation != "worker" && in.ExecutionLocation != "control_plane" {
		return NodeExecution{}, fmt.Errorf("postgres: unknown execution_location %q", in.ExecutionLocation)
	}
	scopeKey := in.ScopeKey
	if scopeKey == "" {
		scopeKey = "/"
	}
	attemptLimit := in.AttemptLimit
	if attemptLimit == 0 {
		attemptLimit = 1
	}
	n, err := s.scanNode(s.Pool.QueryRow(ctx, `
		INSERT INTO node_executions
			(run_id, node_id, kind, node_instance_key, scope_key, execution_location,
			 depends_on, attempt_limit)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, '')::jsonb, '[]'::jsonb), $8)
		RETURNING `+runNodeColumns,
		in.RunID, in.NodeID, in.Kind, in.NodeInstanceKey, scopeKey, in.ExecutionLocation,
		string(in.DependsOn), attemptLimit))
	if err != nil {
		if pipUniqueErr(err) != nil {
			return NodeExecution{}, ErrConflict // UNIQUE (run_id, node_instance_key)
		}
		return NodeExecution{}, fmt.Errorf("postgres: insert node execution %q in run %s: %w",
			in.NodeInstanceKey, in.RunID, err)
	}
	return n, nil
}

// GetNodeExecution reads one node execution by id.
func (s *RunStore) GetNodeExecution(ctx context.Context, id string) (NodeExecution, error) {
	n, err := s.scanNode(s.Pool.QueryRow(ctx, `
		SELECT `+runNodeColumns+` FROM node_executions WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return NodeExecution{}, ErrRunNotFound
	}
	if err != nil {
		return NodeExecution{}, fmt.Errorf("postgres: get node execution %s: %w", id, err)
	}
	return n, nil
}

// ListNodeExecutions returns a run's node executions in key order (route 24).
func (s *RunStore) ListNodeExecutions(ctx context.Context, runID string) ([]NodeExecution, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+runNodeColumns+` FROM node_executions
		WHERE run_id = $1::uuid ORDER BY node_instance_key, id`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list node executions for run %s: %w", runID, err)
	}
	defer rows.Close()
	var out []NodeExecution
	for rows.Next() {
		n, err := s.scanNode(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan node execution: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// NodeStatusInput is one advancer state move on a node execution. Terminal
// timestamps are the store's job (the CHECK is the backstop, not the plan);
// waiting_reason is cleared on leaving 'waiting' the same statement sets
// anything else, so a succeeded row cannot keep a stale reason.
type NodeStatusInput struct {
	Status        string
	Outputs       json.RawMessage
	Outcome       string
	ErrorClass    string
	FailedCause   string
	WaitingReason string
	ArtifactRefs  json.RawMessage
	Event         *RunEvent
}

var nodeTerminalStatuses = map[string]bool{
	"succeeded": true, "failed": true, "skipped": true, "cancelled": true, "interrupted": true,
}

// SetNodeStatus moves one node execution and appends its event in one
// transaction, under a row lock. Control-plane kinds run
// pending → ready → succeeded through here with no attempts row anywhere
// (ADR-0023 § 3); a control_plane row targeted at leased/running is refused
// here and by the CHECK, and refusing it here names the caller in the error.
func (s *RunStore) SetNodeStatus(ctx context.Context, nodeExecutionID string, in NodeStatusInput) (NodeExecution, error) {
	switch in.Status {
	case "pending", "ready", "leased", "running", "succeeded", "failed",
		"skipped", "waiting", "cancelled", "interrupted":
	default:
		return NodeExecution{}, fmt.Errorf("postgres: unknown node status %q", in.Status)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return NodeExecution{}, fmt.Errorf("postgres: begin node status tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	n, err := s.scanNode(tx.QueryRow(ctx, `
		SELECT `+runNodeColumns+` FROM node_executions WHERE id = $1::uuid FOR UPDATE`, nodeExecutionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return NodeExecution{}, ErrRunNotFound
	}
	if err != nil {
		return NodeExecution{}, fmt.Errorf("postgres: lock node execution %s: %w", nodeExecutionID, err)
	}
	if n.ExecutionLocation == "control_plane" && (in.Status == "leased" || in.Status == "running") {
		return NodeExecution{}, fmt.Errorf(
			"postgres: control-plane node %s (%s) cannot enter %s (node_executions_control_plane_never_leased)",
			nodeExecutionID, n.Kind, in.Status)
	}
	ready := "ready_at"
	if in.Status != "pending" {
		ready = "COALESCE(ready_at, now())"
	}
	finished := "finished_at"
	if nodeTerminalStatuses[in.Status] {
		finished = "now()"
	}
	clearWaiting := in.Status != "waiting"
	n, err = s.scanNode(tx.QueryRow(ctx, fmt.Sprintf(`
		UPDATE node_executions
		SET status = $2,
		    outputs        = CASE WHEN $3::text <> '' THEN $3::jsonb ELSE outputs END,
		    outcome        = COALESCE(NULLIF($4, ''), outcome),
		    error_class    = COALESCE(NULLIF($5, ''), error_class),
		    failed_cause   = COALESCE(NULLIF($6, ''), failed_cause),
		    waiting_reason = CASE WHEN $8::boolean THEN NULL ELSE NULLIF($7, '') END,
		    artifact_refs  = CASE WHEN $9::text <> '' THEN $9::jsonb ELSE artifact_refs END,
		    ready_at       = %s,
		    finished_at    = %s
		WHERE id = $1::uuid
		RETURNING `+runNodeColumns, ready, finished),
		nodeExecutionID, in.Status, string(in.Outputs), in.Outcome,
		in.ErrorClass, in.FailedCause, in.WaitingReason, clearWaiting,
		string(in.ArtifactRefs)))
	if err != nil {
		return NodeExecution{}, fmt.Errorf("postgres: set node %s status %s: %w", nodeExecutionID, in.Status, err)
	}
	if in.Event != nil {
		if _, err := runAppendTx(ctx, tx, n.RunID, n.ID, "", *in.Event); err != nil {
			return NodeExecution{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return NodeExecution{}, fmt.Errorf("postgres: commit node status: %w", err)
	}
	return n, nil
}

// SetNodeInFlight adjusts the fan-out counter (contract § 5.2:
// for_each.maxConcurrency is enforced by counting in-flight children in the
// advancer). The CHECK refuses a negative bookkeeping slip.
func (s *RunStore) SetNodeInFlight(ctx context.Context, nodeExecutionID string, delta int) (int, error) {
	var inFlight int
	err := s.Pool.QueryRow(ctx, `
		UPDATE node_executions SET in_flight = in_flight + $2
		WHERE id = $1::uuid RETURNING in_flight`, nodeExecutionID, delta).Scan(&inFlight)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrRunNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("postgres: adjust in_flight on node %s by %d: %w", nodeExecutionID, delta, err)
	}
	return inFlight, nil
}
