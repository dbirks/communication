# ADR-0064 — A run serves a title and its repository; a hand-started issue run links to its issue

- **Date:** 2026-10-25
- **Status:** Accepted (runs.title + RunCreate.title/issue + RunSummary title/repository fields)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0013 (forward-only migrations), ADR-0023 (§ 2 a run pins its facts at creation, § 12 idempotency), ADR-0031 (read-only GitHub adapter), ADR-0053 (`RunCreate.source`, thread titles), ADR-0056 (`trigger_kind`/`trigger_ref`, the issue-polling fire), ADR-0060 (`runs.repository_id`, repo-scoped assignments), ADR-0061 (per-repository GitHub credential), ADR-0047 (cross-project run rows), migrations `00003` (the 1..200 title bound), `00015`, `00020`, `communication-spec/09` (API resources), the Projects Review handoff (`docs/design/handoff-projects/`, artboards 1b/1e)

## Context

The Projects Review screens show every run by a human title ("Add saved cards to
checkout") and its repository. `RunSummary` served neither, so `RunningNow`,
`ProjectRuns` and the Repository page's rows could only say "workflow name +
short id — repository not served". Two gaps compounded it:

1. `runs.repository_id` (ADR-0060) exists and every create path resolves it,
   but the project run list schema never documented `repository_id` /
   `repository_name`, and the cross-project rows (ADR-0047) never selected them.
2. No run ever carried a title. And a run started by hand from the Repository
   page's OPEN ISSUES row recorded `trigger.kind = manual` with no ref, so the
   issue row could not show "run in progress" for its own hand-started run —
   only trigger-fired issue runs (`trigger.ref = owner/repo#n`) linked back.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A: nullable `runs.title` written in the creating transaction from the fact that named the run (issue title / thread title / caller's `RunCreate.title`), null otherwise; `RunCreate.issue {number}` records the trigger-fired issue run's own `{kind: issue, ref}` fact | no invented data (null is the honest answer for a nameless run); the issue row's "run in progress" needs no new matching rule — the ADR-0056 ref grammar already answers it; one column, forward-only | old rows stay null and the UI keeps its fallback; a >200-char GitHub title (up to 259) must be bounded | migration `00020`, `fireIssue` (issue_triggers.go), ADR-0056 § 5 |
| B: derive the title at read time (join issue_triggers / conversations per row, or paraphrase `pipeline_display_name`) | no migration | re-resolves what the run should have pinned (ADR-0023 § 2); the join answers nothing for a schedule fire or a renamed/closed issue; a paraphrase is an invented title — forbidden by the design's honesty rule | ADR-0047's "human names, not bare ids" rule exists because reads must not chase definitions |
| C: a separate `run_titles` table keyed by run | leaves `runs` untouched | a second source of truth for one immutable string; every run read gains a join | migration `00011`'s single-column precedent |

## Decision

1. **Migration `00020_run_title_repository.sql`**: nullable `runs.title text`
   with `CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200)` — the same
   width `conversations.title` carries (`00003`). **No backfill**: a run that
   was never named has no title to recover, and inventing one from the
   workflow name would put words on a row that never carried them.
   `runs.repository_id` is NOT re-added — it already exists (`00015`,
   ADR-0060); this ADR only makes it and its display name readable on the API.
2. **The title is written in the creating transaction**, from whichever fact
   named the run at that moment, in this precedence:
   - issue-trigger fire → the GitHub issue title the poll already fetched to
     render the inputs (`fireIssue`);
   - hand start with `issue` → `RunCreate.title` if given, else the issue's
     own title when the server can read it (best-effort, see 4), else null;
   - thread start (`RunCreate.source`) → the conversation's own title
     (`conversations.title`, NOT NULL 1..200);
   - direct/manual start → `RunCreate.title` when given, else null;
   - schedule fire → null: schedules have no `name` column today (ADR-0032),
     and there is nothing honest to record. If a name lands later, the fire
     path is the one line to change.
   A derived title longer than the column bound (GitHub allows 259 characters)
   is truncated to 200 characters on the rune boundary by the create itself
   (`clampRunTitle`) — losing the run over the length of its banner is worse
   than a clipped banner, and the clipping is documented, not hidden.
   The title is pinned at creation and never re-resolved (ADR-0023 § 2): a
   renamed issue does not retitle its runs.
3. **`RunCreate` gains two optional members** (`api/openapi.yaml`):
   - `title` (string, 1..200; empty or over-long is `400`);
   - `issue` `{number: integer ≥ 1}` — valid **only** with `assignment_id` on
     a **repo-scoped** assignment whose repository is a GitHub remote. Any
     other claim is `422` with code `issue_requires_repo_assignment` or
     `issue_requires_github_repository` (never a silently dropped member: a
     run that quietly lost its issue link could not be found by its issue
     row). With a valid `issue` the run records the trigger fact a fire
     records — `trigger_kind = 'issue'`, `trigger_ref = 'owner/repo#<number>'`
     (the `owner/repo` parsed from the assignment repository's `git_url`, the
     adapter's canonical form) — with `trigger_id` NULL: no `issue_triggers`
     row fired this. The run's repository is the assignment's.
4. **The server-side issue-title default is best-effort and fails silent**:
   mounted via `RegisterRuns`' `WithGitHubIssueReader` seam (the ADR-0031
   lister + the ADR-0061 broker). No adapter mounted, a credential that cannot
   be resolved, any upstream refusal/timeout/rate-limit, or the issue simply
   not on the listed page ⇒ the title stays null and the run still starts.
   The UI, which already read the issue to offer the run, sends `title`
   explicitly; the server read is the fallback for API-only clients.
5. **The API**: `RunSummary` (and therefore `Run`, `CrossProjectRunSummary` —
   both extend it) gains `title: string|null`, `repository_id: uuid|null`,
   `repository_name: string|null`. The cross-project page resolves the page's
   repository names in one extra statement per page, only when a row names a
   repository. UI rows render `title ?? workflow display name` and the
   repository segment from `repository_name` — with the pre-existing honest
   fallbacks wherever a field is null (old rows keep the old rendering; this
   is the point of 1, not a defect of it).

## Consequences

- Positive: every screen named in the Projects Review can show the run's own
  title and repository from the list row, no extra fetch; the issue row shows
  "run in progress" for hand-started issue runs with **zero** new matching
  rules — the ADR-0056 ref pair the design already reads now covers them too.
- `trigger_kind = 'issue'` no longer implies a trigger row: readers must not
  join `issue_triggers` on every issue run (the `trigger_id` column already
  distinguishes them; ADR-0062's agent-turn author read only follows
  `trigger_id`, which stays NULL here).
- Idempotent replay semantics are unchanged: the title rides the same
  `RequestSHA`-checked body, so same key + same body returns the stored run
  with the stored title.
- The shared lab needs a rebuild to serve the new fields; against an old build
  the UI renders the fallback, which is the designed behaviour, not a defect.

## Security/privacy

- The issue title comes from the same read the issue list already performs
  (per-repository ADR-0061 credential or anonymous); no new egress, no token
  in any stored field, no URL that could carry one.
- `issue` validation discloses nothing: the assignment and the repository are
  resolved through the caller's own visibility-scoped reads; a foreign
  repository is the same refusal `invalid_repository` already gives.
- Titles are user/issue prose: stored as text, rendered escaped by the UI,
  never evaluated; the 200-char bound caps blast radius in every list row.

## Verification

- Real-PostgreSQL store tests: `internal/store/postgres/runs_title_test.go`
  (title sources: manual `RunCreate.title`, thread → conversation title,
  issue fire → issue title with the 200-char clamp, hand issue start → trigger
  pair + repository; no-title rows stay null; `RunView`/summary projection).
- Handler tests: `internal/api/runs_issue_test.go` (400 title shapes, 422
  `issue_requires_repo_assignment` / `issue_requires_github_repository` /
  repository conflict, the 201 body and `GET /run` echo of title/repository,
  best-effort title read with a fake lister and its silent failures).
- `pnpm --dir ui gen:api:check` regenerates and pins the UI types; UI tests
  render title, repository and the null fallbacks (`RunningNow`,
  `ProjectRuns`, Repository rows, `IssueRunExpansion`).

## Migration/rollback

`00020_run_title_repository.sql` is forward-only (Down exists for test resets
only, per ADR-0013). Reverting the code without reverting the column is safe:
`title` is nullable and simply unread. Reverting the column while the code
serves null titles is equally safe. No backfill ever runs; old rows keep
answering "not named" honestly.
