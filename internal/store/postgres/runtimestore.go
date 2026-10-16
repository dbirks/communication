package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// RuntimeStore is the Postgres implementation of runtime.Store
// (docs/m4-contract.md § 5). The database is the ONLY state: every
// Transact(ctx, runID, fn) is one Postgres transaction that
//
//	(1) takes the advancer advisory lock communication/advancer/<run-id>
//	   plus the run row lock (§ 5.1 step 1),
//	(2) HYDRATES the full runtime.State from the run's rows — runs,
//	   run_inputs, node_executions, attempts, approval_requests,
//	   run_checkpoints, pipeline_invocations and the journal resume
//	   (runtime_read.go),
//	(3) applies fn — and the § 5.1 advancer pass — through the real engine
//	   on that hydrated state: the same transition tables, guards and
//	   reference operations the hermetic MemStore runs (no re-derivation
//	   of behaviour, and none is copied here),
//	(4) writes ONLY the mutated/new rows plus the journal appends
//	   (pevents.Record → domain_events via runAppendTx/AppendRecordTx),
//	   atomically. Any error — fn's, a guard's, a CHECK's — rolls the
//	   whole thing back, so the § 5 boundary is all-or-nothing per real
//	   COMMIT/ROLLBACK, and the checkpoint-rollback conformance arm is
//	   asserted, not promised.
//
// No per-run State survives a call, in this process or any other: there is
// no live mirror, no snapshot/restore, and no id registry. Row identities
// are uuids end to end — existing rows carry the uuid they were inserted
// with, ids the advancer mints inside a transaction hash deterministically
// under the run's uuid namespace (runtime_read.go), so two replicas
// hydrating the same run compute the same identities and a restart loses
// nothing that was committed. Fencing tokens are drawn from
// attempt_fencing_seq inside the transaction, once per claim (ADR-0016 § 3,
// ADR-0023 § 4), so a replacement attempt's token is strictly greater
// across every process sharing the database (12 case 3/C4c).
//
// The worker/reconciler/API ops mirror runtime.MemStore's one-for-one and
// run through it — a THROWAWAY MemStore instance built per transaction
// around the hydrated state, because those operations ARE the reference
// semantics the harness certifies; the instance is discarded at commit or
// rollback and never addressed by id. Identity arguments (worker id,
// decider id, checkpoint workspace/volume carrier) resolve through
// rteIdentity — a pure function, not a registry.
type RuntimeStore struct {
	Pool *pgxpool.Pool

	// Adv is the deployment's advancer shell: its child resolver (and any
	// program a caller wired for a plan-less run row). Per transaction, the
	// adapter rebuilds it around the RUN's own compiled plan, hydrated from
	// runs.plan_snapshot (ADR-0023 § 1/§ 2: the run executes a plan snapshot,
	// so a replica driving two revisions never drives either with the wrong
	// graph).
	Adv *runtime.Advancer
	// Now is the deployment's clock; tests drive it (the reconciler
	// poll's hermetic twin, § 5.4).
	Now func() time.Time
	// Lease is the attempt lease duration (ADR-0023 § 4: 30 s).
	Lease time.Duration
}

var _ runtime.Store = (*RuntimeStore)(nil)

// NewRuntimeStore wires the adapter to a pool and the advancer that owns the
// run's plan. The run row must already exist (created through RunStore's
// create transaction, like the POST /runs route); there is no registration
// step, because there is no in-process state to register into.
func NewRuntimeStore(pool *pgxpool.Pool, adv *runtime.Advancer) *RuntimeStore {
	return &RuntimeStore{
		Pool:  pool,
		Adv:   adv,
		Now:   func() time.Time { return time.Now() },
		Lease: 30 * time.Second,
	}
}

// advancerLockPrefix is contract § 5.1 step 1's advisory-lock namespace:
// communication/advancer/<run-id>, keyed by the run's ledger uuid.
const advancerLockPrefix = "communication/advancer/"

// RuntimeIdentity exposes the adapter's pure identity resolution (see
// runtime_read.go's rteIdentity): a harness or operator name maps to the
// same ledger uuid in every replica, so seeding a worker/user/workspace row
// and the row that references it can never disagree — there is no id
// registry to keep in step.
func RuntimeIdentity(name string) string { return rteIdentity(name) }

// Transact implements runtime.Store: lock, hydrate, fn, advancer pass,
// write-back, commit — or none of it.
func (s *RuntimeStore) Transact(ctx context.Context, runID string, fn func(tx *runtime.Tx) error) error {
	return s.settle(ctx, runID, func(_ context.Context, tx pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Transact(ctx, runID, fn)
	}, nil)
}

// settle is the whole adapter in one shape. commitOnRefusal is the Decide
// arm only: an authorization refusal journals approval.denied AND returns
// the conflict (§ 3 row 29, C9b), so the append is part of the contract
// rather than a mutation to roll back; the appended rows are still
// boundary-checked (only journal appends may commit alongside a refusal).
func (s *RuntimeStore) settle(ctx context.Context, runID string,
	op func(ctx context.Context, tx pgx.Tx, ms *runtime.MemStore, st *runtime.State) error,
	commitOnRefusal func(err error, appended []pevents.Record) bool,
) error {
	if !prjValidUUID(runID) {
		return fmt.Errorf("postgres: RuntimeStore addresses runs by their ledger uuid, got %q", runID)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin runtime tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ready, err := s.settleTx(ctx, tx, runID, op, commitOnRefusal)
	if !ready {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit runtime tx for run %s: %w", runID, err)
	}
	return err
}

// settleTx is settle's body on a transaction the CALLER already owns: same
// lock, same hydrate, same write-back — but the CALLER commits, because it may
// own more rows than this run's. It exists for the one handoff whose halves are
// a single fact: ADR-0016 § 5's takeover moves the conversation-control row AND
// pauses the run, and a run paused with the human still locked out (or a human
// locked in with the run still driving) is exactly the split-brain the ADR
// forbids. The bool says whether the write-back landed, i.e. whether the caller
// may commit: true alongside a nil error, and alongside the commitOnRefusal
// arm's accepted error.
func (s *RuntimeStore) settleTx(ctx context.Context, tx pgx.Tx, runID string,
	op func(ctx context.Context, tx pgx.Tx, ms *runtime.MemStore, st *runtime.State) error,
	commitOnRefusal func(err error, appended []pevents.Record) bool,
) (ready bool, err error) {
	// (1) The advancer lock, then the run row — the § 5.1 pair, in this
	// order, on every path.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		advancerLockPrefix+runID); err != nil {
		return false, fmt.Errorf("postgres: advancer lock for run %s: %w", runID, err)
	}
	var locked int
	if err := tx.QueryRow(ctx,
		`SELECT 1 FROM runs WHERE id = $1::uuid FOR UPDATE`, runID).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrRunNotFound
		}
		return false, fmt.Errorf("postgres: lock run %s: %w", runID, err)
	}

	// (2) Hydrate the truth from rows.
	st, err := hydrateTx(ctx, tx, runID)
	if err != nil {
		return false, err
	}
	adv, err := s.advancerForTx(ctx, tx, runID)
	if err != nil {
		return false, err
	}
	journalLen := len(st.Events)
	hydrated := snapshotRows(st)

	// (3) Apply through the engine. The throwaway MemStore carries this
	// transaction's clock, lease and advancer; it dies with the call.
	ms := runtime.NewMemStore(adv)
	ms.AddRun(st)
	ms.Now = s.Now
	ms.Lease = s.Lease
	opErr := op(ctx, tx, ms, st)

	// (4) Write back whatever the engine changed. With an op error, the
	// only permitted writes are the commitOnRefusal arm's journal appends.
	if opErr != nil && (commitOnRefusal == nil || !commitOnRefusal(opErr, st.Events[journalLen:])) {
		return false, opErr
	}
	if err := writeRowsTx(ctx, tx, st, hydrated, journalLen); err != nil {
		return false, err
	}
	return true, opErr
}

// advancerForTx assembles the advancer for ONE transaction on ONE run: the
// run's own pinned program (runs.plan_snapshot, hydrated per call — no plan
// is cached across a transaction, exactly as no State is) with the
// deployment's child resolver and clock that s.Adv carries.
//
// This is why the deployment wires a single Advancer for every run: the plan
// is per-run state that lives in the database, so a replica serving two
// pipelines — or a parent and a child run of different revisions — drives each
// with the plan that run pinned. A run row with no pinned snapshot (a
// hand-seeded fixture, never an API-created run) falls back to s.Adv's program
// so the wired advancer stays meaningful; when neither exists, the engine
// refuses with runtime.ErrNoProgram rather than panicking (see Advance).
func (s *RuntimeStore) advancerForTx(ctx context.Context, tx pgx.Tx, runID string) (*runtime.Advancer, error) {
	adv := &runtime.Advancer{}
	if s.Adv != nil {
		cp := *s.Adv
		adv = &cp
	}
	// The capabilities the advancer calls mid-pass ride THIS transaction (see
	// withPassTx): the child resolver's CreateChild cannot take KEY SHARE on the
	// parent run row from a second connection while this one holds it FOR UPDATE,
	// and contract § 5.5's child run plus invocation row are one fact with the
	// parent's rows anyway. The pass's own context is the parent — the caller's
	// cancellation is what must stop the in-pass writes — so a deployment
	// context on AdvancerDeps is not carried into a pass (nothing in this build
	// sets one; grep AdvancerDeps{ shows Children only).
	adv.Deps.Context = withPassTx(ctx, tx)
	prog, err := hydrateProgramTx(ctx, tx, runID)
	if err != nil {
		return nil, err
	}
	if prog == nil {
		// A row that pins no plan (a hand-seeded fixture). A store wired
		// with no advancer at all stays "no advancer": the engine's own
		// guards treat nil as "this caller does not schedule", exactly as
		// before the run's plan became the source of its program.
		if s.Adv == nil {
			return nil, nil
		}
		return adv, nil
	}
	adv.Prog = prog
	return adv, nil
}

// drawFence is attempt_fencing_seq's one draw per claim (ADR-0016 § 3). A
// rolled-back claim still burns the number: monotonic, not gap-free, is the
// property the fence proves.
func (s *RuntimeStore) drawFence(ctx context.Context, tx pgx.Tx) (int64, error) {
	var v int64
	if err := tx.QueryRow(ctx, `SELECT nextval('attempt_fencing_seq')`).Scan(&v); err != nil {
		return 0, fmt.Errorf("postgres: draw fencing token: %w", err)
	}
	return v, nil
}

// ------------------------------------------------------------ worker-side ops

// Claim is ADR-0023 § 4's atomic pick: the advisory+row lock makes the
// across-replica race a queue, and the fencing token is drawn from the
// ledger sequence inside this transaction (never from a per-process
// counter). The pick/fence/tie-break semantics run on the hydrated state
// through the reference op.
func (s *RuntimeStore) Claim(ctx context.Context, runID, workerID string) (*runtime.Attempt, error) {
	var claimed *runtime.Attempt
	err := s.settle(ctx, runID, func(ctx context.Context, tx pgx.Tx, ms *runtime.MemStore, st *runtime.State) error {
		token, err := s.drawFence(ctx, tx)
		if err != nil {
			return err
		}
		// The reference op draws FenceSeq+1 for its claim; parking the
		// counter one below the ledger draw hands every claimer a unique,
		// strictly greater token.
		ms.FenceSeq = token - 1
		a, err := ms.Claim(runID, rteIdentity(workerID))
		claimed = a
		return err
	}, nil)
	if err != nil {
		return nil, err
	}
	return claimed, nil
}

// Start leases→running and stamps the launch-relative deadline (§ 3 row
// 20), fenced.
func (s *RuntimeStore) Start(ctx context.Context, runID, attemptID, workerID string, token int64) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Start(runID, attemptID, rteIdentity(workerID), token)
	}, nil)
}

// Renew extends the live lease (§ 4 step 7; the paired turn renewal is the
// worker claim path's concern, attempts.go, not this adapter's).
func (s *RuntimeStore) Renew(ctx context.Context, runID, attemptID, workerID string, token int64) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Renew(runID, attemptID, rteIdentity(workerID), token)
	}, nil)
}

// Complete is the boundary transaction (§ 4 step 10): fenced, it closes the
// attempt with outputs/digest/refs, moves the node, appends the checkpoint
// row and both events, and the advancer pass follows — all in one commit.
// A CheckpointRecord refusal rolls back the success half too: the
// contract-§ 5 all-or-nothing the MemStore deviates from is NOT copied;
// the harness's rollback arm asserts this against the real database.
func (s *RuntimeStore) Complete(ctx context.Context, runID, attemptID, workerID string, token int64,
	outputs any, outputsDigest string, artifactRefs []any, outcome string, ckpt runtime.CheckpointRecord) error {

	ckpt.WorkerID = rteIdentity(ckpt.WorkerID)
	ckpt.WorkspaceID = rteIdentity(ckpt.WorkspaceID)
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Complete(runID, attemptID, rteIdentity(workerID), token,
			outputs, outputsDigest, artifactRefs, outcome, ckpt)
	}, nil)
}

// Fail closes an attempt as failed, fenced; the retry decision stays the
// advancer's, from rows (ADR-0023 § 5).
func (s *RuntimeStore) Fail(ctx context.Context, runID, attemptID, workerID string, token int64,
	class, detail string, outputErrors []any) error {

	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Fail(runID, attemptID, rteIdentity(workerID), token, class, detail, outputErrors)
	}, nil)
}

// Interrupt is the reconciler's honest terminal (unfenced by design, § 5.4
// pass 1) — or a worker closing its own attempt (§ 3 row 23).
func (s *RuntimeStore) Interrupt(ctx context.Context, runID, attemptID, reason string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Interrupt(runID, attemptID, reason)
	}, nil)
}

// CancelAttempt is the owner's honest close of a cancel-requested attempt
// (§ 4 step 11), fenced.
func (s *RuntimeStore) CancelAttempt(ctx context.Context, runID, attemptID, workerID string, token int64, reason string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.CancelAttempt(runID, attemptID, rteIdentity(workerID), token, reason)
	}, nil)
}

// ---------------------------------------------------------- reconciler ops

// m4WorkspaceLostGrace is ADR-0023 § 11 pass 5's "> 1 pass" debounce: a run
// workspace is only treated as gone once its lost_at is older than more than
// one serve reconciler tick (cmd/communication/serve.go drives the tick every
// 2 s), so a loss a worker is still reporting cannot terminalise a run that a
// later pass would find restored. runtime_read.go's hydration is the only
// reader; the engine's rule lives in the advancer.
const m4WorkspaceLostGrace = 5 * time.Second

// ReconcileLeases is § 5.4 pass 1; ReconcileDeadlines is pass 3. Both
// re-derive from the rows they just hydrated, so a pass from any replica is
// the same function on the same data.
func (s *RuntimeStore) ReconcileLeases(ctx context.Context, runID string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.ReconcileLeases(runID)
	}, nil)
}

func (s *RuntimeStore) ReconcileDeadlines(ctx context.Context, runID string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.ReconcileDeadlines(runID)
	}, nil)
}

// InterruptWorkspaceLost is § 5.4 pass 5's evidence seam for a store that has
// no workspace rows of its own to consult (the conformance suite's in-memory
// session). A real deployment never calls it: hydrateRunTx reads the loss from
// `workspaces` and the advancer applies the same rule on the ordinary advance.
// It runs the advance rather than the transition itself, so the consequence —
// cancel open rows, interrupt, never retry — has exactly one implementation.
func (s *RuntimeStore) InterruptWorkspaceLost(ctx context.Context, runID string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, st *runtime.State) error {
		st.Run.WorkspaceLost = true
		if ms.Adv != nil {
			return ms.Adv.Advance(st, ms.Now())
		}
		return nil
	}, nil)
}

// ------------------------------------------------------------------ gates

// Decide applies the gate's CAS decision (§ 5.3). The authorization refusal
// commits ONLY its approval.denied append and returns ErrApprovalConflict
// (a refusal is not a decision, but the denial is an event — 12 case 9,
// C9b); a CAS miss (stale version / already decided) appends nothing and
// commits nothing.
func (s *RuntimeStore) Decide(ctx context.Context, runID, approvalID, decision, comments, decider string,
	version int, authorize runtime.AuthorizeFunc) error {

	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Decide(runID, approvalID, decision, comments, rteIdentity(decider), version, authorize)
	}, func(err error, appended []pevents.Record) bool {
		var conflict runtime.ErrApprovalConflict
		if !errors.As(err, &conflict) {
			return false
		}
		if conflict.Reason == "stale_version" || conflict.Reason == "already_decided" {
			return false // CAS arms: zero rows, zero journal
		}
		for _, rec := range appended {
			if rec.Type != pevents.TypeApprovalDenied {
				return false
			}
		}
		return len(appended) > 0
	})
}

// -------------------------------------------------------------------- retry

// Retry is contract route 31's engine half over rows: reopen failed /
// interrupted / cancelled targets append-only, re-queue attempts with the
// decision's continue_workspace context, and journal run.retried — the
// whole reopen or none of it.
func (s *RuntimeStore) Retry(ctx context.Context, runID, requestedBy string, targets []string, inputOverrides map[string]any) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.Retry(runID, rteIdentity(requestedBy), targets, inputOverrides)
	}, nil)
}

// ---------------------------------------------------- human takeover (§ 5.3)

// takeoverRuntime is the adapter the CONVERSATION-side transactions drive: it
// owns no pool because its transaction is the caller's, and it carries no
// advancer because advancerForTx rebuilds the right one from the run row's own
// plan_snapshot on every call. There is one RuntimeStore per mutation, exactly
// as there is one throwaway MemStore per transaction.
func takeoverRuntime() *RuntimeStore { return NewRuntimeStore(nil, nil) }

// HumanTakeover is contract § 5.3 / ADR-0016 § 5's run half of a takeover:
// the attempt closes interrupted{human_takeover} and the run pauses with that
// reason, through the engine arm (pause first, so the follow-up advance
// schedules no retry for the attempt the human is taking over). Unfenced by
// design, like every reconciler-side close: the human's CAS on the control row
// is the authorization, and the attempt's own worker learns to stop from the
// turn's cancel_requested_at that the same transaction wrote.
func (s *RuntimeStore) HumanTakeover(ctx context.Context, runID, attemptID, requestedBy string) error {
	return s.settle(ctx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.MarkCancelledByHumanTakeover(runID, attemptID, rteIdentity(requestedBy))
	}, nil)
}

// HumanTakeoverTx is HumanTakeover on the caller's transaction — the form
// CnvStore.TakeControl uses, because "control moved" and "the run paused" are
// one fact (ADR-0016 § 5).
func (s *RuntimeStore) HumanTakeoverTx(ctx context.Context, tx pgx.Tx, runID, attemptID, requestedBy string) error {
	_, err := s.settleTx(ctx, tx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.MarkCancelledByHumanTakeover(runID, attemptID, rteIdentity(requestedBy))
	}, nil)
	return err
}

// ResumeFromHumanTakeover is return-control's run half: the takeover pause is
// lifted and the interrupted node's next attempt carries the recorded
// intervention as retry_context (ADR-0016 § 5, ADR-0023 § 6, C9g). intervention
// is what the human did while they held the conversation, assembled by the
// caller from the transcript rows; the engine neither invents nor forgets it.
func (s *RuntimeStore) ResumeFromHumanTakeoverTx(ctx context.Context, tx pgx.Tx,
	runID, attemptID, requestedBy string, intervention any) error {
	_, err := s.settleTx(ctx, tx, runID, func(_ context.Context, _ pgx.Tx, ms *runtime.MemStore, _ *runtime.State) error {
		return ms.ResumeFromHumanTakeover(runID, attemptID, rteIdentity(requestedBy), intervention)
	}, nil)
	return err
}

// Advance is the reconciler's backstop trigger (§ 5.1: called after every
// event that can change readiness, and by the reconciler regardless).
func (s *RuntimeStore) Advance(ctx context.Context, runID string) error {
	return s.Transact(ctx, runID, func(*runtime.Tx) error { return nil })
}

// NextDue reports the earliest future moment the run waits on, from a fresh
// read of the rows (a scheduled retry's landing time or a gate deadline).
func (s *RuntimeStore) NextDue(ctx context.Context, runID string) (time.Time, bool) {
	st, err := s.Read(ctx, runID)
	if err != nil {
		return time.Time{}, false
	}
	next := time.Time{}
	set := func(t time.Time) {
		if t.IsZero() {
			return
		}
		if next.IsZero() || t.Before(next) {
			next = t
		}
	}
	for _, a := range st.Attempts {
		if a.Status == runtime.AttemptQueued {
			set(a.ScheduledAt)
		}
	}
	for _, ap := range st.Approvals {
		if ap.State == runtime.ApprovalPending {
			set(ap.DeadlineAt)
		}
	}
	if next.IsZero() {
		return time.Time{}, false
	}
	return next, true
}

// Read is the honest read-your-commit view of one run: a fresh hydration
// from rows, outside any lock (the snapshot the engine would see if it
// settled right now). Nothing is kept from a previous call.
func (s *RuntimeStore) Read(ctx context.Context, runID string) (*runtime.State, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("postgres: begin runtime read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	st, err := hydrateTx(ctx, tx, runID)
	if err != nil {
		return nil, err
	}
	return st, nil
}

// ------------------------------------------------------------- write-back

// hydratedRows is the row-identity + change-detection baseline of one
// transaction: the values as the database held them at hydration time. It
// exists ONLY to answer "did fn move this row" (write ONLY mutated rows);
// it is never restored into anything — the engine's state is born and dies
// inside settle, and no copy of it outlives the call.
type hydratedRows struct {
	run         runtime.Run
	nodes       map[string]runtime.NodeExecution
	attempts    map[string]runtime.Attempt
	approvals   map[string]runtime.Approval
	checkpoints map[string]runtime.CheckpointRecord
	invocations map[string]runtime.Invocation
}

func snapshotRows(st *runtime.State) hydratedRows {
	h := hydratedRows{
		run:         *st.Run,
		nodes:       map[string]runtime.NodeExecution{},
		attempts:    map[string]runtime.Attempt{},
		approvals:   map[string]runtime.Approval{},
		checkpoints: map[string]runtime.CheckpointRecord{},
		invocations: map[string]runtime.Invocation{},
	}
	for _, n := range st.Nodes {
		h.nodes[n.ID] = *n
	}
	for _, a := range st.Attempts {
		h.attempts[a.ID] = *a
	}
	for _, ap := range st.Approvals {
		h.approvals[ap.ID] = *ap
	}
	for _, c := range st.Checkpoints {
		h.checkpoints[c.RunID+"\x00"+c.NodeExecutionID] = c
	}
	for _, iv := range st.Invocations {
		h.invocations[iv.NodeExecutionID] = iv
	}
	return h
}

// mintedIDPattern matches the ids the advancer mints inside a transaction
// (advancer.go/retry.go: NewID("ne"|"at"|"ap"|"inv")). Row ids and event
// correlation columns for these names hash under the run's uuid namespace;
// ids already uuid (every hydrated row) pass through untouched.
var mintedIDPattern = regexp.MustCompile(`^(ne|at|ap|inv)[0-9]+$`)

// rteColID maps a state-side row reference to its ledger uuid: minted ids
// (ne/at/ap/inv + counter) hash under the run's namespace; hydrated rows
// already carry uuids and pass through.
func rteColID(runID, ref string) string {
	if ref == "" {
		return ""
	}
	if mintedIDPattern.MatchString(ref) {
		return rteRowUUID(runID, ref)
	}
	return ref
}

// rtePayloadIDs rewrites ONLY exact-match string values that are minted row
// ids inside an event payload, so § 3's payload correlations speak ledger
// uuids. No substring rewriting: instance keys, digests and decision words
// cannot collide with the mint grammar by construction.
func rtePayloadIDs(runID string, payload any) any {
	raw, err := json.Marshal(payload)
	if err != nil {
		return payload
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return payload
	}
	out := mintedToUUIDs(doc, runID)
	b, err := json.Marshal(out)
	if err != nil {
		return payload
	}
	return json.RawMessage(b)
}

func mintedToUUIDs(v any, runID string) any {
	switch t := v.(type) {
	case map[string]any:
		for k, elem := range t {
			if s, ok := elem.(string); ok && mintedIDPattern.MatchString(s) {
				t[k] = rteRowUUID(runID, s)
				continue
			}
			t[k] = mintedToUUIDs(elem, runID)
		}
		return t
	case []any:
		for i, elem := range t {
			if s, ok := elem.(string); ok && mintedIDPattern.MatchString(s) {
				t[i] = rteRowUUID(runID, s)
				continue
			}
			t[i] = mintedToUUIDs(elem, runID)
		}
		return t
	}
	return v
}

// writeRowsTx persists the engine's mutations: new rows INSERT, rows the
// diff finds moved UPDATE, untouched rows write nothing, then the journal
// appends — state and events share this transaction (ADR-0013). It only
// ever speaks uuids (rteColID), including for rows minted mid-pass.
func writeRowsTx(ctx context.Context, tx pgx.Tx, st *runtime.State, hydrated hydratedRows, journalLen int) error {

	runID := st.Run.ID
	if !reflect.DeepEqual(hydrated.run, *st.Run) {
		if err := writeRunTx(ctx, tx, st.Run); err != nil {
			return err
		}
	}
	for _, n := range st.Nodes {
		id := rteColID(runID, n.ID)
		old, existed := hydrated.nodes[n.ID]
		if !existed {
			if err := insertNodeTx(ctx, tx, runID, id, n); err != nil {
				return err
			}
			continue
		}
		if reflect.DeepEqual(old, *n) {
			continue // untouched row: no write
		}
		if err := updateNodeTx(ctx, tx, id, n); err != nil {
			return err
		}
	}
	for _, a := range st.Attempts {
		id := rteColID(runID, a.ID)
		nodeID := rteColID(runID, a.NodeExecutionID)
		old, existed := hydrated.attempts[a.ID]
		if !existed {
			if err := insertAttemptTx(ctx, tx, runID, id, nodeID, a); err != nil {
				return err
			}
			continue
		}
		if reflect.DeepEqual(old, *a) {
			continue
		}
		if err := updateAttemptTx(ctx, tx, id, a); err != nil {
			return err
		}
		// ADR-0023 § 4 step 1's decrement is not the worker's private debt. The
		// engine terminalizes attempts on behalf of writers that can never reach
		// RunStore.FinishAttempt — § 5.4 pass 1's lease interrupt, pass 5's lost
		// workspace, a run cancel's cascade, § 5.3's human takeover hand-off, a
		// control-plane fail — and this write-back is the single place all of
		// them land. The slot goes back in THIS transaction, exactly once: the
		// diff's own previous status (hydrated under the run row lock) must have
		// been non-terminal, so a second pass over an already-terminal row writes
		// nothing here.
		if !attemptStatusTerminal(old.Status) && attemptStatusTerminal(a.Status) {
			if err := releaseWorkerSlotTx(ctx, tx, id); err != nil {
				return err
			}
		}
	}
	for _, ap := range st.Approvals {
		id := rteColID(runID, ap.ID)
		nodeID := rteColID(runID, ap.NodeExecutionID)
		old, existed := hydrated.approvals[ap.ID]
		if !existed {
			if err := insertApprovalTx(ctx, tx, st.Run, id, nodeID, ap); err != nil {
				return err
			}
			continue
		}
		if reflect.DeepEqual(old, *ap) {
			continue
		}
		if err := updateApprovalTx(ctx, tx, id, ap); err != nil {
			return err
		}
	}
	for _, c := range st.Checkpoints {
		key := c.RunID + "\x00" + c.NodeExecutionID
		if _, existed := hydrated.checkpoints[key]; existed {
			continue // boundary records are append-only history
		}
		if err := insertCheckpointTx(ctx, tx, runID, c); err != nil {
			return err
		}
	}
	for _, iv := range st.Invocations {
		if _, existed := hydrated.invocations[iv.NodeExecutionID]; existed {
			continue
		}
		if err := insertInvocationTx(ctx, tx, runID, iv); err != nil {
			return err
		}
	}
	return appendJournalTx(ctx, tx, st, journalLen)
}

// appendJournalTx appends the records the engine added inside this
// transaction, bridged through the exported helpers in run_journal.go.
// A worker-actor record carries the attempt owner as its honest actor id
// (MemStore's actorWorker leaves the id blank by design); one without a
// resolvable owner is the emitter's bug and is refused loudly.
func appendJournalTx(ctx context.Context, tx pgx.Tx, st *runtime.State, journalLen int) error {
	runID := st.Run.ID
	for _, rec := range st.Events[journalLen:] {
		out := rec
		out.RunID = rteColID(runID, rec.RunID)
		out.NodeExecutionID = rteColID(runID, rec.NodeExecutionID)
		out.AttemptID = rteColID(runID, rec.AttemptID)
		out.ActorID = rec.ActorID
		if out.ActorID == "" && rec.ActorKind == pevents.ActorKindWorker {
			var owner string
			for _, a := range st.Attempts {
				if a.ID == rec.AttemptID {
					owner = a.WorkerID
					break
				}
			}
			if owner == "" {
				return fmt.Errorf("postgres: %s has actor kind worker but no attempt owner to attribute it", rec.Type)
			}
			out.ActorID = rteIdentity(owner)
		}
		out.Payload = rtePayloadIDs(runID, rec.Payload)
		if err := AppendRecordTx(ctx, tx, out); err != nil {
			return err
		}
	}
	return nil
}

func writeRunTx(ctx context.Context, tx pgx.Tx, r *runtime.Run) error {
	// The pins (digests, snapshots, scope ids) are immutable (12 case 11);
	// only the engine-owned columns move, and only when they differ from
	// what was hydrated — hydrateRunTx re-reads them, so the diff lives on
	// the Run struct itself against the values SELECT returned.
	_, err := tx.Exec(ctx, `
		UPDATE runs
		SET status               = $2,
		    failed_cause         = NULLIF($3, ''),
		    paused_reason        = NULLIF($4, ''),
		    cancel_requested_at  = $5,
		    expression_evaluations = $6,
		    started_at           = $7,
		    finished_at          = $8
		WHERE id = $1::uuid`,
		r.ID, r.Status, r.FailedCause, r.PausedReason, r.CancelRequestedAt,
		r.ExpressionEvaluations, rteTimePtr(r.StartedAt), rteTimePtr(r.FinishedAt))
	if err != nil {
		return fmt.Errorf("postgres: write run %s: %w", r.ID, err)
	}
	return nil
}

func insertNodeTx(ctx context.Context, tx pgx.Tx, runID, id string, n *runtime.NodeExecution) error {
	outputs, err := rteJSON(n.Outputs)
	if err != nil {
		return err
	}
	refs, err := rteJSONArray(n.ArtifactRefs)
	if err != nil {
		return err
	}
	depends, err := rteJSONArray(n.DependsOn)
	if err != nil {
		return err
	}
	scope := n.ScopeKey
	if scope == "" {
		scope = "/"
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO node_executions
			(id, run_id, node_id, kind, node_instance_key, scope_key, execution_location,
			 status, outputs, outcome, error_class, failed_cause, artifact_refs, depends_on,
			 attempt_count, attempt_limit, in_flight, waiting_reason,
			 created_at, ready_at, finished_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7,
		        $8, NULLIF($9, '')::jsonb, NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''),
		        $13::jsonb, COALESCE(NULLIF($14, '')::jsonb, '[]'::jsonb),
		        $15, $16, $17, NULLIF($18, ''),
		        $19, $20, $21)`,
		id, runID, n.NodeID, n.Kind, n.InstanceKey, scope, n.Location,
		n.Status, outputs, n.Outcome, n.ErrorClass, n.FailedCause, refs, depends,
		n.AttemptCount, n.AttemptLimit, n.InFlight, n.Waiting,
		n.CreatedAt.UTC(), rteTimePtr(n.ReadyAt), rteTimePtr(n.FinishedAt))
	if err != nil {
		return fmt.Errorf("postgres: insert node %s (%s): %w", n.InstanceKey, n.Status, err)
	}
	return nil
}

func updateNodeTx(ctx context.Context, tx pgx.Tx, id string, n *runtime.NodeExecution) error {
	outputs, err := rteJSON(n.Outputs)
	if err != nil {
		return err
	}
	refs, err := rteJSONArray(n.ArtifactRefs)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE node_executions
		SET status = $2, outputs = NULLIF($3, '')::jsonb, outcome = NULLIF($4, ''),
		    error_class = NULLIF($5, ''), failed_cause = NULLIF($6, ''),
		    artifact_refs = $7::jsonb, attempt_count = $8, in_flight = $9,
		    waiting_reason = NULLIF($10, ''),
		    ready_at = $11, finished_at = $12
		WHERE id = $1::uuid`,
		id, n.Status, outputs, n.Outcome, n.ErrorClass, n.FailedCause,
		refs, n.AttemptCount, n.InFlight, n.Waiting,
		rteTimePtr(n.ReadyAt), rteTimePtr(n.FinishedAt))
	if err != nil {
		return fmt.Errorf("postgres: update node %s (%s): %w", id, n.Status, err)
	}
	return nil
}

func insertAttemptTx(ctx context.Context, tx pgx.Tx, runID, id, nodeID string, a *runtime.Attempt) error {
	outputs, err := rteJSON(a.Outputs)
	if err != nil {
		return err
	}
	refs, err := rteJSONArray(a.ArtifactRefs)
	if err != nil {
		return err
	}
	errs, err := rteJSONArray(a.OutputErrors)
	if err != nil {
		return err
	}
	overrides, err := rteJSON(a.Overrides)
	if err != nil {
		return err
	}
	retryCtx, err := rteJSON(a.RetryContext)
	if err != nil {
		return err
	}
	scheduled := a.ScheduledAt
	if scheduled.IsZero() {
		scheduled = time.Now().UTC()
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO attempts
			(id, node_execution_id, run_id, attempt_number, status, error_class, detail,
			 output_errors, worker_id, lease_expires_at, fencing_token,
			 scheduled_at, deadline_at, cancel_requested_at, outputs, outputs_digest,
			 artifact_refs, overrides, retry_context,
			 created_at, started_at, finished_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULLIF($6, ''), LEFT(NULLIF($7, ''), 512),
		        $8::jsonb, NULLIF($9, '')::uuid, $10, $11,
		        $12, $13, $14, NULLIF($15, '')::jsonb, NULLIF($16, ''),
		        $17::jsonb, NULLIF($18, '')::jsonb, NULLIF($19, '')::jsonb,
		        $20, $21, $22)`,
		id, nodeID, runID, a.AttemptNumber, a.Status, a.ErrorClass, a.Detail,
		errs, rteIdentity(a.WorkerID), rteTimePtr(a.LeaseExpiresAt), a.FencingToken,
		scheduled.UTC(), rteTimePtr(a.DeadlineAt), a.CancelRequested,
		outputs, a.OutputsDigest, refs, overrides, retryCtx,
		a.CreatedAt.UTC(), rteTimePtr(a.StartedAt), rteTimePtr(a.FinishedAt))
	if err != nil {
		return fmt.Errorf("postgres: insert attempt %s (%s): %w", id, a.Status, err)
	}
	return nil
}

func updateAttemptTx(ctx context.Context, tx pgx.Tx, id string, a *runtime.Attempt) error {
	outputs, err := rteJSON(a.Outputs)
	if err != nil {
		return err
	}
	refs, err := rteJSONArray(a.ArtifactRefs)
	if err != nil {
		return err
	}
	errs, err := rteJSONArray(a.OutputErrors)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		UPDATE attempts
		SET status = $2, error_class = NULLIF($3, ''), detail = LEFT(NULLIF($4, ''), 512),
		    output_errors = $5::jsonb, worker_id = NULLIF($6, '')::uuid,
		    lease_expires_at = $7, fencing_token = $8,
		    deadline_at = $9, cancel_requested_at = $10,
		    outputs = NULLIF($11, '')::jsonb, outputs_digest = NULLIF($12, ''),
		    artifact_refs = $13::jsonb,
		    started_at = $14, finished_at = $15
		WHERE id = $1::uuid`,
		id, a.Status, a.ErrorClass, a.Detail, errs, rteIdentity(a.WorkerID),
		rteTimePtr(a.LeaseExpiresAt), a.FencingToken,
		rteTimePtr(a.DeadlineAt), a.CancelRequested,
		outputs, a.OutputsDigest, refs,
		rteTimePtr(a.StartedAt), rteTimePtr(a.FinishedAt))
	if err != nil {
		return fmt.Errorf("postgres: update attempt %s (%s): %w", id, a.Status, err)
	}
	return nil
}

func insertApprovalTx(ctx context.Context, tx pgx.Tx, r *runtime.Run, id, nodeID string, ap *runtime.Approval) error {
	refs, err := rteJSONArray(ap.ArtifactRefs)
	if err != nil {
		return err
	}
	roles := ap.ApproverRoles
	if roles == nil {
		roles = []string{}
	}
	userIDs := make([]string, 0, len(ap.ApproverUserIDs))
	for _, u := range ap.ApproverUserIDs {
		userIDs = append(userIDs, rteIdentity(u))
	}
	onTimeout := ap.OnTimeout
	if onTimeout == "" {
		onTimeout = "fail"
	}
	kind := ap.Kind
	if kind == "" {
		kind = "pipeline_gate"
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO approval_requests
			(id, organization_id, project_id, run_id, node_execution_id, kind, summary,
			 artifact_refs, approver_roles, approver_user_ids, deadline_at, on_timeout,
			 re_requested, state, decision, comments, decided_by, decided_at, version, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, NULLIF($7, ''),
		        $8::jsonb, $9::text[], COALESCE($10::uuid[], '{}'::uuid[]), $11, $12, $13, $14,
		        NULLIF($15, ''), LEFT(NULLIF($16, ''), 8192), NULLIF($17, '')::uuid, $18, $19, $20)`,
		id, r.OrganizationID, r.ProjectID, r.ID, nodeID, kind, ap.Summary,
		refs, roles, userIDs, ap.DeadlineAt.UTC(), onTimeout, ap.ReRequested, ap.State,
		ap.Decision, ap.Comments, rteIdentity(ap.DecidedBy),
		rteTimePtr(ap.DecidedAt), ap.Version, ap.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("postgres: insert approval %s (%s): %w", id, ap.State, err)
	}
	return nil
}

func updateApprovalTx(ctx context.Context, tx pgx.Tx, id string, ap *runtime.Approval) error {
	_, err := tx.Exec(ctx, `
		UPDATE approval_requests
		SET state = $2, decision = NULLIF($3, ''), comments = LEFT(NULLIF($4, ''), 8192),
		    decided_by = NULLIF($5, '')::uuid, decided_at = $6, version = $7,
		    deadline_at = $8, re_requested = $9
		WHERE id = $1::uuid`,
		id, ap.State, ap.Decision, ap.Comments, rteIdentity(ap.DecidedBy),
		rteTimePtr(ap.DecidedAt), ap.Version, ap.DeadlineAt.UTC(), ap.ReRequested)
	if err != nil {
		return fmt.Errorf("postgres: update approval %s (%s): %w", id, ap.State, err)
	}
	return nil
}

func insertCheckpointTx(ctx context.Context, tx pgx.Tx, runID string, c runtime.CheckpointRecord) error {
	refs, err := rteJSONArray(c.ArtifactRefs)
	if err != nil {
		return err
	}
	states := make([]map[string]any, 0, len(c.RepoStates))
	for _, r := range c.RepoStates {
		m := map[string]any{
			"repository_id":       r.RepositoryID,
			"base_commit":         r.BaseCommit,
			"head_commit":         r.HeadCommit,
			"committed":           r.Committed,
			"modified_path_count": r.ModifiedPathCount,
		}
		if r.ModifiedPathsArtifact != "" {
			m["modified_paths_artifact"] = r.ModifiedPathsArtifact
		}
		states = append(states, m)
	}
	repos, err := json.Marshal(states)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO run_checkpoints
			(run_id, node_execution_id, attempt_id, inputs_digest, outputs_digest,
			 artifact_refs, repo_states, workspace_id, volume_id, worker_id, plan_digest, created_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb,
		        $8::uuid, $9, $10::uuid, $11, $12)`,
		runID, rteColID(runID, c.NodeExecutionID), rteColID(runID, c.AttemptID),
		c.InputsDigest, c.OutputsDigest, refs, string(repos),
		rteIdentity(c.WorkspaceID), c.VolumeID, rteIdentity(c.WorkerID),
		c.PlanDigest, c.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("postgres: insert checkpoint run=%s node=%s: %w", runID, c.NodeExecutionID, err)
	}
	return nil
}

func insertInvocationTx(ctx context.Context, tx pgx.Tx, runID string, iv runtime.Invocation) error {
	// This is the ONE writer of pipeline_invocations (ADR-0023 § 10's
	// "resolved once and stored on the invocation", runtime/advancer.go's
	// ChildResolver contract): the parent's own advance transaction, because the
	// row references the node execution that only this transaction has created.
	// The host child resolver owns the RESOLUTION and reports the ids it
	// resolved (postgres.M4Children.CreateChild -> runtime.ChildOutcome); an
	// invocation whose target nobody resolved is the in-memory record of a
	// scripted host, and there is nothing truthful to write into NOT NULL
	// pipeline_id / resolved_revision_id.
	//
	// The insert is idempotent rather than fatal: § 8's "calling Advance twice
	// has one effect" means a retried pass may not be stopped by a booking that
	// already exists.
	if iv.PipelineID == "" || iv.ResolvedRevisionID == "" {
		return nil
	}
	// A booking this transaction already made (or one a previous pass committed
	// and the caller did not hydrate) answers before the insert.
	var booked bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pipeline_invocations WHERE node_execution_id = $1::uuid)`,
		rteColID(runID, iv.NodeExecutionID)).Scan(&booked); err != nil {
		return fmt.Errorf("postgres: check invocation of node execution %s: %w", iv.NodeExecutionID, err)
	}
	if booked {
		return nil
	}
	waitPolicy := iv.WaitPolicy
	if waitPolicy == "" {
		waitPolicy = "completion"
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO pipeline_invocations
			(id, run_id, node_execution_id, child_run_id, child_project_id, pipeline_id,
			 resolved_revision_id, wait_policy, depth, created_at, updated_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10, $10)
		ON CONFLICT (node_execution_id) DO NOTHING`,
		rteColID(runID, iv.ID), runID, rteColID(runID, iv.NodeExecutionID),
		iv.ChildRunID, iv.ChildProjectID, iv.PipelineID, iv.ResolvedRevisionID,
		waitPolicy, iv.Depth, iv.CreatedAt.UTC())
	if err != nil {
		return fmt.Errorf("postgres: insert invocation %s: %w", iv.ID, err)
	}
	return nil
}
