package postgres

// TestM4APIStream*: the two M4 read adapters on a database that actually ran
// 00005 — the journal stream behind GET /runs/{runId}/events (contract § 2.1
// route 33) and the ops counters behind GET /api/v1/system/scheduler (route
// 37, ADR-0023 Consequences). Layer: integration. Every assertion reads rows
// a real Postgres wrote, and the scheduler numbers are compared as DELTAS
// because they are fleet-wide aggregates over a database other tests share.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// The two foreign identities for the visibility legs: valid uuids that name
// nothing, which is exactly what a cross-organization probe looks like from
// the SQL's side.
const (
	m4StreamForeignOrg  = "0af0df00-0000-4000-8000-0000000000f1"
	m4StreamForeignUser = "0af0df00-0000-4000-8000-0000000000f2"
)

// m4StreamMember makes the fixture user a project member and returns the api
// caller the tests read as. m4Setup seeds the project with a bare INSERT (no
// membership row), and the stream's whole answer depends on the membership
// predicate, so the test states the membership explicitly rather than hiding
// behind IsOrgAdmin.
func m4StreamMember(t *testing.T, ctx context.Context, f *m4Fixture, role string) api.Caller {
	t.Helper()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO memberships (project_id, user_id, role)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		f.projectID, f.userID, role); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	// Cleanup runs LIFO, before m4Setup's own unwind (which drops the project
	// the membership key points at).
	t.Cleanup(func() {
		if _, err := f.pool.Exec(context.Background(),
			`DELETE FROM memberships WHERE project_id = $1 AND user_id = $2`,
			f.projectID, f.userID); err != nil {
			t.Errorf("cleanup membership: %v", err)
		}
	})
	return api.Caller{UserID: f.userID, OrganizationID: f.orgID}
}

// m4StreamAppend appends one run-correlated journal row through the real M4
// append path (state + journal in one tx) and returns its global_seq.
func m4StreamAppend(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID, typ string) int64 {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin append tx: %v", err)
	}
	env, err := runAppendTx(ctx, tx, runID, "", "", RunEvent{
		Type:      typ,
		ActorKind: events.ActorKindSystem,
		ActorID:   "system",
		Payload:   map[string]any{"note": "m4api stream fixture"},
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("runAppendTx %s: %v", typ, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit append tx: %v", err)
	}
	return env.GlobalSeq
}

// m4StreamHas reports whether seq appears in a batch.
func m4StreamHas(batch []events.Envelope, seq int64) bool {
	for _, env := range batch {
		if env.GlobalSeq == seq {
			return true
		}
	}
	return false
}

// m4StreamSeqs projects a batch to its sequence column for failure messages.
func m4StreamSeqs(batch []events.Envelope) []int64 {
	out := make([]int64, 0, len(batch))
	for _, env := range batch {
		out = append(out, env.GlobalSeq)
	}
	return out
}

// TestM4APIStreamRunEventsAfter proves the three properties the SSE handler's
// gap argument rests on: strictly-greater-than-cursor, oldest-first order,
// and a real LIMIT — plus the visibility rule that an unauthorized caller
// gets api.ErrRunNotFound instead of a row or a peek.
func TestM4APIStreamRunEventsAfter(t *testing.T) {
	ctx := journalCtx(t)
	f := m4Setup(t)
	member := m4StreamMember(t, ctx, f, "viewer")
	runID := f.m4QueuedRun(t, ctx, "", 0)
	stream := APIRunEventStream{Journal: &ProjectStore{Pool: f.pool}}

	// Four appends in a row: distinct types so a mix-up is visible in the
	// order assertion, and their global_seqs are the commit order.
	var seqs []int64
	for i, typ := range []string{events.TypeRunStarted, events.TypeRunPaused,
		events.TypeRunResumed, events.TypeRunWaitingHuman} {
		seqs = append(seqs, m4StreamAppend(t, ctx, f.pool, runID, fmt.Sprintf("%s.%d", typ, i)))
	}

	// The four appends have committed; whether the reader may see them is a
	// second question. The gap-safety clause of ADR-0014 §9 hides a committed
	// row until the cluster-wide watermark passes its transaction, and that
	// watermark is held back by an open write transaction in ANY database of
	// the cluster — a sibling `go test -p 4` binary, for instance. The stream
	// poller waits for a wake-up; this test reads once, so it waits here.
	waitJournalReadable(t, f.pool, "e.run_id = $1::uuid", runID)

	all, err := stream.RunEventsAfter(ctx, member, runID, 0, 100)
	if err != nil {
		t.Fatalf("RunEventsAfter: %v", err)
	}
	if len(all) < len(seqs) {
		t.Fatalf("RunEventsAfter returned %d rows (%v), want at least the %d appended",
			len(all), m4StreamSeqs(all), len(seqs))
	}
	prev := int64(0)
	for _, env := range all {
		if env.GlobalSeq <= prev {
			t.Errorf("rows not oldest-first: %d follows %d in %v", env.GlobalSeq, prev, m4StreamSeqs(all))
		}
		prev = env.GlobalSeq
		// The run scope is the stream's whole authorization story: a row of
		// another run could only arrive through a broken predicate.
		if env.RunID != runID {
			t.Errorf("row seq=%d carries run_id %q, want %q", env.GlobalSeq, env.RunID, runID)
		}
	}
	for _, seq := range seqs {
		if !m4StreamHas(all, seq) {
			t.Errorf("appended seq=%d missing from %v", seq, m4StreamSeqs(all))
		}
	}

	// The cursor is exclusive, and it is exclusive against the journal's own
	// numbers rather than the caller's array positions.
	tail, err := stream.RunEventsAfter(ctx, member, runID, seqs[1], 100)
	if err != nil {
		t.Fatalf("RunEventsAfter after seq %d: %v", seqs[1], err)
	}
	for _, env := range tail {
		if env.GlobalSeq <= seqs[1] {
			t.Errorf("cursor %d not honoured: seq=%d in %v", seqs[1], env.GlobalSeq, m4StreamSeqs(tail))
		}
	}
	for _, seq := range seqs[2:] {
		if !m4StreamHas(tail, seq) {
			t.Errorf("seq=%d missing from the tail %v", seq, m4StreamSeqs(tail))
		}
	}
	if m4StreamHas(tail, seqs[0]) || m4StreamHas(tail, seqs[1]) {
		t.Errorf("tail %v replayed at or below the cursor %d", m4StreamSeqs(tail), seqs[1])
	}

	// limit is a real LIMIT, applied after the ordering (the handler's batch
	// size, and the "keep draining while a full batch arrives" rule).
	for _, limit := range []int{1, 2} {
		batch, err := stream.RunEventsAfter(ctx, member, runID, 0, limit)
		if err != nil {
			t.Fatalf("RunEventsAfter limit %d: %v", limit, err)
		}
		if len(batch) != limit {
			t.Fatalf("limit %d returned %d rows (%v)", limit, len(batch), m4StreamSeqs(batch))
		}
		for i, env := range batch {
			if env.GlobalSeq != all[i].GlobalSeq {
				t.Errorf("limit %d row %d = seq %d, want the oldest-first seq %d",
					limit, i, env.GlobalSeq, all[i].GlobalSeq)
			}
		}
	}

	// Visibility: another organization, and this organization with no
	// membership, both answer the not-found sentinel — the same bytes a run
	// that never existed produces, and never a foreign row.
	crossOrg := api.Caller{UserID: m4StreamForeignUser, OrganizationID: m4StreamForeignOrg}
	if batch, err := stream.RunEventsAfter(ctx, crossOrg, runID, 0, 50); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("cross-org caller = %v, %v; want api.ErrRunNotFound", m4StreamSeqs(batch), err)
	} else if batch != nil {
		t.Errorf("cross-org caller received %d rows with %v", len(batch), err)
	}
	stranger := api.Caller{UserID: m4StreamForeignUser, OrganizationID: f.orgID}
	if batch, err := stream.RunEventsAfter(ctx, stranger, runID, 0, 50); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("non-member in the same org = %v, %v; want api.ErrRunNotFound", m4StreamSeqs(batch), err)
	}
	// An org admin sees every project in the organization without a
	// membership (authz.CanView's rule, enforced in the same predicate).
	if batch, err := stream.RunEventsAfter(ctx,
		api.Caller{UserID: m4StreamForeignUser, OrganizationID: f.orgID, IsOrgAdmin: true},
		runID, 0, 100); err != nil || !m4StreamHas(batch, seqs[0]) {
		t.Errorf("org admin = %v, %v; want the run's journal", m4StreamSeqs(batch), err)
	}
	// A malformed id never reaches the driver.
	if _, err := stream.RunEventsAfter(ctx, member, "not-a-uuid", 0, 50); !errors.Is(err, api.ErrRunNotFound) {
		t.Errorf("garbage run id = %v; want api.ErrRunNotFound", err)
	}
	// An unwired adapter refuses plainly instead of panicking mid-handler.
	if _, err := (APIRunEventStream{}).RunEventsAfter(ctx, member, runID, 0, 50); err == nil {
		t.Error("stream without a journal answered no error")
	}
}

// TestM4APIStreamWatchFiresAfterAppend is the LISTEN/NOTIFY leg: a stream
// subscribed through the adapter wakes when a run-correlated row commits, and
// the wake is followed by the row itself in the journal read (ADR-0014 § 6 —
// the notification is only a hint, the re-query is the truth).
func TestM4APIStreamWatchFiresAfterAppend(t *testing.T) {
	ctx := journalCtx(t)
	url := mustMigrate(t)
	pool, err := Open(ctx, url)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(pool.Close)
	f := m4SetupShared(t, ctx, pool)
	member := m4StreamMember(t, ctx, f, "maintainer")
	runID := f.m4QueuedRun(t, ctx, "", 0)

	wakes := NewEventWake(url, nil)
	t.Cleanup(wakes.Close)
	stream := APIRunEventStream{Journal: &ProjectStore{Pool: pool}, Wakes: wakes}

	wake, stop, err := stream.Watch(ctx)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	defer stop()

	// Drain any wake the subscription's attach produced, so the receive below
	// can only be answered by the append that follows.
	select {
	case <-wake:
	case <-time.After(time.Second):
	}

	seq := m4StreamAppend(t, ctx, pool, runID, events.TypeRunCompleted)

	select {
	case _, open := <-wake:
		if !open {
			t.Fatal("wake channel closed before the append")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no wake-up after a run journal append; the run stream would fall back to polling forever")
	}

	// The notification proves the row committed, not that the gap-safety gate
	// has admitted it: a foreign open transaction holds the watermark, and the
	// re-query the handler would poll again in a moment would come back empty.
	waitJournalReadable(t, pool, "e.global_seq = $1", seq)
	batch, err := stream.RunEventsAfter(ctx, member, runID, seq-1, 10)
	if err != nil {
		t.Fatalf("RunEventsAfter after wake: %v", err)
	}
	if !m4StreamHas(batch, seq) {
		t.Errorf("woken but seq=%d is not readable yet: %v", seq, m4StreamSeqs(batch))
	}

	// A stream with no wake-up source still subscribes (nil channel + no-op
	// stop): the handler's poll ticker is the fallback, not a crash.
	bareWake, bareStop, err := (APIRunEventStream{}).Watch(ctx)
	if err != nil {
		t.Errorf("Watch without a wake source = %v; want a usable fallback", err)
	}
	bareStop()
	if bareWake != nil {
		t.Error("Watch without a wake source handed out a channel it cannot feed")
	}
}

// TestM4APIStreamSchedulerStatus reads the ops counters before and after each
// mutation and asserts the DELTA: every number on this route is a fleet-wide
// aggregate, so its absolute value belongs to whatever else the test database
// holds.
func TestM4APIStreamSchedulerStatus(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := APISchedulerStore{Pool: f.pool}

	base, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus: %v", err)
	}
	if base.Workers == nil {
		t.Error("SchedulerStatus returned a nil workers slice; the handler would render JSON null")
	}

	// A worker registered through the real registry path shows up with the
	// capacity it published and no attempts (the counter a wedged fleet page
	// is read from).
	reg := &WorkerRegistry{Pool: f.pool, Capacity: 3}
	name := "m4-sched-" + migFixtureToken(t)
	workerID, err := reg.Register(ctx, name, "lab", "contract-test")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// runs.worker_affinity points here, and m4Setup's own unwind deletes
		// those runs later than this callback runs (LIFO), so the affinity is
		// cleared before the row can go — the same order m4Worker uses.
		if _, err := f.pool.Exec(bg,
			"UPDATE runs SET worker_affinity = NULL, worker_volume_id = NULL WHERE worker_affinity = $1", workerID); err != nil {
			t.Errorf("clear affinity by worker: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workers WHERE id = $1::uuid`, workerID); err != nil {
			t.Errorf("cleanup scheduler-test worker: %v", err)
		}
	})

	afterWorker, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after register: %v", err)
	}
	if len(afterWorker.Workers) != len(base.Workers)+1 {
		t.Fatalf("workers = %d, want %d (base %d + the one just registered)",
			len(afterWorker.Workers), len(base.Workers)+1, len(base.Workers))
	}
	var mine *api.SchedulerWorkerLoadView
	for i, w := range afterWorker.Workers {
		if w.WorkerID == workerID {
			mine = &afterWorker.Workers[i]
			break
		}
	}
	if mine == nil {
		t.Fatalf("registered worker %s (%s) absent from the load list: %+v", workerID, name, afterWorker.Workers)
	}
	if mine.Name != name || mine.Capacity != 3 || mine.ActiveAttempts != 0 {
		t.Errorf("registered worker = %+v, want name %s capacity 3 active_attempts 0", *mine, name)
	}

	// Queue one attempt: the queue counter, its oldest-age gauge (a *float64
	// that must be non-nil once anything waits) and the retry-depth guard all
	// move by exactly the work this test did.
	runID := f.m4QueuedRun(t, ctx, "", 0)
	nodeID, _ := f.m4WorkerNode(t, ctx, runID, "/implement")
	afterAttempt, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after queue: %v", err)
	}
	if got := afterAttempt.AttemptsByStatus.Queued - base.AttemptsByStatus.Queued; got != 1 {
		t.Errorf("queued delta = %d, want 1 (%d -> %d)", got,
			base.AttemptsByStatus.Queued, afterAttempt.AttemptsByStatus.Queued)
	}
	if afterAttempt.OldestQueuedAgeSeconds == nil {
		t.Error("oldest_queued_age_seconds = nil with a queued attempt on the table")
	} else if *afterAttempt.OldestQueuedAgeSeconds < 0 {
		t.Errorf("oldest_queued_age_seconds = %v, want >= 0", *afterAttempt.OldestQueuedAgeSeconds)
	}
	if afterAttempt.MaxRetryLoopDepth < 1 {
		t.Errorf("max_retry_loop_depth = %d, want >= 1 for a live attempt_number 1", afterAttempt.MaxRetryLoopDepth)
	}

	// A pending gate counts as waiting work with no lease behind it.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO approval_requests (organization_id, project_id, run_id, node_execution_id, summary, deadline_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'm4 stream fixture gate', now() + interval '1 hour')`,
		f.orgID, f.projectID, runID, nodeID); err != nil {
		t.Fatalf("insert pending gate: %v", err)
	}
	afterGate, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after gate: %v", err)
	}
	if got := afterGate.WaitingApprovals - base.WaitingApprovals; got != 1 {
		t.Errorf("waiting_approvals delta = %d, want 1", got)
	}

	// § 5.2's honest number: a queued run bound to a worker that cannot take
	// it is counted, and the same run without an affinity is not.
	offlineName := "m4-off-" + migFixtureToken(t)
	offlineID, err := (&WorkerRegistry{Pool: f.pool, Capacity: 1}).Register(ctx, offlineName, "lab", "contract-test")
	if err != nil {
		t.Fatalf("Register offline worker: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		if _, err := f.pool.Exec(bg,
			"UPDATE runs SET worker_affinity = NULL, worker_volume_id = NULL WHERE worker_affinity = $1", offlineID); err != nil {
			t.Errorf("clear affinity by offline worker: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workers WHERE id = $1::uuid`, offlineID); err != nil {
			t.Errorf("cleanup offline worker: %v", err)
		}
	})
	if err := (&WorkerRegistry{Pool: f.pool}).SetStatus(ctx, offlineName, WorkerStatusOffline); err != nil {
		t.Fatalf("SetStatus offline: %v", err)
	}
	stuckRun, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun (queued): %v", err)
	}
	freeRun, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun (unbound): %v", err)
	}
	// A run with no volume to locality-bind to is not unbindable-by-affinity,
	// so the pair constraint keeps it out of the count on both sides.
	if bound, err := f.runs.SetRunAffinity(ctx, stuckRun.ID, offlineID, "vol-m4-stream"); err != nil || !bound {
		t.Fatalf("SetRunAffinity stuck run = %v, %v", bound, err)
	}
	afterStuck, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after affinity: %v", err)
	}
	if got := afterStuck.QueuedUnbindableRuns - base.QueuedUnbindableRuns; got != 1 {
		t.Errorf("queued_unbindable_runs delta = %d, want 1 (the affinity-bound run only; %s stays claimable)",
			got, freeRun.ID)
	}

	// § 5.2's other arm: the advancer moves every queued run to 'running'
	// on its first pass (contract § 4 step 3), so the honest "still queued"
	// state materialises as status='running' with ready attempts that
	// cannot be claimed. A running run whose affinity worker is offline/full
	// and has a queued attempt (scheduled_at <= now) is counted.
	advRun, _, err := f.runs.CreateRun(ctx, NewRun{
		OrganizationID: f.orgID, ProjectID: f.projectID, PipelineID: f.pipelineID,
		PipelineRevisionID: f.revisionID, RevisionDigest: f.digest, PlanDigest: f.planDigest,
		PlanSnapshot: json.RawMessage(`{"nodes":[]}`), PoliciesSnapshot: json.RawMessage(`{}`),
		TriggeredBy: f.userID,
	})
	if err != nil {
		t.Fatalf("CreateRun (advancer arm): %v", err)
	}
	// Simulate the advancer: queued → running.
	if _, err := f.runs.SetRunStatus(ctx, advRun.ID, RunStatusInput{Status: "running"}); err != nil {
		t.Fatalf("SetRunStatus running: %v", err)
	}
	if bound, err := f.runs.SetRunAffinity(ctx, advRun.ID, offlineID, "vol-adv-arm"); err != nil || !bound {
		t.Fatalf("SetRunAffinity adv run = %v, %v", bound, err)
	}
	// Seed a ready queued attempt (the work the affinity worker should take).
	advNode, err := f.runs.InsertNodeExecution(ctx, NewNodeExecution{
		RunID: advRun.ID, NodeID: "adv_stuck", Kind: "agent.acp",
		NodeInstanceKey: "/adv_stuck", ExecutionLocation: "worker",
	})
	if err != nil {
		t.Fatalf("InsertNodeExecution: %v", err)
	}
	if _, err := f.runs.SetNodeStatus(ctx, advNode.ID, NodeStatusInput{Status: "ready"}); err != nil {
		t.Fatalf("SetNodeStatus ready: %v", err)
	}
	if _, err := f.runs.QueueAttempt(ctx, NewAttempt{NodeExecutionID: advNode.ID, AttemptNumber: 1}); err != nil {
		t.Fatalf("QueueAttempt: %v", err)
	}
	afterAdv, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after advancer arm: %v", err)
	}
	if got := afterAdv.QueuedUnbindableRuns - base.QueuedUnbindableRuns; got != 2 {
		t.Errorf("queued_unbindable_runs after advancer arm delta = %d, want 2"+
			" (stuckRun queued+offline, advRun running+offline with ready attempt)", got)
	}
	// Bring the offline worker back online: the affinity is now satisfiable,
	// both runs drop from the counter. Only Register (upsert) brings a worker
	// online (SetStatus refuses it — worker_registry.go:187).
	if _, err := (&WorkerRegistry{Pool: f.pool, Capacity: 1}).Register(ctx, offlineName, "lab", "contract-test"); err != nil {
		t.Fatalf("Register (bring online): %v", err)
	}
	afterOnline, err := store.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus after worker back online: %v", err)
	}
	if got := afterOnline.QueuedUnbindableRuns - base.QueuedUnbindableRuns; got != 0 {
		t.Errorf("queued_unbindable_runs after worker online delta = %d, want 0 (affinity satisfiable)", got)
	}

	// The lease-expiration counter is the reconciler's own, injected: a store
	// wired without one honestly reports 0.
	if base.LeaseExpirations != 0 {
		t.Errorf("LeaseExpirations = %d with no counter wired, want 0", base.LeaseExpirations)
	}
	withCounter := APISchedulerStore{Pool: f.pool, LeaseExpirations: func() int { return 7 }}
	counted, err := withCounter.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus with counter: %v", err)
	}
	if counted.LeaseExpirations != 7 {
		t.Errorf("LeaseExpirations = %d, want the wired counter's 7", counted.LeaseExpirations)
	}

	// An unwired adapter answers a plain error, not a zeroed view that would
	// read as "the fleet is idle".
	if _, err := (APISchedulerStore{}).SchedulerStatus(ctx); err == nil {
		t.Error("APISchedulerStore without a pool answered no error")
	}
}

// TestM4APIStreamSchedulerStaleWorker proves the liveness filter behind
// GET /api/v1/system/scheduler's per-worker list: a freshly registered
// worker counts as live capacity, and the moment its heartbeat falls out
// of the same window /api/v1/workers uses (heartbeatInterval ×
// regLivenessIntervals) it leaves the list and its capacity drops out of
// the fleet total. A dead k8s pod's row stays in workers (GET /workers
// still reports it, offline) — only the scheduler's claimable-capacity
// view stops crediting it.
func TestM4APIStreamSchedulerStaleWorker(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := APISchedulerStore{Pool: f.pool}

	reg := &WorkerRegistry{Pool: f.pool, Capacity: 4}
	name := "m4-stale-" + migFixtureToken(t)
	workerID, err := reg.Register(ctx, name, "lab", "contract-test")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		// runs.worker_affinity can point here, and m4Setup's own unwind
		// deletes those runs later (LIFO) than this callback.
		if _, err := f.pool.Exec(bg,
			"UPDATE runs SET worker_affinity = NULL, worker_volume_id = NULL WHERE worker_affinity = $1", workerID); err != nil {
			t.Errorf("clear affinity by worker: %v", err)
		}
		if _, err := f.pool.Exec(bg, `DELETE FROM workers WHERE id = $1::uuid`, workerID); err != nil {
			t.Errorf("cleanup scheduler-test worker: %v", err)
		}
	})

	loads := func(t *testing.T) ([]api.SchedulerWorkerLoadView, int, bool) {
		view, err := store.SchedulerStatus(ctx)
		if err != nil {
			t.Fatalf("SchedulerStatus: %v", err)
		}
		total, present := 0, false
		for _, w := range view.Workers {
			total += w.Capacity
			if w.WorkerID == workerID {
				present = true
			}
		}
		return view.Workers, total, present
	}

	// Fresh heartbeat: the worker is live and its capacity is the fleet's.
	_, liveCap, present := loads(t)
	if !present {
		t.Fatal("freshly registered worker (heartbeat = now()) missing from the scheduler worker list")
	}

	// Expire the heartbeat far past the default window
	// (3 × regDefaultHeartbeat = 30s): the row still says 'online', but the
	// process that should be heartbeating it is gone.
	if _, err := f.pool.Exec(ctx,
		`UPDATE workers SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1::uuid`,
		workerID); err != nil {
		t.Fatalf("expire heartbeat: %v", err)
	}
	stale, staleCap, present := loads(t)
	if present {
		t.Errorf("worker with a 5-minute-stale heartbeat is still listed at capacity 4: %+v", stale)
	}
	// No other test runs between the two reads, so the only capacity that
	// may have moved is this worker's: the dead row's 4 must drop out.
	if staleCap != liveCap-4 {
		t.Errorf("fleet capacity %d -> %d; want exactly the dead worker's 4 to drop out", liveCap, staleCap)
	}

	// The window is the reader's configuration, exactly as /workers' is: a
	// control plane configured for a 1h heartbeat (window 3h) still reads
	// this worker as live at 5 minutes of silence.
	wide := APISchedulerStore{Pool: f.pool, HeartbeatInterval: time.Hour}
	view, err := wide.SchedulerStatus(ctx)
	if err != nil {
		t.Fatalf("SchedulerStatus (wide window): %v", err)
	}
	present = false
	for _, w := range view.Workers {
		if w.WorkerID == workerID {
			present = true
		}
	}
	if !present {
		t.Errorf("5-minute-stale heartbeat must stay inside a 3-hour liveness window")
	}
}
