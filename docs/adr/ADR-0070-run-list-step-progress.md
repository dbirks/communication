# ADR-0070 — The project run list carries a bounded step progress (`RunProgress`) for the 5-segment strip

- **Date:** 2026-10-30
- **Status:** Accepted (implemented and verified on real PostgreSQL — see Verification)
- **Owners:** control-plane API + store maintainers
- **Related decisions / contracts:** ADR-0047 (the cross-project board's seven-state `steps`, same derivation rule), ADR-0063 (bounded database work: one set-based statement per page, never N+1), ADR-0023 § 2 (the run pins `plan_snapshot` at creation — the definition-order authority), `communication-spec/09` (run list rows), `docs/design/handoff-repo-chat-nav` (artboards 3a/3b: the 5-segment progress strip under each running run)

## Context

The repo page's run rows draw a 5-segment progress strip (done / running /
open, `ds/ProgressStrip.tsx`) under each running run's title. The project
runs list (`GET /api/v1/projects/{projectId}/runs` → `useProjectRuns`) served
no per-step state, so the UI omitted the strip — and the brief is explicit:
do not invent progress. The data exists: every run pins its `plan_snapshot`
(the compiler appends root-scope nodes in definition order), and
`node_executions` rows carry each top-level step's status. ADR-0047 already
solves this shape for the *cross-project* board (`steps`, seven states, one
set-based query per page); the project list had nothing, and the strip wants
a coarser five-state vocabulary bounded per row (a 20-node plan must not
sprawl across a list row).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A: derive onto the list read — one `run_id = ANY(...)` statement per page, projected in Go from the pinned plan (chosen)** | nothing stored twice (the plan and the node rows stay the only authorities); one query regardless of page size, riding `node_executions_run_scope_idx`; the definition order is the pinned plan's, not the row materialization order; a node with no row yet reads `open`, so a queued run's strip is honestly all-open | every list page pays one extra statement; the cap is a read-side rule, not a stored fact | implemented; `TestM4RunsListProgress*` (five scenarios + a QueryTracer proving exactly one `node_executions` statement per call) |
| B: reuse ADR-0047's seven-state `steps` verbatim on the project list | one vocabulary | the strip is five states (skipped/interrupted/cancelled fold, ready/leased fold); an uncapped array breaks the 5-segment design; and `steps` would then ride a schema the board owns, drifting the two surfaces | CrossProjectRunStep's enum has no `done`/`open` |
| C: a `runs.progress` column maintained by the advancer | the read is free | a second copy of a fact the node rows already own — every node transition must maintain it or the strip rots; the advancer already writes journal events per transition, a denormalized counter is exactly the double-bookkeeping ADR-0065 rejected | ADR-0065 Options B ("nothing stored twice") |
| D: one LATERAL per run inside the runs query | single statement total | couples the runs list SQL to the plan projection and re-materializes the aggregate per row on a plan-less read; the page-wide `ANY` read is simpler and provably one statement | the existing `xpRunSteps` precedent |

## Decision

`RunSummaryList.runs` items become `RunListRow`: the existing `RunSummary`
plus a **required** `progress` member (`RunProgress`):

```
progress: { steps: [{node_id, state}], more: int }   // steps ≤ 12
state ∈ done | running | waiting | failed | open
```

1. **Five coarse states**, folded from the node execution statuses by the
   store read: `succeeded`/`skipped` → `done` (settled, nothing asks for
   attention), `leased`/`running` → `running`, `waiting` → `waiting`,
   `failed`/`interrupted`/`cancelled` → `failed` (a stop that did not
   complete), `pending`/`ready` (and a planned node with no execution row
   yet) → `open`. A node with several execution rows (a loop) takes the
   state that most needs attention: failed > running > waiting > done >
   open — the ADR-0047 precedence folded to five.
2. **Definition order, top-level only, bounded:** the steps are the pinned
   plan's root-scope (`scope: "/"`) nodes in document order — loop body
   nodes never surface, the loop's own row carries the loop's fate — capped
   at **12**; `more` counts the steps beyond the cap. A plan snapshot that
   does not decode answers `steps: []`, `more: 0`: no fabricated segment,
   the run row still lists (same rule as `xpProjectSteps`).
3. **One set-based read:** the list reuses `xpRunSteps` —
   `WHERE run_id = ANY($1) AND scope_key = '/'` over the whole page, one
   statement per list call (ADR-0063). A skipped entirely on an empty page.
4. **The member rides the project list row only.** `progress` is a
   nullable `omitempty` field on the Go `RunSummaryView`, and openapi adds
   `RunListRow` (allOf `RunSummary` + `progress`) as *RunSummaryList's item
   schema* — `RunSummary`, `Run` and `CrossProjectRunSummary` are
   untouched, so the run detail, the tree and the board serialize without
   it (the board keeps ADR-0047's finer `steps`). Pinning the omission is
   contractual: `TestRunListProgressContract` asserts the list body carries
   `progress` and the run-detail body does not.
5. **No migration, no new index**: `node_executions_run_scope_idx`
   (00005) is the seek; `runs.plan_snapshot` is already scanned by the list
   read.

## Consequences

- The strip renders from the list row alone — no per-run node fetch, and a
  queued run honestly shows all-open.
- `progress` values describe the pinned plan, so a retry/replay of the same
  run never changes the segment count, only the states.
- The coarse fold loses `skipped` vs `succeeded` and `cancelled` vs
  `failed`; that is the strip's need, and the run detail's node route
  remains the fine-grained authority (ADR-0043's workbench is unaffected).
- One extra statement per project-runs page is the whole cost; the page has
  no pagination in M4, so the statement's row count grows with the page
  like ADR-0047's already does.
- Backwards compatible: an additive member on one response schema; no wire,
  event or persistence change; clients that ignore it are unaffected.

## Security/privacy

`node_id` is the plan's own node name — already served by
`GET /runs/{id}/nodes` to the same Viewer+ caller — and `state` is derived
from node statuses the run's event stream already emits. No new secret,
path, worker identity or lease fact rides the row; the read keeps the
project-membership gate (`m4RunReadProjectScope`) unchanged, so a
non-member still gets the project 404 before any step is named.

## Verification

Real PostgreSQL (`COMMUNICATION_TEST_DATABASE_URL`,
`postgres://ci@127.0.0.1:55432/ci`), 2026-10-30:

```
--- PASS: TestM4RunsListProgressMidwayRun      done/running/open on a mid-way run, loop-body node absent
--- PASS: TestM4RunsListProgressFinishedRun    all-succeeded (+skipped) run reads all-done
--- PASS: TestM4RunsListProgressFailedRun      the failing step is failed; later steps stay open
--- PASS: TestM4RunsListProgressCap            15 planned steps → 12 shown in order, more=3
--- PASS: TestM4RunsListProgressOneQuery       3 runs, 1 list call: exactly ONE node_executions statement, run_id = ANY(...) (pgx QueryTracer)
--- PASS: TestM4RunsListProgressEmptyPlan      {"nodes":[]} → steps=[] more=0, never null
--- PASS: TestRunListProgressContract          the list body carries progress (states, more); the run-detail body omits the member entirely
```

Plus `go build ./...`, `go vet ./internal/...`, the full
`go test -p 1 ./internal/api/... ./internal/store/postgres/...` suites,
`redocly lint api/openapi.yaml` (0 errors) and `pnpm --dir ui gen:api:check`.

## Migration/rollback

No migration, no backfill, no index — the read rides columns it already
selects. Rollback is a straight revert of the code + schema commit: the
field disappears from the one response it was added to, and no stored fact
was ever written for it, so nothing can drift left behind.
