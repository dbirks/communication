package postgres

// The READ half of api.RunStore (docs/m4-contract.md § 2.1 routes 21/23/24/
// 25/26/27/32 and § 5.2's placement answer). The write half — CreateRun,
// PauseRun, ResumeRun, CancelRun, RetryRun — lives in m4api_runs_write.go;
// this file touches no row.
//
// Every read here carries the caller's membership in its SQL, transplanted
// from prjProjectSelect onto the resource the caller named: a run, node
// execution, checkpoint or attempt of a project the caller is not a member
// of answers api.ErrRunNotFound (api.ErrProjectNotFound on the project-scoped
// list), byte-identical to a uuid that never existed. The one piece of
// run-internal machinery these views do NOT carry is the lease triple:
// api.RunView reports placement as {scheduled, reason} and api.AttemptView has
// no worker/fence column at all, because "which worker owns this row" is
// server-side fencing state, not browser knowledge (ADR-0016 § 8, ADR-0023
// § 4). MyRole rides every view so the handler's role gate has the caller's
// project role without a second round trip.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// APIRunStore exposes the committed *RunStore as api.RunStore's read face.
// Runtime is carried for the write half's wiring (and is optional for reads:
// nothing here advances a run).
type APIRunStore struct {
	Runs    *RunStore     // internal/store/postgres/runs.go
	Runtime *RuntimeStore // internal/store/postgres/runtimestore.go
}

// (The api.RunStore conformance assertion lives in m4api.go's var block, so
// this file — the read half alone — does not re-declare it.)

// m4RunReadPool resolves the store's pool or refuses with a plain error.
// A free function rather than a method so the write-half file stays free to
// name its own helper without colliding on one method set.
func m4RunReadPool(a APIRunStore) (*pgxpool.Pool, error) {
	if a.Runs == nil {
		return nil, errors.New("postgres: APIRunStore has no RunStore")
	}
	return m4Pool(a.Runs.Pool, "APIRunStore")
}

// m4RunReadScopeSQL is m4RunScopeSQL's predicate with the caller's project
// role added: $1 user, $2 organization, $3 org-admin, $4 run id. It answers
// both questions a run read needs — may this caller see the row, and with
// what role — in one round trip, and it scopes the ORGANIZATION through
// projects (the authoritative scope) rather than runs.organization_id.
const m4RunReadScopeSQL = `
	SELECT r.project_id::text, COALESCE(m.role, 'maintainer')
	FROM runs r
	JOIN projects p ON p.id = r.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE r.id = $4::uuid
	  AND p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// m4RunReadScope resolves a run through the caller's visibility. The
// not-found leg wraps BOTH sentinels (api's, so the handler renders the 404,
// and the store's, so a caller reading the chain sees which layer refused)
// exactly as APIRunEventStream does.
func m4RunReadScope(ctx context.Context, pool *pgxpool.Pool, c api.Caller, runID string) (projectID, role string, err error) {
	if !prjValidUUID(runID) {
		return "", "", fmt.Errorf("%w: %w", api.ErrRunNotFound, ErrRunNotFound)
	}
	err = pool.QueryRow(ctx, m4RunReadScopeSQL,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, runID).Scan(&projectID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("%w: %w", api.ErrRunNotFound, ErrRunNotFound)
	}
	if err != nil {
		return "", "", fmt.Errorf("postgres: authorize run read for %s: %w", runID, err)
	}
	return projectID, role, nil
}

// m4RunReadProjectScope is the same predicate narrowed to a project (route
// 21 asks about a project, not a run, so its refusal is the project 404).
func m4RunReadProjectScope(ctx context.Context, pool *pgxpool.Pool, c api.Caller, projectID string) (string, error) {
	cc := callerFromAPI(c)
	if err := prjRequireCaller(cc); err != nil {
		return "", err
	}
	proj, err := prjGetProject(ctx, pool, cc, projectID)
	if errors.Is(err, ErrProjectNotFound) {
		return "", fmt.Errorf("%w: %w", api.ErrProjectNotFound, err)
	}
	if err != nil {
		return "", err
	}
	return proj.MyRole, nil
}

// m4RunReadNotFound is the family's uniform refusal.
func m4RunReadNotFound() error {
	return fmt.Errorf("%w: %w", api.ErrRunNotFound, ErrRunNotFound)
}

// m4RunSummary projects a Run row onto the RunSummary schema. Every digest on
// it is the pinned copy from creation, never a re-resolve (12 case 11).
func m4RunSummary(r Run) api.RunSummaryView {
	v := api.RunSummaryView{
		ID: r.ID, ProjectID: r.ProjectID, PipelineID: r.PipelineID,
		PipelineRevisionID: r.PipelineRevisionID,
		RevisionDigest:     r.RevisionDigest, PlanDigest: r.PlanDigest,
		Status: r.Status, Depth: r.Depth, Priority: r.Priority,
		CreatedAt: r.CreatedAt, StartedAt: r.StartedAt, FinishedAt: r.FinishedAt,
	}
	v.AssignmentID = m4RunReadPtr(r.AssignmentID)
	v.FailedCause = m4RunReadPtr(r.FailedCause)
	v.ParentRunID = m4RunReadPtr(r.ParentRunID)
	v.TriggeredBy = m4RunReadPtr(r.TriggeredBy)
	v.Trigger = m4RunTrigger(r)
	return v
}

// m4RunTrigger projects the ADR-0056 trigger fact onto the run JSON: the
// kind how the run was started ('manual' for a hand start, 'thread' for a
// handoff start, 'schedule' for a fire, 'issue' for an issue start) and the
// trigger's own identifier in Ref (the schedule id, the `owner/repo#<n>`, or
// null when the kind is 'manual'/'thread' and the context is the thread).
func m4RunTrigger(r Run) *api.RunTriggerView {
	kind := r.TriggerKind
	if kind == "" {
		kind = "manual"
	}
	v := &api.RunTriggerView{Kind: kind}
	if r.TriggerRef != "" {
		ref := r.TriggerRef
		v.Ref = &ref
	}
	return v
}

func m4RunReadPtr(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

// m4RunRepoSnapshot decodes runs.repo_snapshot into the schema's commit
// identities. A malformed row yields nothing rather than a half-truth: the
// column has no CHECK pinning member names, and an unrecognizable entry is
// never rendered as a commit the run did not start from.
func m4RunRepoSnapshot(raw json.RawMessage) []api.RunRepoSnapshotView {
	out := []api.RunRepoSnapshotView{}
	if len(raw) == 0 {
		return out
	}
	var rows []struct {
		RepositoryID string `json:"repository_id"`
		BaseCommit   string `json:"base_commit"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return out
	}
	for _, r := range rows {
		if r.RepositoryID == "" || r.BaseCommit == "" {
			continue
		}
		out = append(out, api.RunRepoSnapshotView{RepositoryID: r.RepositoryID, BaseCommit: r.BaseCommit})
	}
	return out
}

// m4RunReadPlacementSQL is § 5.2's whole question in one row: is the run's
// affinity worker online and under capacity? The scheduler counter's SQL
// (m4SchedulerStatusSQL's queued_unbindable_runs) uses this same predicate,
// so the run detail and /system/scheduler can never disagree about how many
// runs are stuck waiting for a worker that is not coming.
const m4RunReadPlacementSQL = `
	SELECT COUNT(*) FROM workers w
	WHERE w.id = $1::uuid AND w.status = 'online' AND w.active_attempts < w.capacity`

// m4RunReadPlacement derives the placement view from the run row and its
// worker's state — never from an in-memory guess, and it never names the
// worker (§ 5.2, ADR-0023 § 4/§ 5).
func m4RunReadPlacement(ctx context.Context, pool *pgxpool.Pool, r Run) api.RunPlacementView {
	view := api.RunPlacementView{Scheduled: true}
	if (r.Status != "queued" && r.Status != "preparing") || r.WorkerAffinity == "" {
		return view
	}
	var bindable int
	if err := pool.QueryRow(ctx, m4RunReadPlacementSQL, r.WorkerAffinity).Scan(&bindable); err != nil {
		// An unreadable worker row is not evidence that the worker is
		// healthy: say so with the honest false rather than a optimistic true.
		reason := "volume_affinity_unsatisfied"
		view.Scheduled, view.Reason = false, &reason
		return view
	}
	if bindable == 0 {
		reason := "volume_affinity_unsatisfied"
		view.Scheduled, view.Reason = false, &reason
	}
	return view
}

// GetRun is route 23: the run detail with its validated inputs, its pinned
// repo snapshot, the revision's digest_scope and the placement view.
func (a APIRunStore) GetRun(ctx context.Context, c api.Caller, runID string) (api.RunView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return api.RunView{}, err
	}
	_, role, err := m4RunReadScope(ctx, pool, c, runID)
	if err != nil {
		return api.RunView{}, err
	}
	r, err := a.Runs.GetRun(ctx, runID)
	if errors.Is(err, ErrRunNotFound) {
		return api.RunView{}, m4RunReadNotFound()
	}
	if err != nil {
		return api.RunView{}, err
	}
	return a.m4RunReadView(ctx, pool, r, role)
}

// m4RunReadView assembles the Run schema from the row plus its two joined
// reads (run_inputs, the revision's digest_scope) and the placement answer.
func (a APIRunStore) m4RunReadView(ctx context.Context, pool *pgxpool.Pool, r Run, role string) (api.RunView, error) {
	view := api.RunView{
		RunSummaryView:        m4RunSummary(r),
		PausedReason:          m4RunReadPtr(r.PausedReason),
		ExpressionEvaluations: r.ExpressionEvals,
		Placement:             m4RunReadPlacement(ctx, pool, r),
		RepoSnapshot:          m4RunRepoSnapshot(r.RepoSnapshot),
		MyRole:                role,
	}
	view.CancelRequestedAt = r.CancelRequestedAt
	if r.SourceConversationID != "" {
		id := r.SourceConversationID
		view.SourceConversationID = &id
	}

	var digestScope string
	err := pool.QueryRow(ctx, `
		SELECT pr.digest_scope FROM pipeline_revisions pr
		WHERE pr.id = $1::uuid`, r.PipelineRevisionID).Scan(&digestScope)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return api.RunView{}, fmt.Errorf("postgres: read run %s digest scope: %w", r.ID, err)
	}
	view.DigestScope = digestScope

	inputs, err := m4RunReadInputs(ctx, pool, r.ID)
	if err != nil {
		return api.RunView{}, err
	}
	view.Inputs = inputs
	return view, nil
}

// m4RunReadInputs reads a run's validated input rows. run_inputs is written
// in the create transaction and never re-resolved, so the origin column is
// the durable answer to "what did this run actually receive?".
func m4RunReadInputs(ctx context.Context, pool *pgxpool.Pool, runID string) ([]api.RunInputValueView, error) {
	rows, err := pool.Query(ctx, `
		SELECT name, value, origin FROM run_inputs
		WHERE run_id = $1::uuid ORDER BY name`, runID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list run %s inputs: %w", runID, err)
	}
	defer rows.Close()
	out := []api.RunInputValueView{}
	for rows.Next() {
		var (
			in    api.RunInputValueView
			value []byte
		)
		if err := rows.Scan(&in.Name, &value, &in.Origin); err != nil {
			return nil, fmt.Errorf("postgres: scan run input: %w", err)
		}
		in.Value = json.RawMessage(value)
		out = append(out, in)
	}
	return out, rows.Err()
}

// ListProjectRuns is route 21: the project's runs newest-first. An invisible
// project answers api.ErrProjectNotFound (the handler's own project gate
// agrees), never an empty list that pretends the project has no runs. The
// assistant's read surface reuses it with no trigger filter.
func (a APIRunStore) ListProjectRuns(ctx context.Context, c api.Caller, projectID string) ([]api.RunSummaryView, error) {
	return a.listProjectRuns(ctx, c, projectID, "")
}

// ListProjectRunsFiltered is route 21's ADR-0056 trigger-filtered read: the
// project's runs, optionally kept only to the started-by kind (the handler
// validates the kind before it reaches the store).
func (a APIRunStore) ListProjectRunsFiltered(ctx context.Context, c api.Caller, projectID string, trigger string) ([]api.RunSummaryView, error) {
	return a.listProjectRuns(ctx, c, projectID, trigger)
}

func (a APIRunStore) listProjectRuns(ctx context.Context, c api.Caller, projectID, trigger string) ([]api.RunSummaryView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return nil, err
	}
	if _, err := m4RunReadProjectScope(ctx, pool, c, projectID); err != nil {
		return nil, err
	}
	runs, err := a.Runs.ListProjectRuns(ctx, projectID, trigger)
	if err != nil {
		return nil, err
	}
	out := make([]api.RunSummaryView, 0, len(runs))
	for _, r := range runs {
		out = append(out, m4RunSummary(r))
	}
	return out, nil
}

// m4RunNodeView projects a node execution row. Iterations/Items stay nil —
// they are scope bookkeeping the plan snapshot carries, and an absent
// pointer serializes as absent, never as a wrong zero.
func m4RunNodeView(n NodeExecution, role string) api.NodeExecutionView {
	v := api.NodeExecutionView{
		ID: n.ID, RunID: n.RunID, NodeID: n.NodeID, Kind: n.Kind,
		NodeInstanceKey: n.NodeInstanceKey, ScopeKey: n.ScopeKey,
		ExecutionLocation: n.ExecutionLocation, Status: n.Status,
		Outputs: n.Outputs, ArtifactRefs: n.ArtifactRefs, DependsOn: n.DependsOn,
		AttemptCount: n.AttemptCount, AttemptLimit: n.AttemptLimit, InFlight: n.InFlight,
		CreatedAt: n.CreatedAt, ReadyAt: n.ReadyAt, FinishedAt: n.FinishedAt,
		Outcome:       m4RunReadPtr(n.Outcome),
		ErrorClass:    m4RunReadPtr(n.ErrorClass),
		FailedCause:   m4RunReadPtr(n.FailedCause),
		WaitingReason: m4RunReadPtr(n.WaitingReason),
		MyRole:        role,
	}
	return v
}

// ListRunNodes is route 24 — every node execution of the run in key order.
func (a APIRunStore) ListRunNodes(ctx context.Context, c api.Caller, runID string) ([]api.NodeExecutionView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return nil, err
	}
	_, role, err := m4RunReadScope(ctx, pool, c, runID)
	if err != nil {
		return nil, err
	}
	nodes, err := a.Runs.ListNodeExecutions(ctx, runID)
	if err != nil {
		return nil, err
	}
	out := make([]api.NodeExecutionView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, m4RunNodeView(n, role))
	}
	return out, nil
}

// m4RunCheckpointView projects a boundary record. worker_id appears exactly
// as far as M3 already made it fleet identity (D-009); no path, no lease.
func m4RunCheckpointView(runID string, cp CheckpointRecord) api.RunCheckpointView {
	return api.RunCheckpointView{
		RunID: runID, NodeExecutionID: cp.NodeExecutionID, AttemptID: cp.AttemptID,
		NodeInstanceKey: cp.NodeInstanceKey, InputsDigest: cp.InputsDigest,
		OutputsDigest: cp.OutputsDigest, RepoStates: cp.RepoStates,
		ArtifactRefs: cp.ArtifactRefs, WorkspaceID: cp.WorkspaceID,
		VolumeID: cp.VolumeID, WorkerID: cp.WorkerID, PlanDigest: cp.PlanDigest,
		CreatedAt: cp.CreatedAt,
	}
}

// GetRunNode is route 25: the execution, its full attempt history, its
// checkpoint when one exists, and the CEL envelope it actually saw. The
// (runId, nodeExecutionId) PAIR is enforced — a node of another run answers
// the same 404 even when the caller may see both rows, because the URL is a
// claim about a relationship.
func (a APIRunStore) GetRunNode(ctx context.Context, c api.Caller, runID, nodeExecutionID string) (api.NodeExecutionDetailView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return api.NodeExecutionDetailView{}, err
	}
	_, role, err := m4RunReadScope(ctx, pool, c, runID)
	if err != nil {
		return api.NodeExecutionDetailView{}, err
	}
	if !prjValidUUID(nodeExecutionID) {
		return api.NodeExecutionDetailView{}, m4RunReadNotFound()
	}
	n, err := a.Runs.GetNodeExecution(ctx, nodeExecutionID)
	if errors.Is(err, ErrRunNotFound) {
		return api.NodeExecutionDetailView{}, m4RunReadNotFound()
	}
	if err != nil {
		return api.NodeExecutionDetailView{}, err
	}
	if n.RunID != runID {
		return api.NodeExecutionDetailView{}, m4RunReadNotFound()
	}

	attempts, err := a.Runs.ListNodeAttempts(ctx, nodeExecutionID)
	if err != nil {
		return api.NodeExecutionDetailView{}, err
	}
	out := api.NodeExecutionDetailView{
		NodeExecutionView: m4RunNodeView(n, role),
		Attempts:          make([]api.AttemptView, 0, len(attempts)),
		// ADR-0022 § 3's published envelope for THIS node: the row is the
		// envelope's source, so an unscheduled node's {status, no outputs}
		// answer is exactly what a when/skip decision read.
		CelEnvelope: api.CelEnvelopeView{
			Status: n.Status, Outcome: m4RunReadPtr(n.Outcome),
			Outputs: n.Outputs, ArtifactRefs: n.ArtifactRefs,
		},
	}
	for _, at := range attempts {
		out.Attempts = append(out.Attempts, m4AttemptView(at, role))
	}
	cps, err := a.Runs.ListRunCheckpoints(ctx, runID)
	if err != nil {
		return api.NodeExecutionDetailView{}, err
	}
	for _, cp := range cps {
		if cp.NodeExecutionID == nodeExecutionID {
			view := m4RunCheckpointView(runID, cp)
			out.Checkpoint = &view
			break
		}
	}
	return out, nil
}

// m4AttemptView projects an attempt WITHOUT the lease triple: api.AttemptView
// has no worker_id / fencing_token / lease_expires_at field to leak
// (ADR-0016 § 8) — the fence protects clients by being asserted server-side.
func m4AttemptView(a Attempt, role string) api.AttemptView {
	return api.AttemptView{
		ID: a.ID, NodeExecutionID: a.NodeExecutionID, RunID: a.RunID,
		AttemptNumber: a.AttemptNumber, Status: a.Status,
		ErrorClass: m4RunReadPtr(a.ErrorClass), Detail: m4RunReadPtr(a.Detail),
		OutputErrors: a.OutputErrors, ScheduledAt: a.ScheduledAt, DeadlineAt: a.DeadlineAt,
		Overrides: a.Overrides, RetryContext: a.RetryContext, ArtifactRefs: a.ArtifactRefs,
		Outputs: a.Outputs, OutputsDigest: m4RunReadPtr(a.OutputsDigest),
		ConversationID: m4RunReadPtr(a.ConversationID), TurnID: m4RunReadPtr(a.TurnID),
		CreatedAt: a.CreatedAt, StartedAt: a.StartedAt, FinishedAt: a.FinishedAt,
		MyRole: role,
	}
}

// m4RunReadAttemptScopeSQL resolves an attempt's owning run through the
// caller's membership — the attempt route's visibility predicate, so a
// foreign attempt is indistinguishable from a nonsense uuid.
const m4RunReadAttemptScopeSQL = `
	SELECT r.id::text, COALESCE(m.role, 'maintainer')
	FROM attempts at
	JOIN runs r ON r.id = at.run_id
	JOIN projects p ON p.id = r.project_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE at.id = $4::uuid
	  AND p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// GetAttempt is route 32.
func (a APIRunStore) GetAttempt(ctx context.Context, c api.Caller, attemptID string) (api.AttemptView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return api.AttemptView{}, err
	}
	if err := prjRequireCaller(callerFromAPI(c)); err != nil {
		return api.AttemptView{}, err
	}
	if !prjValidUUID(attemptID) {
		return api.AttemptView{}, m4RunReadNotFound()
	}
	var runID, role string
	err = pool.QueryRow(ctx, m4RunReadAttemptScopeSQL,
		c.UserID, c.OrganizationID, c.IsOrgAdmin, attemptID).Scan(&runID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.AttemptView{}, m4RunReadNotFound()
	}
	if err != nil {
		return api.AttemptView{}, fmt.Errorf("postgres: authorize attempt read for %s: %w", attemptID, err)
	}
	at, err := a.Runs.GetAttempt(ctx, attemptID)
	if errors.Is(err, ErrRunNotFound) {
		return api.AttemptView{}, m4RunReadNotFound()
	}
	if err != nil {
		return api.AttemptView{}, err
	}
	return m4AttemptView(at, role), nil
}

// m4RunReadChildrenSQL is one tree level: the child runs this run's
// pipeline_invocations produced, with the invoking node key and wait policy.
const m4RunReadChildrenSQL = `
	SELECT pi.child_run_id::text, ne.node_instance_key, pi.wait_policy, pi.depth
	FROM pipeline_invocations pi
	JOIN node_executions ne ON ne.id = pi.node_execution_id
	WHERE pi.run_id = $1::uuid
	ORDER BY ne.node_instance_key, pi.child_run_id`

// GetRunTree is route 26: the run and the child runs its invocations
// produced, recursively (root depth 0, ceiling 2 — the schema refuses more).
// Children are read only through the root's already-authorized project, so a
// tree can never be walked out of the caller's visibility.
func (a APIRunStore) GetRunTree(ctx context.Context, c api.Caller, runID string) (api.RunTreeView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return api.RunTreeView{}, err
	}
	projectID, _, err := m4RunReadScope(ctx, pool, c, runID)
	if err != nil {
		return api.RunTreeView{}, err
	}
	return a.m4RunReadTree(ctx, pool, projectID, runID)
}

func (a APIRunStore) m4RunReadTree(ctx context.Context, pool *pgxpool.Pool, projectID, runID string) (api.RunTreeView, error) {
	r, err := a.Runs.GetRun(ctx, runID)
	if errors.Is(err, ErrRunNotFound) {
		return api.RunTreeView{}, m4RunReadNotFound()
	}
	if err != nil {
		return api.RunTreeView{}, err
	}
	if r.ProjectID != projectID {
		// A child in another project is not this caller's to see, whatever
		// pipeline_invocations says about the relationship.
		return api.RunTreeView{}, m4RunReadNotFound()
	}
	tree := api.RunTreeView{Run: m4RunSummary(r), Children: []api.RunTreeView{}}

	rows, err := pool.Query(ctx, m4RunReadChildrenSQL, runID)
	if err != nil {
		return api.RunTreeView{}, fmt.Errorf("postgres: list child runs of %s: %w", runID, err)
	}
	type child struct {
		id, key, wait string
		depth         int
	}
	var kids []child
	for rows.Next() {
		var ch child
		if err := rows.Scan(&ch.id, &ch.key, &ch.wait, &ch.depth); err != nil {
			rows.Close()
			return api.RunTreeView{}, fmt.Errorf("postgres: scan pipeline invocation: %w", err)
		}
		kids = append(kids, ch)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return api.RunTreeView{}, fmt.Errorf("postgres: list child runs of %s: %w", runID, err)
	}
	rows.Close()

	for _, ch := range kids {
		sub, err := a.m4RunReadTree(ctx, pool, projectID, ch.id)
		if err != nil {
			return api.RunTreeView{}, err
		}
		key, wait, depth := ch.key, ch.wait, ch.depth
		sub.NodeInstanceKey, sub.WaitPolicy, sub.Depth = &key, &wait, &depth
		tree.Children = append(tree.Children, sub)
	}
	return tree, nil
}

// ListRunCheckpoints is route 27.
func (a APIRunStore) ListRunCheckpoints(ctx context.Context, c api.Caller, runID string) ([]api.RunCheckpointView, error) {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return nil, err
	}
	if _, _, err := m4RunReadScope(ctx, pool, c, runID); err != nil {
		return nil, err
	}
	cps, err := a.Runs.ListRunCheckpoints(ctx, runID)
	if err != nil {
		return nil, err
	}
	out := make([]api.RunCheckpointView, 0, len(cps))
	for _, cp := range cps {
		out = append(out, m4RunCheckpointView(runID, cp))
	}
	return out, nil
}

// RecordDenied writes the audit row for a refused run-family request; the
// shared m4Denied helper resolves the owning project from the row the caller
// named and leaves it NULL for an id that names none (audit_events.project_id
// is nullable).
func (a APIRunStore) RecordDenied(ctx context.Context, c api.Caller, resourceID, action string) error {
	pool, err := m4RunReadPool(a)
	if err != nil {
		return err
	}
	return m4Denied(ctx, pool, c, resourceID, action)
}
