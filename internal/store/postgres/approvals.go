package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------- approvals

// Approval is a pipeline gate (ADR-0023 § 9). It is NOT permission_requests:
// different table, different authorizer (the project's designated approvers,
// at decision time), different CAS. The gate holds no worker and no lease —
// the run flips waiting_human while the row is pending.
type Approval struct {
	ID              string
	OrganizationID  string
	ProjectID       string
	RunID           string
	NodeExecutionID string
	Kind            string
	Summary         string
	ArtifactRefs    json.RawMessage
	ApproverRoles   []string
	ApproverUserIDs []string
	DeadlineAt      time.Time
	OnTimeout       string
	ReRequested     bool
	State           string // pending|decided|expired|cancelled|denied
	Decision        string // "" until decided; approved|rejected
	Comments        string
	DecidedBy       string
	DecidedAt       *time.Time
	Version         int
	CreatedAt       time.Time
}

const runApprovalColumns = `id, organization_id, project_id, run_id, node_execution_id,
	kind, summary, artifact_refs, approver_roles, approver_user_ids, deadline_at,
	on_timeout, re_requested, state, decision, comments, decided_by::text, decided_at,
	version, created_at`

func scanApproval(row pgx.Row) (Approval, error) {
	var (
		a         Approval
		refs      []byte
		decision  *string
		comments  *string
		decidedBy *string
		decidedAt *time.Time
		userIDs   []string
	)
	err := row.Scan(&a.ID, &a.OrganizationID, &a.ProjectID, &a.RunID, &a.NodeExecutionID,
		&a.Kind, &a.Summary, &refs, &a.ApproverRoles, &userIDs, &a.DeadlineAt,
		&a.OnTimeout, &a.ReRequested, &a.State, &decision, &comments, &decidedBy, &decidedAt,
		&a.Version, &a.CreatedAt)
	if err != nil {
		return Approval{}, err
	}
	a.ArtifactRefs = refs
	a.ApproverUserIDs = userIDs
	a.Decision, a.Comments = derefStr(decision), derefStr(comments)
	a.DecidedBy = derefStr(decidedBy)
	a.DecidedAt = decidedAt
	return a, nil
}

// NewApproval is the advancer's gate-creation input (contract § 5.3):
// human.approval moved ready → waiting, this row is inserted, and the run
// flips waiting_human — three writes the caller wraps in one transaction
// with InsertApprovalTx.
type NewApproval struct {
	OrganizationID  string
	ProjectID       string
	RunID           string
	NodeExecutionID string
	Summary         string
	ArtifactRefs    json.RawMessage
	ApproverRoles   []string
	ApproverUserIDs []string
	DeadlineAt      time.Time
	OnTimeout       string // fail|cancel_run|expire ("" ⇒ fail)
	ReRequested     bool   // the 'expire' arm's second request (exactly once)
}

// InsertApproval creates a pending gate. A second live gate on one node
// execution is ErrConflict (UNIQUE (node_execution_id), contract § 1's
// table row).
func (s *RunStore) InsertApproval(ctx context.Context, in NewApproval) (Approval, error) {
	var a Approval
	err := s.withRunLock(ctx, in.RunID, func(ctx context.Context, tx pgx.Tx, _ Run) error {
		var err error
		a, err = s.insertApprovalTx(ctx, tx, in)
		return err
	})
	return a, err
}

// insertApprovalTx is InsertApproval's statement, exported to callers'
// transactions so the gate insert, the node's ready→waiting move and the
// run's waiting_human flip share one commit (§ 5.3).
func (s *RunStore) insertApprovalTx(ctx context.Context, tx pgx.Tx, in NewApproval) (Approval, error) {
	onTimeout := in.OnTimeout
	if onTimeout == "" {
		onTimeout = "fail"
	}
	refs := string(in.ArtifactRefs)
	roles := in.ApproverRoles
	if roles == nil {
		roles = []string{}
	}
	userIDs := in.ApproverUserIDs
	if userIDs == nil {
		userIDs = []string{}
	}
	a, err := scanApproval(tx.QueryRow(ctx, `
		INSERT INTO approval_requests
			(organization_id, project_id, run_id, node_execution_id, summary, artifact_refs,
			 approver_roles, approver_user_ids, deadline_at, on_timeout, re_requested)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, COALESCE(NULLIF($6, '')::jsonb, '[]'::jsonb),
		        $7::text[], $8::uuid[], $9, $10, $11)
		RETURNING `+runApprovalColumns,
		in.OrganizationID, in.ProjectID, in.RunID, in.NodeExecutionID, in.Summary, refs,
		roles, userIDs, in.DeadlineAt, onTimeout, in.ReRequested))
	if err != nil {
		if pipUniqueErr(err) != nil {
			return Approval{}, ErrConflict // UNIQUE (node_execution_id)
		}
		return Approval{}, fmt.Errorf("postgres: insert approval for node %s: %w", in.NodeExecutionID, err)
	}
	return a, nil
}

// GetApproval reads one gate.
func (s *RunStore) GetApproval(ctx context.Context, id string) (Approval, error) {
	a, err := scanApproval(s.Pool.QueryRow(ctx, `
		SELECT `+runApprovalColumns+` FROM approval_requests WHERE id = $1::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrRunNotFound
	}
	if err != nil {
		return Approval{}, fmt.Errorf("postgres: get approval %s: %w", id, err)
	}
	return a, nil
}

// ListProjectApprovals returns a project's gates, pending first then newest
// decided (route 34's "needs attention" ordering).
func (s *RunStore) ListProjectApprovals(ctx context.Context, projectID string) ([]Approval, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT `+runApprovalColumns+` FROM approval_requests
		WHERE project_id = $1::uuid
		ORDER BY (state = 'pending') DESC, created_at DESC, id DESC`, projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list approvals for project %s: %w", projectID, err)
	}
	defer rows.Close()
	var out []Approval
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan approval: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DecideApproval is the CAS decision (route 36): state and version must both
// still say pending, or the loser gets ErrConflict and re-reads the winner
// (12 case 9's 409 arm — authorization is the API's decision-time check;
// this method only refuses the double-decide). decision is approved or
// rejected; a rejection is a business outcome, and the advancer turns it
// into outputs {decision: rejected} on the node (§ 5.3).
func (s *RunStore) DecideApproval(ctx context.Context, id, decision, comments string, expectedVersion int, decidedBy string, event *RunEvent) (Approval, error) {
	if decision != "approved" && decision != "rejected" {
		return Approval{}, fmt.Errorf("postgres: approval decision must be approved|rejected, got %q", decision)
	}
	var a Approval
	err := s.withApprovalLock(ctx, id, func(ctx context.Context, tx pgx.Tx, cur Approval) error {
		if cur.State != "pending" || cur.Version != expectedVersion {
			a = cur // the winner, for the caller's 409 body
			return ErrConflict
		}
		var err error
		a, err = scanApproval(tx.QueryRow(ctx, `
			UPDATE approval_requests
			SET state = 'decided', decision = $2, comments = NULLIF($3, ''),
			    decided_by = $4::uuid, decided_at = now(), version = version + 1
			WHERE id = $1::uuid AND state = 'pending' AND version = $5
			RETURNING `+runApprovalColumns,
			id, decision, comments, decidedBy, expectedVersion))
		if errors.Is(err, pgx.ErrNoRows) {
			a = cur
			return ErrConflict
		}
		if err != nil {
			return fmt.Errorf("postgres: decide approval %s: %w", id, err)
		}
		if event != nil {
			_, err = runAppendTx(ctx, tx, a.RunID, a.NodeExecutionID, "", *event)
		}
		return err
	})
	return a, err
}

// DenyApproval records the refusal arm (approval.denied: the caller was not
// a designated approver or lost access). Per approvals_decided_consistency a
// denial carries NO decision — that is what separates 403/409 from an
// approved/rejected outcome downstream.
func (s *RunStore) DenyApproval(ctx context.Context, id string, expectedVersion int, decidedBy string, event *RunEvent) (Approval, error) {
	var a Approval
	err := s.withApprovalLock(ctx, id, func(ctx context.Context, tx pgx.Tx, cur Approval) error {
		if cur.State != "pending" || cur.Version != expectedVersion {
			a = cur
			return ErrConflict
		}
		var err error
		a, err = scanApproval(tx.QueryRow(ctx, `
			UPDATE approval_requests
			SET state = 'denied', decided_by = $2::uuid, decided_at = now(), version = version + 1
			WHERE id = $1::uuid AND state = 'pending' AND version = $3
			RETURNING `+runApprovalColumns,
			id, decidedBy, expectedVersion))
		if errors.Is(err, pgx.ErrNoRows) {
			a = cur
			return ErrConflict
		}
		if err != nil {
			return fmt.Errorf("postgres: deny approval %s: %w", id, err)
		}
		if event != nil {
			_, err = runAppendTx(ctx, tx, a.RunID, a.NodeExecutionID, "", *event)
		}
		return err
	})
	return a, err
}

// CloseApproval expires or cancels a still-pending gate (reconciler pass 2
// and the advancer's cancellation cascade). Per the CHECK, neither arm may
// carry a decision or a decided_at.
func (s *RunStore) CloseApproval(ctx context.Context, id, state string, event *RunEvent) (Approval, error) {
	if state != "expired" && state != "cancelled" {
		return Approval{}, fmt.Errorf("postgres: CloseApproval cannot close as %q", state)
	}
	var a Approval
	err := s.withApprovalLock(ctx, id, func(ctx context.Context, tx pgx.Tx, cur Approval) error {
		if cur.State != "pending" {
			a = cur
			return ErrConflict
		}
		var err error
		a, err = scanApproval(tx.QueryRow(ctx, `
			UPDATE approval_requests SET state = $2, version = version + 1
			WHERE id = $1::uuid AND state = 'pending'
			RETURNING `+runApprovalColumns, id, state))
		if err != nil {
			return fmt.Errorf("postgres: close approval %s as %s: %w", id, state, err)
		}
		if event != nil {
			_, err = runAppendTx(ctx, tx, a.RunID, a.NodeExecutionID, "", *event)
		}
		return err
	})
	return a, err
}

func (s *RunStore) withApprovalLock(ctx context.Context, id string, fn func(context.Context, pgx.Tx, Approval) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin approval tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cur, err := scanApproval(tx.QueryRow(ctx, `
		SELECT `+runApprovalColumns+` FROM approval_requests WHERE id = $1::uuid FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRunNotFound
	}
	if err != nil {
		return fmt.Errorf("postgres: lock approval %s: %w", id, err)
	}
	if err := fn(ctx, tx, cur); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ------------------------------------------------------------- invocations

// InvocationRecord is one pipeline_invocations row: the parent run's node
// execution, its child, and the revision resolved at run start — never
// re-resolved mid-flight (12 case 11's child-side twin).
type InvocationRecord struct {
	ID                 string
	RunID              string
	NodeExecutionID    string
	ChildRunID         string
	ChildProjectID     string
	PipelineID         string
	ResolvedRevisionID string
	WaitPolicy         string
	Depth              int
	CreatedAt          time.Time
}

// NewInvocation is InsertInvocation's input.
type NewInvocation struct {
	RunID              string
	NodeExecutionID    string
	ChildRunID         string
	ChildProjectID     string
	PipelineID         string
	ResolvedRevisionID string
	WaitPolicy         string // "" ⇒ completion
	Depth              int    // 1 or 2; the CHECK refuses anything else
}

// InsertInvocation books a parent→child run relationship. One node execution
// spawning two children, or two invocations sharing a child, is ErrConflict;
// a self-invocation is refused in Go before the CHECK ever has to speak.
func (s *RunStore) InsertInvocation(ctx context.Context, in NewInvocation) (InvocationRecord, error) {
	if in.ChildRunID == in.RunID {
		return InvocationRecord{}, fmt.Errorf("postgres: a run cannot invoke itself (pipeline_invocations_child_is_not_self)")
	}
	waitPolicy := in.WaitPolicy
	if waitPolicy == "" {
		waitPolicy = "completion"
	}
	var rec InvocationRecord
	err := s.withRunLock(ctx, in.RunID, func(ctx context.Context, tx pgx.Tx, _ Run) error {
		return tx.QueryRow(ctx, `
			INSERT INTO pipeline_invocations
				(run_id, node_execution_id, child_run_id, child_project_id, pipeline_id,
				 resolved_revision_id, wait_policy, depth)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8)
			RETURNING id::text, run_id::text, node_execution_id::text, child_run_id::text,
			          child_project_id::text, pipeline_id::text, resolved_revision_id::text,
			          wait_policy, depth, created_at`,
			in.RunID, in.NodeExecutionID, in.ChildRunID, in.ChildProjectID, in.PipelineID,
			in.ResolvedRevisionID, waitPolicy, in.Depth).
			Scan(&rec.ID, &rec.RunID, &rec.NodeExecutionID, &rec.ChildRunID,
				&rec.ChildProjectID, &rec.PipelineID, &rec.ResolvedRevisionID,
				&rec.WaitPolicy, &rec.Depth, &rec.CreatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return InvocationRecord{}, ErrRunNotFound
	}
	if pipUniqueErr(err) != nil {
		return InvocationRecord{}, ErrConflict
	}
	if err != nil {
		return InvocationRecord{}, fmt.Errorf("postgres: insert invocation run=%s node=%s: %w",
			in.RunID, in.NodeExecutionID, err)
	}
	return rec, nil
}

// ListRunInvocations returns a run's child-run bookkeeping (route 26's
// join input).
func (s *RunStore) ListRunInvocations(ctx context.Context, runID string) ([]InvocationRecord, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text, run_id::text, node_execution_id::text, child_run_id::text,
		       child_project_id::text, pipeline_id::text, resolved_revision_id::text,
		       wait_policy, depth, created_at
		FROM pipeline_invocations WHERE run_id = $1::uuid ORDER BY created_at, id`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list invocations for run %s: %w", runID, err)
	}
	defer rows.Close()
	var out []InvocationRecord
	for rows.Next() {
		var rec InvocationRecord
		if err := rows.Scan(&rec.ID, &rec.RunID, &rec.NodeExecutionID, &rec.ChildRunID,
			&rec.ChildProjectID, &rec.PipelineID, &rec.ResolvedRevisionID,
			&rec.WaitPolicy, &rec.Depth, &rec.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan invocation: %w", err)
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}
