package postgres

// Cross-project reads (ADR-0047, contract C3): the app shell's Home/Board/
// Threads/Inbox need one scoped answer per page, and the permission
// predicate is the project-scoped family's, transplanted onto a LIST —
// `JOIN projects` + the caller's `memberships` row, scoped through the
// ORGANIZATION (the authoritative scope), org-admin seeing all. An
// invisible project contributes no rows: a list never leaks existence the
// way a detail route's uniform not-found must, and a `project_id` filter
// naming an invisible project answers an empty page, not a 404.
//
// The per-step projection costs exactly ONE extra statement per page
// (every top-level node execution of every page row, `scope_key = '/'`),
// never one per run: the definition order and kind come from the run's
// pinned `plan_snapshot` (the root scope's nodes in document order — the
// compiler appends nodes as it walks the document), so a loop's iterations
// collapse into their single top-level segment and the `2/4` fractions the
// board draws stay honest.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dbirks/communication/internal/api"
)

// APICrossProjectStore implements api.CrossProjectStore. It holds only the
// pool: nothing here advances a run or writes a row.
type APICrossProjectStore struct {
	Pool *pgxpool.Pool
}

var (
	_ api.CrossProjectStore = APICrossProjectStore{}
	_ api.CrossProjectStore = (*APICrossProjectStore)(nil)
)

func (a APICrossProjectStore) pool() (*pgxpool.Pool, error) {
	if a.Pool == nil {
		return nil, fmt.Errorf("postgres: APICrossProjectStore has no pool")
	}
	return a.Pool, nil
}

// xpRunSelect is the page query's SELECT: the Run row plus the human names
// a cross-project card needs (the project's name, the pipeline's slug and
// display name) and the plan_snapshot the steps projection decodes.
const xpRunSelect = `
	SELECT r.id::text, r.project_id::text, p.name,
	       r.pipeline_id::text, pl.slug, pl.display_name,
	       r.pipeline_revision_id::text, r.revision_digest, r.plan_digest,
	       r.plan_snapshot,
	       COALESCE(r.assignment_id::text, ''), r.status, COALESCE(r.failed_cause, ''),
	       r.depth, COALESCE(r.parent_run_id::text, ''),
	       COALESCE(r.triggered_by::text, ''), r.priority,
	       COALESCE(r.trigger_kind, ''), COALESCE(r.trigger_ref, ''),
	       r.created_at, r.started_at, r.finished_at
	FROM runs r
	JOIN projects p ON p.id = r.project_id
	JOIN pipelines pl ON pl.id = r.pipeline_id
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// ListVisibleRuns answers GET /api/v1/runs: the caller's runs across all
// their projects, newest first, with the board's filters and keyset
// pagination. The caller's identity is always args 1-3 (the predicate's
// shape); the optional filters append after, so their clause numbers are
// derived, never hand-counted.
func (a APICrossProjectStore) ListVisibleRuns(ctx context.Context, c api.Caller, f api.CrossProjectRunsFilter) ([]api.CrossProjectRunView, string, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, "", err
	}
	args := []any{c.UserID, c.OrganizationID, c.IsOrgAdmin}
	var conds []string
	addCond := func(clause string, values ...any) {
		args = append(args, values...)
		conds = append(conds, clause)
	}
	if len(f.Statuses) > 0 {
		addCond(fmt.Sprintf("r.status = ANY($%d)", len(args)+1), f.Statuses)
	}
	if f.ProjectID != "" {
		addCond(fmt.Sprintf("r.project_id = $%d::uuid", len(args)+1), f.ProjectID)
	}
	if f.PipelineID != "" {
		addCond(fmt.Sprintf("r.pipeline_id = $%d::uuid", len(args)+1), f.PipelineID)
	}
	if f.Mine {
		// Reuses $1 (the caller): a child or a system start has no
		// triggered_by and is never "mine".
		conds = append(conds, "r.triggered_by = $1::uuid")
	}
	if f.UpdatedSince != nil {
		addCond(fmt.Sprintf("COALESCE(r.finished_at, r.created_at) >= $%d::timestamptz", len(args)+1),
			f.UpdatedSince.UTC())
	}
	if f.Trigger != "" {
		// ADR-0056: the run-list trigger filter (manual|schedule|issue|thread);
		// validated by the handler before it reaches the store.
		addCond(fmt.Sprintf("r.trigger_kind = $%d::text", len(args)+1), f.Trigger)
	}
	if f.Cursor != "" {
		cur, err := api.ParseCrossProjectCursor(f.Cursor)
		if err != nil {
			// The handler answered 400 before this; a store-level caller
			// with a bad cursor gets a plain error, not a page.
			return nil, "", fmt.Errorf("postgres: cross-project runs cursor: %w", err)
		}
		addCond(fmt.Sprintf("(r.created_at, r.id) < ($%d::timestamptz, $%d::uuid)",
			len(args)+1, len(args)+2), cur.CreatedAt.UTC(), cur.ID)
	}
	limit := f.Limit
	if limit < 1 {
		limit = api.CrossProjectDefaultLimit
	}
	if limit > api.CrossProjectMaxLimit {
		limit = api.CrossProjectMaxLimit
	}
	// Fetch limit+1: the extra row is the over-fetch that decides whether a
	// next page exists, so `next_cursor` never claims a page that is empty.
	probe := limit + 1
	sql := xpRunSelect
	if len(conds) > 0 {
		sql += "\n  AND " + strings.Join(conds, "\n  AND ")
	}
	sql += fmt.Sprintf("\nORDER BY r.created_at DESC, r.id DESC\nLIMIT $%d", len(args)+1)
	args = append(args, probe)

	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: list visible runs: %w", err)
	}
	defer rows.Close()

	var (
		views  []api.CrossProjectRunView
		runIDs []string
		plans  = map[string]Run{}
	)
	for rows.Next() {
		var (
			r            Run
			projectName  string
			pipelineSlug string
			pipelineName string
		)
		if err := rows.Scan(&r.ID, &r.ProjectID, &projectName, &r.PipelineID,
			&pipelineSlug, &pipelineName, &r.PipelineRevisionID, &r.RevisionDigest,
			&r.PlanDigest, &r.PlanSnapshot, &r.AssignmentID, &r.Status, &r.FailedCause,
			&r.Depth, &r.ParentRunID, &r.TriggeredBy, &r.Priority,
			&r.TriggerKind, &r.TriggerRef,
			&r.CreatedAt, &r.StartedAt, &r.FinishedAt); err != nil {
			return nil, "", fmt.Errorf("postgres: scan visible run: %w", err)
		}
		view := api.CrossProjectRunView{
			RunSummaryView: m4RunSummary(r),
			ProjectName:    projectName, PipelineSlug: pipelineSlug,
			PipelineDisplayName: pipelineName, Steps: []api.CrossProjectRunStep{},
		}
		views = append(views, view)
		runIDs = append(runIDs, r.ID)
		plans[r.ID] = r
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: list visible runs rows: %w", err)
	}

	next := ""
	if len(views) > limit {
		// The over-fetched row proves a next page: the cursor is the LAST
		// row the caller gets, and the probe row is dropped.
		tail := views[limit-1]
		next = api.EncodeCrossProjectCursor(api.CrossProjectCursor{
			CreatedAt: tail.CreatedAt, ID: tail.ID})
		views = views[:limit]
		runIDs = runIDs[:limit]
	}

	// The one per-page statement for the whole projection: every top-level
	// node execution of every page row, in one ANY(). No N+1 — a 200-row
	// page costs these two statements.
	if len(views) > 0 {
		steps, err := xpRunSteps(ctx, pool, runIDs)
		if err != nil {
			return nil, "", err
		}
		for i := range views {
			views[i].Steps = xpProjectSteps(plans[views[i].ID].PlanSnapshot, steps[views[i].ID])
		}
	}
	return views, next, nil
}

// xpRunSteps is the projection's one statement: every TOP-LEVEL node
// execution (scope_key = '/', the run's root scope) of the page's runs.
// Body nodes of a loop live in their loop's scope key and never surface
// here — the loop's own single top-level row carries the whole loop's fate.
func xpRunSteps(ctx context.Context, pool *pgxpool.Pool, runIDs []string) (map[string]map[string][]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT run_id::text, node_id, status
		FROM node_executions
		WHERE run_id = ANY($1::uuid[]) AND scope_key = '/'`, runIDs)
	if err != nil {
		return nil, fmt.Errorf("postgres: page run steps: %w", err)
	}
	defer rows.Close()
	out := map[string]map[string][]string{}
	for rows.Next() {
		var runID, nodeID, status string
		if err := rows.Scan(&runID, &nodeID, &status); err != nil {
			return nil, fmt.Errorf("postgres: scan page run step: %w", err)
		}
		byNode, ok := out[runID]
		if !ok {
			byNode = map[string][]string{}
			out[runID] = byNode
		}
		byNode[nodeID] = append(byNode[nodeID], status)
	}
	return out, rows.Err()
}

// xpPlanNodes is the shape of runs.plan_snapshot this projection needs:
// the compiler appends nodes as it walks the document, so the root scope's
// entries are the top-level steps in DEFINITION order (ADR-0047 § 4).
type xpPlanNodes struct {
	Nodes []struct {
		ID    string `json:"id"`
		Kind  string `json:"kind"`
		Scope string `json:"scope"`
	} `json:"nodes"`
}

// xpProjectSteps builds one run's steps: the pinned revision's top-level
// nodes in definition order, each projected onto its seven step states
// from that run's node executions. A node with no execution row is pending
// (a queued run's plan is all-pending, exactly as the board draws it).
func xpProjectSteps(planSnapshot []byte, statuses map[string][]string) []api.CrossProjectRunStep {
	steps := []api.CrossProjectRunStep{}
	var plan xpPlanNodes
	if len(planSnapshot) > 0 {
		if err := json.Unmarshal(planSnapshot, &plan); err != nil {
			// A stored snapshot is schema-checked at publish; a decode
			// failure is a data bug the projection must not crash on —
			// it answers with no steps, and the run row still lists.
			return steps
		}
	}
	for _, n := range plan.Nodes {
		if n.Scope != "/" {
			continue
		}
		steps = append(steps, api.CrossProjectRunStep{
			NodeID: n.ID, Kind: n.Kind, State: xpAggregateStepState(statuses[n.ID]),
		})
	}
	return steps
}

// xpStepState maps one node execution's status onto a step state
// (ADR-0047 § 4's table): ready/leased have not visibly started (pending),
// interrupted stopped without completing (failed), and the rest is the
// identity.
func xpStepState(status string) string {
	switch status {
	case "running":
		return api.CrossProjectStepRunning
	case "waiting":
		return api.CrossProjectStepWaiting
	case "succeeded":
		return api.CrossProjectStepSucceeded
	case "skipped":
		return api.CrossProjectStepSkipped
	case "cancelled":
		return api.CrossProjectStepCancelled
	case "failed", "interrupted":
		return api.CrossProjectStepFailed
	default: // pending, ready, leased — and anything new the CHECK adds
		return api.CrossProjectStepPending
	}
}

// xpStepStateRank is the aggregation precedence for a node's several
// executions (a loop's rows): the state that most needs attention wins.
// A top-level node carries one row (UNIQUE (run_id, node_instance_key)),
// so on today's data this is the identity — the precedence is the contract
// for a future writer that adds rows.
var xpStepStateRank = map[string]int{
	api.CrossProjectStepFailed:    6,
	api.CrossProjectStepRunning:   5,
	api.CrossProjectStepWaiting:   4,
	api.CrossProjectStepCancelled: 3,
	api.CrossProjectStepSucceeded: 2,
	api.CrossProjectStepSkipped:   1,
	api.CrossProjectStepPending:   0,
}

// xpAggregateStepState folds one top-level node's execution statuses into
// its single step state: the highest-ranked one (failed beats running
// beats ... beats pending; no executions = pending).
func xpAggregateStepState(execStatuses []string) string {
	best, bestRank := api.CrossProjectStepPending, xpStepStateRank[api.CrossProjectStepPending]
	for _, s := range execStatuses {
		st := xpStepState(s)
		if xpStepStateRank[st] > bestRank {
			best, bestRank = st, xpStepStateRank[st]
		}
	}
	return best
}

// ListVisibleApprovals answers GET /api/v1/approvals: the caller's gates
// across all their projects. The predicate and the columns are the
// project route's own (m4ApprovalScope / m4ApprovalColumns) transplanted
// onto the list — the same role gate the detail route enforces, applied
// row by row in SQL.
func (a APICrossProjectStore) ListVisibleApprovals(ctx context.Context, c api.Caller, status string) ([]api.ApprovalView, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, err
	}
	cc := callerFromAPI(c)
	sql := "SELECT " + m4ApprovalColumns + "\n" + m4ApprovalScope
	args := []any{cc.UserID, cc.OrganizationID, cc.IsOrgAdmin}
	if status != "" {
		args = append(args, status)
		sql += "\n\t  AND x.state = $" + strconv.Itoa(len(args))
	}
	// The project list's ordering: the urgent one (about to expire) first.
	sql += `
	ORDER BY CASE WHEN x.state = 'pending' THEN 0 ELSE 1 END,
	         CASE WHEN x.state = 'pending' THEN x.deadline_at END ASC NULLS FIRST,
	         x.created_at DESC, x.id DESC`
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: list visible approvals: %w", err)
	}
	defer rows.Close()
	out := []api.ApprovalView{}
	for rows.Next() {
		v, err := m4ScanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// xpConversationSelect is the project list's SELECT (conversation,
// profile name, controller, creator display name, the two EXISTS liveness
// probes and the run-link LATERAL) with the visibility predicate swapped:
// the project id comes from the JOIN, so the predicate is the family's.
const xpConversationSelect = `
	SELECT c.id::text, c.project_id::text, c.agent_profile_id::text, c.title, c.status,
	       c.created_by::text, COALESCE(cb.display_name, ''), c.created_at, c.updated_at,
	       ctl.controller_kind, COALESCE(ctl.controller_user_id::text, ''),
	       COALESCE(ctr.display_name, ''), COALESCE(ctl.previous_controller_user_id::text, ''),
	       ctl.version,
	       EXISTS (
	           SELECT 1 FROM conversation_turns t
	           WHERE t.conversation_id = c.id
	             AND t.status IN ('queued', 'leased', 'running')
	       ),
	       EXISTS (
	           SELECT 1 FROM acp_session_bindings b
	           WHERE b.conversation_id = c.id AND b.status = 'connected'
	       ),
	       COALESCE(la.run_id::text, ''), COALESCE(la.node_execution_id::text, ''),
	       COALESCE(la.node_instance_key, ''), COALESCE(la.node_id, ''),
	       COALESCE(la.attempt_id::text, ''), COALESCE(la.attempt_number, 0)
	FROM conversations c
	JOIN projects p ON p.id = c.project_id
	JOIN conversation_control ctl ON ctl.conversation_id = c.id
	LEFT JOIN users cb ON cb.id = c.created_by
	LEFT JOIN users ctr ON ctr.id = ctl.controller_user_id` + cnvRunLinkSubquery + `
	LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = $1::uuid
	WHERE p.organization_id = $2::uuid
	  AND ($3::boolean OR m.user_id IS NOT NULL)`

// ListVisibleConversations answers GET /api/v1/conversations: the caller's
// conversations across all their projects, newest first, keyset-paginated
// on (created_at, id). The run-link columns are COALESCEd exactly as the
// project list does, so the scan shares its sentinel convention.
func (a APICrossProjectStore) ListVisibleConversations(ctx context.Context, c api.Caller, limit int, cursor string) ([]api.ConversationSummaryView, string, error) {
	pool, err := a.pool()
	if err != nil {
		return nil, "", err
	}
	args := []any{c.UserID, c.OrganizationID, c.IsOrgAdmin}
	sql := xpConversationSelect
	if cursor != "" {
		cur, err := api.ParseCrossProjectCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("postgres: cross-project conversations cursor: %w", err)
		}
		args = append(args, cur.CreatedAt.UTC(), cur.ID)
		sql += fmt.Sprintf("\n  AND (c.created_at, c.id) < ($%d::timestamptz, $%d::uuid)",
			len(args)-1, len(args))
	}
	if limit < 1 {
		limit = api.CrossProjectDefaultLimit
	}
	if limit > api.CrossProjectMaxLimit {
		limit = api.CrossProjectMaxLimit
	}
	// The over-fetch, as on the runs page: limit+1 decides the next page.
	args = append(args, limit+1)
	sql += "\nORDER BY c.created_at DESC, c.id DESC\nLIMIT $" + strconv.Itoa(len(args))

	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: list visible conversations: %w", err)
	}
	defer rows.Close()
	out := []api.ConversationSummaryView{}
	for rows.Next() {
		var (
			cv                                                    CnvSummary
			laRunID, laNodeExec, laNodeKey, laNodeID, laAttemptID string
			laAttemptNumber                                       int
		)
		if err := rows.Scan(&cv.ID, &cv.ProjectID, &cv.AgentProfileID, &cv.Title, &cv.Status,
			&cv.CreatedBy, &cv.CreatedByDisplay, &cv.CreatedAt, &cv.UpdatedAt,
			&cv.Control.Kind, &cv.Control.UserID, &cv.Control.DisplayName,
			&cv.Control.PreviousUserID, &cv.Control.Version,
			&cv.HasActiveTurn, &cv.AgentConnected,
			&laRunID, &laNodeExec, &laNodeKey, &laNodeID, &laAttemptID, &laAttemptNumber); err != nil {
			return nil, "", fmt.Errorf("postgres: scan visible conversation: %w", err)
		}
		cv.Control.ConversationID = cv.ID
		cv.CreatedAt = cv.CreatedAt.UTC()
		cv.UpdatedAt = cv.UpdatedAt.UTC()
		if laAttemptID != "" {
			var laNodeIDPtr *string
			if laNodeID != "" {
				laNodeIDPtr = &laNodeID
			}
			cv.RunLink = &CnvRunLink{
				RunID: laRunID, NodeExecutionID: laNodeExec, NodeInstanceKey: laNodeKey,
				NodeID: laNodeIDPtr, AttemptID: laAttemptID, AttemptNumber: laAttemptNumber,
			}
			cv.Origin = "run"
		} else {
			cv.Origin = "manual"
		}
		view := api.ConversationSummaryView{
			ID:               cv.ID,
			ProjectID:        cv.ProjectID,
			AgentProfileID:   cv.AgentProfileID,
			Title:            cv.Title,
			Status:           cv.Status,
			CreatedBy:        cv.CreatedBy,
			CreatedByDisplay: apiNullString(cv.CreatedByDisplay),
			CreatedAt:        cv.CreatedAt,
			UpdatedAt:        cv.UpdatedAt,
			Control:          cnvAPIControl(cv.Control),
			HasActiveTurn:    cv.HasActiveTurn,
			AgentConnected:   cv.AgentConnected,
			Origin:           cv.Origin,
			RunLink:          cnvAPIRunLink(cv.RunLink),
		}
		out = append(out, view)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: list visible conversations rows: %w", err)
	}
	next := ""
	if len(out) == limit+1 {
		tail := out[limit-1]
		next = api.EncodeCrossProjectCursor(api.CrossProjectCursor{
			CreatedAt: tail.CreatedAt, ID: tail.ID})
		out = out[:limit]
	}
	return out, next, nil
}
