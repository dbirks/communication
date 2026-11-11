package postgres

// ADR-0081's brief reads, against a real PostgreSQL (skipped unless
// COMMUNICATION_TEST_DATABASE_URL is set — CI runs them, and they are the only
// way the authorization claim is actually known rather than asserted).
//
// Two things are pinned here, both of which a fake store cannot prove:
//
//   - the membership predicate. Every section read starts from `catchUpVisibleSome`
//     and every count too, so an in-window world that exists in a project the
//     caller is not in contributes NOTHING — no row in any section, and no unit
//     in `numbers`. The test seeds that world twice, once where the caller can
//     see it and once where they cannot, and asks both readers the same question;
//   - `still_failing` against `fixed_at`. A pipeline that red-lined twice and is
//     still red is a different sentence from one that red-lined and then went
//     green, and the old recap could not tell them apart. The grouping read is
//     what decides, over the ledger rather than over the window, so the pair is
//     checked on two pipelines seeded to disagree.
//
// The seeded-scenario cross-check (what the brief says against the per-window
// fixtures) belongs to the orchestrator's follow-up, not to this file: these
// tests do not depend on internal/store/postgres/catchupseed.

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
)

// cuBriefExec is m4Fixture's own exec: the fixture carries cleanup, not helpers.
func cuBriefExec(t *testing.T, f *m4Fixture, q string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(testCtx(t), q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

// cuBriefMembership makes the fixture's own user a maintainer of its project —
// the precondition every brief read checks — and removes the row BEFORE
// m4Setup's cleanup runs (a later registration is an earlier cleanup), because a
// `projects` row cannot go while a membership still points at it.
func cuBriefMembership(t *testing.T, f *m4Fixture) {
	t.Helper()
	cuBriefExec(t, f, `INSERT INTO memberships (project_id, user_id, role)
	                VALUES ($1::uuid, $2::uuid, 'maintainer')`, f.projectID, f.userID)
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM memberships WHERE project_id = $1::uuid AND user_id = $2::uuid`,
			f.projectID, f.userID)
	})
}

// cuBriefRun inserts one run at a chosen age, owned by `by` ("" = a start with
// no human author). The status CHECKs are real, so a failed run has to carry its
// cause and a terminal one its finish — which is also why the clock a run is
// read on is the one this inserts.
func cuBriefRun(t *testing.T, f *m4Fixture, project, pipeline, revision, status, by string,
	ago time.Duration) string {
	t.Helper()
	terminal := status == "completed" || status == "failed" || status == "cancelled"
	var id string
	err := f.pool.QueryRow(testCtx(t), `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  status, failed_cause, triggered_by, title, created_at,
		                  started_at, finished_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
		        $7,
		        CASE WHEN $7 = 'failed' THEN 'agent_error' ELSE NULL END,
		        $8::uuid, 'Brief run ' || $7,
		        now() - $9::interval,
		        CASE WHEN $7 IN ('queued') THEN NULL ELSE now() - $9::interval END,
		        CASE WHEN $10::boolean THEN now() - $9::interval ELSE NULL END)
		RETURNING id`, f.orgID, project, pipeline, revision, f.digest, f.planDigest,
		status, cuBriefNull(by), fmt.Sprintf("%d seconds", int(ago.Seconds())),
		terminal).Scan(&id)
	if err != nil {
		t.Fatalf("insert %s run: %v", status, err)
	}
	return id
}

// cuBriefNode is one node execution, with the output envelope the shipped
// section must be able to read a ref out of.
func cuBriefNode(t *testing.T, f *m4Fixture, run, key, status, errorClass, outputs string,
	ago time.Duration) {
	t.Helper()
	terminal := status == "succeeded" || status == "failed"
	_, err := f.pool.Exec(testCtx(t), `
		INSERT INTO node_executions (run_id, node_id, kind, node_instance_key,
		                             execution_location, status, outputs, error_class,
		                             failed_cause, ready_at, finished_at, created_at)
		VALUES ($1::uuid, 'implement', 'command.agent', $2, 'worker', $3,
		        NULLIF($4, '')::jsonb, NULLIF($5, ''),
		        CASE WHEN $3 = 'failed' THEN 'the test went red' ELSE NULL END,
		        now() - $6::interval,
		        CASE WHEN $7::boolean THEN now() - $6::interval ELSE NULL END,
		        now() - $6::interval)`,
		run, key, status, outputs, errorClass,
		fmt.Sprintf("%d seconds", int(ago.Seconds())), terminal)
	if err != nil {
		t.Fatalf("insert node %s: %v", key, err)
	}
}

// cuBriefGate opens one real gate on one node execution: pending, with a named
// approver and a deadline in the future. `approver` is the ONLY way a reader may
// be told about it, which is the point of the test.
func cuBriefGate(t *testing.T, f *m4Fixture, project, run, node, summary, approver string,
	deadline time.Time) {
	t.Helper()
	_, err := f.pool.Exec(testCtx(t), `
		INSERT INTO approval_requests (organization_id, project_id, run_id, node_execution_id,
		                               kind, summary, approver_user_ids, deadline_at, state)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'pipeline_gate', $5,
		        ARRAY[$6::uuid], $7, 'pending')`,
		f.orgID, project, run, node, summary, approver, deadline)
	if err != nil {
		t.Fatalf("insert approval: %v", err)
	}
}

// cuBriefNodeID reads one node execution id back, because a gate hangs off the
// node rather than the run.
func cuBriefNodeID(t *testing.T, f *m4Fixture, run, key string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(testCtx(t),
		`SELECT id FROM node_executions WHERE run_id = $1::uuid AND node_instance_key = $2`,
		run, key).Scan(&id); err != nil {
		t.Fatalf("node %s of run %s: %v", key, run, id)
	}
	return id
}

func cuBriefNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// cuBriefDropPipeline registers the teardown of a pipeline this test created:
// its runs, its revisions and its drafts, in the order the circular
// `pipeline_drafts.published_revision_id` ↔ `pipeline_revisions.draft_id` pair
// requires. The fixture's own pipeline is not this file's to delete.
func cuBriefDropPipeline(t *testing.T, f *m4Fixture, pipeID string) {
	t.Helper()
	t.Cleanup(func() {
		bg := context.Background()
		steps := []string{
			`DELETE FROM approval_requests WHERE node_execution_id IN
			      (SELECT ne.id FROM node_executions ne JOIN runs r ON r.id = ne.run_id
			       WHERE r.pipeline_id = $1::uuid)`,
			`DELETE FROM node_executions WHERE run_id IN
			      (SELECT id FROM runs WHERE pipeline_id = $1::uuid)`,
			`DELETE FROM runs WHERE pipeline_id = $1::uuid`,
			`UPDATE pipeline_drafts SET published_revision_id = NULL WHERE pipeline_id = $1::uuid`,
			`DELETE FROM pipeline_revisions WHERE pipeline_id = $1::uuid`,
			`DELETE FROM pipeline_drafts WHERE pipeline_id = $1::uuid`,
			`DELETE FROM pipelines WHERE id = $1::uuid`,
		}
		for _, q := range steps {
			if _, err := f.pool.Exec(bg, q, pipeID); err != nil {
				t.Errorf("cleanup pipeline %q: %v", q, err)
			}
		}
	})
}

// cuBriefProject builds a second project of the SAME organization with `member`
// (or nobody) holding it, plus its own pipeline, revision and assignment — the
// in-window world one reader must never be shown. Its cleanup runs before
// m4Setup's (LIFO), so the shared fixture never learns it existed.
func cuBriefProject(t *testing.T, f *m4Fixture, member, slug string) (string, string, string) {
	t.Helper()
	ctx := testCtx(t)
	token := migFixtureToken(t)
	var project string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO projects (organization_id, slug, name, created_by)
		VALUES ($1::uuid, $2, 'Brief foreign fixture', $3::uuid) RETURNING id`,
		f.orgID, slug+"-"+token, f.userID).Scan(&project); err != nil {
		t.Fatalf("insert project %s: %v", slug, err)
	}
	if member != "" {
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO memberships (project_id, user_id, role)
			VALUES ($1::uuid, $2::uuid, 'maintainer')`, project, member); err != nil {
			t.Fatalf("membership: %v", err)
		}
	}
	pipe, err := f.pipelines.CreatePipeline(ctx, f.orgID, f.userID, "cu-brief-"+slug+"-"+token,
		"Brief "+slug, "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	saved := f.pipelineID
	f.pipelineID = pipe.ID
	defer func() { f.pipelineID = saved }()
	rev := f.publishRevision(t, ctx, "1.0.0", m4Digest("cu-brief/"+slug+"/"+token))
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: project, PipelineID: pipe.ID, PinnedRevisionID: rev, CreatedBy: f.userID,
	}); err != nil {
		t.Fatalf("assignment: %v", err)
	}
	cuBriefDropPipeline(t, f, pipe.ID)
	t.Cleanup(func() {
		bg := context.Background()
		steps := []struct {
			q    string
			args []any
		}{
			{`DELETE FROM approval_requests WHERE project_id = $1::uuid`, []any{project}},
			{`DELETE FROM conversations WHERE project_id = $1::uuid`, []any{project}},
			{`DELETE FROM node_executions WHERE run_id IN (SELECT id FROM runs WHERE project_id = $1::uuid)`, []any{project}},
			{`DELETE FROM runs WHERE project_id = $1::uuid`, []any{project}},
			{`DELETE FROM assignments WHERE project_id = $1::uuid`, []any{project}},
			{`DELETE FROM memberships WHERE project_id = $1::uuid`, []any{project}},
			{`DELETE FROM projects WHERE id = $1::uuid`, []any{project}},
		}
		for _, step := range steps {
			if _, err := f.pool.Exec(bg, step.q, step.args...); err != nil {
				t.Errorf("cleanup %q: %v", step.q, err)
			}
		}
	})
	return project, pipe.ID, rev
}

// cuBriefFilter is the whole window: an hour back from now, every project the
// caller may see.
func cuBriefFilter() api.CatchUpBriefFilter {
	until := time.Now().UTC()
	return api.CatchUpBriefFilter{Since: until.Add(-time.Hour), Until: until}
}

// cuBriefStore is the surface the route reaches by type assertion.
func cuBriefStore(f *m4Fixture) APICatchUpStore {
	return APICatchUpStore{S: &CatchUpStore{Pool: f.pool}}
}

// TestCatchUpBriefForeignProjectContributesNothing is ADR-0081 § Security/privacy
// as a query: the same in-window activity seeded twice — once in a project the
// reader is in, once in one they are not — and the answer names only the first,
// in EVERY section and in the counts.
func TestCatchUpBriefForeignProjectContributesNothing(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	store := cuBriefStore(f)
	// The caller is a maintainer of the fixture's own project and of nothing
	// else; the foreign project is seeded with a whole week of the same events
	// and no membership for them.
	cuBriefMembership(t, f)
	if _, err := f.pipelines.CreateAssignment(ctx, NewAssignment{
		ProjectID: f.projectID, PipelineID: f.pipelineID, PinnedRevisionID: f.revisionID,
		CreatedBy: f.userID,
	}); err != nil {
		t.Fatalf("assignment: %v", err)
	}
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	var outsider string
	if err := f.pool.QueryRow(ctx,
		`INSERT INTO users (organization_id, display_name) VALUES ($1::uuid, 'cu-brief-outsider')
		 RETURNING id`, f.orgID).Scan(&outsider); err != nil {
		t.Fatalf("insert outsider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, outsider)
	})
	// The outsider holds the foreign project — the read must be able to answer
	// for them and refuse the same rows for the caller, from the same seed.
	foreign, foreignPipe, foreignRev := cuBriefProject(t, f, outsider, "brief-foreign")

	// Seed the same in-window activity in both. Each side gets: a gate pending
	// on its own approver, a run in flight, a run that shipped a PR, a revision
	// published (by m4Setup's publishRevision path) and a member added.
	seed := func(project, pipeline, revision, approver string) (gateRun, liveRun, shipRun string) {
		gateRun = cuBriefRun(t, f, project, pipeline, revision, "waiting_human", approver, 20*time.Minute)
		cuBriefNode(t, f, gateRun, "/gate", "waiting", "", `{"branch":"comm/1"}`, 20*time.Minute)
		cuBriefGate(t, f, project, gateRun, cuBriefNodeID(t, f, gateRun, "/gate"),
			"Publish the release", approver, time.Now().Add(time.Hour))
		liveRun = cuBriefRun(t, f, project, pipeline, revision, "running", approver, 10*time.Minute)
		cuBriefNode(t, f, liveRun, "/implement", "running", "", "", 5*time.Minute)
		shipRun = cuBriefRun(t, f, project, pipeline, revision, "completed", approver, 30*time.Minute)
		cuBriefNode(t, f, shipRun, "/implement", "succeeded", "",
			`{"pr_url":"https://github.com/acme/web/pull/7","commit_sha":"abc1234567890abcdef1234567890abcdef12345"}`,
			30*time.Minute)
		return
	}
	mineGate, mineLive, mineShip := seed(f.projectID, f.pipelineID, f.revisionID, f.userID)
	foreignGate, foreignLive, foreignShip := seed(foreign, foreignPipe, foreignRev, outsider)

	filter := cuBriefFilter()
	joined := filter

	sections := map[string]func() string{
		"approvals": func() string {
			rows, err := store.CatchUpBriefApprovals(ctx, caller, filter)
			if err != nil {
				t.Fatalf("approvals: %v", err)
			}
			if len(rows) == 0 {
				t.Error("approvals is empty: the caller's own pending gate must be there")
			}
			return briefNeedProjects(rows)
		},
		"running": func() string {
			rows, err := store.CatchUpBriefRunning(ctx, caller, filter)
			if err != nil {
				t.Fatalf("running: %v", err)
			}
			if len(rows) == 0 {
				t.Error("running is empty: the caller's own in-flight run must be there")
			}
			out := ""
			for _, r := range rows {
				out += r.Project.ID + " "
			}
			return out
		},
		"nodes": func() string {
			rows, err := store.CatchUpBriefRunNodes(ctx, caller, filter)
			if err != nil {
				t.Fatalf("nodes: %v", err)
			}
			out := ""
			for _, r := range rows {
				out += r.Project.ID + " "
			}
			return out
		},
		"revisions": func() string {
			rows, err := store.CatchUpBriefRevisions(ctx, caller, filter)
			if err != nil {
				t.Fatalf("revisions: %v", err)
			}
			out := ""
			for _, r := range rows {
				out += r.Project.ID + " "
			}
			return out
		},
		"members": func() string {
			rows, err := store.CatchUpBriefMembers(ctx, caller, filter)
			if err != nil {
				t.Fatalf("members: %v", err)
			}
			if len(rows) == 0 {
				t.Error("members is empty: the fixture's own membership is in the window")
			}
			return ""
		},
		"counts": func() string {
			n, err := store.CatchUpBriefCounts(ctx, caller, joined)
			if err != nil {
				t.Fatalf("counts: %v", err)
			}
			// The caller's side of the seed: one gate pending, one live run, one
			// completed run. If a foreign row reached the arithmetic, one of
			// these would be two.
			if n.Approvals.Pending != 1 || n.Runs.Running != 1 || n.Runs.Succeeded != 1 {
				t.Errorf("counts = %+v, want the caller's own one gate, one live run, one success",
					n)
			}
			return ""
		},
	}
	for name, run := range sections {
		if got := run(); strings.Contains(got, foreign) {
			t.Errorf("%s leaked the foreign project: %q", name, got)
		}
	}

	// And no row may name one of the foreign runs either — a project id can be
	// hidden while its run id rides along in a link.
	links := func() string {
		rows, err := store.CatchUpBriefApprovals(ctx, caller, filter)
		if err != nil {
			t.Fatalf("approvals: %v", err)
		}
		out := briefNeedProjects(rows)
		live, err := store.CatchUpBriefRunning(ctx, caller, filter)
		if err != nil {
			t.Fatalf("running: %v", err)
		}
		for _, r := range live {
			out += r.Link + " " + r.RunID + " "
		}
		return out
	}()
	for _, id := range []string{foreignGate, foreignLive, foreignShip} {
		if strings.Contains(links, id) {
			t.Errorf("a link names the foreign run %s: %q", id, links)
		}
	}
	for _, id := range []string{mineGate, mineLive, mineShip} {
		if id == "" {
			t.Fatal("the caller's own seed produced no run")
		}
	}

	// The same reads as the outsider — a member of the FOREIGN project only —
	// are the mirror image: their side appears, the fixture's does not. Naming a
	// project they are not in (`f.projectID`) is not a 403 either; it just
	// contributes nothing.
	asForeign := api.Caller{UserID: outsider, OrganizationID: f.orgID}
	nodes, err := store.CatchUpBriefRunNodes(ctx, asForeign, filter)
	if err != nil {
		t.Fatalf("nodes as outsider: %v", err)
	}
	seen := map[string]bool{}
	for _, n := range nodes {
		seen[n.Project.ID] = true
	}
	if !seen[foreign] {
		t.Errorf("the outsider cannot see their own project's runs: %+v", nodes)
	}
	if seen[f.projectID] {
		t.Errorf("the outsider sees the fixture project: %+v", nodes)
	}
	narrow := filter
	narrow.ProjectIDs = []string{f.projectID} // a project they are NOT in
	counts, err := store.CatchUpBriefCounts(ctx, asForeign, narrow)
	if err != nil {
		t.Fatalf("counts narrowed to a foreign project: %v", err)
	}
	if counts != (api.CatchUpBriefNumbers{}) {
		t.Errorf("counts for a project the caller is not in = %+v, want the zero block, not a 403",
			counts)
	}
}

// TestCatchUpBriefStillFailingVersusFixed is the pair the audit said the recap
// could not express: two pipelines that both failed inside the window, one of
// which has since gone green.
func TestCatchUpBriefStillFailingVersusFixed(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	cuBriefMembership(t, f)
	store := cuBriefStore(f)
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID}
	token := migFixtureToken(t)

	// Still red: two failures, the newest one last.
	brokeRun := cuBriefRun(t, f, f.projectID, f.pipelineID, f.revisionID, "failed", f.userID, 40*time.Minute)
	cuBriefNode(t, f, brokeRun, "/tests", "failed", "test_failure", "", 40*time.Minute)
	newestRed := cuBriefRun(t, f, f.projectID, f.pipelineID, f.revisionID, "failed", f.userID, 10*time.Minute)
	cuBriefNode(t, f, newestRed, "/tests", "failed", "infra", "", 10*time.Minute)

	// Fixed: a failure, then a later green run of ANOTHER pipeline (the grouping
	// is per (project, pipeline), so the two must not be folded into one row).
	fixedPipe, err := f.pipelines.CreatePipeline(ctx, f.orgID, f.userID, "cu-brief-fixed-"+token,
		"Cu brief fixed", "")
	if err != nil {
		t.Fatalf("CreatePipeline: %v", err)
	}
	cuBriefDropPipeline(t, f, fixedPipe.ID)
	saved := f.pipelineID
	f.pipelineID = fixedPipe.ID
	fixedRev := f.publishRevision(t, ctx, "1.0.0", m4Digest("cu-brief-fixed/"+token))
	f.pipelineID = saved
	failedThen := cuBriefRun(t, f, f.projectID, fixedPipe.ID, fixedRev, "failed", f.userID, 50*time.Minute)
	cuBriefNode(t, f, failedThen, "/tests", "failed", "test_failure", "", 50*time.Minute)
	cuBriefRun(t, f, f.projectID, fixedPipe.ID, fixedRev, "completed", f.userID, 5*time.Minute)

	rows, err := store.CatchUpBriefBroke(ctx, caller, cuBriefFilter())
	if err != nil {
		t.Fatalf("broke: %v", err)
	}
	byPipe := map[string]api.CatchUpBriefBroke{}
	for _, b := range rows {
		byPipe[b.Title] = b
	}
	if len(rows) != 2 {
		t.Fatalf("broke = %+v, want one row per (project, pipeline)", rows)
	}
	red, ok := byPipe["M4 pipe"]
	if !ok {
		t.Fatalf("broke lost the still-red pipeline: %+v", rows)
	}
	if !red.StillFailing {
		t.Errorf("%q still_failing = false, want true (its newest run is red)", red.Title)
	}
	if red.FixedAt != nil {
		t.Errorf("%q fixed_at = %s beside still_failing: the pair is a contradiction",
			red.Title, red.FixedAt)
	}
	if red.Failures != 2 {
		t.Errorf("%q failures = %d, want the window's two red runs", red.Title, red.Failures)
	}
	if red.ErrorClass != "infra" {
		t.Errorf("%q error_class = %q, want the NEWEST failed node's class", red.Title, red.ErrorClass)
	}
	fixed, ok := byPipe["Cu brief fixed"]
	if !ok {
		t.Fatalf("broke lost the recovered pipeline: %+v", rows)
	}
	if fixed.StillFailing {
		t.Errorf("%q still_failing = true, want false: a later run went green", fixed.Title)
	}
	if fixed.FixedAt == nil {
		t.Fatalf("%q fixed_at = nil, want the moment the later run finished", fixed.Title)
	}
	if fixed.FixedAt.After(time.Now().UTC()) || fixed.FixedAt.Before(time.Now().UTC().Add(-time.Hour)) {
		t.Errorf("%q fixed_at = %s, want the window's green run", fixed.Title, fixed.FixedAt)
	}
	// still_failing is about the newest run of the pipeline, not the newest run
	// in the window: a row whose red-ness the reader can act on must not be
	// stale by construction.
	_ = newestRed
}

func briefNeedProjects(rows []api.CatchUpBriefNeed) string {
	out := ""
	for _, r := range rows {
		out += r.Project.ID + " " + r.Link + " "
	}
	return out
}
