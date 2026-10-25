package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
	"github.com/dbirks/communication/internal/worker"
)

// The Postgres side of the seams internal/worker/agentturn.go declares
// (docs/m4-contract.md § 4 step 6): the attempt's conversation/turn pair and
// its binding bookkeeping, the pinned agent-profile read, and the node-policy
// answer to a permission prompt. This file lands no new tables: everything it
// writes lives in the M2/M3 families the contract says to reuse —
// conversations, conversation_turns (+ node_attempt_id), conversation_control
// (the reserved run_attempt kind finally written), acp_session_bindings,
// agent_profiles — and the attempt fence is runWithFencedTx, the same helper
// every other fenced attempt write takes (ADR-0016 § 9 obligation 2, reused
// verbatim for attempts).

// ------------------------------------------------------------ session store

// AttemptSessions is the worker.AttemptSessionStore over the attempt's
// conversation: the stamped pair, the binding rows resume answers read, and
// the honest close. It reuses the RunStore fence and the TurnStore binding
// SQL rather than restating either — one authority per table family, or the
// two loops drift.
type AttemptSessions struct {
	Runs *RunStore
}

var _ worker.AttemptSessionStore = (*AttemptSessions)(nil)

func (s *AttemptSessions) pool() (*pgxpool.Pool, error) {
	if s == nil || s.Runs == nil || s.Runs.Pool == nil {
		return nil, errors.New("postgres: attempt session store has no pool")
	}
	return s.Runs.Pool, nil
}

// turns is the binding-side delegate: ResumableSession and CloseBinding have
// exactly TurnStore's rules ("TurnStore.ResumableSession's rule, verbatim" is
// the seam's own words), and duplicating their SQL is how two files start
// disagreeing about what a live binding is.
func (s *AttemptSessions) turns() *TurnStore {
	return &TurnStore{Pool: s.Runs.Pool, LeaseTTL: s.Runs.leaseTTL()}
}

// ConversationFor reads this attempt's stamped conversation/turn pair, and —
// when the pair does not exist yet — creates it UNDER THE ATTEMPT FENCE in one
// transaction (contract § 4 step 6: conversation, its turn row, the
// node_attempt_id stamp, attempts.conversation_id/turn_id, and
// conversation_control taken as controller_kind='run_attempt', CAS).
//
// § 4 step 6 pins the creation in "the same transaction as the claim". The
// claim transaction is RunStore.ClaimAttempts, and the fence it drew IS the
// authority that rule protects — an attempt the fence never approved cannot
// reach this method with a live triple — so this landing takes the claim's
// token as its authorization one transaction later and stamps under the same
// row lock. What is NOT done here, in either landing, is any creation outside
// a proven triple: a stale writer gets ErrLeaseLost and lands nothing, which
// is the promise the sentence "a worker that could enqueue the turn outside
// the claim could enqueue turns the fence never approved" actually guards.
//
// ok=false is the § 4 step 6 wiring gap stated as one — a claim whose Config
// carries no prompt/profile. When a run itself cannot name an honest
// submitter, this seam ERRORS (a fail-closed node failure with a detail,
// not a silent wiring gap): ADR-0062 resolved the "no triggering user" case
// — an unattended run's agent turns are submitted on behalf of the human who
// authorised the automation (attemptSubmitter), and when even that walk
// finds no provable user the node fails rather than forge one.
func (s *AttemptSessions) ConversationFor(ctx context.Context, c worker.AttemptClaim) (worker.AttemptConversation, bool, error) {
	pool, err := s.pool()
	if err != nil {
		return worker.AttemptConversation{}, false, err
	}
	st := workerClaim(c)

	// Already stamped? The pair is immutable once the claim transaction that
	// wrote it committed (attempts_agent_turn_pair keeps the halves together).
	var conv, turn *string
	err = pool.QueryRow(ctx, `
		SELECT conversation_id::text, turn_id::text FROM attempts WHERE id = $1::uuid`,
		st.AttemptID).Scan(&conv, &turn)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.AttemptConversation{}, false, fmt.Errorf("postgres: attempt %s not found", st.AttemptID)
	}
	if err != nil {
		return worker.AttemptConversation{}, false, fmt.Errorf("postgres: read attempt %s pair: %w", st.AttemptID, err)
	}
	if derefStr(conv) != "" && derefStr(turn) != "" {
		return worker.AttemptConversation{ConversationID: *conv, TurnID: *turn}, true, nil
	}

	spec, ok, err := attemptTurnSpec(c)
	if err != nil || !ok {
		return worker.AttemptConversation{}, false, err
	}

	out := worker.AttemptConversation{}
	fenceErr := s.Runs.runWithFencedTx(ctx, st, true, func(ctx context.Context, tx pgx.Tx) error {
		// Re-read under the row lock: a concurrent stamp (a retried call after
		// a lost ack) must not produce a second conversation.
		var existingConv, existingTurn *string
		if err := tx.QueryRow(ctx, `
			SELECT conversation_id::text, turn_id::text FROM attempts WHERE id = $1::uuid FOR UPDATE`,
			st.AttemptID).Scan(&existingConv, &existingTurn); err != nil {
			return fmt.Errorf("postgres: lock attempt %s: %w", st.AttemptID, err)
		}
		if derefStr(existingConv) != "" && derefStr(existingTurn) != "" {
			out.ConversationID, out.TurnID = *existingConv, *existingTurn
			return nil
		}

		var projectID, orgID string
		err := tx.QueryRow(ctx, `
			SELECT project_id::text, organization_id::text
			FROM runs WHERE id = $1::uuid`, st.RunID).Scan(&projectID, &orgID)
		if err != nil {
			return fmt.Errorf("postgres: read run %s for the attempt conversation: %w", st.RunID, err)
		}
		// ADR-0062: the human this attempt's turn is submitted on behalf of —
		// the run's own triggering user, else the author of the trigger row
		// that fired it (schedule / issue trigger), else the same answer read
		// off an ancestor run (a pipeline.invoke child). No provable human ⇒
		// no rows, and the error says why.
		submitter, submittedVia, err := attemptSubmitter(ctx, tx, st.RunID)
		if err != nil {
			return err
		}

		// A retry of the same node execution rides the conversation its
		// earlier attempts already used — that continuity is what makes
		// resume_if_supported mean anything across attempts (contract § 4
		// step 6 "create (or resume, via acp_session_bindings)").
		var conversationID *string
		err = tx.QueryRow(ctx, `
			SELECT conversation_id::text FROM attempts
			WHERE node_execution_id = $1::uuid AND conversation_id IS NOT NULL
			ORDER BY attempt_number DESC, id DESC LIMIT 1`, st.NodeExecutionID).Scan(&conversationID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("postgres: look for the node's conversation: %w", err)
		}

		if conversationID == nil || *conversationID == "" {
			var profileID string
			err := tx.QueryRow(ctx, `
				SELECT id::text FROM agent_profiles WHERE organization_id = $1::uuid AND name = $2`,
				orgID, spec.profile).Scan(&profileID)
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("postgres: agent profile %q is not defined in the run's organization (ADR-0016's agent_profiles is name-scoped): the conversation binds a profile, and none can be invented", spec.profile)
			}
			if err != nil {
				return fmt.Errorf("postgres: read agent profile %q: %w", spec.profile, err)
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO conversations (project_id, agent_profile_id, title, created_by)
				VALUES ($1::uuid, $2::uuid, $3, $4::uuid) RETURNING id::text`,
				projectID, profileID, attemptConversationTitle(st), submitter).Scan(&conversationID); err != nil {
				return fmt.Errorf("postgres: create attempt conversation for %s: %w", st.AttemptID, err)
			}
		}
		convID := *conversationID

		// The control row: created already holding this attempt (§ 4 step 6
		// "taking conversation_control as controller_kind='run_attempt'"). On a
		// reused conversation the take is a version bump over 'none' or an
		// existing run_attempt — a HUMAN controller is ADR-0016 § 5's takeover
		// machinery to move, not this insert's, and refusing here is what keeps
		// "the human gave up control" a fact the takeover transaction wrote.
		var kind string
		var holder *string
		err = tx.QueryRow(ctx, `
			SELECT controller_kind, controller_run_attempt_id::text
			FROM conversation_control WHERE conversation_id = $1::uuid FOR UPDATE`,
			convID).Scan(&kind, &holder)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if _, err := tx.Exec(ctx, `
				INSERT INTO conversation_control (conversation_id, controller_kind, controller_run_attempt_id)
				VALUES ($1::uuid, 'run_attempt', $2::uuid)`, convID, st.AttemptID); err != nil {
				return fmt.Errorf("postgres: open control for %s: %w", convID, err)
			}
		case err != nil:
			return fmt.Errorf("postgres: lock control for %s: %w", convID, err)
		case kind == "run_attempt" && derefStr(holder) == st.AttemptID:
			// Already ours (idempotent re-entry).
		case kind == "none", kind == "run_attempt":
			tag, err := tx.Exec(ctx, `
				UPDATE conversation_control
				SET controller_kind = 'run_attempt', controller_user_id = NULL,
				    controller_run_attempt_id = $2::uuid, version = version + 1, updated_at = now()
				WHERE conversation_id = $1::uuid AND controller_kind IN ('none', 'run_attempt')`,
				convID, st.AttemptID)
			if err != nil {
				return fmt.Errorf("postgres: take control for attempt %s: %w", st.AttemptID, err)
			}
			if tag.RowsAffected() == 0 {
				return fmt.Errorf("postgres: conversation %s control moved underneath the take (CAS): the takeover machinery owns that transition (ADR-0016 § 5)", convID)
			}
		default:
			return fmt.Errorf("postgres: conversation %s is controlled by a human: a run attempt may not take control from the controller the takeover transaction installed (ADR-0016 § 5)", convID)
		}

		// The attempt's turn row. It is stamped leased on the attempt's own
		// triple (the two-lease pair ADR-0023 § 4 renews in one statement),
		// never queued: a queued node_attempt_id turn would fall into M2's
		// human-turn claim scan, which selects on status alone — 'leased' is
		// how the node_attempt_id population stays unclaimable there (contract
		// § 4 step 2). conversation_turns_one_active_idx is the backstop that a
		// prior attempt left its turn open past its terminal: that refusal
		// names the writer that owes the close, and this seam does not close a
		// turn vocabulary it does not own. It is equally the backstop for the
		// human's OWN turn a return-control raced past (m4-contract § 5.3's
		// journey): the executor reads that refusal as
		// worker.ErrAttemptConversationBusy and waits for the slot, because the
		// close is that turn's worker's to write, never the claim's.
		var turnID string
		stampErr := tx.QueryRow(ctx, `
			INSERT INTO conversation_turns
				(conversation_id, prompt, submitted_by, submitted_via, status, worker_id,
				 fencing_token, lease_expires_at, started_at, node_attempt_id)
			VALUES ($1::uuid, $2, $3::uuid, $8, 'leased', $4::uuid, $5,
			        now() + make_interval(secs => $6::double precision), NULL, $7::uuid)
			RETURNING id::text`,
			convID, spec.prompt, submitter, st.WorkerID, st.FencingToken,
			s.Runs.leaseTTL().Seconds(), st.AttemptID, submittedVia).Scan(&turnID)
		if stampErr != nil {
			if idnUniqueViolation(stampErr) {
				return fmt.Errorf("postgres: conversation %s still carries a non-terminal turn: its owner owes conversation.turn.<terminal> before this retry enqueues its own (one-active-turn index, ADR-0016 § 5; the holder is the human's own prompt when a return-control landed inside it): %w", convID, worker.ErrAttemptConversationBusy)
			}
			return fmt.Errorf("postgres: stamp attempt %s turn: %w", st.AttemptID, stampErr)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE attempts SET conversation_id = $2::uuid, turn_id = $3::uuid WHERE id = $1::uuid`,
			st.AttemptID, convID, turnID); err != nil {
			return fmt.Errorf("postgres: stamp attempt %s pair: %w", st.AttemptID, err)
		}
		out.ConversationID, out.TurnID = convID, turnID
		return nil
	})
	if fenceErr != nil {
		return worker.AttemptConversation{}, false, attemptErrStaleLease(fenceErr)
	}
	return out, out.ConversationID != "" && out.TurnID != "", nil
}

// The conversation_turns.submitted_via vocabulary (migration 00017,
// ADR-0062): WHAT put the prompt in the queue, read next to submitted_by's
// "on whose behalf". A transcript that renders only submitted_by is honest
// exactly when this says 'human'.
const (
	turnSubmittedViaHuman        = "human"
	turnSubmittedViaSchedule     = "schedule"
	turnSubmittedViaIssueTrigger = "issue_trigger"
	turnSubmittedViaChildRun     = "child_run"
)

// errAttemptNoSubmitter is the honest fail-closed refusal: no provable human
// stands behind this run's agent turn. It names the constraint it obeys and
// every detail wraps the reason into it, so the attempt's failure detail
// always says both.
var errAttemptNoSubmitter = errors.New("postgres: an unattended agent turn has no honest submitter: conversation_turns.submitted_by is NOT NULL REFERENCES users and this seam will not forge a user (ADR-0062)")

// attemptQuerier is the read face the submitter walk needs — the fenced
// transaction answers it, and a pool would too, but the walk runs inside the
// stamp transaction so the attribution and the rows it names commit together.
type attemptQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// attemptSubmitterMaxHops bounds the ancestor walk: 00005's depth CHECK caps
// a run chain at three rows (0 → 1 → 2), so two hops past the first row is
// already past the legal chain; the bound is a loop guard, not a policy.
const attemptSubmitterMaxHops = 3

// attemptSubmitter names the human the run's agent turns are submitted on
// behalf of, and the submitted_via kind that says so (ADR-0062):
//
//   - the run's own triggered_by (a manual or thread start — 'human');
//   - else the author of the trigger row the run names — schedules.created_by
//     for a 'schedule' fire, issue_triggers.created_by for an 'issue' fire
//     (the human who WROTE the automation authorised it — 'schedule' /
//     'issue_trigger');
//   - else the same walk one run up, following parent_run_id to an ancestor
//     whose triggered_by or trigger row answers — 'child_run' when a person's
//     triggered_by was reached through the chain, the ancestor's automation
//     kind when its trigger row was.
//
// A deleted trigger row or a dangling author is a CLOSED failure, never a
// guessed user: the run keeps failing until an operator decides, because the
// alternative is attributing an unattended agent's prompts to somebody the
// audit trail cannot prove.
func attemptSubmitter(ctx context.Context, q attemptQuerier, runID string) (string, string, error) {
	cur := runID
	for hop := 0; hop <= attemptSubmitterMaxHops; hop++ {
		var triggeredBy, kind, triggerID, parentID string
		err := q.QueryRow(ctx, `
			SELECT COALESCE(triggered_by::text, ''), trigger_kind,
			       COALESCE(trigger_id::text, ''), COALESCE(parent_run_id::text, '')
			FROM runs WHERE id = $1::uuid`, cur).
			Scan(&triggeredBy, &kind, &triggerID, &parentID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Only reachable mid-walk: a run row deleted while a child of
			// theirs was being stamped. The chain's authority is gone.
			return "", "", fmt.Errorf("%w: run %s of the attribution chain is gone", errAttemptNoSubmitter, cur)
		}
		if err != nil {
			return "", "", fmt.Errorf("postgres: read submitter columns of run %s: %w", cur, err)
		}
		if triggeredBy != "" {
			if !attemptUserExists(ctx, q, triggeredBy) {
				return "", "", fmt.Errorf("%w: run %s names triggering user %s, which is not a users row", errAttemptNoSubmitter, cur, triggeredBy)
			}
			if hop == 0 {
				return triggeredBy, turnSubmittedViaHuman, nil
			}
			return triggeredBy, turnSubmittedViaChildRun, nil
		}
		if triggerID != "" {
			var author string
			var via string
			var rowErr error
			switch kind {
			case "schedule":
				rowErr = q.QueryRow(ctx, `
					SELECT created_by::text FROM schedules WHERE id = $1::uuid`, triggerID).Scan(&author)
				via = turnSubmittedViaSchedule
			case "issue":
				rowErr = q.QueryRow(ctx, `
					SELECT created_by::text FROM issue_triggers WHERE id = $1::uuid`, triggerID).Scan(&author)
				via = turnSubmittedViaIssueTrigger
			default:
				// 00017's runs_trigger_id_names_a_trigger makes this row
				// unrepresentable; if the CHECK is ever dropped, refusing is
				// still the honest answer.
				return "", "", fmt.Errorf("%w: run %s carries trigger_id %s under kind %q, which cannot name an author", errAttemptNoSubmitter, cur, triggerID, kind)
			}
			if errors.Is(rowErr, pgx.ErrNoRows) {
				return "", "", fmt.Errorf("%w: run %s was fired by %s %s, whose row is gone — the human who authorised the automation can no longer be named", errAttemptNoSubmitter, cur, kind, triggerID)
			}
			if rowErr != nil {
				return "", "", fmt.Errorf("postgres: read the author of %s %s: %w", kind, triggerID, rowErr)
			}
			if !attemptUserExists(ctx, q, author) {
				return "", "", fmt.Errorf("%w: %s %s names author %s, which is not a users row", errAttemptNoSubmitter, kind, triggerID, author)
			}
			return author, via, nil
		}
		if parentID == "" {
			break
		}
		cur = parentID
	}
	return "", "", fmt.Errorf("%w: run %s and its ancestor runs name no triggering user and no live trigger author", errAttemptNoSubmitter, runID)
}

// attemptUserExists re-proves the FK the columns already assert: users rows
// are not deleted under referencers today, and if that ever changes the
// stamp must still refuse to name a submitter that cannot be displayed.
func attemptUserExists(ctx context.Context, q attemptQuerier, userID string) bool {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1::uuid)`, userID).Scan(&ok)
	return err == nil && ok
}

// attemptTurnSpec pulls the two hydration-owned members the conversation
// creation needs from the claim config: the resolved prompt text and the
// profile name. The executor's parseConfig has already run the shape checks
// on the same map (agentturn.go); this read re-asserts them only so this
// writer never inserts a row on a shape another reader refused.
type attemptTurnSpecShape struct {
	prompt  string
	profile string
}

func attemptTurnSpec(c worker.AttemptClaim) (attemptTurnSpecShape, bool, error) {
	if c.Config == nil {
		return attemptTurnSpecShape{}, false, nil
	}
	prompt, _ := c.Config["prompt"].(string)
	if prompt == "" {
		return attemptTurnSpecShape{}, false, nil
	}
	if len(prompt) > 65536 {
		return attemptTurnSpecShape{}, false, fmt.Errorf("postgres: agent prompt is %d characters, over conversation_turns' 65536 bound (00003): the turn row cannot hold it and no truncation is honest to the prompt the node declared", len(prompt))
	}
	profile, _ := c.Config["profile"].(string)
	if profile == "" {
		profile, _ = c.Config["agent"].(string)
	}
	if profile == "" {
		return attemptTurnSpecShape{}, false, nil
	}
	return attemptTurnSpecShape{prompt: prompt, profile: profile}, true, nil
}

// attemptConversationTitle names the conversation for the human reader of the
// timeline: run, node, attempt — ids the UI already carries, no prompt text.
func attemptConversationTitle(c AttemptClaim) string {
	t := fmt.Sprintf("run %s %s attempt %d", shortID(c.RunID), c.NodeInstanceKey, c.AttemptNumber)
	if len(t) > 200 {
		t = t[:200]
	}
	return t
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// ResumableSession is TurnStore's rule verbatim (the seam's own words): the
// session id a stored binding offers for this conversation on this worker,
// only when the recorded capabilities advertised loadSession.
func (s *AttemptSessions) ResumableSession(ctx context.Context, conversationID, workerID string) (domain.SessionInfo, bool, error) {
	if _, err := s.pool(); err != nil {
		return domain.SessionInfo{}, false, err
	}
	return s.turns().ResumableSession(ctx, conversationID, workerID)
}

// RecordBinding closes any stale live binding and inserts this attempt's
// connected row, fenced on the attempt triple — a session record is a claim
// about what THIS owner attached, and a stale writer may not land it (or
// close somebody else's live row). The reuse labelling is carried by the
// column CHECK: acp_session_bindings.session_origin holds 'new' or 'resumed'
// and nothing else, so the `reused` origin an attempt may never claim
// (contract § 4 step 14) is refused here in words before Postgres refuses it
// by constraint — commit 9d0e560's labelling rule, enforced at the write.
func (s *AttemptSessions) RecordBinding(ctx context.Context, c worker.AttemptClaim, conversationID string, sess domain.SessionInfo) (string, []string, error) {
	if _, err := s.pool(); err != nil {
		return "", nil, err
	}
	switch sess.Origin {
	case "", events.SessionOriginNew, events.SessionOriginResumed:
	default:
		return "", nil, fmt.Errorf("postgres: session origin %q cannot be recorded for an attempt: a node attempt never holds a session across attempts, so `reused` is a labelling lie (contract § 4 step 14, commit 9d0e560)", sess.Origin)
	}
	caps, err := json.Marshal(orEmptyMap(sess.AgentCapabilities))
	if err != nil {
		return "", nil, fmt.Errorf("postgres: encode agent capabilities: %w", err)
	}
	st := workerClaim(c)
	var (
		id     string
		closed []string
	)
	err = s.Runs.runWithFencedTx(ctx, st, true, func(ctx context.Context, tx pgx.Tx) error {
		// The conversation this attempt owns — an executor that passed a
		// conversation id from somewhere else is writing bindings for a
		// session its fence says nothing about.
		var owned *string
		if err := tx.QueryRow(ctx, `
			SELECT conversation_id::text FROM attempts WHERE id = $1::uuid FOR UPDATE`,
			st.AttemptID).Scan(&owned); err != nil {
			return fmt.Errorf("postgres: lock attempt %s for binding: %w", st.AttemptID, err)
		}
		if derefStr(owned) != conversationID {
			return fmt.Errorf("postgres: binding for conversation %s refused: attempt %s owns %s (the stamped pair is the only authority)", conversationID, st.AttemptID, orNone(derefStr(owned)))
		}
		rows, err := tx.Query(ctx, `
			UPDATE acp_session_bindings SET status = 'closed', disconnected_at = now()
			WHERE conversation_id = $1::uuid AND status = 'connected'
			RETURNING id::text`, conversationID)
		if err != nil {
			return fmt.Errorf("postgres: close stale bindings %s: %w", conversationID, err)
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
			VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8)
			RETURNING id::text`,
			conversationID, st.WorkerID, sess.ACPSessionID, sess.ProtocolVersion, caps,
			sess.LauncherID, sess.LauncherVersion, origin).Scan(&id)
	})
	if err != nil {
		return "", nil, attemptErrStaleLease(err)
	}
	return id, closed, nil
}

func orNone(s string) string {
	if s == "" {
		return "no conversation"
	}
	return s
}

// CloseBinding marks this worker's live binding closed for the attempt's
// conversation. It runs on the loop's detached teardown context, where the
// attempt may already be terminal, so it carries no fence — exactly
// TurnStore.CloseBinding's contract (a worker may always say what ITS session
// did; the ids it returns are the eventing the caller still journals under the
// last successful append).
func (s *AttemptSessions) CloseBinding(ctx context.Context, conversationID, workerID, reason string) ([]string, error) {
	if _, err := s.pool(); err != nil {
		return nil, err
	}
	return s.turns().CloseBinding(ctx, conversationID, workerID, reason)
}

// ---------------------------------------------------------- profile source

// AgentProfiles resolves the agent profile an agent.acp attempt names
// (contract § 4 step 6). There are no profile REVISIONS yet (deviation D10:
// the launcher, permission mode and sandbox axes are columns on
// agent_profiles; ADR-0008's pin is the run's plan + this row's identity), so
// "the pinned revision" this read promises is the org-scoped name the COMPILER
// validated at publish (unknown_profile) resolved against the attempt's RUN's
// organization — the same authority ProfileReader carries. The launcher id it
// returns is a registry key (internal/agent/acp/launchers.go); the executor
// looks the launcher up there and refuses an unknown one, because a launcher
// is read, never invented from the profile name.
type AgentProfiles struct {
	Pool *pgxpool.Pool
}

var _ worker.AgentProfileResolver = (*AgentProfiles)(nil)

// AgentProfileFor resolves config.profile by name within the attempt's run
// organization. ok=false is "the revision is not resolvable for this run" —
// the name exists nowhere in this org — an honest refusal, never a default.
func (p *AgentProfiles) AgentProfileFor(ctx context.Context, c worker.AttemptClaim, profileName string) (worker.AgentProfile, bool, error) {
	if p == nil || p.Pool == nil {
		return worker.AgentProfile{}, false, errors.New("postgres: agent profile resolver has no pool")
	}
	if profileName == "" || c.OrganizationID == "" {
		return worker.AgentProfile{}, false, nil
	}
	var out worker.AgentProfile
	err := p.Pool.QueryRow(ctx, `
		SELECT ap.id::text, ap.launcher_id, ap.permission_mode, ap.commit_granted
		FROM agent_profiles ap
		WHERE ap.organization_id = $1::uuid AND ap.name = $2`,
		c.OrganizationID, profileName).
		Scan(&out.AgentProfileID, &out.LauncherID, &out.PermissionMode, &out.CommitGranted)
	if errors.Is(err, pgx.ErrNoRows) {
		return worker.AgentProfile{}, false, nil
	}
	if err != nil {
		return worker.AgentProfile{}, false, fmt.Errorf("postgres: read agent profile %q for organization %s: %w", profileName, c.OrganizationID, err)
	}
	return out, true, nil
}

// ------------------------------------------------------ permission policies

// PermissionPolicyFor builds the node-policy answer for one profile permission
// mode (contract § 4 step 6: prompts are answered by the node's declared
// policy, and BOTH halves are journalled by the executor's bridge). Option
// selection is by KIND, never label or id — domain.PermissionOption's rule,
// observed harness ids disagree with their kinds (docs/compatibility/ACP.md:
// Codex names its reject option literally "cancel") — and the two-step
// fallback mirrors the adapter's own static policy (allow_once before
// allow_always, reject_once before reject_always,
// internal/agent/acp/permission.go) so the bridge and the ACP layer answer the
// same prompt the same way.
//
// 'ask' has no synchronous decider on the attempt path: run-attempt prompts do
// not surface to a human controller — control is held AS the run attempt, and
// a human who wants to answer takes over, which cancels the turn (ADR-0016 § 5,
// contract § 5.3). An unattended ask therefore answers with the ACP cancelled
// outcome, journalled as such: a prompt nobody could answer is visible as one,
// and no verdict is invented for it.
func PermissionPolicyFor(mode string) worker.PermissionPolicy {
	switch mode {
	case "preapproved_within_sandbox":
		return func(p domain.PermissionPrompt) worker.PermissionVerdict {
			// The profile's promise is that isolation, not a human, carries
			// this call; the sandbox is the axis that says so (ADR-0017 D4,
			// ADR-0019), and the decided_by line names the profile as the
			// decider so the audit never reads like consent from a person.
			return pickKind(p, "preapproved_within_sandbox", "allow_once", "allow_always")
		}
	case "deny":
		return func(p domain.PermissionPrompt) worker.PermissionVerdict {
			return pickKind(p, "deny", "reject_once", "reject_always")
		}
	case "ask":
		return func(domain.PermissionPrompt) worker.PermissionVerdict {
			return worker.PermissionVerdict{DecidedBy: "node_policy:ask_unattended"}
		}
	default: // "" — the profile declared none: fail closed, the adapter's own default.
		return func(p domain.PermissionPrompt) worker.PermissionVerdict {
			return pickKind(p, "deny_undeclared_mode", "reject_once", "reject_always")
		}
	}
}

func pickKind(p domain.PermissionPrompt, decider string, kinds ...string) worker.PermissionVerdict {
	for _, k := range kinds {
		for _, o := range p.Options {
			if o.Kind == k {
				return worker.PermissionVerdict{OptionKind: k, DecidedBy: "node_policy:" + decider}
			}
		}
	}
	// No compatible option: the empty verdict is the cancelled outcome —
	// never a fabricated option id (domain.PermissionChoice's rule).
	return worker.PermissionVerdict{DecidedBy: "node_policy:" + decider}
}
