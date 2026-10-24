# Approval-gate file changes — design for the "FILES IT WILL TOUCH" section

Status: design, awaiting product decision (2026-10-22)

- **Task:** `files-design` — design only. No Go, no TypeScript, no migration file, no UI edit.
- **Area:** app-shell redesign artboard 4g (`docs/design/handoff-app-shell/README.md:129-131`),
  gap register `docs/design/handoff-app-shell/gaps/inbox-ops.md` (§1, §3 gap row, §5 honest states).
- **Status:** design record; the implementation follow-on is a separate change.

## The ask

At a human approval gate the approver must see which files the agent's work changed (or, before any
attempt, which files a plan will touch) so the approval covers real material. Today the 4g surface
answers "not available yet": `ui/src/pages/Approval.tsx:6` ("not available yet for the files the plan
will touch (no diff/manifest API)") and `FilesItWillTouch` (`ui/src/pages/Approval.tsx:461-475`).

## Findings (path:line)

1. **The durable boundary already exists and already carries paths.** Worker boundary capture
   (`internal/worker/unit_capture.go:171-260`, `Capture`/`captureArtifact`) reads
   `git status --porcelain=v1 --untracked-files=all` plus `git diff --stat` through the
   `BoundaryGit` seam (`internal/workspace/git/workspace.go:712-762`, `Summary` at 756-760) and
   writes the boundary into `run_checkpoints` (`internal/store/postgres/attempts.go:862-935`,
   `NewCheckpoint`; table in migration `00005_m4_pipelines.sql:317-332`) inside the attempt-completion
   fence transaction (`internal/store/postgres/attempt_worker.go:560-650`).
2. **The record carries commits, not per-file diffstat.** The journal/checkpoint shape
   (`internal/events/events.go:1382-1400`, `Checkpoint`/`RepoState`) and the runtime mirror
   (`internal/pipelines/runtime/state.go:955-975`) carry `base_commit`/`head_commit` plus
   `modified_paths_artifact`, `modified_path_count` and `committed` — paths are known (as a
   manifest), added/deleted line counts are not, and content never is. `Summary.Diff`
   (`git diff --stat`) is computed at capture but not persisted.
3. **Worker knows, API replicas do not.** Checkpoints are written by the worker (worker volume);
   API replicas read them through the run-workspace resolver
   (`internal/store/postgres/run_workspace.go:236-264`) and join gates
   (`internal/store/postgres/m4api_approvals.go:690-723`; `approval_requests` UNIQUE per node
   execution, migration `00005_m4_pipelines.sql:337-370`).
4. **A first-time gate opens with no attempt at all.** `human.approval` → `openGate`
   (`internal/pipelines/runtime/advancer.go:795-860`) runs from the node row before any attempt; a
   retry re-arms the same node execution's gate (`internal/pipelines/runtime/retry.go`).

## Options considered

| Option | Advantages | Disadvantages |
|---|---|---|
| A. Worker records `git diff --numstat <base>..HEAD` + untracked into the checkpoint row at node completion | authoritative (same read that produced the manifest), structured, lands in the existing fence transaction | new persisted state → ADR; untracked-file accounting + cap policy |
| B. Parse the plan artifact (`plan.md`) for file paths | available pre-attempt | prose parsing is unreliable; the gate may open before any attempt exists |
| C. Per-tool-event file paths from the transcript | richer per-call attribution | `conversation.tool.call` carries only a redacted bounded `InputPreview` (`internal/events/events.go:476-491`, `internal/worker/sink.go:129-145`); `ui/src/api/transcript.ts:121-126` already refuses to diffstat from prose ("no event or API field carries added/removed line counts… a guess dressed as data") |

## Recommendation

Adopt **A** as the source of truth, keeping the honest states elsewhere.

- The gate-time answer comes from the node execution's durable boundary checkpoint — the same row the
  retry machinery already trusts — enriched with a per-repo change-set.
- A first-time gate (no attempt yet) keeps `changes: null` and the honest empty state; a plan-only
  pre-attempt view is out of scope for this design.

## Exact schema

Draft migration `00016_approval_gate_changes.sql` (next free number after `00014_*`):

```sql
ALTER TABLE run_checkpoints
    ADD COLUMN changes jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Change-set shape (per repository; the flat shape below is the single-repo instance, extended to a
list on fan-out):

```json
{
  "repository_id": "…",
  "base_commit": "…",
  "head_commit": "…",
  "files": [ { "path": "src/app.ts", "status": "modified", "added": 12, "deleted": 3 } ],
  "truncated": false
}
```

Caps: ≤ 256 files per change-set, path ≤ 1024 bytes, `added`/`deleted` integers, change-set ≤ 64 KiB;
the worker sets `truncated` when the change-set is cut. The new column keeps the published `repo_states`
wire shape (`CheckpointRepoState`) untouched — its json keys are the published shape and must not grow
path fields (`internal/worker/procexec.go:49-60`).

## Event / API shape

`GET /api/v1/approvals/{approvalId}` gains on the `Approval` schema:

```json
"changes": {
  "repository_id": "…",
  "files": [ { "path": "…", "status": "added|modified|deleted", "added": 3, "deleted": 1 } ],
  "truncated": false,
  "base_commit": "…",
  "head_commit": "…"
} | null
```

- `null` when no boundary/checkpoint exists for the gate's node execution (first-time gate, or a run
  that never completed a node).
- Derived in the approval read's existing join (approval → run → node execution → checkpoint); no
  second join path.

## UI behaviour

- `changes` non-null → render the list: mono path, status chip, `+N −M`, sorted.
- `changes` null → keep the honest empty state; refine copy for the no-attempt case (no attempt has
  run yet).

## Security

- Paths only, never content; checkout-relative, no absolute or `..` paths (the worker already refuses
  `..` at the capture read seam).
- Re-apply the declared exclusion set before writing (ADR-0017 D6) so secret-file names never surface.
- Caps and redaction discipline; no diff content in the journal.

## Tests

Worker capture seam (numstat + untracked + cap), store read (change-set decode, null case), API
approval (tenant visibility, null derivation), UI (list / empty / decided).

## ADR appendix — ADR-0057 (Proposed)

Draft text for `docs/adr/ADR-0057-approval-gate-file-changes.md`:

- **Date:** 2026-10-21. **Status:** Proposed (design record; the decision is to add the change-set).
- **Owners:** pipeline runtime + API + UI.
- **Related decisions / contracts:** ADR-0023 §6 (durable boundaries / fence), ADR-0017 D8 (capture),
  ADR-0020 D8 (checkpoint artifact), ADR-0016 (lease/authorization), `communication-spec/09-api-events_data.md`
  (event/approval vocabulary), design brief `docs/design/handoff-app-shell/`, gap
  `docs/design/handoff-app-shell/gaps/inbox-ops.md`.

**Context.** The 4g approval detail must show what a gate approves. The durable boundary
(`run_checkpoints`) already records commits and modified paths but no per-file diffstat; the worker is
the only side that can run git, while API replicas must not read worktrees — so the change-set has to be
materialized worker-side at node completion, inside the existing fence transaction.

**Options.** A (worker numstat at boundary), B (plan artifact), C (tool-event paths).

**Decision.** Adopt A: add `run_checkpoints.changes` (jsonb, default `'[]'::jsonb`), written by the
worker at node completion, and expose `changes` on `GET /approvals/{approvalId}` (`{files,
truncated, base_commit, head_commit} | null`). First-time gates answer `null`.

**Consequences.** Positive: the approver sees real, captured material. Negative: one new persisted
column; untracked-file accounting; cap policy.

**Security/privacy.** Paths only, never content, exclusions re-applied, caps.

**Verification.** Worker capture seam tests, store/API tests, UI tests; real-git evidence required.

**Migration/rollback.** `00016_approval_gate_changes.sql`; rollback drops the column.
