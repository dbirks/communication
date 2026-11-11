package postgres

// The five Catch up windows the page can ask for (15m, 1h, 1d, 3d, 7d), each with
// the history a returning engineer would actually be handed. The content follows
// the seeding brief in docs/research/2026-11-catch-up-audit.md § 6; the SEEDING of
// it lives in catch_up_seed_test.go, and every scenario below re-runs the previous
// one first, because that is what "what happened today" means — the last fifteen
// minutes happened inside today too.
//
// Each scenario test asserts four things:
//
//  1. it seeds without error;
//  2. the run counts, the approval counts and the title buckets read back out of
//     the database match what the seeder recorded — the window filter, the
//     membership filter and every backdate are what is under test, not the
//     scenario's prose about itself;
//  3. nothing from secret-ops (the project the reader is NOT in) comes back
//     through the existing membership-scoped list read, while the teammate who IS
//     in it sees exactly the item the reader cannot; and
//  4. the story is a function of the `now` passed in: no seeded row kept the real
//     clock, and seeding the same window at the same clock twice produces the
//     same rows.
//
// Like the rest of catch_up*_test.go these skip without
// COMMUNICATION_TEST_DATABASE_URL (mustMigrate skips first) and run on real
// PostgreSQL in CI.

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dbirks/communication/internal/domain"
)

// cuSeed builds one window's history in `f`'s database, anchored on `now`, and
// returns the expectation the test asserts against.
func cuSeed(t *testing.T, f *cnvFixture, s cuScenario, now time.Time) cuSeeded {
	t.Helper()
	w := cuWorldNew(t, f, s, now)
	layers := map[cuScenario]func(*cuWorld){
		cuWindow15m: cuContent15m,
		cuWindow1h:  cuContent1h,
		cuWindow1d:  cuContent1d,
		cuWindow3d:  cuContent3d,
		cuWindow7d:  cuContent7d,
	}
	for _, layer := range []cuScenario{cuWindow15m, cuWindow1h, cuWindow1d, cuWindow3d, cuWindow7d} {
		if _, ok := layers[s]; !ok {
			t.Fatalf("no catch-up scenario %q", string(s))
		}
		layers[layer](w)
		if layer == s {
			break
		}
	}
	return w.seeded()
}

// --- 15 minutes: the last few minutes of a live team ---------------------

// cuContent15m is the whole story of the smallest window: one run in progress,
// one plan waiting on the reader, one finished piece with a PR number on it. Two
// older runs sit outside every short window — so a page that ignored its own
// `since` could not pass for the right reason — and one failure lives in
// secret-ops, the project the reader is not a member of.
func cuContent15m(w *cuWorld) {
	// Running now: started 6m ago, one node in flight, no finish to report (a
	// terminal stamp on a running run is the constraint runs_terminal_timestamped
	// refuses, so the seeder cannot quietly invent one).
	running := w.seedRun(cuPayments, "Fix flaky checkout test", "running",
		6*time.Minute, 0, w.reader)
	w.seedNode(running, "/implement", "running", "", nil, 6*time.Minute)

	// Waiting on the reader: a plan gate nobody has answered.
	waiting := w.seedRun(cuPayments, "Rotate the payments webhook secret", "waiting_human",
		3*time.Minute, 0, w.reader)
	w.seedApproval(waiting, cuPayments, "Approve plan: rotate webhook secret", "pending",
		3*time.Minute, "")

	// Shipped 9m ago, with the PR its outputs name.
	done := w.seedRun(cuPayments, "Add idempotency keys to refunds", "completed",
		12*time.Minute, 9*time.Minute, w.reader)
	w.seedNode(done, "/implement", "succeeded", "", cuOutputs(
		"pr_number", 412,
		"pr_url", "https://github.com/acme/payments-api/pull/412",
		"branch", "refund-idempotency-keys",
		"commit_sha", cuSHA("refund-idempotency-keys"),
	), 9*time.Minute)
	w.seedItem(cuItemSpec{
		project: cuPayments, by: w.reader, title: "Add idempotency keys to refunds",
		summary:    "Refunds send an idempotency key now, so a retried charge cannot double-refund.",
		refPRs:     []int{412},
		refCommits: []string{cuSHA("refund-idempotency-keys")},
		ago:        9 * time.Minute, runID: done,
	})

	// Outside the short windows: an old failure and an older success.
	stale := w.seedRun(cuWebApp, "Chase the flaky upload progress bar", "failed",
		2*time.Hour+5*time.Minute, 2*time.Hour, w.teammate)
	w.seedNode(stale, "/implement", "failed", "test", cuOutputs(
		"failed_test", "ui/upload-progress.test.tsx",
	), 2*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.teammate, title: "Chase the flaky upload progress bar",
		summary:    "The upload progress test failed again and the run stopped without a branch.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        2 * time.Hour, runID: stale,
	})
	old := w.seedRun(cuInfra, "Archive last quarter's dashboards", "completed",
		3*24*time.Hour+30*time.Minute, 3*24*time.Hour, w.teammate)
	w.seedNode(old, "/implement", "succeeded", "", cuOutputs(
		"commit_sha", cuSHA("archive-dashboards"),
	), 3*24*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.teammate, title: "Archive last quarter's dashboards",
		summary:    "The Q3 dashboards moved to the archive bucket.",
		refCommits: []string{cuSHA("archive-dashboards")},
		ago:        3 * 24 * time.Hour, runID: old,
	})

	// secret-ops: a real failure with a real story, in a project the reader is not
	// in. It must never reach their page, whoever seeded it.
	secret := w.seedRun(cuSecretOps, "Rotate the deploy credentials", "failed",
		9*time.Minute, 5*time.Minute, w.teammate)
	w.seedNode(secret, "/implement", "failed", "infra", nil, 5*time.Minute)
	w.seedItem(cuItemSpec{
		project: cuSecretOps, by: w.teammate, title: "Rotate the deploy credentials",
		summary:    "The credential rotation timed out at the provider.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        5 * time.Minute, runID: secret,
	})
}

// --- 1 hour: a night's cron and a published pipeline ----------------------

// cuContent1h adds the failure that is still failing, a revision a teammate
// published, and three runs nobody will stop for.
func cuContent1h(w *cuWorld) {
	nightly := w.seedRun(cuPayments, "Nightly migration check", "failed",
		50*time.Minute, 40*time.Minute, "")
	w.seedNode(nightly, "/migrate_dry_run", "failed", "test", cuOutputs(
		"failed_test", "db/migrations/ledger_test",
	), 40*time.Minute)
	w.seedItem(cuItemSpec{
		project: cuPayments, by: w.teammate, title: "Nightly migration check",
		summary:    "The nightly dry-run fails on the ledger migration; nobody has fixed it yet.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        40 * time.Minute, runID: nightly,
	})

	// A teammate publishes v3 of the payments pipeline ("issue to draft PR").
	w.seedRevision(cuPayments, "2.1.0", 25*time.Minute, w.teammate)

	for _, r := range []struct {
		project, title string
		ago            time.Duration
	}{
		{cuWebApp, "Refresh the lab image pins", 12 * time.Minute},
		{cuInfra, "Tidy the alert routing tree", 20 * time.Minute},
		{cuPayments, "Regenerate the OpenAPI client", 35 * time.Minute},
	} {
		w.seedRoutineRun(r.project, r.title, r.ago)
	}
}

// --- 1 day: one engineer's day across two projects -----------------------

// cuContent1d is a working day: a bug found and fixed, a second bug nobody has
// fixed, two PRs, a commit pushed straight to main, a schema migration, an
// approval the teammate answered, one the reader still owes, and a new agent
// profile.
func cuContent1d(w *cuWorld) {
	// The bug story: found 20h ago, fixed 18h ago on the same pipeline. One work
	// item, two runs, the newest one carrying the fix (ADR-0078 § Grouping).
	bug := "Checkout timeouts under load"
	found := w.seedRun(cuPayments, bug, "failed", 20*time.Hour+10*time.Minute, 20*time.Hour, w.reader)
	w.seedNode(found, "/implement", "failed", "test", cuOutputs(
		"failed_test", "checkout/load_test",
	), 20*time.Hour)
	fixed := w.seedRun(cuPayments, bug, "completed", 18*time.Hour+20*time.Minute,
		18*time.Hour, w.reader)
	w.seedNode(fixed, "/implement", "succeeded", "", cuOutputs(
		"pr_number", 415,
		"pr_url", "https://github.com/acme/payments-api/pull/415",
		"branch", "checkout-connection-pool",
		"commit_sha", cuSHA("checkout-connection-pool"),
	), 18*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuPayments, by: w.reader, title: bug,
		summary: "FOUND in the load suite; CAUSE was a connection pool that starved under " +
			"load; FIXED by sizing the pool with the worker count; FOLLOW-UP is the load test " +
			"that should have caught it, still owed.",
		kind:       "FIXED",
		refPRs:     []int{415},
		refCommits: []string{cuSHA("checkout-connection-pool")},
		ago:        18 * time.Hour, runID: fixed,
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionMerged,
	})

	// A still-failing run of its own, with nothing after it.
	unfixed := w.seedRun(cuInfra, "Flaky node DNS probe", "failed",
		22*time.Hour+30*time.Minute, 22*time.Hour, w.teammate)
	w.seedNode(unfixed, "/probe", "failed", "test", nil, 22*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.teammate, title: "Flaky node DNS probe",
		summary:    "The DNS probe still fails intermittently and no later run has fixed it.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        22 * time.Hour, runID: unfixed,
	})

	// Two PRs that shipped.
	for _, pr := range []struct {
		project, title string
		number         int
		ago            time.Duration
		by             string
	}{
		{cuPayments, "Rate limit the refunds API", 416, 21 * time.Hour, "reader"},
		{cuWebApp, "Draft the ledger export", 417, 19 * time.Hour, "teammate"},
	} {
		by := w.reader
		if pr.by == "teammate" {
			by = w.teammate
		}
		sha := cuSHA(pr.title)
		run := w.seedRun(pr.project, pr.title, "completed", pr.ago+30*time.Minute, pr.ago, by)
		w.seedNode(run, "/implement", "succeeded", "", cuOutputs(
			"pr_number", pr.number,
			"pr_url", "https://github.com/acme/"+pr.project+"/pull/"+fmt.Sprint(pr.number),
			"branch", cuBranch(pr.title),
			"commit_sha", sha,
		), pr.ago)
		w.seedItem(cuItemSpec{
			project: pr.project, by: by, title: pr.title,
			summary:    "Opened, reviewed and merged in the same sitting.",
			refPRs:     []int{pr.number},
			refCommits: []string{sha},
			ago:        pr.ago, runID: run,
		})
	}

	// A commit pushed straight to main, by nobody: must_know, because no review
	// was ever in its path (the importance rules in the tour prompt name it).
	pushed := w.seedRun(cuPayments, "Pin the shared lint config on main", "completed",
		16*time.Hour+45*time.Minute, 16*time.Hour, "")
	w.seedNode(pushed, "/implement", "succeeded", "", cuOutputs(
		"pushed_to", "main",
		"commit_sha", cuSHA("pin-lint-config"),
	), 16*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuPayments, by: w.teammate, title: "Pin the shared lint config on main",
		summary:    "The version bump went straight to main with no PR behind it.",
		refCommits: []string{cuSHA("pin-lint-config")},
		ago:        16 * time.Hour, runID: pushed,
		importance: domain.CatchUpImportanceMustKnow, kind: "PUSH_TO_MAIN",
		shape: domain.CatchUpShapePush,
	})

	// A data migration: the file it touched travels in the outputs, which is where
	// the tour's evidence comes from.
	migration := w.seedRun(cuWebApp, "Backfill the ledger accounts", "completed",
		14*time.Hour+40*time.Minute, 14*time.Hour, w.teammate)
	w.seedNode(migration, "/implement", "succeeded", "", cuOutputs(
		"migration", "db/migrations/00042_add_ledger.sql",
		"patch", "db/migrations/00042_add_ledger.sql",
		"pr_number", 418,
		"pr_url", "https://github.com/acme/web-app/pull/418",
		"commit_sha", cuSHA("backfill-ledger"),
	), 14*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.teammate, title: "Backfill the ledger accounts",
		summary: "Adds db/migrations/00042_add_ledger.sql and backfills 41 rows; rolling it " +
			"back needs a restore, not a down-migration.",
		refPRs:     []int{418},
		refCommits: []string{cuSHA("backfill-ledger")},
		ago:        14 * time.Hour, runID: migration,
		importance: domain.CatchUpImportanceMustKnow, kind: "MIGRATION",
	})

	// An approval the teammate answered (the run then shipped), and one the reader
	// still owes.
	answered := w.seedRun(cuWebApp, "Cut the 2026-11 release branch", "completed",
		8*time.Hour+30*time.Minute, 8*time.Hour, w.reader)
	w.seedApproval(answered, cuWebApp, "Approve plan: cut the release branch", "decided",
		8*time.Hour, w.teammate)
	w.seedNode(answered, "/implement", "succeeded", "", cuOutputs(
		"branch", "release/2026-11",
		"pushed_to", "release/2026-11",
		"commit_sha", cuSHA("release-2026-11"),
	), 8*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.reader, title: "Cut the 2026-11 release branch",
		summary:    "Approved by the teammate and cut; the branch exists and nothing has landed on it.",
		refCommits: []string{cuSHA("release-2026-11")},
		ago:        8 * time.Hour, runID: answered,
		shape: domain.CatchUpShapePush,
	})
	owed := w.seedRun(cuInfra, "Widen the alert dedupe window", "waiting_human",
		4*time.Hour+20*time.Minute, 0, w.reader)
	w.seedApproval(owed, cuInfra, "Approve plan: widen the alert dedupe window", "pending",
		4*time.Hour, "")

	// A new agent profile is a thing a team notices when it comes back.
	w.seedProfile("Pi", "pi", 5*time.Hour)

	for _, r := range []struct {
		project, title string
		ago            time.Duration
	}{
		{cuWebApp, "Clear the stale preview environments", 23 * time.Hour},
		{cuPayments, "Retry the provider latency flake", 21 * time.Hour},
		{cuInfra, "Renew the lab TLS certificate", 17 * time.Hour},
		{cuPayments, "Trim the refund worker's log noise", 15 * time.Hour},
		{cuWebApp, "Bump the design tokens package", 13 * time.Hour},
		{cuInfra, "Rotate the lab kubeconfig", 11 * time.Hour},
		{cuPayments, "Update the provider SDK", 10 * time.Hour},
		{cuWebApp, "Fix the sidebar overflow on tablets", 7 * time.Hour},
	} {
		w.seedRoutineRun(r.project, r.title, r.ago)
	}
}

// --- 3 days: a sprint's worth, across three projects ---------------------

// cuContent3d adds roughly thirty runs, a dependency bump, a new member, a
// cancelled run and the one story in the set that asks the reader something.
func cuContent3d(w *cuWorld) {
	// A new dependency: the importance rules put it above the day's other work.
	bump := w.seedRun(cuPayments, "Bump pgx to v5.9", "completed",
		60*time.Hour+40*time.Minute, 60*time.Hour, w.teammate)
	w.seedNode(bump, "/implement", "succeeded", "", cuOutputs(
		"dependency_bump", "go.mod",
		"file", "go.mod",
		"commit_sha", cuSHA("bump-pgx"),
	), 60*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuPayments, by: w.teammate, title: "Bump pgx to v5.9",
		summary:    "go.mod requires pgx v5.9 now, pulled in by the retry policy the migration needs.",
		refCommits: []string{cuSHA("bump-pgx")},
		ago:        60 * time.Hour, runID: bump,
		importance: domain.CatchUpImportanceMustKnow, kind: "NEW_DEPENDENCY",
	})

	// Somebody new joined infra — a fact about the window, not about this test run.
	dana := w.cuNewUser("cnv-dana")
	w.seedMember(cuInfra, dana, "contributor", 30*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.teammate, title: "A new member joined infra",
		summary:    "Dana was added to the infra project as a contributor.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionNoCode,
		ago:        30 * time.Hour,
		importance: domain.CatchUpImportanceMustKnow, kind: "NEW_MEMBER",
	})

	// A run somebody stopped on purpose.
	cancelled := w.seedRun(cuWebApp, "Rewrite the upload queue in workers", "cancelled",
		50*time.Hour+20*time.Minute, 50*time.Hour, w.reader)
	w.seedNode(cancelled, "/implement", "cancelled", "cancelled", nil, 50*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.reader, title: "Rewrite the upload queue in workers",
		summary:    "Stopped at the two-hour mark; the branch is not worth finishing.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        50 * time.Hour, runID: cancelled,
	})

	// The one beat that asks the reader something. It belongs to a thread rather
	// than a run, which is the only shape a decision survives in
	// (internal/api/catch_up.go: Asks = the stop has a decision).
	thread := w.cuNewConversation(cuInfra, "Alert routing: one tree or two?", w.reader,
		22*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.reader, title: "Alert routing: one tree or two?",
		summary: "The agent can fold paging into the existing tree or split it in two, and " +
			"wants an answer before it touches the routing config.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionOpen,
		ago:        20 * time.Hour, convID: thread,
		importance: domain.CatchUpImportanceWorthLook,
		decision:   cuAsk("Fold paging into the existing alert tree, or split it in two?", "One tree", "Two trees"),
	})

	// Two shipped PRs, so the window has more in it than filler.
	for _, pr := range []struct {
		title  string
		number int
		ago    time.Duration
	}{
		{"Split the refunds worker from the API", 419, 40 * time.Hour},
		{"Cache the provider latency lookups", 420, 36 * time.Hour},
	} {
		ago := pr.ago
		sha := cuSHA(pr.title)
		run := w.seedRun(cuPayments, pr.title, "completed", ago+25*time.Minute, ago, w.teammate)
		w.seedNode(run, "/implement", "succeeded", "", cuOutputs(
			"pr_number", pr.number,
			"pr_url", "https://github.com/acme/payments-api/pull/"+fmt.Sprint(pr.number),
			"branch", cuBranch(pr.title),
			"commit_sha", sha,
		), ago)
		w.seedItem(cuItemSpec{
			project: cuPayments, by: w.teammate, title: pr.title,
			summary:    "Merged by the teammate; the request path no longer waits on the provider.",
			refPRs:     []int{pr.number},
			refCommits: []string{sha},
			ago:        ago, runID: run,
		})
	}

	// A teammate published a revision; the reader kept running the old pin.
	w.seedRevision(cuInfra, "1.2.0", 34*time.Hour, w.teammate)

	// The rest of the sprint: thirty-ish runs over three projects and three days.
	for _, r := range []struct {
		project, title string
		ago            time.Duration
	}{
		{cuPayments, "Nightly migration check", 70 * time.Hour},
		{cuPayments, "Nightly migration check", 46 * time.Hour},
		{cuPayments, "Nightly migration check", 26 * time.Hour},
		{cuWebApp, "Nightly snapshot job", 71 * time.Hour},
		{cuWebApp, "Nightly snapshot job", 47 * time.Hour},
		{cuWebApp, "Nightly snapshot job", 27 * time.Hour},
		{cuInfra, "Rotate lab credentials", 69 * time.Hour},
		{cuInfra, "Rotate lab credentials", 45 * time.Hour},
		{cuInfra, "Rotate lab credentials", 25 * time.Hour},
		{cuPayments, "Triage issue 231", 68 * time.Hour},
		{cuPayments, "Triage issue 232", 67 * time.Hour},
		{cuPayments, "Triage issue 233", 66 * time.Hour},
		{cuWebApp, "Docs pass for the sidebar", 65 * time.Hour},
		{cuWebApp, "Docs pass for the settings page", 64 * time.Hour},
		{cuInfra, "Prune the old alert rules", 63 * time.Hour},
		{cuInfra, "Prune the old dashboards", 62 * time.Hour},
		{cuPayments, "Refunds lint sweep", 61 * time.Hour},
		{cuWebApp, "Design tokens lint sweep", 59 * time.Hour},
		{cuInfra, "Node image cache warm-up", 58 * time.Hour},
		{cuPayments, "Nightly lint", 57 * time.Hour},
		{cuWebApp, "Nightly lint", 56 * time.Hour},
		{cuInfra, "Nightly lint", 55 * time.Hour},
		{cuPayments, "Quarantine the flaky refunds test", 54 * time.Hour},
		{cuWebApp, "Regenerate the API client", 53 * time.Hour},
		{cuInfra, "Refresh the runbook index", 52 * time.Hour},
		{cuPayments, "Clean the abandoned preview envs", 51 * time.Hour},
		{cuWebApp, "Trim unused CSS in the shell", 49 * time.Hour},
		{cuInfra, "Renew the lab ingress certificate", 48 * time.Hour},
		{cuPayments, "Retry the webhook timeout probe", 44 * time.Hour},
		{cuWebApp, "Compact the comment search index", 43 * time.Hour},
	} {
		w.seedRoutineRun(r.project, r.title, r.ago)
	}
}

// --- 7 days: the whole week, with the long tail -------------------------

// cuContent7d adds roughly seventy runs: fourteen pieces of work that name a PR,
// one security change, one test that got skipped rather than fixed, and a failure
// that began six days ago and has never stopped failing.
func cuContent7d(w *cuWorld) {
	// The auth change, which outranks everything else in the window.
	auth := w.seedRun(cuWebApp, "Switch session cookies to SameSite=Strict", "completed",
		120*time.Hour+40*time.Minute, 120*time.Hour, w.teammate)
	w.seedNode(auth, "/implement", "succeeded", "", cuOutputs(
		"pr_number", 431,
		"pr_url", "https://github.com/acme/web-app/pull/431",
		"branch", "samesite-strict",
		"commit_sha", cuSHA("samesite-strict"),
	), 120*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.teammate, title: "Switch session cookies to SameSite=Strict",
		summary: "Session cookies are SameSite=Strict now, so a cross-site embed that relied on " +
			"the session will not carry it.",
		refPRs:     []int{431},
		refCommits: []string{cuSHA("samesite-strict")},
		ago:        120 * time.Hour, runID: auth,
		importance: domain.CatchUpImportanceMustKnow, kind: "AUTH",
	})

	// A test skipped instead of fixed: the beats weakened on purpose.
	skipped := w.seedRun(cuWebApp, "Quarantine the flaky upload test", "completed",
		96*time.Hour+30*time.Minute, 96*time.Hour, w.reader)
	w.seedNode(skipped, "/test", "skipped", "", cuOutputs(
		"skipped_test", "ui/upload-progress.test.tsx",
		"commit_sha", cuSHA("quarantine-upload-test"),
	), 96*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuWebApp, by: w.reader, title: "Quarantine the flaky upload test",
		summary: "The upload progress test is skipped rather than fixed, so the flake is hidden " +
			"rather than gone.",
		refCommits: []string{cuSHA("quarantine-upload-test")},
		ago:        96 * time.Hour, runID: skipped,
		importance: domain.CatchUpImportanceMustKnow, kind: "TESTS_WEAKENED",
		shape: domain.CatchUpShapePush,
	})

	// The failure that began six days ago and is still failing: the same nightly
	// smoke, failing every night since, with no success after any of them.
	for _, ago := range []time.Duration{
		144 * time.Hour, 121 * time.Hour, 97 * time.Hour,
		72 * time.Hour, 48 * time.Hour, 24 * time.Hour,
	} {
		run := w.seedRun(cuInfra, "Nightly exporter smoke test", "failed",
			ago+45*time.Minute, ago, "")
		w.seedNode(run, "/smoke", "failed", "infra", cuOutputs(
			"failed_test", "exporters/ledger_smoke",
		), ago)
	}
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.teammate, title: "Nightly exporter smoke test",
		summary: "Failing since six days ago: the ledger exporter is unreachable from the lab. " +
			"Every night since has failed the same way.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        24 * time.Hour,
	})

	// A cancelled week-old experiment.
	abandoned := w.seedRun(cuInfra, "Try the new alert dedupe engine", "cancelled",
		100*time.Hour+20*time.Minute, 100*time.Hour, w.reader)
	w.seedNode(abandoned, "/implement", "cancelled", "cancelled", nil, 100*time.Hour)
	w.seedItem(cuItemSpec{
		project: cuInfra, by: w.reader, title: "Try the new alert dedupe engine",
		summary:    "Cancelled after an hour: it could not beat the tree it replaced.",
		shape:      domain.CatchUpShapeIssue,
		resolution: domain.CatchUpResolutionRunFailed,
		ago:        100 * time.Hour, runID: abandoned,
	})

	// Fourteen pieces of work that name a PR, spread over the week and the three
	// projects the reader belongs to.
	for _, pr := range []struct {
		project, title string
		number         int
		ago            time.Duration
	}{
		{cuPayments, "Rate limit the refunds endpoint", 432, 140 * time.Hour},
		{cuPayments, "Add the webhook replay endpoint", 433, 138 * time.Hour},
		{cuPayments, "Move provider retries behind a policy", 434, 134 * time.Hour},
		{cuPayments, "Split the charge disputes worker", 435, 130 * time.Hour},
		{cuPayments, "Index the ledger accounts table", 436, 126 * time.Hour},
		{cuPayments, "Retire the legacy charge endpoint", 437, 118 * time.Hour},
		{cuPayments, "Tidy the idempotency key docs", 438, 112 * time.Hour},
		{cuWebApp, "Virtualise the conversation list", 439, 136 * time.Hour},
		{cuWebApp, "Persist the catch-up window choice", 440, 132 * time.Hour},
		{cuWebApp, "Add the evidence drawer", 441, 128 * time.Hour},
		{cuWebApp, "Fix the timeline scroll jump", 442, 124 * time.Hour},
		{cuWebApp, "Keyboard-navigate the tour cards", 443, 116 * time.Hour},
		{cuInfra, "Terraform the alert routing tree", 444, 139 * time.Hour},
		{cuInfra, "Move lab snapshots to the cheap bucket", 445, 122 * time.Hour},
	} {
		sha := cuSHA(pr.title)
		run := w.seedRun(pr.project, pr.title, "completed", pr.ago+35*time.Minute, pr.ago, w.teammate)
		w.seedNode(run, "/implement", "succeeded", "", cuOutputs(
			"pr_number", pr.number,
			"pr_url", "https://github.com/acme/"+pr.project+"/pull/"+fmt.Sprint(pr.number),
			"branch", cuBranch(pr.title),
			"commit_sha", sha,
		), pr.ago)
		w.seedItem(cuItemSpec{
			project: pr.project, by: w.teammate, title: pr.title,
			summary:    "Reviewed and merged in the same run; the discussion is on the PR.",
			refPRs:     []int{pr.number},
			refCommits: []string{sha},
			ago:        pr.ago, runID: run,
		})
	}

	// Two revisions the reader never saw, published by the rest of the team.
	w.seedRevision(cuPayments, "3.0.0", 72*time.Hour, w.teammate)
	w.seedRevision(cuWebApp, "1.5.0", 42*time.Hour, w.reader)

	// The rest of the week: routine, finished, worth a line at most.
	for _, r := range cuWeekFiller() {
		w.seedRoutineRun(r.project, r.title, r.ago)
	}
}

// cuWeekFiller is the long tail of a week: nineteen infra jobs, twelve web passes
// and fourteen payments runs, spread across the whole window — real finished work
// that no returning engineer would stop for.
func cuWeekFiller() []struct {
	project, title string
	ago            time.Duration
} {
	out := []struct {
		project, title string
		ago            time.Duration
	}{}
	add := func(project string, every time.Duration, titles ...string) {
		for i, title := range titles {
			out = append(out, struct {
				project, title string
				ago            time.Duration
			}{project, title, 168*time.Hour - time.Duration(i)*every})
		}
	}
	add(cuInfra, 3*time.Hour, "Nightly lint", "Nightly snapshot job", "Rotate lab credentials",
		"Prune old dashboards", "Compact the event journal partition", "Refresh the runbook index",
		"Node image cache warm-up", "Renew the lab TLS certificate", "Tidy the alert routing tree",
		"Check the backup restore drill", "Renew the lab ingress certificate",
		"Rotate the lab kubeconfig", "Clear the stale preview environments",
		"Audit the worker fleet versions", "Rebalance the lab storage class",
		"Trim unused alert rules", "Refresh the lab image pins", "Renumber the on-call rota file",
		"Warm the artifact cache", "Verify the audit log retention", "Refresh the sandbox base image",
		"Check the DNS probe flake rate", "Trim the log retention policy")
	add(cuWebApp, 3*time.Hour+30*time.Minute, "Nightly lint", "Docs pass for the settings page",
		"Regenerate the API client", "Design tokens lint sweep", "Trim unused CSS in the shell",
		"Compact the comment search index", "Clear the stale preview environments",
		"Refresh the lab image pins", "Triage issue 241", "Triage issue 242", "Triage issue 243",
		"Triage issue 244", "Triage issue 245", "Triage issue 246", "Triage issue 247",
		"Triage issue 248", "Triage issue 249", "Triage issue 250", "Update the rich text editor",
		"Quarantine the flaky date picker test", "Clear the abandoned branches",
		"Refresh the screenshot fixtures", "Tidy the storybook build", "Fix the empty-state copy")
	add(cuPayments, 3*time.Hour+45*time.Minute, "Nightly lint", "Nightly snapshot job",
		"Quarantine the flaky refunds test", "Tidy the flake quarantine list",
		"Retry the webhook timeout probe", "Update the provider SDK", "Update the stripe client",
		"Update the OAuth dependencies", "Triage issue 251", "Triage issue 252", "Triage issue 253",
		"Triage issue 254",
		"Trim the refund worker's log noise", "Clean the abandoned preview envs",
		"Instrument the charge retry path", "Renumber the error code registry")
	return out
}

// cuSHA derives a commit sha from a label the way m4Digest derives a digest:
// deterministic, distinct where the story needs distinct, never a real object.
func cuSHA(label string) string { return m4Hex("catchup-seed/" + label)[:40] }

// cuBranch turns a title into the branch name its PR would carry.
func cuBranch(title string) string {
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r == ' ' || r == '-' || r == '.':
			return '-'
		}
		return -1
	}, title)
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return strings.Trim(out, "-")
}

// --- the shared assertions ----------------------------------------------

// cuSeedScenario runs the four assertions above for one window.
func cuSeedScenario(t *testing.T, s cuScenario) {
	t.Helper()
	now := cuClock()

	f := cnvSetup(t)
	seeded := cuSeed(t, f, s, now)
	t.Logf("%s window: %d runs, %d work items, %d approvals, %d revisions published",
		s, len(seeded.world.runs), len(seeded.world.items), len(seeded.world.approvals),
		len(seeded.world.published))

	t.Run("reads back as recorded", func(t *testing.T) {
		if diff := cuExpectDiff(seeded.Expect, cuReadExpectation(t, f, seeded, now)); diff != "" {
			t.Errorf("the seeded window does not read back as recorded:\n%s", diff)
		}
	})

	t.Run("the list read is the seeded story", func(t *testing.T) {
		// The page's own read, membership-scoped and narrowed to the window: it
		// must return exactly the stories the window contains — no more (nothing
		// older, nothing from a project the reader is not in), no less (every
		// seeded story has a tour the reader has not read).
		got := cuTitles(cuList(t, f, seeded.ReaderID,
			append(seeded.visibleIDs(), seeded.secretID()), ptrTime(cuCutoff(now, s)), false))
		if diff := cuDiffStrings("list", seeded.world.storyTitles(), got); diff != "" {
			t.Errorf("the Catch up list is not the seeded history:%s", diff)
		}
	})

	t.Run("secret-ops never reaches the reader", func(t *testing.T) {
		// Every project, including the one the reader is not in, named explicitly:
		// the whole window and the seen state too, so nothing can hide in a filter.
		all := append(seeded.visibleIDs(), seeded.secretID())
		for _, item := range cuList(t, f, seeded.ReaderID, all, nil, true) {
			if item.ProjectID == seeded.secretID() {
				t.Errorf("reader can see the secret-ops work item %q", item.Title)
			}
			if strings.Contains(item.Title, "deploy credentials") {
				t.Errorf("reader can see %q, which belongs to secret-ops", item.Title)
			}
		}
		// And it is the membership that hides it, not a seed that never landed: the
		// teammate, who IS a member of secret-ops, sees exactly that one more item.
		var seen int
		for _, item := range cuList(t, f, seeded.TeammateID, all, nil, true) {
			if item.ProjectID == seeded.secretID() {
				seen++
			}
		}
		if seen != 1 {
			t.Errorf("the teammate saw %d secret-ops work items, want 1", seen)
		}
	})

	t.Run("deterministic for a fixed now", func(t *testing.T) {
		cuSeedFutureTimestamps(t, f, seeded, now)
		f2 := cnvSetup(t)
		again := cuSeed(t, f2, s, now)
		if diff := cuExpectDiff(seeded.Expect, again.Expect); diff != "" {
			t.Errorf("seeding the same window at the same clock twice gave a different story:%s", diff)
		}
		a, b := cuSeedFingerprint(t, f, seeded, now), cuSeedFingerprint(t, f2, again, now)
		if diff := cuDiffStrings("rows", a, b); diff != "" {
			t.Errorf("seeding the same window at the same clock twice wrote different rows:%s", diff)
		}
	})
}

func cuTitles(items []domain.CatchUpListItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Title)
	}
	sort.Strings(out)
	return out
}

// --- reads the tests make themselves --------------------------------------

// cuCutoff is where a window begins.
func cuCutoff(now time.Time, s cuScenario) time.Time { return now.Add(-s.window()) }

// cuReadExpectation re-derives cuSeeded.Expect from the rows, with reads that
// share nothing with the seeder's own bookkeeping. The comparison is the test: if
// a backdate did not land, a row went to the wrong project, or a story was never
// claimed, the two accounts disagree.
func cuReadExpectation(t *testing.T, f *cnvFixture, s cuSeeded, now time.Time) cuExpect {
	t.Helper()
	ctx, cutoff := testCtx(t), cuCutoff(now, s.world.scenario)
	want := cuExpect{}

	// Run counts by status inside the window. A terminal run is dated by its
	// finish, one still going by when it started — the rule the sweep read uses,
	// and the reason a seeded run can never have both stamps missing.
	rows, err := f.pool.Query(ctx, `
		SELECT status, count (*) FROM runs
		WHERE project_id = ANY ($1::uuid[])
		  AND COALESCE (finished_at, started_at) >= $2::timestamptz
		GROUP BY status ORDER BY status`, s.visibleIDs(), cutoff)
	if err != nil {
		t.Fatalf("read run counts: %v", err)
	}
	other := []string{}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			rows.Close()
			t.Fatalf("scan run counts: %v", err)
		}
		switch status {
		case "completed":
			want.Succeeded = n
		case "failed":
			want.Failed = n
		case "cancelled":
			want.Cancelled = n
		case "running":
			want.Running = n
		case "waiting_human": // an approval's run: counted under approvals, not here
		default:
			other = append(other, fmt.Sprintf("%s=%d", status, n))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("read run counts: %v", err)
	}
	if len(other) > 0 {
		t.Errorf("seeded runs in statuses the expectation does not count: %s",
			strings.Join(other, ", "))
	}

	// Approvals: pending is the reader's problem, decided was somebody else's.
	if err := f.pool.QueryRow(ctx, `
		SELECT count (*) FILTER (WHERE state = 'pending'),
		       count (*) FILTER (WHERE state = 'decided')
		FROM approval_requests
		WHERE project_id = ANY ($1::uuid[]) AND created_at >= $2::timestamptz`,
		s.visibleIDs(), cutoff).Scan(&want.ApprovalsPending, &want.ApprovalsDecided); err != nil {
		t.Fatalf("read approval counts: %v", err)
	}

	// A waiting_human run with no pending approval would be a state the page has
	// no answer for.
	var stranded int
	if err := f.pool.QueryRow(ctx, `
		SELECT count (*) FROM runs r
		WHERE r.project_id = ANY ($1::uuid[])
		  AND COALESCE (r.finished_at, r.started_at) >= $2::timestamptz
		  AND r.status = 'waiting_human'
		  AND NOT EXISTS (SELECT 1 FROM approval_requests a
		                  WHERE a.run_id = r.id AND a.state = 'pending')`,
		s.visibleIDs(), cutoff).Scan(&stranded); err != nil {
		t.Fatalf("read stranded runs: %v", err)
	}
	if stranded != 0 {
		t.Errorf("%d waiting_human runs have no pending approval behind them", stranded)
	}

	// Titles, classified by the same ordered rule the seeder applies to its own
	// record — so what is compared is the rows, not the scenario's prose.
	buckets, err := cuReadBuckets(ctx, f, s, cutoff)
	if err != nil {
		t.Fatalf("read title buckets: %v", err)
	}
	want.NeedsYou, want.RunningNow = buckets.NeedsYou, buckets.RunningNow
	want.Shipped, want.StillFailing, want.Fixed = buckets.Shipped, buckets.StillFailing, buckets.Fixed
	want.HeadsUp, want.Changes = buckets.HeadsUp, buckets.Changes
	sortStrings(&want)
	return want
}

// cuBucketSQL classifies every work item the reader can see inside the window
// into exactly one bucket, by the ordered rule documented on cuExpect.
const cuBucketSQL = `
	WITH newest AS (
		SELECT DISTINCT ON (tv.work_item_id) tv.work_item_id, tv.stops
		FROM catchup_tour_versions tv
		JOIN catchup_work_items w ON w.id = tv.work_item_id
		WHERE w.project_id = ANY ($1::uuid[]) AND w.updated_at >= $2::timestamptz
		ORDER BY tv.work_item_id, tv.version DESC
	),
	classified AS (
		SELECT w.id, w.title,
		       CASE
		           WHEN bool_or (e.value ->> 'importance' = 'must_know')       THEN 'heads_up'
		           WHEN w.resolution = 'run_failed'                            THEN 'still_failing'
		           WHEN bool_or (e.value ? 'decision')                         THEN 'needs_you'
		           WHEN w.resolution IN ('open','branch_ready')                THEN 'needs_you'
		           WHEN w.shape = 'issue' AND w.resolution = 'merged'          THEN 'fixed'
		           WHEN w.shape IN ('pr','push')                               THEN 'shipped'
		           ELSE 'other'
		       END AS bucket
		FROM catchup_work_items w
		JOIN newest n ON n.work_item_id = w.id
		CROSS JOIN jsonb_array_elements (n.stops) AS e
		WHERE w.project_id = ANY ($1::uuid[]) AND w.updated_at >= $2::timestamptz
		GROUP BY w.id, w.title, w.shape, w.resolution
	)
	SELECT bucket, COALESCE (jsonb_agg (title ORDER BY title), '[]'::jsonb)
	FROM classified GROUP BY bucket ORDER BY bucket`

// cuAggSQL collects one read's rows into a jsonb array. Each inner query returns
// exactly one column, aliased q (x) by the wrapper.
const cuAggSQL = `SELECT COALESCE (jsonb_agg (q.x ORDER BY q.x), '[]'::jsonb) FROM (`

// cuReadBuckets reads the story titles out of the work items, the pending
// approvals, the still-running runs and the published revisions.
func cuReadBuckets(ctx context.Context, f *cnvFixture, s cuSeeded,
	cutoff time.Time) (cuExpect, error) {
	var out cuExpect
	rows, err := f.pool.Query(ctx, cuBucketSQL, s.visibleIDs(), cutoff)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var bucket string
		var raw []byte
		if err := rows.Scan(&bucket, &raw); err != nil {
			rows.Close()
			return out, err
		}
		switch bucket {
		case "heads_up":
			err = cuAppendStrings(raw, &out.HeadsUp)
		case "still_failing":
			err = cuAppendStrings(raw, &out.StillFailing)
		case "needs_you":
			err = cuAppendStrings(raw, &out.NeedsYou)
		case "fixed":
			err = cuAppendStrings(raw, &out.Fixed)
		case "shipped":
			err = cuAppendStrings(raw, &out.Shipped)
		default:
			err = fmt.Errorf("work items in no bucket at all (%s): %s",
				bucket, strings.TrimPrefix(strings.TrimSuffix(string(raw), "]"), "["))
		}
		if err != nil {
			rows.Close()
			return out, err
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	reads := []struct {
		what string
		ids  []string
		sql  string
		to   *[]string
	}{
		{"pending approvals", s.visibleIDs(), cuAggSQL + `
			SELECT summary FROM approval_requests
			WHERE project_id = ANY ($1::uuid[]) AND state = 'pending'
			  AND created_at >= $2::timestamptz` + "\n) q (x)", &out.NeedsYou},
		{"running runs", s.visibleIDs(), cuAggSQL + `
			SELECT title FROM runs
			WHERE project_id = ANY ($1::uuid[]) AND status = 'running'
			  AND started_at >= $2::timestamptz` + "\n) q (x)", &out.RunningNow},
		// The revisions a teammate published, which are the pipeline's rows rather
		// than any project's, so this read is scoped by the world's pipeline ids.
		{"published revisions", s.world.pipelineIDs, cuAggSQL + `
			SELECT p.display_name || ' ' || r.version_label
			FROM pipeline_revisions r JOIN pipelines p ON p.id = r.pipeline_id
			WHERE p.id = ANY ($1::uuid[]) AND r.published_at >= $2::timestamptz
			  AND r.version_label <> '1.0.0'` + "\n) q (x)", &out.Changes},
	}
	for _, r := range reads {
		var raw []byte
		if err := f.pool.QueryRow(ctx, r.sql, r.ids, cutoff).Scan(&raw); err != nil {
			return out, fmt.Errorf("read %s: %w", r.what, err)
		}
		if err := cuAppendStrings(raw, r.to); err != nil {
			return out, fmt.Errorf("read %s: %w", r.what, err)
		}
	}
	return out, nil
}

func cuAppendStrings(raw []byte, to *[]string) error {
	var add []string
	if err := json.Unmarshal(raw, &add); err != nil {
		return err
	}
	*to = append(*to, add...)
	sort.Strings(*to)
	return nil
}

// cuSeedFutureTimestamps proves every seeded row is dated from the clock it was
// handed. DEFAULT now() is the drift this catches: audit § 6 lists these very
// columns as the ones a seeder must override, and any one of them left at the
// real clock would make the same `now` tell a different story tomorrow.
func cuSeedFutureTimestamps(t *testing.T, f *cnvFixture, s cuSeeded, now time.Time) {
	t.Helper()
	projects := append(s.visibleIDs(), s.secretID())
	for _, q := range []struct {
		what, sql string
		args      []any
	}{
		{"runs", `SELECT count (*) FROM runs
		  WHERE project_id = ANY ($1::uuid[]) AND created_at > $2::timestamptz`,
			[]any{projects, now}},
		{"nodes", `SELECT count (*) FROM node_executions ne
		  WHERE ne.created_at > $2::timestamptz AND ne.run_id IN
		        (SELECT id FROM runs WHERE project_id = ANY ($1::uuid[]))`,
			[]any{projects, now}},
		{"approvals", `SELECT count (*) FROM approval_requests
		  WHERE project_id = ANY ($1::uuid[]) AND created_at > $2::timestamptz`,
			[]any{projects, now}},
		{"work items", `SELECT count (*) FROM catchup_work_items
		  WHERE project_id = ANY ($1::uuid[])
		    AND (created_at > $2::timestamptz OR updated_at > $2::timestamptz)`,
			[]any{projects, now}},
		{"tour versions", `SELECT count (*) FROM catchup_tour_versions tv
		  JOIN catchup_work_items w ON w.id = tv.work_item_id
		  WHERE w.project_id = ANY ($1::uuid[]) AND tv.created_at > $2::timestamptz`,
			[]any{projects, now}},
		{"run claims", `SELECT count (*) FROM catchup_work_item_runs c
		  JOIN catchup_work_items w ON w.id = c.work_item_id
		  WHERE w.project_id = ANY ($1::uuid[]) AND c.added_at > $2::timestamptz`,
			[]any{projects, now}},
		{"revisions", `SELECT count (*) FROM pipeline_revisions
		  WHERE pipeline_id = ANY ($1::uuid[]) AND published_at > $2::timestamptz`,
			[]any{s.world.pipelineIDs, now}},
		{"profiles", `SELECT count (*) FROM agent_profiles
		  WHERE id = ANY ($1::uuid[]) AND created_at > $2::timestamptz`,
			[]any{s.world.profileIDs, now}},
		{"memberships", `SELECT count (*) FROM memberships
		  WHERE project_id = ANY ($1::uuid[]) AND created_at > $2::timestamptz`,
			[]any{projects, now}},
		{"conversations", `SELECT count (*) FROM conversations
		  WHERE project_id = ANY ($1::uuid[]) AND created_at > $2::timestamptz`,
			[]any{projects, now}},
	} {
		if len(q.args[0].([]string)) == 0 {
			continue // nothing of theirs to check
		}
		var n int
		if err := f.pool.QueryRow(testCtx(t), q.sql, q.args...).Scan(&n); err != nil {
			t.Fatalf("clock check %s: %v", q.what, err)
		}
		if n != 0 {
			t.Errorf("%s: %d seeded rows are dated after the supplied clock — a DEFAULT now() "+
				"the seeder never overrode", q.what, n)
		}
	}
}

// cuSeedFingerprint is the whole seeded story as one sorted list of lines: ids
// replaced by the name a reader would recognise, timestamps replaced by their age
// at the supplied clock. Two seeds of the same window at the same clock must
// produce the same text, which is what "deterministic for a fixed now" means at
// the row level rather than at the level of the seeder's own bookkeeping.
func cuSeedFingerprint(t *testing.T, f *cnvFixture, s cuSeeded, now time.Time) []string {
	t.Helper()
	projects := append(s.visibleIDs(), s.secretID())
	age := func(col string) string {
		return "coalesce (round (extract (epoch from ($2::timestamptz - " + col +
			")) / 60)::text, 'none')"
	}
	who := func(col string) string {
		return "CASE WHEN " + col + " = $3::uuid THEN 'reader'" +
			" WHEN " + col + " = $4::uuid THEN 'teammate'" +
			" WHEN " + col + " IS NULL THEN 'none' ELSE 'other' END"
	}
	out := []string{}
	for _, q := range []struct {
		head string
		// who marks a read that names the reader and the teammate ($3, $4);
		// scope marks one whose $1 is the world's own ids rather than its projects.
		who   bool
		scope bool
		sql   string
	}{
		{"run", true, false, `
			SELECT 'run|' || pr.name || '|' || r.title || '|' || r.status || '|' ||
			       ` + age("COALESCE (r.finished_at, r.started_at)") + ` || '|' || ` +
			who("r.triggered_by") + `
			FROM runs r JOIN projects pr ON pr.id = r.project_id
			WHERE r.project_id = ANY ($1::uuid[])`},
		{"node", false, false, `
			SELECT 'node|' || pr.name || '|' || r.title || '|' || ne.node_instance_key || '|' ||
			       ne.status || '|' || coalesce (ne.error_class, 'none') || '|' ||
			       coalesce (ne.outputs::text, 'none') || '|' || ` + age("ne.finished_at") + `
			FROM node_executions ne
			JOIN runs r ON r.id = ne.run_id
			JOIN projects pr ON pr.id = r.project_id
			WHERE r.project_id = ANY ($1::uuid[])`},
		{"approval", true, false, `
			SELECT 'approval|' || pr.name || '|' || a.summary || '|' || a.state || '|' ||
			       ` + who("a.decided_by") + ` || '|' || ` + age("a.created_at") + `
			FROM approval_requests a
			JOIN projects pr ON pr.id = a.project_id
			WHERE a.project_id = ANY ($1::uuid[])`},
		{"item", false, false, `
			SELECT 'item|' || pr.name || '|' || w.title || '|' || w.shape || '|' || w.resolution ||
			       '|' || coalesce (w.refs::text, 'none') || '|' || ` + age("w.updated_at") + `
			FROM catchup_work_items w
			JOIN projects pr ON pr.id = w.project_id
			WHERE w.project_id = ANY ($1::uuid[])`},
		{"tour", false, false, `
			SELECT 'tour|' || pr.name || '|' || w.title || '|v' || tv.version || '|' ||
			       coalesce (tv.stops::text, 'none') || '|' || ` + age("tv.created_at") + `
			FROM catchup_tour_versions tv
			JOIN catchup_work_items w ON w.id = tv.work_item_id
			JOIN projects pr ON pr.id = w.project_id
			WHERE w.project_id = ANY ($1::uuid[])`},
		{"revision", false, true, `
			SELECT 'revision|' || p.display_name || '|' || r.version_label || '|' || r.status ||
			       '|' || ` + age("r.published_at") + `
			FROM pipeline_revisions r JOIN pipelines p ON p.id = r.pipeline_id
			WHERE p.id = ANY ($1::uuid[])`},
		{"profile", false, true, `
			SELECT 'profile|' || ap.name || '|' || ` + age("ap.created_at") + `
			FROM agent_profiles ap WHERE ap.id = ANY ($1::uuid[])`},
		{"member", true, false, `
			SELECT 'member|' || pr.name || '|' ||
			       CASE WHEN m.user_id = $3::uuid THEN 'reader'
			            WHEN m.user_id = $4::uuid THEN 'teammate' ELSE 'newcomer' END || '|' ||
			       m.role || '|' || ` + age("m.created_at") + `
			FROM memberships m
			JOIN projects pr ON pr.id = m.project_id
			JOIN users u ON u.id = m.user_id
			WHERE m.project_id = ANY ($1::uuid[])`},
	} {
		// pgx wants exactly as many arguments as the statement's highest
		// placeholder, so each read carries its own parameter tail.
		var args []any
		if q.scope {
			args = []any{s.world.fingerprintScope(), now}
		} else {
			args = []any{projects, now}
		}
		if q.who {
			args = append(args, s.ReaderID, s.TeammateID)
		}
		rows, err := f.pool.Query(testCtx(t), q.sql, args...)
		if err != nil {
			t.Fatalf("fingerprint %s: %v", q.head, err)
		}
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				rows.Close()
				t.Fatalf("fingerprint %s scan: %v", q.head, err)
			}
			// Fixture names carry the per-run token; blank it so two seeds of one
			// window read as the same story.
			out = append(out, strings.ReplaceAll(line, s.world.token, "<token>"))
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("fingerprint %s: %v", q.head, err)
		}
	}
	sort.Strings(out)
	return out
}

// --- comparison ----------------------------------------------------------

func cuExpectDiff(want, got cuExpect) string {
	var out string
	for _, c := range []struct {
		what      string
		want, got any
	}{
		{"succeeded", want.Succeeded, got.Succeeded},
		{"failed", want.Failed, got.Failed},
		{"cancelled", want.Cancelled, got.Cancelled},
		{"running", want.Running, got.Running},
		{"approvals_pending", want.ApprovalsPending, got.ApprovalsPending},
		{"approvals_decided", want.ApprovalsDecided, got.ApprovalsDecided},
		{"needs_you", want.NeedsYou, got.NeedsYou},
		{"running_now", want.RunningNow, got.RunningNow},
		{"shipped", want.Shipped, got.Shipped},
		{"still_failing", want.StillFailing, got.StillFailing},
		{"fixed", want.Fixed, got.Fixed},
		{"heads_up", want.HeadsUp, got.HeadsUp},
		{"changes", want.Changes, got.Changes},
	} {
		if reflect.DeepEqual(c.want, c.got) {
			continue
		}
		if list, ok := c.want.([]string); ok {
			other, _ := c.got.([]string)
			out += "\n" + cuDiffStrings(c.what, list, other)
			continue
		}
		out += fmt.Sprintf("\n%s: want %v, got %v", c.what, c.want, c.got)
	}
	return out
}

// cuDiffStrings reports two sorted lists' differences element by element, which
// reads better in a failure log than a %v of a hundred titles.
func cuDiffStrings(what string, want, got []string) string {
	out := ""
	if len(want) != len(got) {
		out += fmt.Sprintf("\n%s: %d wanted, %d got", what, len(want), len(got))
	}
	for i := range want {
		switch {
		case i >= len(got):
			out += fmt.Sprintf("\n%s[%d]: want %q, got nothing", what, i, want[i])
		case want[i] != got[i]:
			out += fmt.Sprintf("\n%s[%d]: want %q, got %q", what, i, want[i], got[i])
		}
	}
	for i := len(want); i < len(got); i++ {
		out += fmt.Sprintf("\n%s[%d]: want nothing, got %q", what, i, got[i])
	}
	return out
}

// --- the five windows ----------------------------------------------------

func TestCatchUpSeed15m(t *testing.T) { cuSeedScenario(t, cuWindow15m) }
func TestCatchUpSeed1h(t *testing.T)  { cuSeedScenario(t, cuWindow1h) }
func TestCatchUpSeed1d(t *testing.T)  { cuSeedScenario(t, cuWindow1d) }
func TestCatchUpSeed3d(t *testing.T)  { cuSeedScenario(t, cuWindow3d) }
func TestCatchUpSeed7d(t *testing.T)  { cuSeedScenario(t, cuWindow7d) }
