# ADR-0037 — `POST /runs/{runId}/retry` names an unknown node execution as `404 node-execution-not-found`

- **Date:** 2026-10-16 · **Status:** Accepted · **Owners:** control-plane contributors
- **Related:** ADR-0014 (problem+json conventions, stable codes), ADR-0023 (runs, attempts, retry),
  ADR-0024 (route 31's retry semantics); `docs/m4-contract.md` route 31, `09-api-events-data.md`;
  the live evidence in `docs/m4-exit-status.md` C5e/C6d (`live8/C6.out:61-62, :66` @ 522a82b)

## Context

The M4 lab retried a run with a target that the run did not have — `live8/C6.out:66`: a
`POST /runs/{id}/retry` whose `workspacePolicy` named `/implement` while the kill had landed on
`/plan`, so no node execution of that run carried the key. The server answered **`500`**
`about:blank` "The server could not complete the request" (`docs/m4-exit-status.md` C5e, C6d —
the arms that ran on the refusal path passed: nothing reset, zero `run.checkpoint_restored`, no
appended attempt — but the status code was a lie, and C6d additionally lost its problem+json
code). Cause: `runtime.RetryPlan`/`MemStore.Retry` returned a bare `fmt.Errorf("runtime: no node
execution …")`, which the store cannot distinguish from a real failure, so it fell through to the
generic 500. Asking the server to act on a row that does not exist in the run you addressed is a
**client error**, and the public API surface needs a decision record before it changes shape
(`AGENTS.md`: public API changes require an ADR).

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| Keep `500` | zero work | blames the server for the client's typo; unretriable-looking by convention; C5e/C6d stay FAIL | `live8/C6.out:61-62, :66` |
| `409` (reuse the conflict family) | one refusal bucket | `409` means "the resource exists, the state forbids it" — that is exactly what `run_not_retriable` (terminal-successful/`running` run) and `checkpoint_unavailable` already mean; collapsing "no such row" into it destroys the distinction | route 31's current `409` arms |
| **`404 node-execution-not-found`** (chosen) | the addressed row does not exist — the honest status; stable code per ADR-0014; `node_instance_key` in the body points at the offending input; the run-invisibility `404 not-found` arm keeps its shape | one more problem type on a route that already declared a plain `404` | `internal/api/m4routes_test.go` `TestM4RetryUnknownNodeIsNotFound` |

## Decision

1. **Runtime** (`internal/pipelines/runtime/retry.go`): the unknown-target error becomes the
   typed `ErrNodeExecutionNotFound{InstanceKey, RunID}`, returned by `RetryPlan` and by retry
   target validation — never a bare `fmt.Errorf`, so the store can tell a client mistake from a
   store failure. Targets are validated **before** any row moves (validate-then-mutate is already
   the engine's order); the whole reopen is refused and nothing resets.
2. **API** (`internal/api/runs.go`): `NodeExecutionNotFound{NodeInstanceKey}` (unwrapping the
   sentinel `ErrNodeExecutionNotFound`, which stores that cannot name the key may return alone)
   renders `404 application/problem+json`, type
   `https://communication.dev/errors/node-execution-not-found`, title "No Such Node Execution",
   plus a `node_instance_key` field carrying the key the client sent, and a detail pointing at
   `GET /api/v1/runs/{runId}/nodes` for legal targets.
3. **Why 404 and not 409:** `409` stays reserved for "the row exists but its state forbids the
   retry" — `run_not_retriable` on a terminal-successful or `running` run, and
   `checkpoint_unavailable` — while `404` says "there is no such node execution of this run".
   Route 31's `404` arm keeps both shapes with the same status: plain `not-found` when the **run**
   is missing or invisible (no resource named — W9's non-disclosure rule), and
   `node-execution-not-found` only after the run has been resolved and authorized.
4. **OpenAPI** (`api/openapi.yaml`): the new `RunRetryNotFound` response documents the two arms
   with examples; no other route, status, or field changes. No event is added — a refused retry
   appends nothing.

## Consequences

The C5e/C6d retry arms read `404` with a machine-stable code on the next lab pass instead of
`500` (live rerun pending in the exit-status ledger); no schema or migration change; strictly a
500→4xx correction on a route whose `404` was already declared, so no client that honored the
contract breaks. Clients get an actionable error (the named key + where to list valid ones) and
`409` retains its "exists but forbidden" meaning.

## Security/privacy

The echoed `node_instance_key` is the caller's own request input, so naming it discloses nothing
— unlike the run-level `404`, which stays anonymous per W9 (a caller who cannot see the run learns
only "No such run"). Fail-closed unchanged: refusal happens before any row moves, appends no
`run.retried`, and nudges no advancer (asserted in the API test).

## Verification

- Observed live failure: `docs/m4-exit-status.md` C5e/C6d — `live8/C6.out:61-62, :66` (500
  `about:blank`, empty code) on pass 8 @ 522a82b.
- `go test ./internal/api/ -run TestM4RetryUnknownNodeIsNotFound` — PASS: 404, type suffix
  `node-execution-not-found`, body names the sent key, zero advancer nudges; the bare sentinel
  maps the same way.
- `go test ./internal/pipelines/runtime/ -run TestRetry` — PASS (unknown target returns
  `ErrNodeExecutionNotFound`). `go build ./...` clean.
- Remaining: the live lab re-run flips C5e/C6d's status codes; that evidence updates
  `docs/m4-exit-status.md`, not this record.

## Migration/rollback

No migration, no data change. Deploy the serve binary; old clients see a better status on a route
that already documented `404`. Revert = restore the bare `fmt.Errorf`/`404`-passthrough mapping
(the C5e/C6d arms return to reading `500`).
