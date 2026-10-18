package postgres

// The two remaining M4 read adapters (docs/m4-contract.md § 2.1 routes 33
// and 37): the run journal stream behind GET /runs/{runId}/events and the
// ops counters behind GET /system/scheduler.
//
// Neither one re-implements a mechanism that already exists:
//
//   - The stream reuses the committed journal cursor (ProjectStore.RunEvents-
//     After over runEventsSQL, with its gap-safety clause intact) and the
//     committed shared wake-up source (EventWake's single LISTEN connection,
//     ADR-0014 § 6). What this file adds is only the authorization predicate
//     the lower read deliberately does not carry — visibility is resolved in
//     SQL, so a caller removed mid-stream starts answering api.ErrRunNotFound
//     (the handler's stop signal) and never sees a foreign row.
//   - The scheduler read is one round trip of aggregates over the tables the
//     engine already maintains (attempts, approval_requests, runs, workers).
//     It invents no counter table: every number is derived from the same rows
//     the claim predicate and the gates read, so the dashboard cannot drift
//     from the engine (ADR-0023 Consequences, `02` Observability: fleet-wide
//     aggregates, no prompt text, no secret material, no user names).

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/events"
)

// =============================================================== run events

// APIRunEventStream is api.RunEventStream, the journal read behind the run
// SSE stream (route 33). Journal is the committed cursor, Wakes the shared
// LISTEN/NOTIFY source — a stream with no wake-up source still works, it just
// falls back to the handler's poll interval.
type APIRunEventStream struct {
	Journal *ProjectStore
	Wakes   *EventWake
}

var (
	_ api.RunEventStream = APIRunEventStream{}
	_ api.RunEventStream = (*APIRunEventStream)(nil)
)

// m4RunScopeSQL resolves a run's owning project under the caller's
// visibility — prjProjectSelect's predicate ($1 user, $2 organization,
// $3 org-admin) transplanted onto the run, with the run id at $4, so the run
// route family answers "not found" for a foreign run exactly as the project
// routes do. The organization check rides on projects (the authoritative
// scope), not on the denormalized runs.organization_id, so the two can never
// disagree about what a caller may read.
const m4RunScopeSQL = `
	SELECT r.project_id::text
	FROM runs r
	JOIN projects p ON p.id = r.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE r.id = $4::uuid
	  AND p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// RunEventsAfter implements api.RunEventStream. Visibility first (one
// predicate-scoped query), then the committed run-scoped read with the
// project the predicate returned repeated in its own WHERE — a journal row
// that somehow names a project other than its run's is never delivered here
// either. An invisible run answers api.ErrRunNotFound wrapped over the
// store's own sentinel, byte-identical to a run that never existed; an
// invisible-but-referenced run cannot leak a sequence number either, because
// nothing is read from domain_events until the predicate matched.
func (a APIRunEventStream) RunEventsAfter(ctx context.Context, c api.Caller, runID string, afterSeq int64, limit int) ([]events.Envelope, error) {
	if a.Journal == nil {
		return nil, errors.New("postgres: APIRunEventStream has no journal")
	}
	pool, err := m4Pool(a.Journal.Pool, "APIRunEventStream")
	if err != nil {
		return nil, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return nil, err
	}
	if !prjValidUUID(runID) {
		return nil, fmt.Errorf("%w: %w", api.ErrRunNotFound, ErrRunNotFound)
	}

	var projectID string
	err = pool.QueryRow(ctx, m4RunScopeSQL,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, runID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: %w", api.ErrRunNotFound, ErrRunNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("postgres: authorize run stream for %s: %w", runID, err)
	}

	out, err := a.Journal.RunEventsAfter(ctx, runID, projectID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Watch implements api.RunEventStream on the same shared source as the
// project and conversation streams. A nil wake-up source hands back a nil
// channel and a no-op stop: the handler's select then blocks on nothing and
// the poll ticker carries the stream, which is ADR-0014 § 6's
// "notification is an optimization" made literal.
func (a APIRunEventStream) Watch(ctx context.Context) (<-chan struct{}, func(), error) {
	if a.Wakes == nil {
		return nil, func() {}, nil
	}
	return a.Wakes.Watch(ctx)
}

// =============================================================== scheduler

// APISchedulerStore answers GET /api/v1/system/scheduler (route 37). Session
// required, no membership check: an operator has to see the queue before
// anyone trusts it, and every field is a fleet-wide aggregate — no project,
// no prompt, no user name appears in any of them.
type APISchedulerStore struct {
	Pool *pgxpool.Pool

	// HeartbeatInterval is the workers' configured heartbeat period (serve
	// passes the same value it hands to APIWorkerStore); zero uses
	// regDefaultHeartbeat. Together with regLivenessIntervals it is the SAME
	// liveness window WorkerRegistry.ListWorkersWithLiveness applies, so the
	// scheduler view and GET /api/v1/workers cannot disagree about which
	// workers are live.
	HeartbeatInterval time.Duration

	// LeaseExpirations reports the attempt-lease expirations THIS replica has
	// observed since it started, which is exactly the window openapi.yaml
	// names ("Reconciler-observed ... since this replica started"). The
	// counter belongs to the reconciler's pass — a per-replica process
	// counter, not a table, because a database-wide count would change the
	// number every time an operator restarted anything. nil answers 0: this
	// replica has observed none, which is the truth for a serve process that
	// runs no reconciler.
	LeaseExpirations func() int
}

var (
	_ api.SchedulerStore = APISchedulerStore{}
	_ api.SchedulerStore = (*APISchedulerStore)(nil)
)

// m4SchedulerWorkerLiveness is the effective-status expression
// WorkerRegistry.ListWorkersWithLiveness applies (worker_registry.go),
// written over the workers alias w: a row still stored as 'online' whose
// heartbeat is older than heartbeatInterval * regLivenessIntervals reads as
// 'offline' ($1 is the window, in Postgres interval syntax). A worker pod
// that died without a graceful exit never writes its own offline row; the
// scheduler view must not credit its capacity, or a k8s rollout leaves ~90
// long-dead pods each advertising capacity 2.
const m4SchedulerWorkerLiveness = `
	CASE
		WHEN w.status = '` + WorkerStatusOnline + `' AND w.last_heartbeat_at < now() - $1::interval THEN '` + WorkerStatusOffline + `'
		ELSE w.status
	END`

// m4SchedulerStatusSQL is the whole read in one round trip. Each member is
// the number the contract names, computed from the rows that make the
// decision rather than from a mirrored counter:
//
//   - attempts by status uses the three live statuses only — terminal
//     history is a run-list question (§ SchedulerAttemptsView).
//   - oldest_queued_age_seconds walks attempts_claim_idx (the queue's own
//     ordering: scheduled_at, id) and is NULL when nothing is queued; the
//     NULL is api's JSON null, not a fabricated 0.
//   - max_retry_loop_depth is the highest attempt_number among LIVE attempts:
//     the runaway-retry guard's dashboard number, so it must count what is in
//     flight now, not the deepest failure in history.
//   - waiting_approvals counts pending gates, behind which no worker and no
//     lease stand (ADR-0023 § 6).
//   - queued_unbindable_runs mirrors runClaimPredicate's worker half
//     (status='online' AND active_attempts < capacity) onto a queued or
//     running run's affinity: § 5.2's honest "still queued" number.
//     The advancer moves every queued run to 'running' on its first pass
//     (contract § 4 step 3, hermetic model), so a run with an unsatisfied
//     affinity whose READY attempts cannot be claimed is 'running' in the
//     database. The second OR arm catches that: the run is effectively
//     stuck because its only eligible worker is offline/draining/full.
//     It intentionally does NOT judge a run whose affinity is NULL — that
//     run is claimable by any worker, and counting it would blame the
//     scheduler for a state it is about to resolve.
const m4SchedulerStatusSQL = `
	SELECT 
		(SELECT COUNT(*) FROM attempts WHERE status = 'queued')::int8,
		(SELECT COUNT(*) FROM attempts WHERE status = 'leased')::int8,
		(SELECT COUNT(*) FROM attempts WHERE status = 'running')::int8,
		(SELECT EXTRACT(EPOCH FROM now() - a.scheduled_at)::double precision
		 FROM attempts a WHERE a.status = 'queued'
		 ORDER BY a.scheduled_at, a.id LIMIT 1),
		(SELECT COALESCE(MAX(a.attempt_number), 0)::int8
		 FROM attempts a WHERE a.status IN ('queued', 'leased', 'running')),
		(SELECT COUNT(*) FROM approval_requests WHERE state = 'pending')::int8,
		(SELECT COUNT(*) FROM runs r
		 JOIN workers w ON w.id = r.worker_affinity
		 WHERE (r.status = 'queued'
		    OR (r.status = 'running'
		        AND EXISTS (SELECT 1 FROM attempts a
		                    JOIN node_executions ne ON ne.id = a.node_execution_id
		                    WHERE ne.run_id = r.id
		                      AND a.status = 'queued'
		                      AND a.scheduled_at <= now())))
		   AND (` + m4SchedulerWorkerLiveness + ` <> '` + WorkerStatusOnline + `' OR w.active_attempts >= w.capacity))::int8`

// m4SchedulerWorkersSQL is the per-worker load pair the claim predicate
// compares, for every worker the claim predicate could actually grant work
// to: effective status 'online' (m4SchedulerWorkerLiveness, the same
// window /api/v1/workers uses). A row whose heartbeat expired cannot claim
// — its process is gone — so its capacity is not the engine's and listing
// it at "capacity 2" would inflate the fleet total with pods k8s rolled
// away long ago. Operators looking for the dead worker itself go to
// GET /api/v1/workers, which still reports every row with its effective
// status.
const m4SchedulerWorkersSQL = `
	SELECT w.id::text, w.name, w.capacity, w.active_attempts
	FROM workers w
	WHERE ` + m4SchedulerWorkerLiveness + ` = '` + WorkerStatusOnline + `'
	ORDER BY w.name, w.id`

// SchedulerStatus implements api.SchedulerStore.
func (a APISchedulerStore) SchedulerStatus(ctx context.Context) (api.SchedulerStatusView, error) {
	view := api.SchedulerStatusView{Workers: []api.SchedulerWorkerLoadView{}}
	if a.LeaseExpirations != nil {
		view.LeaseExpirations = a.LeaseExpirations()
	}
	pool, err := m4Pool(a.Pool, "APISchedulerStore")
	if err != nil {
		return view, err
	}

	// The same liveness window ListWorkersWithLiveness applies; zero falls
	// back to the registry default, mirroring its own rule.
	heartbeat := a.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = regDefaultHeartbeat
	}
	interval := regIntervalString(heartbeat * regLivenessIntervals)

	var (
		queued, leased, running   int64
		oldest                    sql.NullFloat64
		maxDepth, waiting, unbind int64
	)
	err = pool.QueryRow(ctx, m4SchedulerStatusSQL, interval).Scan(
		&queued, &leased, &running, &oldest, &maxDepth, &waiting, &unbind)
	if err != nil {
		return api.SchedulerStatusView{}, fmt.Errorf("postgres: scheduler counters read: %w", err)
	}
	view.AttemptsByStatus = api.SchedulerAttemptsView{
		Queued:  int(queued),
		Leased:  int(leased),
		Running: int(running),
	}
	if oldest.Valid {
		age := oldest.Float64
		if age < 0 {
			// A queued attempt scheduled in the future (a backoff written by a
			// clock ahead of the database's) would otherwise render a negative
			// age the schema forbids. Zero is the honest floor: the queue is
			// not waiting yet.
			age = 0
		}
		view.OldestQueuedAgeSeconds = &age
	}
	view.MaxRetryLoopDepth = int(maxDepth)
	view.WaitingApprovals = int(waiting)
	view.QueuedUnbindableRuns = int(unbind)

	rows, err := pool.Query(ctx, m4SchedulerWorkersSQL, interval)
	if err != nil {
		return api.SchedulerStatusView{}, fmt.Errorf("postgres: scheduler worker load read: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var w api.SchedulerWorkerLoadView
		if err := rows.Scan(&w.WorkerID, &w.Name, &w.Capacity, &w.ActiveAttempts); err != nil {
			return api.SchedulerStatusView{}, fmt.Errorf("postgres: scan scheduler worker load: %w", err)
		}
		view.Workers = append(view.Workers, w)
	}
	if err := rows.Err(); err != nil {
		return api.SchedulerStatusView{}, fmt.Errorf("postgres: scheduler worker load read: %w", err)
	}
	return view, nil
}
