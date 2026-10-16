package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/pipelines/compiler"
	"github.com/dbirks/communication/internal/pipelines/loader"
	"github.com/dbirks/communication/internal/pipelines/runtime"
	"github.com/dbirks/communication/internal/pipelines/schema"
)

// TestM4Driver* — the integration layer for the serve-side driver
// (docs/m4-contract.md § 5.1/§ 5.4) against a real Postgres: the engine is
// the committed RuntimeStore's, so what these tests certify is WHEN it runs
// and WHO is allowed to run it in a given pass, not what it computes.

// m4DriverYAML is the smallest plan whose first advance does observable
// work: a `condition` settles in the control plane, its chosen branch
// queues an attempt, and the run leaves 'queued' (contract § 5.1 steps 2-4).
const m4DriverYAML = `
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: m4-driver
spec:
  inputs:
    type: object
    required: [goal, flags]
    properties:
      goal: {type: string, minLength: 1}
      flags:
        type: object
        properties:
          keep: {type: boolean}
  policies:
    maxConcurrentNodes: 4
    maxDurationSeconds: 3600
    maxNodeExecutions: 50
    cancelPolicy: cascade
  nodes:
  - id: pick
    kind: condition
    config:
      cases:
      - when: inputs.flags.keep == true
        route: on
      default: off
    outputs:
      type: object
      properties:
        route: {type: string}
  - id: on
    kind: process.exec
    dependsOn: [pick]
    when: nodes.pick.outputs.route == 'on'
    config:
      executable: on
  - id: off
    kind: process.exec
    dependsOn: [pick]
    when: nodes.pick.outputs.route == 'off'
    config:
      executable: off
  resultBindings:
    route: ${{ nodes.pick.outputs.route }}
`

// m4DriverPlan compiles the fixture document through the real loader →
// schema → compiler → PreparePlan path (runtimetest's preparePlan shape): a
// driver test that hand-wrote a plan jsonb would be testing a document no
// pipeline could ever publish.
func m4DriverPlan(t *testing.T) (prog *runtime.Program, planJSON json.RawMessage) {
	t.Helper()
	doc, d := loader.Load([]byte(m4DriverYAML))
	if !d.Valid() {
		t.Fatalf("loader: %v", d)
	}
	if d := schema.MustCompile().Validate(doc.Value); !d.Valid() {
		t.Fatalf("schema: %v", d)
	}
	plan, d := compiler.Compile(doc, compiler.Options{})
	if !d.Valid() {
		t.Fatalf("compiler: %v", d)
	}
	prog, d = runtime.PreparePlan(plan)
	if !d.Valid() {
		t.Fatalf("PreparePlan: %v", d)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	return prog, json.RawMessage(raw)
}

// m4DriverRun seeds a live run the way the conformance Postgres factory
// does — real publish path for the pinned revision, real RunStore.create —
// and returns (runID, RuntimeStore) over one pool shared by the fixture and
// the driver.
func m4DriverRun(t *testing.T) (*m4Fixture, *RuntimeStore, string, string) {
	t.Helper()
	ctx := testCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := m4SetupShared(t, ctx, pool)

	prog, planJSON := m4DriverPlan(t)
	revDigest := m4Digest("driver-rev/" + migFixtureToken(t))
	doc := "apiVersion: communication.dev/v1alpha1\nkind: Pipeline\n# m4-driver\n"
	draft, err := f.pipelines.CreateDraft(ctx, NewDraft{
		PipelineID: f.pipelineID, DocumentText: doc, SourceKind: "manual",
		SourceSHA256: m4Hex("driver-src/" + revDigest), EditedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if _, err := f.pipelines.RecordValidation(ctx, draft.ID, "valid", DraftValidation{
		CanonicalDocument: json.RawMessage(`{"apiVersion":"communication.dev/v1alpha1","kind":"Pipeline","name":"m4-driver"}`),
		RevisionDigest:    revDigest,
		CompiledPlan:      planJSON,
		PlanDigest:        m4Digest("driver-plan/" + migFixtureToken(t)),
		Validation:        json.RawMessage(`[]`),
	}); err != nil {
		t.Fatalf("RecordValidation: %v", err)
	}
	rev, err := f.pipelines.PublishDraft(ctx, draft.ID, NewRevision{
		VersionLabel: "1.1.0", DocumentText: doc,
		SchemaDigest: m4Digest("driver-schema"), CelEnvDigest: m4Digest("driver-celenv"),
		PublishedBy: f.userID, ExpectedDraftVersion: draft.Version,
	})
	if err != nil {
		t.Fatalf("PublishDraft: %v", err)
	}

	goal, err := json.Marshal("driver")
	if err != nil {
		t.Fatalf("encode input: %v", err)
	}
	keep, err := json.Marshal(map[string]any{"keep": true})
	if err != nil {
		t.Fatalf("encode flags: %v", err)
	}
	run, created, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: rev.ID, RevisionDigest: revDigest, PlanDigest: f.planDigest,
		PlanSnapshot: planJSON, PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
		Inputs: map[string]RunInput{
			"goal":  {Value: goal, Origin: "submitted"},
			"flags": {Value: keep, Origin: "submitted"},
		},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !created {
		t.Fatalf("CreateRun reported not-created for a fresh run")
	}

	rs := NewRuntimeStore(pool, &runtime.Advancer{Prog: prog})
	return f, rs, run.ID, url
}

func m4DriverRunStatus(t *testing.T, pool interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, runID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(testCtx(t),
		`SELECT status FROM runs WHERE id = $1::uuid`, runID).Scan(&status); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	return status
}

// TestM4DriverTickAdvancesLiveRun: the backstop does the trigger's job when
// no trigger fired — a queued run becomes running, the control-plane node
// settles, and the chosen branch is queued, all from rows.
func TestM4DriverTickAdvancesLiveRun(t *testing.T) {
	f, rs, runID, _ := m4DriverRun(t)
	ctx := testCtx(t)

	var startCount int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM node_executions WHERE run_id = $1::uuid`, runID).Scan(&startCount); err != nil {
		t.Fatalf("count nodes before tick: %v", err)
	}
	if startCount != 0 {
		t.Fatalf("fixture run already has %d node rows; the driver would have nothing to prove", startCount)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got != "queued" {
		t.Fatalf("fixture run status = %q, want queued", got)
	}

	d := NewM4Driver(f.pool, rs, nil)
	touched, err := d.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if touched != 1 {
		t.Errorf("Tick touched %d runs, want 1", touched)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got != "running" {
		t.Errorf("run status after tick = %q, want running", got)
	}

	var nodeStatus, route string
	if err := f.pool.QueryRow(ctx, `
		SELECT n.status, COALESCE(n.outputs->>'route', '')
		FROM node_executions n
		WHERE n.run_id = $1::uuid AND n.node_id = 'pick'`, runID).
		Scan(&nodeStatus, &route); err != nil {
		t.Fatalf("read pick node after tick: %v", err)
	}
	if nodeStatus != "succeeded" || route != "on" {
		t.Errorf("pick node after tick = %s route %q, want succeeded route \"on\"", nodeStatus, route)
	}

	var queued int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM attempts a
		JOIN node_executions n ON n.id = a.node_execution_id
		WHERE a.run_id = $1::uuid AND n.node_id = 'on' AND a.status = 'queued'`, runID).
		Scan(&queued); err != nil {
		t.Fatalf("count queued attempts: %v", err)
	}
	if queued != 1 {
		t.Errorf("queued attempts for the chosen branch = %d, want 1", queued)
	}

	// Idempotence: the pass is a re-derivation, so a second tick cannot
	// double-write the same transition (§ 5.1 step 7 / § 8's idempotence row).
	touched, err = d.Tick(ctx)
	if err != nil {
		t.Fatalf("second Tick: %v", err)
	}
	if touched != 1 {
		t.Errorf("second Tick touched %d runs, want 1", touched)
	}
	var nodeCount int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM node_executions WHERE run_id = $1::uuid`, runID).Scan(&nodeCount); err != nil {
		t.Fatalf("count nodes after tick: %v", err)
	}
	if nodeCount != 3 {
		t.Errorf("node rows after the second tick = %d, want 3 (one per declared node, no duplicates)", nodeCount)
	}
}

// TestM4DriverAdvisoryLockSingleReplica: one pass, one leader. A replica
// that cannot take communication/m4-reconciler answers 0 with no error and
// writes nothing — the "many replicas are safe" claim of § 5.4, observed
// with the lock actually held by another session.
func TestM4DriverAdvisoryLockSingleReplica(t *testing.T) {
	f, rs, runID, url := m4DriverRun(t)
	ctx := testCtx(t)

	// A dedicated session holds the lock, exactly as a leading replica would:
	// released explicitly (not via t.Cleanup, which runs after the pool is
	// closed) and before the connection goes back to the pool, so no lock
	// survives into another test through a reused session.
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect lock-holder session: %v", err)
	}
	defer conn.Close(ctx)
	release := func() {
		if _, err := conn.Exec(ctx,
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey); err != nil {
			t.Errorf("unlock holder session: %v", err)
		}
	}
	var held bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey).Scan(&held); err != nil {
		t.Fatalf("take lock by hand: %v", err)
	}
	if !held {
		t.Fatalf("hand lock take failed before any driver ran")
	}

	d := NewM4Driver(f.pool, rs, nil)
	touched, err := d.Tick(ctx)
	if err != nil {
		t.Fatalf("locked-out Tick: %v", err)
	}
	if touched != 0 {
		t.Errorf("locked-out Tick touched %d runs, want 0", touched)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got != "queued" {
		t.Errorf("run status after locked-out tick = %q, want queued (nothing ran)", got)
	}
	release()

	// The same exclusion between two live replicas, made deterministic rather
	// than raced: the leading driver signals from inside its own locked
	// session and holds the pass open on a channel, so the second driver's
	// whole Tick provably happens while the first holds
	// communication/m4-reconciler. It must answer 0 with no error — two
	// leaders in one pass window is the bug this test exists to catch.
	holder, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect leading driver's session: %v", err)
	}
	defer holder.Close(ctx)
	var (
		mu        sync.Mutex
		triggered bool
		started   = make(chan struct{})
		gateOpen  = make(chan struct{})
	)
	// The leader owns gateOpen and closes it once the probe below is over;
	// this only releases it if the leader never reached its advance at all.
	defer func() {
		select {
		case <-gateOpen:
		default:
			close(gateOpen)
		}
	}()
	defer func() {
		if _, err := holder.Exec(context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey); err != nil {
			t.Errorf("cleanup unlock leading session: %v", err)
		}
	}()

	leading := NewM4Driver(f.pool, rs, nil)
	// The observation seam goes on the LEADING driver: its advance is the
	// window in which the lock must be held, and that is the window the
	// second driver must fail to enter. The witness is a second session
	// trying the very same pg_try_advisory_lock the driver uses — a refusal
	// there is direct evidence the driver's session holds it right now (the
	// pass is frozen on a channel while it is observed), not a sleep or a
	// guess. pg_locks is not used: it only exposes the key's low 32 bits.
	leading.advance = func(ctx context.Context, runID string) error {
		mu.Lock()
		first := !triggered
		triggered = true
		mu.Unlock()
		if !first {
			return d.rs.Advance(ctx, runID)
		}
		var free bool
		if err := holder.QueryRow(ctx,
			`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey).Scan(&free); err != nil {
			t.Errorf("probe the driver's advisory lock from a second session: %v", err)
		} else if free {
			t.Errorf("leading driver reached the advancer without holding %s: a second session took it", m4DriverAdvisoryLockKey)
			_, _ = holder.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, m4DriverAdvisoryLockKey)
		}
		close(started)
		<-gateOpen
		return d.rs.Advance(ctx, runID)
	}
	lockedOut := NewM4Driver(f.pool, rs, nil)

	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		if _, err := leading.Tick(ctx); err != nil {
			t.Errorf("leading driver Tick: %v", err)
		}
	}()
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		close(gateOpen)
		t.Fatalf("leading driver never signalled a locked pass")
	}

	second, err := lockedOut.Tick(ctx)
	if err != nil {
		t.Errorf("second driver Tick while the first led: %v", err)
	}
	if second != 0 {
		t.Errorf("second driver touched %d runs while the first held the lock, want 0", second)
	}
	close(gateOpen)
	<-leaderDone

	// The leading pass really did drive the run (so the 0 above is exclusion,
	// not an empty batch). ReconcileLeases runs the advancer itself as pass
	// 1's other half, so the run has already left 'queued' by the time the
	// gated advance happens — what is asserted is that exactly one replica
	// got there and the row set is what one pass writes.
	if got := m4DriverRunStatus(t, f.pool, runID); got != "running" {
		t.Errorf("run status after the leading pass = %q, want running", got)
	}
	var nodeCount int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM node_executions WHERE run_id = $1::uuid`, runID).Scan(&nodeCount); err != nil {
		t.Fatalf("count nodes: %v", err)
	}
	if nodeCount != 3 {
		t.Errorf("node rows = %d, want 3", nodeCount)
	}
}

// TestM4DriverTriggerUnknownRun: a trigger is a nudge, not a request — an
// unknown run id (malformed or uuid-shaped but absent) is logged and
// swallowed, never a panic and never something the handler can see.
func TestM4DriverTriggerUnknownRun(t *testing.T) {
	f, rs, runID, _ := m4DriverRun(t)
	ctx := testCtx(t)

	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	d := NewM4Driver(f.pool, rs, log)

	var trigger api.M4Trigger = d.Trigger // the seam the handlers inject
	before := m4DriverRunStatus(t, f.pool, runID)

	for _, bad := range []string{"not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		func() {
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("Trigger(%q) panicked: %v", bad, p)
				}
			}()
			trigger(ctx, bad)
		}()
		line := strings.TrimSpace(buf.String())
		if line == "" {
			t.Errorf("Trigger(%q) logged nothing; an unusable run id must be visible in the log", bad)
		}
		buf.Reset()
	}

	if after := m4DriverRunStatus(t, f.pool, runID); after != before {
		t.Errorf("unknown-id triggers disturbed the live run: %q -> %q", before, after)
	}

	// And the same method, wired the same way, does drive a real run.
	buf.Reset()
	trigger(ctx, runID)
	if line := buf.String(); strings.Contains(line, "level=ERROR") {
		t.Errorf("Trigger on the live run logged an error: %s", line)
	}
	if got := m4DriverRunStatus(t, f.pool, runID); got != "running" {
		t.Errorf("run status after Trigger = %q, want running", got)
	}
}
