package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// TurnStore is the execution worker's persistence face: the fenced claim /
// lease / transcript / permission / binding writes of ADR-0016 §3–§5. It
// implements worker.TurnStore; every turn-scoped write takes a FOR UPDATE
// row lock on the turn first and fails worker.ErrLeaseLost unless
// (turn, worker, fencing token) is the current triple, with the journal
// append in the same transaction — a stale owner cannot land even a partial
// write (ADR-0016 §9 obligation 2, "fail closed").
//
// The worker's journal INSERT lives here (trnAppendTx) rather than reusing
// AppendEvent because it must also set conversation_id — the transcript is
// this journal scoped to a conversation (ADR-0016), and the append path
// here is the one the conversation stream reads.
type TurnStore struct {
	Pool *pgxpool.Pool

	// LeaseTTL is the lease this store hands out at claim time; zero uses
	// worker.DefaultLeaseTTL (30 s, ADR-0016 §3).
	LeaseTTL time.Duration
}

var _ worker.TurnStore = (*TurnStore)(nil)

// trnErrStaleLease is the internal alias: every rejection paths back to
// worker.ErrLeaseLost so the loop has one error to branch on.
var trnErrStaleLease = worker.ErrLeaseLost

// trnClaimSQL is the claim statement ADR-0016 §3 pins verbatim (mirrored and
// exercised by migrate_test.go's migClaimSQL): FOR UPDATE SKIP LOCKED over
// queued turns, affinity through the live binding, fencing token drawn from
// the sequence at claim time.
const trnClaimSQL = `
	UPDATE conversation_turns t
	SET status = 'leased',
	    worker_id = w.worker_id,
	    lease_expires_at = now() + make_interval(secs => $2::double precision),
	    fencing_token = nextval('conversation_turn_fencing_seq')
	FROM (
		SELECT c.id AS conversation_id, t2.id AS turn_id, $1::uuid AS worker_id
		FROM conversation_turns t2
		JOIN conversations c ON c.id = t2.conversation_id
		LEFT JOIN acp_session_bindings b
		       ON b.conversation_id = c.id AND b.status = 'connected'
		WHERE t2.status = 'queued'
		  AND c.status <> 'archived'
		  AND (b.worker_id IS NULL OR b.worker_id = $1::uuid)
		ORDER BY t2.created_at, t2.id
		FOR UPDATE OF t2 SKIP LOCKED
		LIMIT 1
	) w
	WHERE t.id = w.turn_id
	RETURNING t.id, t.conversation_id, t.worker_id, t.fencing_token`

// ClaimTurn wins at most one queued turn for workerID. The detail read is a
// second statement: the claim itself is the pinned single statement, and
// what it describes (prompt, profile, project) cannot change while we hold
// the lease.
func (s *TurnStore) ClaimTurn(ctx context.Context, workerID string) (worker.Claim, bool, error) {
	ttl := s.LeaseTTL
	if ttl <= 0 {
		ttl = worker.DefaultLeaseTTL
	}
	var (
		c            worker.Claim
		turnID       string
		conversation string
		owner        string
	)
	err := s.Pool.QueryRow(ctx, trnClaimSQL, workerID, ttl.Seconds()).
		Scan(&turnID, &conversation, &owner, &c.FencingToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.Claim{}, false, nil
	}
	if err != nil {
		return worker.Claim{}, false, fmt.Errorf("postgres: claim turn: %w", err)
	}
	c.TurnID, c.ConversationID, c.WorkerID = turnID, conversation, owner

	err = s.Pool.QueryRow(ctx, `
		SELECT t.prompt, t.submitted_by::text, c.project_id::text, p.organization_id::text,
		       ap.launcher_id, ap.permission_mode
		FROM conversation_turns t
		JOIN conversations c ON c.id = t.conversation_id
		JOIN projects p ON p.id = c.project_id
		JOIN agent_profiles ap ON ap.id = c.agent_profile_id
		WHERE t.id = $1`, turnID).
		Scan(&c.Prompt, &c.SubmittedBy, &c.ProjectID, &c.OrganizationID, &c.LauncherID, &c.PermissionMode)
	if err != nil {
		return worker.Claim{}, false, fmt.Errorf("postgres: read claimed turn %s: %w", turnID, err)
	}
	return c, true, nil
}

// trnFenceSELECT locks the turn row and returns its current lease triple
// and status. Every fenced write starts here: the row lock plus the
// in-transaction comparison is what makes "the dead owner's write cannot
// land even partially" true.
const trnFenceSELECT = `
	SELECT worker_id::text, fencing_token, status
	FROM conversation_turns WHERE id = $1::uuid FOR UPDATE`

// trnCheckFence locks the turn and verifies the triple. whenNonTerminal
// additionally requires leased/running (transcript and lifecycle writes);
// lease checks against a terminal row are the double-finish case and are
// rejected the same way — the writer is no longer speaking for this turn.
func trnCheckFence(ctx context.Context, tx pgx.Tx, c worker.Claim) error {
	var owner string
	var token int64
	var status string
	err := tx.QueryRow(ctx, trnFenceSELECT, c.TurnID).Scan(&owner, &token, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return trnErrStaleLease
	}
	if err != nil {
		return fmt.Errorf("postgres: fence turn %s: %w", c.TurnID, err)
	}
	if owner != c.WorkerID || token != c.FencingToken {
		return trnErrStaleLease
	}
	if status != events.TurnStatusLeased && status != events.TurnStatusRunning {
		return trnErrStaleLease
	}
	return nil
}

// trnWithFencedTx runs fn inside a transaction that has already proven the
// lease triple, committing on success.
func (s *TurnStore) trnWithFencedTx(ctx context.Context, c worker.Claim, fn func(ctx context.Context, tx pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin fenced turn tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := trnCheckFence(ctx, tx, c); err != nil {
		return err
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit fenced turn tx: %w", err)
	}
	return nil
}

// RenewLease extends the deadline strictly on the current triple. Zero
// affected rows is ErrLeaseLost: "the worker lost the turn and must stop
// writing, not renew harder" (ADR-0016 §3). It also refreshes the live
// binding's last_seen_at so liveness of the session travels with the lease.
func (s *TurnStore) RenewLease(ctx context.Context, c worker.Claim) error {
	ttl := s.LeaseTTL
	if ttl <= 0 {
		ttl = worker.DefaultLeaseTTL
	}
	return s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE conversation_turns
			SET lease_expires_at = now() + make_interval(secs => $4::double precision)
			WHERE id = $1 AND worker_id = $2 AND fencing_token = $3
			  AND status IN ('leased', 'running')`,
			c.TurnID, c.WorkerID, c.FencingToken, ttl.Seconds())
		if err != nil {
			return fmt.Errorf("postgres: renew lease turn %s: %w", c.TurnID, err)
		}
		if tag.RowsAffected() == 0 {
			return trnErrStaleLease
		}
		_, err = tx.Exec(ctx, `
			UPDATE acp_session_bindings SET last_seen_at = now()
			WHERE conversation_id = (SELECT conversation_id FROM conversation_turns WHERE id = $1)
			  AND worker_id = $2 AND status = 'connected'`, c.TurnID, c.WorkerID)
		if err != nil {
			return fmt.Errorf("postgres: touch binding for turn %s: %w", c.TurnID, err)
		}
		return nil
	})
}

// BeginTurn moves the claimed turn leased→running and appends
// conversation.turn.started under the fence.
//
// It deliberately does NOT append conversation.message.user. That row belongs
// to the enqueue transaction in the control plane
// (CnvStore.PostMessage/CreateConversation), which is what makes ADR-0016 §7's
// "the transcript and the queued work can never disagree" literally true: one
// prompt, one user row, written with the turn itself. An append here produced
// a second copy of every prompt in the transcript, and in the wrong order —
// turn.started landed before the user's own message (observed in the integrated
// M2 lab run, 2026-10-15).
func (s *TurnStore) BeginTurn(ctx context.Context, c worker.Claim, bindingID string, sess domain.SessionInfo) error {
	return s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_turns
			SET status = 'running', started_at = COALESCE(started_at, now())
			WHERE id = $1`, c.TurnID); err != nil {
			return fmt.Errorf("postgres: mark turn running %s: %w", c.TurnID, err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE conversations SET status = 'active', updated_at = now()
			WHERE id = $1 AND status <> 'archived'`, c.ConversationID); err != nil {
			return fmt.Errorf("postgres: activate conversation %s: %w", c.ConversationID, err)
		}
		_, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
			Type:      events.TypeConversationTurnStarted,
			ActorKind: events.ActorKindWorker,
			ActorID:   c.WorkerID,
			Payload: events.TurnStartedPayload{
				ConversationID: c.ConversationID,
				TurnID:         c.TurnID,
				WorkerID:       c.WorkerID,
				FencingToken:   c.FencingToken,
				BindingID:      bindingID,
				ACPSessionID:   sess.ACPSessionID,
				SessionOrigin:  orDefaultStr(sess.Origin, events.SessionOriginNew),
			},
		})
		return err
	})
}

// AppendTurnEvent is the fenced transcript append every worker-side event
// for a turn goes through (tool calls, coalesced agent text, terminal
// markers written by the caller).
func (s *TurnStore) AppendTurnEvent(ctx context.Context, c worker.Claim, ev worker.TurnEvent) error {
	return s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		_, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, ev)
		return err
	})
}

// WorkspaceEvent appends a workspace- or sandbox-scoped event on this turn's
// fence. It is AppendTurnEvent with a name that says what the subject is: the
// payloads (workspace.prepared, sandbox.verified, …) describe a workspace and a
// policy rather than a transcript line, and the distinction is why the loop has
// two calls. Both are fenced, because every one of them reports a security fact
// about a run and an unfenced append is how a stale worker gets to lie about
// having sandboxed something.
//
// The fence is the owner+token pair, not the turn's status: capture-side
// events (workspace.committed, and the permission stragglers) legitimately
// arrive *after* the terminal write — that is D9's ordering, so a capture
// failure can never erase the fact that a turn happened. A lease stolen by a
// re-claim rotates the token, so the triple-only check still refuses the one
// writer it exists to refuse; requiring a non-terminal status here would make
// workspace.committed unjournalable by construction (deviation D24 says these
// appends "can legitimately be written after the turn has reached its terminal
// state" — this is that promise, kept).
func (s *TurnStore) WorkspaceEvent(ctx context.Context, c worker.Claim, ev worker.TurnEvent) error {
	return s.trnWithFenceTripleTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		_, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, ev)
		return err
	})
}

// AppendConversationEvent appends a conversation-scoped event that belongs
// to no in-flight turn (agent.session.connected/disconnected). Scope (org,
// project) is resolved from the conversation itself, so a caller cannot
// forge one; fencing does not apply because these rows are not turn-scoped
// writes (ADR-0016 §9 obligation 2 names turn writes and turn appends).
func (s *TurnStore) AppendConversationEvent(ctx context.Context, conversationID string, ev worker.TurnEvent) error {
	var projectID, orgID string
	if err := s.Pool.QueryRow(ctx, `
		SELECT c.project_id::text, p.organization_id::text
		FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
		conversationID).Scan(&projectID, &orgID); err != nil {
		return fmt.Errorf("postgres: resolve conversation %s scope: %w", conversationID, err)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin conversation event tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := trnAppendTx(ctx, tx, orgID, projectID, conversationID, ev); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CancelRequested reports whether a cancel has been requested for this
// still-owned, non-terminal turn. No matching row means we are stale.
func (s *TurnStore) CancelRequested(ctx context.Context, c worker.Claim) (time.Time, bool, error) {
	var at *time.Time
	err := s.Pool.QueryRow(ctx, `
		SELECT cancel_requested_at FROM conversation_turns
		WHERE id = $1 AND worker_id = $2 AND fencing_token = $3
		  AND status IN ('leased', 'running')`,
		c.TurnID, c.WorkerID, c.FencingToken).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, trnErrStaleLease
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("postgres: read cancel flag turn %s: %w", c.TurnID, err)
	}
	if at == nil {
		return time.Time{}, false, nil
	}
	return *at, true, nil
}

// ControllerUser reads the current human controller (for cancelled-by
// attribution; "" when control is held by none).
func (s *TurnStore) ControllerUser(ctx context.Context, conversationID string) (string, bool, error) {
	var uid *string
	err := s.Pool.QueryRow(ctx, `
		SELECT controller_user_id::text FROM conversation_control WHERE conversation_id = $1`,
		conversationID).Scan(&uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("postgres: read control for %s: %w", conversationID, err)
	}
	if uid == nil {
		return "", true, nil
	}
	return *uid, true, nil
}

// FinishTurn writes the terminal row and exactly one terminal event, both
// under the fence. interrupted carries a reason and no stop reason (the DB
// enforces the pairing; a wrong combination here is a bug report, not a
// retry).
func (s *TurnStore) FinishTurn(ctx context.Context, c worker.Claim, o worker.TurnOutcome) error {
	eventType, payload, stop, err := trnTerminal(c, o)
	if err != nil {
		return err
	}
	return s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE conversation_turns
			SET status = $2, finished_at = now(), stop_reason = NULLIF($3, '')
			WHERE id = $1`, c.TurnID, o.Status, stop); err != nil {
			return fmt.Errorf("postgres: finish turn %s as %s: %w", c.TurnID, o.Status, err)
		}
		_, err := trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
			Type:      eventType,
			ActorKind: events.ActorKindWorker,
			ActorID:   c.WorkerID,
			Payload:   payload,
		})
		return err
	})
}

// trnTerminal validates an outcome against the vocabulary and builds its
// event payload.
func trnTerminal(c worker.Claim, o worker.TurnOutcome) (string, any, string, error) {
	switch o.Status {
	case events.TurnStatusCompleted:
		return events.TypeConversationTurnCompleted, events.TurnCompletedPayload{
			ConversationID: c.ConversationID, TurnID: c.TurnID, WorkerID: c.WorkerID,
			FencingToken: c.FencingToken, StopReason: o.StopReason,
		}, o.StopReason, nil
	case events.TurnStatusCancelled:
		return events.TypeConversationTurnCancelled, events.TurnCancelledPayload{
			ConversationID: c.ConversationID, TurnID: c.TurnID, WorkerID: c.WorkerID,
			FencingToken: c.FencingToken, StopReason: o.StopReason, RequestedBy: o.RequestedBy,
		}, o.StopReason, nil
	case events.TurnStatusFailed:
		return events.TypeConversationTurnFailed, events.TurnFailedPayload{
			ConversationID: c.ConversationID, TurnID: c.TurnID, WorkerID: c.WorkerID,
			FencingToken: c.FencingToken, StopReason: o.StopReason, Message: o.Message,
		}, o.StopReason, nil
	case events.TurnStatusInterrupted:
		reason := o.Reason
		if reason == "" {
			reason = events.InterruptShutdown
		}
		if !events.ValidInterruptReason(reason) {
			return "", nil, "", fmt.Errorf("postgres: unknown interrupt reason %q", reason)
		}
		return events.TypeConversationTurnInterrupted, events.TurnInterruptedPayload{
			ConversationID: c.ConversationID, TurnID: c.TurnID, WorkerID: c.WorkerID,
			FencingToken: c.FencingToken, Reason: reason,
		}, "", nil // interrupted never borrows a stop reason
	default:
		return "", nil, "", fmt.Errorf("postgres: %q is not a terminal turn status", o.Status)
	}
}

// ---------------------------------------------------------------- permission

// OpenPermission inserts a pending prompt and appends
// conversation.permission.requested under the fence.
func (s *TurnStore) OpenPermission(ctx context.Context, c worker.Claim, p worker.PermissionOpen) (string, error) {
	options, err := json.Marshal(p.Options)
	if err != nil {
		return "", fmt.Errorf("postgres: encode permission options: %w", err)
	}
	var id string
	err = s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO permission_requests
				(conversation_id, turn_id, acp_request_id, tool_call_id, tool_title, tool_kind, options, deadline_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7::jsonb, $8)
			RETURNING id::text`,
			c.ConversationID, c.TurnID, p.ACPRequestID, p.ToolCallID, p.Title, p.Kind, options, p.Deadline).
			Scan(&id)
		if err != nil {
			return fmt.Errorf("postgres: open permission turn %s: %w", c.TurnID, err)
		}
		deadline := ""
		if !p.Deadline.IsZero() {
			deadline = p.Deadline.UTC().Format(time.RFC3339)
		}
		_, err = trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
			Type:      events.TypeConversationPermissionRequested,
			ActorKind: events.ActorKindWorker,
			ActorID:   c.WorkerID,
			Payload: events.PermissionRequestedPayload{
				ConversationID:      c.ConversationID,
				TurnID:              c.TurnID,
				PermissionRequestID: id,
				ToolCallID:          p.ToolCallID,
				Title:               p.Title,
				Kind:                p.Kind,
				Options:             p.Options,
				DeadlineAt:          deadline,
			},
		})
		return err
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

// PermissionState reads a prompt's durable answer. Reads are unfenced by
// design: observing a decision cannot corrupt state (only writes fence).
func (s *TurnStore) PermissionState(ctx context.Context, permissionID string) (worker.PermissionState, error) {
	var st worker.PermissionState
	var optionID, decidedBy *string
	err := s.Pool.QueryRow(ctx, `
		SELECT status, decision_option_id, decided_by::text FROM permission_requests WHERE id = $1`,
		permissionID).Scan(&st.Status, &optionID, &decidedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, fmt.Errorf("postgres: permission %s: %w", permissionID, ErrNotFound)
	}
	if err != nil {
		return st, fmt.Errorf("postgres: read permission %s: %w", permissionID, err)
	}
	if optionID != nil {
		st.OptionID = *optionID
	}
	if decidedBy != nil {
		st.DecidedBy = *decidedBy
	}
	return st, nil
}

// ClosePermission expires or cancels a still-pending prompt and appends the
// decided event. A row the API already decided is returned as-is, never
// rewritten (the decision is durable before it is live, ADR-0016 §5). The
// fence triple must still match even on a terminal turn (a prompt can close
// after the turn ended).
func (s *TurnStore) ClosePermission(ctx context.Context, c worker.Claim, permissionID, status string) (worker.PermissionState, bool, error) {
	if status != events.PermissionStatusExpired && status != events.PermissionStatusCancelled {
		return worker.PermissionState{}, false, fmt.Errorf("postgres: ClosePermission cannot close as %q", status)
	}
	var closed bool
	var final worker.PermissionState
	err := s.trnWithFenceTripleTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		var st string
		var optionID, decidedBy *string
		err := tx.QueryRow(ctx, `
			UPDATE permission_requests SET status = $2, decided_at = now()
			WHERE id = $1 AND status = 'pending'
			RETURNING status`, permissionID, status).Scan(&st)
		if errors.Is(err, pgx.ErrNoRows) {
			// Someone else closed it — read what they wrote.
			err := tx.QueryRow(ctx, `
				SELECT status, decision_option_id, decided_by::text FROM permission_requests WHERE id = $1`,
				permissionID).Scan(&st, &optionID, &decidedBy)
			if err != nil {
				return fmt.Errorf("postgres: read permission %s: %w", permissionID, err)
			}
			final = trnPermState(st, optionID, decidedBy)
			return nil
		}
		if err != nil {
			return fmt.Errorf("postgres: close permission %s: %w", permissionID, err)
		}
		closed = true
		final = worker.PermissionState{Status: status}
		_, err = trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
			Type:      events.TypeConversationPermissionDecided,
			ActorKind: events.ActorKindWorker,
			ActorID:   c.WorkerID,
			Payload: events.PermissionDecidedPayload{
				ConversationID:      c.ConversationID,
				TurnID:              c.TurnID,
				PermissionRequestID: permissionID,
				Status:              status,
			},
		})
		return err
	})
	if err != nil {
		return worker.PermissionState{}, false, err
	}
	return final, closed, nil
}

func trnPermState(status string, optionID, decidedBy *string) worker.PermissionState {
	st := worker.PermissionState{Status: status}
	if optionID != nil {
		st.OptionID = *optionID
	}
	if decidedBy != nil {
		st.DecidedBy = *decidedBy
	}
	return st
}

// DecidePermissionByPolicy records a still-pending prompt as `decided` by the
// turn's permission policy (ADR-0039 Option A): the row carries
// decided_by_kind='policy', decided_by_policy (the profile's recorded mode)
// and the chosen option, and conversation.permission.decided is journalled
// with the policy named as the decider. Modelled on ClosePermission: a row
// the API already decided is returned as-is, never rewritten (the decision
// is durable before it is live, ADR-0016 §5), and the fence triple must still
// match even on a terminal turn (a prompt can close after the turn ended).
func (s *TurnStore) DecidePermissionByPolicy(ctx context.Context, c worker.Claim, permissionID, optionID, policy string) (worker.PermissionState, bool, error) {
	if policy == "" {
		return worker.PermissionState{}, false, fmt.Errorf("postgres: DecidePermissionByPolicy requires a policy name")
	}
	var closed bool
	var final worker.PermissionState
	decidedBy := "profile_policy:" + policy
	err := s.trnWithFenceTripleTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		var st string
		var readOption, readDecidedBy *string
		err := tx.QueryRow(ctx, `
			UPDATE permission_requests
			SET status = 'decided', decision_option_id = $2,
			    decided_by_kind = 'policy', decided_by_policy = $3, decided_at = now()
			WHERE id = $1 AND status = 'pending'
			RETURNING status`, permissionID, optionID, policy).Scan(&st)
		if errors.Is(err, pgx.ErrNoRows) {
			// Someone else closed it — read what they wrote.
			err := tx.QueryRow(ctx, `
				SELECT status, decision_option_id, decided_by::text FROM permission_requests WHERE id = $1`,
				permissionID).Scan(&st, &readOption, &readDecidedBy)
			if err != nil {
				return fmt.Errorf("postgres: read permission %s: %w", permissionID, err)
			}
			final = trnPermState(st, readOption, readDecidedBy)
			return nil
		}
		if err != nil {
			return fmt.Errorf("postgres: decide permission %s: %w", permissionID, err)
		}
		closed = true
		final = worker.PermissionState{Status: events.PermissionStatusDecided, OptionID: optionID, DecidedBy: decidedBy}
		_, err = trnAppendTx(ctx, tx, c.OrganizationID, c.ProjectID, c.ConversationID, worker.TurnEvent{
			Type:      events.TypeConversationPermissionDecided,
			ActorKind: events.ActorKindWorker,
			ActorID:   c.WorkerID,
			Payload: events.PermissionDecidedPayload{
				ConversationID:      c.ConversationID,
				TurnID:              c.TurnID,
				PermissionRequestID: permissionID,
				Status:              events.PermissionStatusDecided,
				DecisionOptionID:    optionID,
				DecidedBy:           decidedBy,
			},
		})
		return err
	})
	if err != nil {
		return worker.PermissionState{}, false, err
	}
	return final, closed, nil
}

// trnWithFenceTripleTx is trnWithFencedTx without the non-terminal status
// requirement: same owner+token check, usable while the turn is already
// closed (permission stragglers).
func (s *TurnStore) trnWithFenceTripleTx(ctx context.Context, c worker.Claim, fn func(context.Context, pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin fenced tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner string
	var token int64
	err = tx.QueryRow(ctx, `
		SELECT worker_id::text, fencing_token FROM conversation_turns WHERE id = $1 FOR UPDATE`,
		c.TurnID).Scan(&owner, &token)
	if errors.Is(err, pgx.ErrNoRows) {
		return trnErrStaleLease
	}
	if err != nil {
		return fmt.Errorf("postgres: fence turn %s: %w", c.TurnID, err)
	}
	if owner != c.WorkerID || token != c.FencingToken {
		return trnErrStaleLease
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------- bindings

// RecordBinding closes any stale live binding for the conversation (a dead
// process left its row connected; the partial unique index allows only one)
// and inserts the new connected row.
func (s *TurnStore) RecordBinding(ctx context.Context, c worker.Claim, sess domain.SessionInfo) (string, []string, error) {
	caps, err := json.Marshal(orEmptyMap(sess.AgentCapabilities))
	if err != nil {
		return "", nil, fmt.Errorf("postgres: encode agent capabilities: %w", err)
	}
	var closed []string
	var id string
	err = s.trnWithFencedTx(ctx, c, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			UPDATE acp_session_bindings SET status = 'closed', disconnected_at = now()
			WHERE conversation_id = $1 AND status = 'connected'
			RETURNING id::text`, c.ConversationID)
		if err != nil {
			return fmt.Errorf("postgres: close stale bindings %s: %w", c.ConversationID, err)
		}
		for rows.Next() {
			var old string
			if err := rows.Scan(&old); err != nil {
				rows.Close()
				return fmt.Errorf("postgres: scan stale binding: %w", err)
			}
			closed = append(closed, old)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("postgres: close stale bindings: %w", err)
		}
		origin := orDefaultStr(sess.Origin, events.SessionOriginNew)
		return tx.QueryRow(ctx, `
			INSERT INTO acp_session_bindings
				(conversation_id, worker_id, acp_session_id, protocol_version, agent_capabilities,
				 launcher_id, launcher_version, session_origin)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
			RETURNING id::text`,
			c.ConversationID, c.WorkerID, sess.ACPSessionID, sess.ProtocolVersion, caps,
			sess.LauncherID, sess.LauncherVersion, origin).Scan(&id)
	})
	if err != nil {
		return "", nil, err
	}
	return id, closed, nil
}

// ResumableSession returns the live binding this worker lost its process
// for, but only when the recorded capabilities advertised loadSession —
// session/load is attempted only if advertised (04, ADR-0016 §6).
func (s *TurnStore) ResumableSession(ctx context.Context, conversationID, workerID string) (domain.SessionInfo, bool, error) {
	var info domain.SessionInfo
	var caps []byte
	err := s.Pool.QueryRow(ctx, `
		SELECT acp_session_id, protocol_version, agent_capabilities, launcher_id, launcher_version, session_origin
		FROM acp_session_bindings
		WHERE conversation_id = $1 AND worker_id = $2 AND status = 'connected'
		  AND agent_capabilities ->> 'loadSession' = 'true'
		ORDER BY connected_at DESC, id DESC
		LIMIT 1`, conversationID, workerID).
		Scan(&info.ACPSessionID, &info.ProtocolVersion, &caps, &info.LauncherID, &info.LauncherVersion, &info.Origin)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SessionInfo{}, false, nil
	}
	if err != nil {
		return domain.SessionInfo{}, false, fmt.Errorf("postgres: look up resumable session for %s: %w", conversationID, err)
	}
	return info, info.ACPSessionID != "", nil
}

// CloseBinding marks this worker's live binding closed and returns the
// affected ids so the loop can event them.
func (s *TurnStore) CloseBinding(ctx context.Context, conversationID, workerID, reason string) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `
		UPDATE acp_session_bindings SET status = 'closed', disconnected_at = now()
		WHERE conversation_id = $1 AND worker_id = $2 AND status = 'connected'
		RETURNING id::text`, conversationID, workerID)
	if err != nil {
		return nil, fmt.Errorf("postgres: close bindings %s: %w", conversationID, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("postgres: scan closed binding: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// SetConversationStatus moves a conversation between idle/active/
// disconnected; an archived conversation never moves (read-only).
func (s *TurnStore) SetConversationStatus(ctx context.Context, conversationID, status string) error {
	switch status {
	case "idle", "active", "disconnected":
	default:
		return fmt.Errorf("postgres: refuse to set conversation status %q from the worker", status)
	}
	_, err := s.Pool.Exec(ctx, `
		UPDATE conversations SET status = $2, updated_at = now()
		WHERE id = $1 AND status <> 'archived'`, conversationID, status)
	if err != nil {
		return fmt.Errorf("postgres: set conversation %s status %s: %w", conversationID, status, err)
	}
	return nil
}

// ProjectRepos lists the project's repositories for workspace prep.
func (s *TurnStore) ProjectRepos(ctx context.Context, projectID string) ([]worker.Repo, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text, name, git_url, default_branch, COALESCE(credential_secret_id::text, '')
		FROM repositories WHERE project_id = $1 ORDER BY name`,
		projectID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list repositories for %s: %w", projectID, err)
	}
	defer rows.Close()
	var out []worker.Repo
	for rows.Next() {
		var r worker.Repo
		if err := rows.Scan(&r.ID, &r.Name, &r.GitURL, &r.DefaultBranch, &r.CredentialSecretID); err != nil {
			return nil, fmt.Errorf("postgres: scan repository: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- journal

// trnAppendTx inserts one conversation-scoped journal row in tx. It is the
// worker's own insert (events.go belongs to the control-plane slice) and it
// lists conversation_id — the column that makes the row visible to the
// conversation stream (ADR-0016 §9 obligation 1 states the control plane's
// duty; this is the worker's equivalent for its own appends).
func trnAppendTx(ctx context.Context, tx pgx.Tx, organizationID, projectID, conversationID string, ev worker.TurnEvent) (events.Envelope, error) {
	if ev.Type == "" {
		return events.Envelope{}, errors.New("postgres: turn event requires a type")
	}
	if !events.ValidActorKind(ev.ActorKind) {
		return events.Envelope{}, fmt.Errorf("postgres: turn event actor kind %q is not allowed", ev.ActorKind)
	}
	if ev.ActorID == "" {
		return events.Envelope{}, errors.New("postgres: turn event requires an actor id")
	}
	payload, err := prjPayloadJSON(ev.Payload)
	if err != nil {
		return events.Envelope{}, err
	}
	if err := LockEventJournal(ctx, tx, projectID, organizationID); err != nil {
		return events.Envelope{}, err
	}
	var env events.Envelope
	var payloadRaw []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO domain_events
			(type, organization_id, project_id, conversation_id, actor_kind, actor_id, payload)
		VALUES ($1, $2::uuid, NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, $5, $6, $7::jsonb)
		RETURNING `+prjEventColumns,
		ev.Type, organizationID, prjCleanUUID(projectID), prjCleanUUID(conversationID),
		ev.ActorKind, ev.ActorID, payload).
		Scan(&env.GlobalSeq, &env.EventID, &env.Type, &env.SchemaVersion, &env.OccurredAt,
			&env.OrganizationID, &env.ProjectID, &env.ConversationID,
			&env.RunID, &env.NodeExecutionID, &env.AttemptID,
			&env.Actor.Kind, &env.Actor.ID, &env.TraceID, &payloadRaw)
	if err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append conversation event (%s): %w", ev.Type, err)
	}
	env.Payload = json.RawMessage(payloadRaw)
	if _, err := tx.Exec(ctx, `INSERT INTO outbox (global_seq) VALUES ($1)`, env.GlobalSeq); err != nil {
		return events.Envelope{}, fmt.Errorf("postgres: append outbox row: %w", err)
	}
	return env, nil
}

func orDefaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
