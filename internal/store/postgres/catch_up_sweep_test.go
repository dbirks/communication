package postgres

// ADR-0078 § Trigger: the completion sweep's two store reads, against a real
// PostgreSQL (skipped unless COMMUNICATION_TEST_DATABASE_URL is set, run by
// CI — the only way either is actually known). The sweep candidate read must
// (1) find terminal unclaimed runs across the server, (2) attribute each one
// to the human its row names (ADR-0062's rule: triggered_by, else the
// trigger row's author, else up the bounded parent chain) and DROP the run
// whose human cannot be named rather than forge one, and (3) clear a run
// whose claim carries a tour written after its newest move. The claim read is
// the two-replica idempotency question: the exact predicate, shared with the
// candidate read.

import (
	"testing"
	"time"

	"github.com/dbirks/communication/internal/api"
	"github.com/dbirks/communication/internal/domain"
)

// cuSweepRun inserts one run the sweep can see: terminal, recent, triggered
// by `byUser` ("" = a system start with no author to name).
func cuSweepRun(t *testing.T, f *m4Fixture, status string, byUser string, parent string) string {
	t.Helper()
	var nullable = func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	var id string
	err := f.pool.QueryRow(t.Context(), `
		INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
		                  revision_digest, plan_digest, plan_snapshot, policies_snapshot,
		                  status, failed_cause, finished_at, triggered_by, depth, parent_run_id)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb,
		        $7, CASE WHEN $7 = 'failed' THEN 'agent_error' ELSE NULL END,
		        now() - '1 hour'::interval, $8::uuid,
		        CASE WHEN $9::uuid IS NULL THEN 0 ELSE 1 END, $9::uuid)
		RETURNING id`, f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest,
		f.planDigest, status, nullable(byUser), nullable(parent)).Scan(&id)
	if err != nil {
		t.Fatalf("insert %s run: %v", status, err)
	}
	return id
}

func TestCatchUpSweepCandidatesAndClaimRead(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	gen := APICatchUpGenerator{S: &CatchUpStore{Pool: f.pool}}
	storeCaller := Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}
	caller := api.Caller{UserID: f.userID, OrganizationID: f.orgID, IsOrgAdmin: true}

	human := cuSweepRun(t, f, "completed", f.userID, "")
	ownerless := cuSweepRun(t, f, "completed", "", "") // a system start nobody authored
	running := func() string {
		var id string
		if err := f.pool.QueryRow(ctx, `
			INSERT INTO runs (organization_id, project_id, pipeline_id, pipeline_revision_id,
			                  revision_digest, plan_digest, plan_snapshot, policies_snapshot, status)
			VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '{}'::jsonb, '{}'::jsonb, 'running')
			RETURNING id`, f.orgID, f.projectID, f.pipelineID, f.revisionID, f.digest,
			f.planDigest).Scan(&id); err != nil {
			t.Fatalf("insert running run: %v", err)
		}
		return id
	}()
	child := cuSweepRun(t, f, "completed", "", human) // no author of its own; the parent's

	seen := map[string]api.CatchUpSweepCandidateView{}
	rows, err := gen.CatchUpSweepCandidates(ctx, 7*24*time.Hour, 10)
	if err != nil {
		t.Fatalf("sweep candidates: %v", err)
	}
	for _, row := range rows {
		seen[row.Candidate.RunID] = row
	}
	if _, ok := seen[human]; !ok {
		t.Fatalf("the finished human-run was not swept: %v", keysOf(seen))
	}
	if got := seen[human].Caller; got.UserID != f.userID || got.OrganizationID != f.orgID {
		t.Fatalf("attributed caller = %+v, want the run's own triggering user", got)
	}
	if _, ok := seen[ownerless]; ok {
		t.Fatal("a system run with no nameable human was swept; the generator must not forge a caller")
	}
	if _, ok := seen[running]; ok {
		t.Fatal("a non-terminal run was swept")
	}
	if got, ok := seen[child]; !ok {
		t.Fatalf("a child run whose parent names a human was not swept: %v", keysOf(seen))
	} else if got.Caller.UserID != f.userID {
		t.Fatalf("child attributed to %q, want the parent run's human", got.Caller.UserID)
	}

	if toured, err := gen.CatchUpRunAlreadyToured(ctx, human); err != nil || toured {
		t.Fatalf("an untoured run reads already-toured: %v %v", toured, err)
	}

	// Tell the human's story (upsert by group key, append the claiming tour)
	// and both reads must change their answer the same way.
	key := domain.CatchUpGroupKey("", 0, 0, human)
	item, err := (&CatchUpStore{Pool: f.pool}).UpsertWorkItem(ctx, storeCaller, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapeIssue, Title: "Told by the sweep",
		Summary: "One story.", Resolution: domain.CatchUpResolutionNoCode,
		SourceRunID: &human, GroupKey: key,
	})
	if err != nil {
		t.Fatalf("upsert the swept item: %v", err)
	}
	if _, err := (&CatchUpStore{Pool: f.pool}).AppendTourVersion(ctx, storeCaller, item.ID, human,
		"First telling by the sweep.",
		[]domain.CatchUpStop{cuStop("s1", "UI CHANGE", domain.CatchUpImportanceMustKnow, 1)}); err != nil {
		t.Fatalf("append the sweep's tour: %v", err)
	}
	if rows, err := gen.CatchUpSweepCandidates(ctx, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("post-tour sweep: %v", err)
	} else {
		for _, row := range rows {
			if row.Candidate.RunID == human {
				t.Fatal("a run whose tour was just appended is still a sweep candidate")
			}
		}
	}
	if toured, err := gen.CatchUpRunAlreadyToured(ctx, human); err != nil || !toured {
		t.Fatalf("RunAlreadyToured after the append = %v, %v; want true", toured, err)
	}

	// The run moves again: the tour no longer covers the newest fact, and the
	// claim read answers false so a sibling's claim can never stale-lock the
	// story out of its rewrite.
	if _, err := f.pool.Exec(ctx, `UPDATE runs SET finished_at = now() WHERE id = $1::uuid`, human); err != nil {
		t.Fatalf("move the run: %v", err)
	}
	if toured, err := gen.CatchUpRunAlreadyToured(ctx, human); err != nil || toured {
		t.Fatalf("a run that moved after its tour reads already-toured: %v %v", toured, err)
	}
	if rows, err := gen.CatchUpSweepCandidates(ctx, 7*24*time.Hour, 10); err != nil {
		t.Fatalf("moved-run sweep: %v", err)
	} else {
		var found *api.CatchUpSweepCandidateView
		for i := range rows {
			if rows[i].Candidate.RunID == human {
				found = &rows[i]
			}
		}
		if found == nil {
			t.Fatal("a run that moved after its tour did not re-arm for the sweep")
		}
		if found.Candidate.ItemID != item.ID || found.Candidate.TourHead != 1 {
			t.Fatalf("re-armed candidate lost the item to rewrite: %+v", found.Candidate)
		}
	}

	// § Structure's failure fact rides the grouping read: claim a FAILED run
	// onto the item and the next run folding in must see it.
	failed := cuSweepRun(t, f, "failed", f.userID, "")
	if _, err := (&CatchUpStore{Pool: f.pool}).AppendTourVersion(ctx, storeCaller, item.ID, failed,
		"The failed attempt.",
		[]domain.CatchUpStop{cuStop("s2", "BUG", domain.CatchUpImportanceWorthLook, 2)}); err != nil {
		t.Fatalf("append the failed run's tour: %v", err)
	}
	view, found, err := gen.CatchUpItemForGroup(ctx, caller, f.projectID, key)
	if err != nil || !found {
		t.Fatalf("group read after grouping: %v %v", found, err)
	}
	if !view.PriorRunFailed {
		t.Fatalf("group view = %+v, want PriorRunFailed for the item that carries a failed run", view)
	}
	// A clean group says the honest no: the flag is a read of the rows, not a
	// default.
	other := domain.CatchUpGroupKey("", 0, 0, ownerless)
	clean, err := (&CatchUpStore{Pool: f.pool}).UpsertWorkItem(ctx, storeCaller, domain.CatchUpWorkItem{
		ProjectID: f.projectID, Shape: domain.CatchUpShapeIssue, Title: "Clean work",
		Summary: "Nothing failed.", Resolution: domain.CatchUpResolutionOpen,
		GroupKey: other,
	})
	if err != nil {
		t.Fatalf("upsert the clean item: %v", err)
	}
	if _, err := (&CatchUpStore{Pool: f.pool}).AppendTourVersion(ctx, storeCaller, clean.ID, ownerless,
		"First telling.",
		[]domain.CatchUpStop{cuStop("s1", "UI CHANGE", domain.CatchUpImportanceRoutine, 1)}); err != nil {
		t.Fatalf("append the clean tour: %v", err)
	}
	if view, _, err := gen.CatchUpItemForGroup(ctx, caller, f.projectID, other); err != nil {
		t.Fatalf("clean group read: %v", err)
	} else if view.PriorRunFailed {
		t.Fatal("a group with no failed run claimed PriorRunFailed")
	}
}

// TestCatchUpSweepCandidatesNewestFirst pins § Trigger's ordering rule on
// real PostgreSQL: the sweep read returns the backlog NEWEST-finished first,
// and its LIMIT trims the OLDEST end — so when the sweep's model-call budget
// covers only part of the backlog, the run that just finished is the one told,
// never a run stuck behind the queue. The rows are inserted oldest-first so a
// read that merely echoed insertion order could not pass.
func TestCatchUpSweepCandidatesNewestFirst(t *testing.T) {
	ctx := testCtx(t)
	f := m4Setup(t)
	gen := APICatchUpGenerator{S: &CatchUpStore{Pool: f.pool}}
	move := func(runID string, ago string) {
		if _, err := f.pool.Exec(ctx, `UPDATE runs SET finished_at = now() - $2::interval WHERE id = $1::uuid`,
			runID, ago); err != nil {
			t.Fatalf("move %s's finish: %v", runID, err)
		}
	}
	oldest := cuSweepRun(t, f, "completed", f.userID, "") // inserted first, finished longest ago
	middle := cuSweepRun(t, f, "completed", f.userID, "")
	newest := cuSweepRun(t, f, "completed", f.userID, "") // inserted last, finished most recently
	move(oldest, "2 hours")
	move(middle, "1 hour")
	move(newest, "5 minutes")

	order := func(limit int) []string {
		rows, err := gen.CatchUpSweepCandidates(ctx, 7*24*time.Hour, limit)
		if err != nil {
			t.Fatalf("sweep candidates (limit %d): %v", limit, err)
		}
		want := map[string]bool{oldest: true, middle: true, newest: true}
		out := []string{}
		for _, row := range rows {
			if want[row.Candidate.RunID] {
				out = append(out, row.Candidate.RunID)
			}
		}
		return out
	}
	if got := order(10); len(got) != 3 || got[0] != newest || got[1] != middle || got[2] != oldest {
		t.Fatalf("sweep order = %v, want newest, middle, oldest", got)
	}
	// The LIMIT bites at the OLD end: a budget of two reaches the two most
	// recently finished runs, and the oldest waits for the next tick — the
	// just-finished run is never stuck behind the backlog.
	if got := order(2); len(got) != 2 || got[0] != newest || got[1] != middle {
		t.Fatalf("limited sweep order = %v, want the newest two kept and the oldest dropped", got)
	}
}

func keysOf(m map[string]api.CatchUpSweepCandidateView) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
