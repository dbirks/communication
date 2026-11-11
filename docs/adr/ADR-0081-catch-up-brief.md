# ADR-0081: Catch-up brief, a deterministic "what you missed" with a model-written headline

- **Date:** 2026-11-11
- **Status:** Proposed
- **Owners:** project owner (design), orchestrator
- **Related decisions / contracts:** ADR-0078 (catch-up work items and tours), ADR-0034 (assistant egress),
  ADR-0079 (decision model), `docs/research/2026-11-catch-up-audit.md`

## Context
The Catch up page answers "I was away; what do I need to know?" Today the page has two parts:

- **Per-run tours** (ADR-0078). These are good at telling one run's story.
- **A recap of two or three sentences.** The model writes it from tour **titles only**
  (`catchup_recap.go:273`).

The audit (§5) checked the recap's input against what a returning person needs. Most of it is missing:

- Real **approvals waiting on me** are never in the input.
- **Running now** is missing, because tour candidates are terminal runs only.
- There are no **merges or commits**, and no **workflow, agent or settings changes**.
- There are no **numbers**.
- A failure that is **still failing** cannot be told apart from one that was fixed.
- The smallest window is 6h. "The last few minutes" cannot be asked for.

The chat assistant can't answer "what did I miss" either: no tool takes a time window or reads across projects
(audit §4).

The fix is not a longer prompt. The facts a returning person needs are mostly *lists the server already knows*:
pending approvals, failed runs, merged PRs and published revisions. A model should not choose which items belong
in them. It should write the one thing a list can't give: the shape of the story.

## Options considered
| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Richer prompt over the same tour-title block | small change | still can't see approvals, running work, changes or numbers; the model picks what is important | audit §5 |
| B. Model writes the whole brief from a large DATA block | flexible prose | invented or dropped items, unbounded cost on 7-day windows, and nothing to show when the model is down | ADR-0078's "a fake narrative is worse than none" |
| **C. Deterministic sections plus a short model headline that cites them** | correct by construction, renders without a model, the same data serves the page and chat, cheap to cache | two code paths (assembler and generator) | this ADR |

## Decision
Option C.

### Windows
The vocabulary becomes `15m | 1h | 6h | 24h | 2d | 7d | unseen`. 15m covers "the last few minutes".

- The `unseen` window starts at the reader's last catch-up visit. If there is no visit, it starts 7d ago.
- The page's chips show all seven windows. The suggested chip keeps the existing median-gap rule, extended
  downwards: a gap under 2h suggests `1h`, and a gap under 30m suggests `15m`.

### `GET /api/v1/catch-up/brief?window=<w>[&projects=<id,...>]`
Every list is scoped to the caller's member projects, using the same authorization as `run.list` and
`approval.pending`. Response:

```json
{
  "window": {"key": "24h", "since": "RFC3339", "until": "RFC3339"},
  "headline": {"text": "…", "state": "ready|pending|unavailable"},
  "needs_you": [{"kind": "approval|question|failed_run", "title": "…", "project": {"id": "…", "name": "…"}, "link": "/approvals/…", "at": "RFC3339", "detail": "…"}],
  "running_now": [{"run_id": "…", "title": "…", "project": {…}, "started_at": "…", "step": "implement", "link": "/runs/…"}],
  "shipped": [{"kind": "pr|commit|workflow_revision", "title": "…", "project": {…}, "ref": {"number": 42, "url": "…", "sha": "abc1234"}, "by": "…", "at": "…", "link": "…"}],
  "broke": [{"title": "<pipeline or work title>", "project": {…}, "failures": 3, "error_class": "test|infra|…", "still_failing": true, "fixed_at": null, "link": "…"}],
  "heads_up": [{"signal": "migration|auth|deps|push_to_main|skipped_test|public_api", "title": "…", "project": {…}, "link": "…"}],
  "changes": [{"kind": "workflow_published|profile_created|profile_updated|member_added", "title": "…", "by": "…", "at": "…", "link": "…"}],
  "numbers": {"runs": {"succeeded": 0, "failed": 0, "cancelled": 0, "running": 0}, "approvals": {"decided": 0, "pending": 0}, "threads_active": 0, "prs": 0, "commits": 0},
  "by_project": [{"project": {…}, "line": "…"}],
  "omitted": {"shipped": 4}
}
```

What goes in each section:

- **needs_you** holds pending approvals the caller may decide, tour beats with `asks: true` addressed to the
  caller, and runs the caller started whose newest attempt failed with no later success of the same pipeline in
  the same project. It is sorted oldest first, because the longest-waiting item goes first.
- **broke** groups failed runs in the window by (project, pipeline). `still_failing` means the newest run of
  that pipeline is failed. Otherwise `fixed_at` is when the first later run succeeded.
- **shipped** is read from run-node outputs (`pr_url`, `pr_number`, `commit_sha`, `branch`), using the same
  harvest as `catch_up_gen.go:792`, plus pipeline revisions published in the window. A ref is "labelled data,
  not reconciled state", so the UI says "opened" for a PR URL and never "merged", unless a tour's resolution
  says merged.
- **heads_up** applies the existing must-know signal rules (`catchUpImportanceSignals`) to the window's runs and
  items, and lists each signal once per item.
- **changes** lists pipeline revisions published, agent profiles created or updated, and project members added,
  each with its actor.
- **Caps** depend on the window: 5 rows per section for 1h or less, 8 for 6h and 24h, and 10 for 2d and 7d.
  The remainder is counted in `omitted`, and the UI shows "and N more".

### The model's job (headline and by_project)
The model is given the brief that was **actually assembled**. Every row has a citation id (B1, B2, …). The model
writes:

- `headline`: at most two sentences and 280 characters. It says what changed that affects what the reader does
  next. Its priority order is owed > broken > shipped > risky > routine. It uses counts and exact quoted titles
  instead of adjectives, with no greeting and no advice beyond what to open first.
- `by_project`: one line of at most 140 characters per project. It is produced only when the window is 24h or
  longer and two or more projects have activity.

The existing truth-set check (`validateCatchUpRecapNames`) applies: a quoted name not in the brief fails the
generation. The data stays fenced as untrusted DATA (ADR-0034).

The headline is generated asynchronously and cached per (user, window, brief digest) for 5 minutes.

- **Model not configured or failing:** the headline state is `unavailable` and the page renders the sections
  alone. Sections never wait on the model.
- **Prompt and rubric:** both live in `internal/assistant/catchup_brief.go`.
- **The old recap:** `POST /catch-up/recap` stays during migration and is removed once the page reads the brief.

### Chat tools
- **`catchup.brief {window}`** returns the same JSON without a headline, so the chat model narrates from the
  same facts.
- **`run.list`:** `project_id` becomes optional, so it reads across the caller's projects. It gains `since`
  (RFC3339 or a window key) and `status`.
- **`approval.pending`:** `project_id` becomes optional.

### Evaluation
- **Deterministic tests.** A Postgres seeder builds five realistic histories: 15m, 1h, 1d, 3d and 7d.
  - Integration tests assert each section's membership.
  - A golden JSON snapshot covers each window's brief, with timestamps normalised.
- **Usefulness eval.** It is gated by `COMMUNICATION_EVAL_BASE_URL`, `COMMUNICATION_EVAL_MODEL` and
  `COMMUNICATION_EVAL_API_KEY_FILE`, so CI skips it without them.
  - For each fixture it generates a headline with the real model.
  - A judge model then scores it 1 to 5 against a fixed rubric:
    - names every needs-you item, or the count;
    - mentions anything still failing;
    - invents nothing;
    - leads with the most important thing;
    - respects the length limit.
  - It passes at a mean of 4.0 or more, with no rubric item at 1.
  - Results go to `docs/testing/catch-up-eval.md` with the model, date and scores.

## Consequences
- The page is useful without a model, and correct when one is present.
- One assembler serves the page and chat, so the two never disagree.
- More reads per brief, but each is one indexed query per section, scoped by membership and the window.
- PR state is still not reconciled with GitHub. That is a future integration and outside this ADR.

## Security/privacy
- **Authorization:** every section reads through membership-scoped store calls. A project the caller is not in
  contributes nothing, including to `numbers`.
- **Model egress:** the generator sends the brief through the ADR-0034 broker with secret scanning. Titles are
  untrusted data, and the same injection fence applies.
- **No new secrets.**

## Verification
- `internal/store/postgres/catchupseed`: seeded histories and per-window integration tests.
- `internal/api/catch_up_brief_test.go`: route shape and authorization (a non-member sees nothing).
- `internal/assistant/catchup_brief_test.go`: prompt contents, truth-set rejection and the unavailable path.
- The eval run recorded in `docs/testing/catch-up-eval.md`.

## Migration/rollback
The change is additive: a new route, new tools and new window keys. The page swaps its recap for the brief.
Rollback reverts the UI commit, and the old recap route is still there until it is removed.
