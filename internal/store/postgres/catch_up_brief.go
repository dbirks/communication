package postgres

// The reads behind the catch-up BRIEF (ADR-0081): the lists a returning
// engineer needs, each one statement, each one scoped to the caller's own
// project memberships the way every other catch-up read is.
//
// The rules these queries keep:
//
//   - `WHERE project_id IN (the caller's memberships)` is not a filter the
//     caller may leave out or widen. Every query below starts from
//     `catchUpVisibleSome` (organization match AND org admin OR membership, with
//     the requested set intersected against it), so a project the caller is not
//     in contributes NO row — to no section, and to no count in `numbers`
//     (ADR-0081 § Security/privacy). There is no 403 to give: the honest answer
//     about a project you cannot see is the answer about a project with nothing
//     in it;
//   - the window is `[since, until)` on the row's own event clock (a gate when
//     it opened, a run when it finished, a revision when it published). Nothing
//     here rounds a timestamp or invents one: a run with no `finished_at` is
//     read on `created_at`, which is the clock it has;
//   - each read is bounded. The page caps the rows it draws, but the SQL is
//     bounded too, because a 7-day window over a busy organization is otherwise
//     an unbounded sort (ADR-0063's bounded-work rule, the same reason the tour
//     walk stops at a read count).
//
// One section deliberately does NOT live here: the shipped refs. `outputs` is
// model-written JSON whose shape is the template's, not the schema's, and the
// one reader for it already exists — `catchUpHarvestOutputs` in internal/api.
// This file hands that reader the envelope and the run it came from, so a PR
// number can only have come from a run that named it.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

// catchUpBriefRowMax bounds the reads that a cap will trim anyway. 400 node rows
// is a wide margin over the widest section cap (10), so `omitted` is the truth
// about the window rather than about this constant, except in an organization
// that ran 400 nodes between two page loads.
const catchUpBriefRowMax = 400

// catchUpBriefLiveStatuses is "in flight right now": queued, booting a workspace,
// or executing. It is stated once because `running_now` and `numbers.running`
// must be the same sentence — a count of a set the page does not list is the bug
// the audit found in the recap (a number nobody can check).
const catchUpBriefLiveStatuses = `('queued','preparing','running')`

// catchUpBriefRunClock is a run's event clock: when it ended if it ended, else
// when it began. Two queries that picked different clocks would let a run be
// counted in the window and not listed in it.
const catchUpBriefRunClock = `COALESCE (r.finished_at, r.created_at)`

// --- the window's start -------------------------------------------------

// CatchUpBriefLastVisit is where the `unseen` window begins. No visit row is the
// zero time — the caller's own rows, so no membership is involved and no other
// reader's stamp can be read by accident.
func (a APICatchUpStore) CatchUpBriefLastVisit(ctx context.Context, c api.Caller) (time.Time, error) {
	s, err := a.store()
	if err != nil {
		return time.Time{}, err
	}
	sc := prjAPICaller(c)
	var at time.Time
	err = s.Pool.QueryRow(ctx, `
		SELECT visited_at
		FROM catchup_visits
		WHERE user_id = $1::uuid
		ORDER BY visited_at DESC, id DESC
		LIMIT 1`, sc.UserID).Scan(&at)
	switch {
	case err == nil:
		return at.UTC(), nil
	case errors.Is(err, pgx.ErrNoRows):
		// No stamp is not a failure and not a not-found: `unseen` falls back to
		// the widest window, which is the honest answer for a reader who has
		// never been here.
		return time.Time{}, nil
	default:
		return time.Time{}, catchUpQueryErr(err, "read catchup last visit")
	}
}

// --- needs_you ----------------------------------------------------------

// catchUpBriefApprovalsSQL is the gates that wait on THIS caller: still PENDING,
// opened inside the window, and decidable by them — named in approver_user_ids,
// or holding one of the gate's approver_roles in that project right now. That is
// `approval.pending`'s and route 36's rule (apMayDecide) as a predicate, org
// admin included by role only if a role names them: a gate nobody in this project
// may decide is not "needs you".
const catchUpBriefApprovalsSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT a.id::text, COALESCE (r.title, ''), COALESCE (a.summary, ''), a.created_at,
	       r.id::text, p.id::text, p.name, COALESCE (p.color, '')
	FROM approval_requests a
	JOIN visible v ON v.id = a.project_id
	JOIN projects p ON p.id = a.project_id
	JOIN runs r ON r.id = a.run_id
	LEFT JOIN memberships cm ON cm.project_id = a.project_id AND cm.user_id = $1::uuid
	WHERE a.state = 'pending'
	  AND a.created_at >= $5::timestamptz
	  AND a.created_at <  $6::timestamptz
	  AND ($1::uuid = ANY (a.approver_user_ids)
	       OR COALESCE (cm.role, '') = ANY (a.approver_roles))
	ORDER BY a.created_at ASC, a.id ASC
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefApprovals(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefApprovalsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief approvals")
	}
	defer rows.Close()
	out := []api.CatchUpBriefNeed{}
	for rows.Next() {
		var (
			id, summary, runID, projectID, projectName, projectColor string
			title                                                    string
			at                                                       time.Time
		)
		if err := rows.Scan(&id, &title, &summary, &at, &runID, &projectID, &projectName,
			&projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief approval")
		}
		if title == "" {
			title = "Gate on run " + catchUpBriefShortID(runID)
		}
		out = append(out, api.CatchUpBriefNeed{
			Kind: api.CatchUpNeedApproval, Title: title,
			Project: catchUpBriefChip(projectID, projectName, projectColor),
			Link:    "/approvals/" + id, At: at.UTC(),
			Detail: catchUpBriefClip(summary, 200),
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief approvals")
}

// catchUpBriefQuestionsSQL is the tour beats that ASKED something and were never
// answered: the newest version of each work item that moved in the window, its
// beats unnested, a `decision` object on the beat, and no reply row for that
// (item, beat) at all. A reply by anybody is an answer the agent received, so it
// stops nagging the next reader too — the question was asked of the project,
// which is what a shared tour is (ADR-0078 § Decision 2).
const catchUpBriefQuestionsSQL = `
	WITH ` + catchUpVisibleSome + `,
	items AS (
		SELECT w.id, w.project_id, w.title
		FROM catchup_work_items w
		JOIN visible v ON v.id = w.project_id
		WHERE w.updated_at >= $5::timestamptz AND w.updated_at < $6::timestamptz
	),
	latest AS (
		SELECT DISTINCT ON (tv.work_item_id)
		       tv.work_item_id, tv.stops, tv.created_at
		FROM catchup_tour_versions tv
		JOIN items i ON i.id = tv.work_item_id
		ORDER BY tv.work_item_id, tv.version DESC
	),
	asks AS (
		SELECT i.id AS work_item_id, i.title, i.project_id, l.created_at,
		       (e.value ->> 'id') AS stop_id,
		       COALESCE (e.value -> 'decision' ->> 'prompt', '') AS prompt
		FROM latest l
		JOIN items i ON i.id = l.work_item_id
		CROSS JOIN jsonb_array_elements (l.stops) AS e
		WHERE jsonb_typeof (e.value -> 'decision') = 'object'
	)
	SELECT q.work_item_id::text, q.stop_id, q.prompt, q.title, q.created_at,
	       p.id::text, p.name, COALESCE (p.color, '')
	FROM asks q
	JOIN projects p ON p.id = q.project_id
	WHERE NOT EXISTS (
		          SELECT 1 FROM catchup_decision_replies dr
		          WHERE dr.work_item_id = q.work_item_id AND dr.stop_id = q.stop_id
		      )
	ORDER BY q.created_at ASC, q.work_item_id, q.stop_id
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefQuestions(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefQuestionsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief questions")
	}
	defer rows.Close()
	out := []api.CatchUpBriefNeed{}
	for rows.Next() {
		var (
			itemID, stopID, prompt, itemTitle, projectID, projectName, projectColor string
			at                                                                      time.Time
		)
		if err := rows.Scan(&itemID, &stopID, &prompt, &itemTitle, &at, &projectID,
			&projectName, &projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief question")
		}
		out = append(out, api.CatchUpBriefNeed{
			Kind: api.CatchUpNeedQuestion, Title: itemTitle,
			Project: catchUpBriefChip(projectID, projectName, projectColor),
			// The page's own stop anchor: this is how a reader lands ON the beat
			// that asked, not at the top of its item.
			Link:   "/catch-up/" + itemID + "?stop=" + stopID,
			At:     at.UTC(),
			Detail: catchUpBriefClip(prompt, 200),
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief questions")
}

// catchUpBriefStuckRunsSQL is the reader's OWN failed runs whose pipeline has
// not gone green since: `triggered_by` is them, and no later completed run of the
// same (project, pipeline) exists. A failure somebody else started is `broke`;
// one of yours that nobody fixed is something you owe, which is why the two rows
// live in different sections.
const catchUpBriefStuckRunsSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT r.id::text, COALESCE (r.title, ''), COALESCE (r.failed_cause, ''),
	       COALESCE (r.finished_at, r.created_at), p.id::text, p.name, COALESCE (p.color, '')
	FROM runs r
	JOIN visible v ON v.id = r.project_id
	JOIN projects p ON p.id = r.project_id
	WHERE r.triggered_by = $1::uuid
	  AND r.status = 'failed'
	  AND COALESCE (r.finished_at, r.created_at) >= $5::timestamptz
	  AND COALESCE (r.finished_at, r.created_at) <  $6::timestamptz
	  AND NOT EXISTS (
		          SELECT 1 FROM runs later
		          WHERE later.project_id = r.project_id
		            AND later.pipeline_id = r.pipeline_id
		            AND later.status = 'completed'
		            AND COALESCE (later.finished_at, later.created_at) >
		                COALESCE (r.finished_at, r.created_at)
		      )
	ORDER BY COALESCE (r.finished_at, r.created_at) ASC, r.id ASC
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefStuckRuns(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefNeed, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefStuckRunsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief stuck runs")
	}
	defer rows.Close()
	out := []api.CatchUpBriefNeed{}
	for rows.Next() {
		var (
			runID, title, cause, projectID, projectName, projectColor string
			at                                                        time.Time
		)
		if err := rows.Scan(&runID, &title, &cause, &at, &projectID, &projectName,
			&projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief stuck run")
		}
		if title == "" {
			title = "Run " + catchUpBriefShortID(runID)
		}
		out = append(out, api.CatchUpBriefNeed{
			Kind: api.CatchUpNeedFailedRun, Title: title,
			Project: catchUpBriefChip(projectID, projectName, projectColor),
			Link:    "/runs/" + runID, At: at.UTC(),
			Detail: catchUpBriefClip(cause, 200),
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief stuck runs")
}

// --- running now --------------------------------------------------------

// catchUpBriefRunningSQL is the work in flight, each with the node instance
// executing at the instant the statement ran. The step subquery is deliberately
// a scalar rather than a second statement: one read per section is the ADR's
// cost rule, and a step read after the fact could name a node that had already
// finished while the row still says "running".
const catchUpBriefRunningSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT r.id::text, COALESCE (r.title, ''), COALESCE (r.started_at, r.created_at),
	       COALESCE ((SELECT ne.node_instance_key
	                  FROM node_executions ne
	                  WHERE ne.run_id = r.id AND ne.status = 'running'
	                  ORDER BY ne.created_at DESC, ne.id DESC
	                  LIMIT 1), ''),
	       p.id::text, p.name, COALESCE (p.color, '')
	FROM runs r
	JOIN visible v ON v.id = r.project_id
	JOIN projects p ON p.id = r.project_id
	WHERE r.status IN ` + catchUpBriefLiveStatuses + `
	  AND r.created_at < $6::timestamptz
	  -- 'running now' is a STATE read, so the window's only hold on it is its
	  -- upper bound: a run that started before the window and is still going is
	  -- exactly what a returning reader needs to see. The window is still asserted
	  -- rather than ignored, so no caller may ask a question that starts after it
	  -- ends (and the statement keeps a typed use of both bounds).
	  AND $5::timestamptz <= $6::timestamptz
	ORDER BY COALESCE (r.started_at, r.created_at) DESC, r.id DESC
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefRunning(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefRunning, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefRunningSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief running")
	}
	defer rows.Close()
	out := []api.CatchUpBriefRunning{}
	for rows.Next() {
		var (
			runID, title, step, projectID, projectName, projectColor string
			startedAt                                                time.Time
		)
		if err := rows.Scan(&runID, &title, &startedAt, &step, &projectID, &projectName,
			&projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief running")
		}
		if title == "" {
			title = "Run " + catchUpBriefShortID(runID)
		}
		out = append(out, api.CatchUpBriefRunning{
			RunID: runID, Title: title,
			Project:   catchUpBriefChip(projectID, projectName, projectColor),
			StartedAt: startedAt.UTC(), Step: strings.TrimLeft(step, "/"), Link: "/runs/" + runID,
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief running")
}

// --- broke --------------------------------------------------------------

// catchUpBriefBrokeSQL groups the window's failures per (project, pipeline) and
// answers the two things the old recap could never tell apart:
//
//   - `still_failing`: the NEWEST run of that pipeline — over all time, not just
//     the window — is itself failed, so the red the reader is about to see is the
//     current truth rather than last week's news;
//   - `fixed_at`: otherwise, the first run that went green after the window's
//     last failure. Green first, so a later regression moves the row back to
//     `still_failing` instead of leaving a stale "fixed" on it.
//
// The error class is the newest failed node's own `error_class` (ADR-0023 § 7's
// vocabulary), not a paraphrase of the run's cause.
const catchUpBriefBrokeSQL = `
	WITH ` + catchUpVisibleSome + `,
	win AS (
		SELECT r.id, r.project_id, r.pipeline_id,
		       COALESCE (r.finished_at, r.created_at) AS at
		FROM runs r
		JOIN visible v ON v.id = r.project_id
		WHERE r.status = 'failed'
		  AND COALESCE (r.finished_at, r.created_at) >= $5::timestamptz
		  AND COALESCE (r.finished_at, r.created_at) <  $6::timestamptz
	),
	grp AS (
		SELECT project_id, pipeline_id, count (*)::integer AS failures, max (at) AS last_failed
		FROM win
		GROUP BY project_id, pipeline_id
	)
	SELECT g.project_id::text, p.name, COALESCE (p.color, ''),
	       g.pipeline_id::text, COALESCE (pl.display_name, pl.slug, ''),
	       g.failures,
	       COALESCE ((SELECT ne.error_class
	                  FROM node_executions ne
	                  JOIN runs rr ON rr.id = ne.run_id
	                  WHERE rr.project_id = g.project_id AND rr.pipeline_id = g.pipeline_id
	                    AND ne.status = 'failed' AND ne.error_class IS NOT NULL
	                  ORDER BY COALESCE (ne.finished_at, ne.created_at) DESC, ne.id DESC
	                  LIMIT 1), ''),
	       COALESCE ((SELECT s.status
	                     FROM runs s
	                     WHERE s.project_id = g.project_id AND s.pipeline_id = g.pipeline_id
	                     ORDER BY COALESCE (s.finished_at, s.created_at) DESC, s.id DESC
	                     LIMIT 1), '') = 'failed' AS still_failing,
	       (SELECT min (s3.finished_at)
	          FROM runs s3
	          WHERE s3.project_id = g.project_id AND s3.pipeline_id = g.pipeline_id
	            AND s3.status = 'completed' AND s3.finished_at > g.last_failed) AS fixed_at,
	       (SELECT w.id FROM win w
	          WHERE w.project_id = g.project_id AND w.pipeline_id = g.pipeline_id
	          ORDER BY w.at DESC LIMIT 1)::text AS newest_run
	FROM grp g
	JOIN projects p ON p.id = g.project_id
	LEFT JOIN pipelines pl ON pl.id = g.pipeline_id
	ORDER BY still_failing DESC, g.last_failed DESC, g.project_id, g.pipeline_id
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefBroke(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefBroke, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefBrokeSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief failures")
	}
	defer rows.Close()
	out := []api.CatchUpBriefBroke{}
	for rows.Next() {
		var (
			projectID, projectName, projectColor, pipelineID, pipelineName, errorClass, newestRun string
			failures                                                                              int
			stillFailing                                                                          bool
			fixedAt                                                                               *time.Time
		)
		if err := rows.Scan(&projectID, &projectName, &projectColor, &pipelineID, &pipelineName,
			&failures, &errorClass, &stillFailing, &fixedAt, &newestRun); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief failure")
		}
		broke := api.CatchUpBriefBroke{
			Title: pipelineName, Failures: failures, ErrorClass: errorClass,
			Project: catchUpBriefChip(projectID, projectName, projectColor),
			Link:    "/workflows/" + pipelineID,
		}
		if newestRun != "" {
			broke.Link = "/runs/" + newestRun
		}
		if stillFailing {
			broke.StillFailing = true // a fixed_at beside still_failing would be a contradiction
		} else if fixedAt != nil {
			at := fixedAt.UTC()
			broke.FixedAt = &at
		}
		out = append(out, broke)
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief failures")
}

// --- the window's runs (shipped refs and heads-up signals) ---------------

// catchUpBriefRunNodesSQL is one row per node execution of one run that moved in
// the window, with the run's own goal input beside it. The envelope travels
// undigested on purpose: `outputs` is the template's document, and the ONLY
// reader of it that may decide what counts as a ref is the generator's harvest
// in internal/api. Reading JSON keys in SQL here would be a second opinion
// about the same document, and the two would drift.
const catchUpBriefRunNodesSQL = `
	WITH ` + catchUpVisibleSome + `,
	win AS (
		SELECT r.id, r.project_id, r.title, r.status,
		       COALESCE (r.started_at, r.created_at) AS started_at,
		       COALESCE (r.finished_at, r.created_at) AS at,
		       COALESCE (u.display_name, '') AS started_by,
		       COALESCE ((CASE
		                     WHEN jsonb_typeof (ri.value) = 'string' THEN ri.value #>> '{}'
		                     WHEN ri.value IS NULL THEN ''
		                     ELSE ri.value::text
		                 END), '') AS goal
		FROM runs r
		JOIN visible v ON v.id = r.project_id
		LEFT JOIN users u ON u.id = r.triggered_by
		LEFT JOIN LATERAL (
		    SELECT i2.value
		    FROM run_inputs i2
		    WHERE i2.run_id = r.id
		      AND lower (i2.name) IN ('goal','task','brief','issue_body','prompt')
		    ORDER BY CASE lower (i2.name)
                         WHEN 'goal' THEN 0 WHEN 'task' THEN 1 WHEN 'brief' THEN 2
                         WHEN 'issue_body' THEN 3 ELSE 4 END,
		         i2.name
		    LIMIT 1
		) ri ON TRUE
		WHERE COALESCE (r.finished_at, r.created_at) >= $5::timestamptz
		  AND COALESCE (r.finished_at, r.created_at) <  $6::timestamptz
	)
	SELECT w.id::text, COALESCE (w.title, ''), w.status, w.started_at, w.at, w.started_by, w.goal,
	       p.id::text, p.name, COALESCE (p.color, ''),
	       ne.node_instance_key, ne.status,
	       COALESCE (ne.error_class, ''), COALESCE (ne.failed_cause, ''), ne.outputs
	FROM win w
	JOIN projects p ON p.id = w.project_id
	JOIN node_executions ne ON ne.run_id = w.id
	ORDER BY w.at DESC, w.id, ne.id
	LIMIT 400`

func (a APICatchUpStore) CatchUpBriefRunNodes(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefRunNode, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefRunNodesSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief runs")
	}
	defer rows.Close()
	out := []api.CatchUpBriefRunNode{}
	for rows.Next() {
		var n api.CatchUpBriefRunNode
		var projectID, projectName, projectColor string
		if err := rows.Scan(&n.RunID, &n.Title, &n.Status, &n.StartedAt, &n.FinishedAt,
			&n.By, &n.Goal, &projectID, &projectName, &projectColor,
			&n.NodeKey, &n.NodeStatus, &n.ErrorClass, &n.FailedCause, &n.Outputs); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief run node")
		}
		n.Project = catchUpBriefChip(projectID, projectName, projectColor)
		n.StartedAt = n.StartedAt.UTC()
		n.FinishedAt = n.FinishedAt.UTC()
		out = append(out, n)
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief runs")
}

// --- the window's work items (the items half of `heads_up`) -------------

// catchUpBriefItemsSQL is the window's work items with the text the must-know
// rules scan. The window clock is the item's own `updated_at` — the same clock
// the list read and the tour's grouping use — and the row carries the summary
// rather than the tour beats: a beat's importance is the model's ranking, and
// reading it back would make the server's floor a report of the model's opinion.
// The summary is what the generator was told to keep to the facts it was given,
// and it is the row that names the file a migration touched.
const catchUpBriefItemsSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT w.id::text, COALESCE (w.title, ''), COALESCE (w.summary, ''),
	       p.id::text, p.name, COALESCE (p.color, '')
	FROM catchup_work_items w
	JOIN visible v ON v.id = w.project_id
	JOIN projects p ON p.id = w.project_id
	WHERE w.updated_at >= $5::timestamptz
	  AND w.updated_at <  $6::timestamptz
	ORDER BY w.updated_at DESC, w.id DESC
	LIMIT 400`

func (a APICatchUpStore) CatchUpBriefWorkItems(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefItem, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefItemsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief work items")
	}
	defer rows.Close()
	out := []api.CatchUpBriefItem{}
	for rows.Next() {
		var itemID, title, text, projectID, projectName, projectColor string
		if err := rows.Scan(&itemID, &title, &text, &projectID, &projectName,
			&projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief work item")
		}
		out = append(out, api.CatchUpBriefItem{
			ItemID: itemID, Title: title, Text: catchUpBriefClip(text, 2000),
			Project: catchUpBriefChip(projectID, projectName, projectColor),
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief work items")
}

// --- changes ------------------------------------------------------------

// catchUpBriefRevisionsSQL is the workflows that went live in the window. A
// revision belongs to an organization's pipeline, never to a project, so the
// membership question is "do I have this workflow assigned anywhere?" — and the
// row is drawn under the first such project by id, deterministically rather than
// by whichever join Postgres happened to reach first.
const catchUpBriefRevisionsSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT pr.id::text, pr.pipeline_id::text, COALESCE (pl.display_name, pl.slug, ''),
	       pr.version_label, pr.revision_number, pr.published_at,
	       COALESCE (u.display_name, ''),
	       pv.project_id::text, p.name, COALESCE (p.color, '')
	FROM pipeline_revisions pr
	JOIN pipelines pl ON pl.id = pr.pipeline_id
	JOIN LATERAL (
	    SELECT a.project_id
	    FROM assignments a
	    JOIN visible v ON v.id = a.project_id
	    WHERE a.pipeline_id = pr.pipeline_id
	    ORDER BY a.project_id
	    LIMIT 1
	) pv ON TRUE
	JOIN projects p ON p.id = pv.project_id
	LEFT JOIN users u ON u.id = pr.published_by
	WHERE pr.published_at >= $5::timestamptz
	  AND pr.published_at <  $6::timestamptz
	ORDER BY pr.published_at DESC, pr.id DESC
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefRevisions(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefShipped, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefRevisionsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief revisions")
	}
	defer rows.Close()
	out := []api.CatchUpBriefShipped{}
	for rows.Next() {
		var (
			revID, pipelineID, pipelineName, versionLabel, by, projectID, projectName, projectColor string
			revisionNumber                                                                          int
			at                                                                                      time.Time
		)
		if err := rows.Scan(&revID, &pipelineID, &pipelineName, &versionLabel, &revisionNumber,
			&at, &by, &projectID, &projectName, &projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief revision")
		}
		out = append(out, api.CatchUpBriefShipped{
			Kind:    api.CatchUpShippedRevision,
			Title:   pipelineName + " v" + versionLabel,
			Project: catchUpBriefChip(projectID, projectName, projectColor),
			By:      by, At: at.UTC(),
			Link: "/workflows/" + pipelineID,
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief revisions")
}

// catchUpBriefProfilesSQL is the agent profiles created or edited in the window,
// read off `agent_profile_versions` because that table is the only row that
// records WHO moved a profile. Version 1 is the create (ADR-0058: the create
// lands the first snapshot), so the kind is derived rather than guessed.
//
// Agent profiles are an organization's objects, not a project's: there is no
// project id to scope by, so the boundary is the caller's own organization — the
// same one `catchUpVisibleHead` requires of every project read here.
const catchUpBriefProfilesSQL = `
	SELECT v.profile_id::text, COALESCE (p.name, ''), v.version, v.created_at,
	       COALESCE (u.display_name, NULLIF (v.created_by, ''), '')
	FROM agent_profile_versions v
	JOIN agent_profiles p ON p.id = v.profile_id
	LEFT JOIN users u ON u.id::text = v.created_by
	WHERE v.organization_id = $1::uuid
	  AND v.created_at >= $2::timestamptz
	  AND v.created_at <  $3::timestamptz
	ORDER BY v.created_at DESC, v.id DESC
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefProfiles(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefChange, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	// Three arguments, not the caller quartet: the organization is the WHOLE of
	// the scope here, so no user id and no project set enter the statement — and
	// a parameter a statement does not reference is one Postgres cannot type.
	rows, err := s.Pool.Query(ctx, catchUpBriefProfilesSQL, sc.OrganizationID, f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief profiles")
	}
	defer rows.Close()
	out := []api.CatchUpBriefChange{}
	for rows.Next() {
		var (
			profileID, name, by string
			version             int
			at                  time.Time
		)
		if err := rows.Scan(&profileID, &name, &version, &at, &by); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief profile")
		}
		kind, line := api.CatchUpChangeProfileEd, "edited"
		if version <= 1 {
			kind, line = api.CatchUpChangeProfileNew, "created"
		}
		if name == "" {
			name = "Agent profile " + catchUpBriefShortID(profileID)
		}
		out = append(out, api.CatchUpBriefChange{
			Kind: kind, Title: name + " " + line, By: by, At: at.UTC(),
			Link: "/profiles/" + profileID,
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief profiles")
}

// catchUpBriefMembersSQL is who joined a project in the window. `memberships`
// records no inviter — the row is the fact "this person is a member since T" and
// nothing more — so the change carries the joiner as its subject and no actor,
// rather than dressing up the joiner as whoever added them.
const catchUpBriefMembersSQL = `
	WITH ` + catchUpVisibleSome + `
	SELECT m.user_id::text, COALESCE (u.display_name, ''), m.role, m.created_at,
	       pj.id::text, pj.name, COALESCE (pj.color, '')
	FROM memberships m
	JOIN visible v ON v.id = m.project_id
	JOIN projects pj ON pj.id = m.project_id
	LEFT JOIN users u ON u.id = m.user_id
	WHERE m.created_at >= $5::timestamptz
	  AND m.created_at <  $6::timestamptz
	ORDER BY m.created_at DESC, m.user_id, m.project_id
	LIMIT 100`

func (a APICatchUpStore) CatchUpBriefMembers(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) ([]api.CatchUpBriefChange, error) {
	s, err := a.store()
	if err != nil {
		return nil, err
	}
	sc := prjAPICaller(c)
	rows, err := s.Pool.Query(ctx, catchUpBriefMembersSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until)
	if err != nil {
		return nil, catchUpQueryErr(err, "read catchup brief members")
	}
	defer rows.Close()
	out := []api.CatchUpBriefChange{}
	for rows.Next() {
		var (
			userID, name, role, projectID, projectName, projectColor string
			at                                                       time.Time
		)
		if err := rows.Scan(&userID, &name, &role, &at, &projectID, &projectName,
			&projectColor); err != nil {
			return nil, catchUpQueryErr(err, "scan catchup brief member")
		}
		if name == "" {
			name = "A member"
		}
		out = append(out, api.CatchUpBriefChange{
			Kind:  api.CatchUpChangeMember,
			Title: name + " joined " + projectName + " as " + role,
			At:    at.UTC(),
			Link:  "/p/" + projectID + "/members",
		})
	}
	return out, catchUpQueryErr(rows.Err(), "read catchup brief members")
}

// --- numbers ------------------------------------------------------------

// catchUpBriefCountsSQL is the arithmetic block in one statement. Terminal
// statuses count runs that MOVED in the window; `running` counts the live set as
// of now — the same predicate `running_now` lists, so the number and the section
// are one fact stated twice rather than two facts.
//
// There is no key for `interrupted` in ADR-0081's numbers block. It is counted
// with `cancelled` — both are "ended without finishing" — and the choice is
// stated here rather than left to a reader who would otherwise compare the two
// against a ledger that says something else.
const catchUpBriefCountsSQL = `
	WITH ` + catchUpVisibleSome + `,
	win AS (
		SELECT r.status
		FROM runs r
		JOIN visible v ON v.id = r.project_id
		WHERE COALESCE (r.finished_at, r.created_at) >= $5::timestamptz
		  AND COALESCE (r.finished_at, r.created_at) <  $6::timestamptz
	)
	SELECT
	    (SELECT count (*)::integer FROM win WHERE status = 'completed'),
	    (SELECT count (*)::integer FROM win WHERE status = 'failed'),
	    (SELECT count (*)::integer FROM win WHERE status IN ('cancelled','interrupted')),
	    (SELECT count (*)::integer FROM runs r JOIN visible v ON v.id = r.project_id
	        WHERE r.status IN ` + catchUpBriefLiveStatuses + `),
	    (SELECT count (*)::integer FROM approval_requests ar
	        JOIN visible v ON v.id = ar.project_id
	        WHERE ar.state = 'decided' AND ar.decided_at >= $5::timestamptz
	          AND ar.decided_at < $6::timestamptz),
	    (SELECT count (*)::integer FROM approval_requests ar
	        JOIN visible v ON v.id = ar.project_id
	        WHERE ar.state = 'pending'),
	    (SELECT count (*)::integer FROM conversations cn
	        JOIN visible v ON v.id = cn.project_id
	        WHERE cn.status <> 'archived'
	          AND cn.updated_at >= $5::timestamptz
	          AND cn.updated_at <  $6::timestamptz)`

func (a APICatchUpStore) CatchUpBriefCounts(ctx context.Context, c api.Caller,
	f api.CatchUpBriefFilter) (api.CatchUpBriefNumbers, error) {
	s, err := a.store()
	if err != nil {
		return api.CatchUpBriefNumbers{}, err
	}
	sc := prjAPICaller(c)
	var out api.CatchUpBriefNumbers
	err = s.Pool.QueryRow(ctx, catchUpBriefCountsSQL, sc.UserID, sc.OrganizationID,
		sc.IsOrgAdmin, catchUpBriefWanted(f), f.Since, f.Until).
		Scan(&out.Runs.Succeeded, &out.Runs.Failed, &out.Runs.Cancelled, &out.Runs.Running,
			&out.Approvals.Decided, &out.Approvals.Pending, &out.ThreadsActive)
	if err != nil {
		return api.CatchUpBriefNumbers{}, catchUpQueryErr(err, "count catchup brief")
	}
	return out, nil
}

// --- helpers ------------------------------------------------------------

// catchUpBriefWanted is the requested project set as the SQL wants it: NULL for
// "every project I belong to", the list otherwise. The distinction is the same
// one the ADR-0078 list read preserves (an empty set the caller NAMED is not the
// same question as no set), and the store intersects it with membership either
// way, so it can only ever narrow.
func catchUpBriefWanted(f api.CatchUpBriefFilter) any {
	if len(f.ProjectIDs) == 0 {
		return nil
	}
	return f.ProjectIDs
}

// catchUpBriefChip renders the chip the page draws. A NULL colour is "nobody
// chose", and the fallback is by project id (domain.CatchUpProjectColorOr), so
// two replicas and a rename cannot shuffle it.
func catchUpBriefChip(id, name, color string) api.CatchUpProjectChip {
	return api.CatchUpProjectChip{ID: id, Name: name, Color: domain.CatchUpProjectColorOr(id, color)}
}

// catchUpBriefShortID is the eight leading hex characters of a uuid — enough to
// tell two ids apart in a fallback title, short enough not to dominate one. It
// is only ever used where a row carries no title of its own.
func catchUpBriefShortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// catchUpBriefClip bounds a detail line to N runes with an honest ellipsis. A
// gate summary may run to 64 KiB, and a brief row is a line, not a document.
func catchUpBriefClip(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	return string(r[:max-1]) + "…"
}
