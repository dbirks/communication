// Package runtimetest is the reusable Store-conformance harness for the M4
// execution engine: one suite of named subtests that any runtime.Store
// implementation (the in-memory reference today, the Postgres adapter of
// docs/m4-contract.md § 5 later) must pass unchanged.
//
// The suite is written against the Factory/Session seam, never against
// MemStore directly, so plugging a real adapter in is only an
// Open implementation. Every expectation in here was DERIVED BY OBSERVING
// MemStore's actual behaviour (AGENTS.md: a mocked green test never
// substitutes for the real integration layer — this harness makes the real
// adapter prove the mocked semantics, not the other way round). Where the
// contract text and MemStore's observed behaviour disagree, the subtest
// follows MemStore and the comment says so.
//
// Cited authorities: docs/m4-contract.md § 4 (worker duties), § 5
// (control-plane duties, one transaction per state change / ADR-0013), § 8
// (test matrix: "the two-claim race", "advancer idempotence (advance twice,
// one effect)", "approval CAS"); communication-spec/12-test-strategy.md
// cases 2/3/5/9; ADR-0016 § 3 (token drawn once per claim), ADR-0023
// § 4-§ 6 (leases, fencing, checkpoints), ADR-0023 § 9 (gates), ADR-0024.
package runtimetest

import (
	"reflect"
	"testing"
	"time"

	pevents "github.com/dbirks/communication/internal/pipelines/events"
	"github.com/dbirks/communication/internal/pipelines/runtime"
)

// Pipeline names the fixtures the suite drives. Each is a real authored
// document (loader → schema → compiler, the publish path) embedded here so a
// harness user in any package can run the suite without testdata paths.
type Pipeline string

const (
	// PipelineSingle is one worker node (/work) with an outputs schema and no
	// retry block: the claim/start/renew/complete, stale-owner, two-claim and
	// boundary shapes, plus the honest terminal-failure + run-level Retry.
	PipelineSingle Pipeline = "conform-single"
	// PipelineRetry is one worker node with an authored retry budget
	// (infra/interrupted/timeout retriable): the lease-expiry / late-write
	// shapes where a replacement attempt must appear.
	PipelineRetry Pipeline = "conform-retry"
	// PipelineGate is one human.approval node: the Decide/CAS shapes
	// (12 case 9, contract § 5.3, ADR-0023 § 9).
	PipelineGate Pipeline = "conform-gate"
	// PipelineOutputs is one process.exec reviewer that DECLARES
	// `evidence: boolean` with `invalid_output` in its retriable errors: the
	// § 7.1 C10 shape (a reply its own plan refuses, at the boundary).
	PipelineOutputs Pipeline = "conform-outputs"
	// PipelineUntil is a bounded `until` whose passWhen can never become
	// true (maxIterations 3, one process.exec body node): the § 7.1 C7 shape
	// — one node.scope.iteration per iteration, run failed|until_exhausted.
	PipelineUntil Pipeline = "conform-until"
	// PipelineSkip has a worker node gated false (when: false for every
	// admitted input), its dependant, and one plain work node: the
	// pending → skipped edge that contract § 1's
	// node_executions_ready_timestamped CHECK exists to police.
	PipelineSkip Pipeline = "conform-skip"
)

// Default inputs every fixture admits (spec.inputs requires `goal`).
func defaultInputs() map[string]any { return map[string]any{"goal": "conformance"} }

// Epoch is the fixed clock start (scenario tests pin ids/timestamps; a
// wall-clock epoch would make -count=2 comparisons drift).
var Epoch = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

// DefaultLease is ADR-0023 § 4's 30 s attempt lease (runtime's unexported
// defaultLease twin).
const DefaultLease = 30 * time.Second

// Worker identities the suite injects; named so a stale-owner subtest reads
// as owner A vs thief B.
const (
	WorkerA = "worker-a"
	WorkerB = "worker-b"
	WorkerC = "worker-c"
)

// Config is what ConformanceTests asks a Factory to build per subtest.
type Config struct {
	// Pipeline selects the embedded plan the run pins (ADR-0023 § 1/§ 2:
	// a run executes a plan snapshot, 12 case 11).
	Pipeline Pipeline
	// Inputs overrides the default run inputs when non-nil.
	Inputs map[string]any
	// Lease is the attempt lease duration; zero ⇒ DefaultLease (ADR-0023 § 4).
	Lease time.Duration
	// Start is the clock's opening value; zero ⇒ Epoch.
	Start time.Time
	// Deps wires extra advancer capabilities (ChildResolver); the suite
	// itself never needs them.
	Deps runtime.AdvancerDeps
}

// Factory opens a fresh, fully isolated run per subtest: no state may leak
// between subtests or between -count runs. Open must fail the test loudly
// (t.Fatal), never return a half-built session.
type Factory interface {
	Open(t *testing.T, cfg Config) Session
}

// Completion is the boundary transaction's write set (contract § 4 step 10:
// outputs + digest + artifact refs + the checkpoint record, in one txn).
type Completion struct {
	Outputs       any
	OutputsDigest string
	ArtifactRefs  []any
	Outcome       string
	Checkpoint    runtime.CheckpointRecord
}

// BoundaryDigest is the outputs digest the suite writes through the happy
// boundary. attempts.outputs_digest carries § 1's CHECK
// (^sha256:[0-9a-f]{64}$), so a fixture digest must satisfy it: the Postgres
// adapter mirrors every Completion into the real ledger, and a shape the
// database rejects is not a conformance input worth pinning. (MemStore never
// checked this; the CHECK is the contract, not the adapter — 12-test-strategy:
// constraint behaviour on a database that ran the migration.)
const BoundaryDigest = "sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// AtomicBoundary is an optional Session capability: BoundaryIsAtomic reports
// true when the store's boundary transaction is the contract § 5 all-or-nothing
// one — every Complete/Fail/Decide writes and journal rows commit together, or
// nothing does. The reference MemStore does NOT implement it: its Complete
// mutates the attempt and node rows BEFORE CheckpointRecord.Check() runs, so
// a Check refusal leaves the success half-written (an observed deviation from
// contract § 5 the harness documents, per the package rule "the subtest
// follows MemStore and the comment says so"). The Postgres adapter implements
// it and must roll back; the boundary subtest asserts the rollback arm only
// for stores that claim it, so MemStore keeps its observed behaviour and the
// real adapter is still held to the contract.
type AtomicBoundary interface {
	BoundaryIsAtomic() bool
}

// boundaryAtomic reports whether the session's store promises § 5's
// all-or-nothing boundary.
func boundaryAtomic(s Session) bool {
	a, ok := s.(AtomicBoundary)
	return ok && a.BoundaryIsAtomic()
}

// GateDecision is one POST /approvals/{id}/decide (contract § 5.3).
type GateDecision struct {
	ApprovalID string
	Decision   string // "approved" | "rejected"
	Comments   string
	Decider    string
	Version    int
	Authorize  runtime.AuthorizeFunc
}

// Session is one isolated run inside one store, driven through the same
// fenced surface the worker/reconciler/API use. Every write op carries its
// own worker identity and fencing token so a conformance subtest can present
// stale or forged credentials (12 case 3, ADR-0023 § 4).
type Session interface {
	// RunID names the single live run registered by Open.
	RunID() string
	// Store exposes the runtime.Store under test (Transact seam).
	Store() runtime.Store
	// Program is the compiled plan the run is pinned to.
	Program() *runtime.Program

	// Now reads the session's driven clock; SetNow moves it (hermetic twin
	// of the reconciler poll loop, contract § 5.4).
	Now() time.Time
	SetNow(at time.Time)

	// State returns the authoritative row set for assertions.
	State(t *testing.T) *runtime.State
	// Events returns a journal SNAPSHOT (copy) for append-only prefix
	// comparisons.
	Events(t *testing.T) []pevents.Record

	// Advance is the explicit reconciler backstop (contract § 5.1).
	Advance() error
	// NextDue reports the earliest scheduled/backoff moment (may be absent).
	NextDue() (time.Time, bool)

	// Worker ops, fenced on the presented identity+token.
	Claim(workerID string) (*runtime.Attempt, error)
	Start(attemptID, workerID string, token int64) error
	Renew(attemptID, workerID string, token int64) error
	Complete(attemptID, workerID string, token int64, c Completion) error
	Fail(attemptID, workerID string, token int64, class, detail string) error
	// Interrupt is the reconciler's honest terminal (or worker self-close),
	// unfenced by design (contract § 5.4 pass 1, § 3 row 23).
	Interrupt(attemptID, reason string) error

	// Reconciler passes 1 and 3 (contract § 5.4).
	ReconcileLeases() error
	ReconcileDeadlines() error

	// InterruptWorkspaceLost feeds pass 5's evidence (the run's workspace is
	// gone) to the engine, which owns the consequence — contract § 5.4. A real
	// deployment reads the same evidence from `workspaces` on the ordinary
	// advance; the seam exists so the conformance suite can drive the arm
	// without a worker, and passes 2 and 4 need no such seam because their
	// evidence (deadline_at, maxDurationSeconds) is already rows the suite
	// moves with SetNow.
	InterruptWorkspaceLost() error

	// Decide is the gate CAS surface (contract § 5.3).
	Decide(d GateDecision) error
	// Retry is contract route 31's engine half (append-only reopen).
	Retry(requestedBy string, targets []string, inputOverrides map[string]any) error
}

// NewCheckpoint builds a valid boundary record (run_checkpoints_volume_
// required, D-009): digests, workspace/volume/worker identity all named.
func NewCheckpoint(workerID string) runtime.CheckpointRecord {
	return runtime.CheckpointRecord{
		InputsDigest:  "sha256:" + rep("1", 64),
		OutputsDigest: "sha256:" + rep("2", 64),
		ArtifactRefs:  []any{},
		RepoStates: []runtime.RepoState{{
			RepositoryID: "app", BaseCommit: "base1", HeadCommit: "head1",
			Committed: true, ModifiedPathCount: 2,
		}},
		WorkspaceID: "ws1", VolumeID: "vol-a", WorkerID: workerID,
	}
}

func rep(c string, n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = c[0]
	}
	return string(out)
}

// ConformanceTests runs the whole suite. Each subtest gets a fresh session
// from f, so the same call works for MemStore today and the Postgres adapter
// later; running it with -count=2 must stay green (isolation claim).
func ConformanceTests(t *testing.T, f Factory) {
	t.Helper()
	t.Run("Claim_Start_Renew_Complete_HappyPath", func(t *testing.T) { testHappyPath(t, f) })
	t.Run("CompleteWithStaleToken_RefusedWritesNothing", func(t *testing.T) { testStaleTokenWritesNothing(t, f) })
	t.Run("TwoWorkers_ClaimExactlyOneWins", func(t *testing.T) { testTwoClaimRace(t, f) })
	t.Run("ReconcilerInterrupt_AppendOnly_LateCompleteRefused", func(t *testing.T) { testInterruptAndLateComplete(t, f) })
	t.Run("Boundary_CompletePersistsEverythingOrNothing", func(t *testing.T) { testBoundaryAtomicity(t, f) })
	t.Run("Boundary_DeclaredOutputsRefused_InvalidOutputAndRetry", func(t *testing.T) {
		testDeclaredOutputsBoundary(t, f)
	})
	t.Run("Until_IterationEvents_AppendOncePerIteration_ExhaustedFailsRun", func(t *testing.T) {
		testUntilIterationEventsOnce(t, f)
	})
	t.Run("Decide_AuthorizationRefusalAndVersionCAS", func(t *testing.T) { testDecideRefusalAndCAS(t, f) })
	t.Run("Decide_DoubleDecideRefused", func(t *testing.T) { testDecideDouble(t, f) })
	t.Run("Decide_ResumedRunIsRunningAndClaimable", func(t *testing.T) { testDecideResumesRun(t, f) })
	t.Run("Retry_FailedNode_AppendOnlyNeverRewritesKeys", func(t *testing.T) { testRetryAppendOnly(t, f) })
	t.Run("Advance_TwiceNoNewInputs_IsJournalNoOp", func(t *testing.T) { testAdvanceIdempotence(t, f) })
	t.Run("Skip_ConditionFalse_TerminalRowsAreLedgerLegal", func(t *testing.T) { testSkipLedgerLegal(t, f) })
	// Reconciler passes 4 and 5 (contract § 5.4): the two arms no other
	// subtest reaches — a run that outlived its budget, and a run whose
	// workspace vanished before a worker held it.
	t.Run("ReconcilerRunDuration_CascadesAndNamesCause", func(t *testing.T) { testRunDurationBudget(t, f) })
	t.Run("ReconcilerWorkspaceLost_InterruptsWithNoAutoRetry", func(t *testing.T) { testWorkspaceLostInterrupt(t, f) })
	// Reconciler pass 3 (contract § 5.4): the attempt deadline with a fresh
	// heartbeat is request-only — the worker's own terminal write closes it —
	// and the stale-heartbeat contrast proves pass 1 owns that arm.
	t.Run("ReconcilerDeadline_SetsCancelRequestedOnly", func(t *testing.T) {
		t.Run("fresh-heartbeat", func(t *testing.T) { testDeadlineFreshHeartbeat(t, f) })
		t.Run("stale-heartbeat-is-lease-pass", func(t *testing.T) { testDeadlineStaleHeartbeatIsLeasePass(t, f) })
	})
	// The dual-instance arm is parameterized on the factory: a store whose
	// run-state lives only in one process cannot implement DualFactory's
	// OpenPair honestly, and the in-memory reference simply skips.
	t.Run("DualInstance_TwoStoresOneDatabase_Converge", func(t *testing.T) {
		df, ok := f.(DualFactory)
		if !ok {
			t.Skip("factory provides one store instance only (runtime.Store seam has no cluster to split)")
		}
		dualInstanceTests(t, df)
	})
}

// snapshot is a deep copy of the journal for prefix assertions.
func snapshot(events []pevents.Record) []pevents.Record {
	return append([]pevents.Record{}, events...)
}

func hasPrefix(t *testing.T, name string, before, after []pevents.Record) {
	t.Helper()
	if len(after) < len(before) {
		t.Fatalf("%s: journal shrank from %d to %d rows (append-only violated)", name, len(before), len(after))
	}
	if !reflect.DeepEqual(before, after[:len(before)]) {
		t.Fatalf("%s: journal rows before the write were rewritten (append-only violated)", name)
	}
}

func countType(events []pevents.Record, typ string) int {
	n := 0
	for _, e := range events {
		if e.Type == typ {
			n++
		}
	}
	return n
}
