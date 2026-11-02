# ADR-0073 — An invalid_output refusal teaches the next attempt: retry_context gains validation_errors, and the agent prompt states the declared output constraints

- **Date:** 2026-11-02
- **Status:** Accepted (implemented and verified — see Verification)
- **Owners:** runtime + worker maintainers
- **Related decisions / contracts:** ADR-0023 § 6 (retry_context; "the retry's prompt gains a recorded retry_context block" — until this ADR the block existed but nothing put it in the prompt), ADR-0022 § 4 rule 2 (the boundary refuses an envelope its plan's outputs schema would not accept), contract § 4 step 8, § 1 `attempts.output_errors` / `attempts.retry_context`, § 6 (bounded detail); lab evidence: run 41447122534 / job github-loop (live16).

## Context

The lab's `/plan` node declared `plan.summary: {maxLength: 600}`. Real pi answered 647 characters; the boundary refused the reply `invalid_output`; the retry policy re-queued the node. But the next attempt received **the identical prompt** — nothing told the agent it had been refused or why — and it answered 760, then 765. All three attempts died the same death while `retry_context` already held `{attempt, error_class, …}` and `attempts.output_errors` already held the JSON-Schema evidence. The facts were durable and visible in the ledger; they simply never reached the model.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **Engine folds `validation_errors` into the queued retry's `retry_context`; the claim carries it (plus the node's declared `OutputsSchema`); the worker's prompt builder states the constraints on attempt 1 and the refusal verbatim on the retry (chosen)** | durable and ledger-visible (route 27/31 and takeover resume share it via `RetryPlan`), no new table, no new event; the retry can actually correct the named field; attempt 1 sees the machine-checked rules it will be held to | prompt grows by a bounded summary; feedback applies to `agent.acp` only (the other kinds do not author a JSON reply through a prompt) | `TestInvalidOutputRetryCarriesValidationErrors`, `TestFakeAgentOverrunsOnceThenComplies`, `TestAgentTurn*Prompt*` tests |
| Worker re-derives the violations at claim time by re-validating the previous attempt's rejected envelope | no schema change to retry_context | the rejected envelope is deliberately NOT stored on a failed attempt (01 invariant 4 — nothing is visible before validation), so there is nothing to re-validate; the evidence would have to be re-fabricated | rejected on the ledger facts |
| Append the raw `attempts.output_errors` JSON to the prompt | zero new code | the entry shape is keyword-location noise; a 200-char message × 16 entries, and it couples the prompt to the schema library's wording | rejected — a projection, not a dump |
| Just tell the agent the maxLength up front (no retry feedback) | simple | a model that violates a stated rule must still be told WHICH rule it broke; the lab shows it re-violates harder (647 → 760) | rejected — necessary but not sufficient |

## Decision

1. **`retry_context.validation_errors`** (runtime): when the attempt the retry follows failed `invalid_output` with readable evidence, the engine queues the next attempt with `validation_errors: [{path, rule, got, want, message}, …]` — `runtime.ValidationFeedback` projects `attempts.output_errors` (never the rejected reply itself), bounded to 8 entries (path ≤ 160, rule ≤ 64, message ≤ 200 chars). It rides every retry path that goes through `RetryPlan` (automatic advancer retry, routes 27/31, human-takeover resume). Additive key; the ADR-0023 § 6 facts are untouched.
2. **The claim carries the contract**: `worker.AttemptClaim` gains `RetryContext` (attempts.retry_context, verbatim) and `OutputsSchema` (the node's declared outputs JSON Schema from the pinned plan snapshot — the same value the boundary validates against).
3. **Prompt assembly states the contract** (worker `agentturn_prompt.go`, `agent.acp` only): every attempt's prompt ends with the declared constraints a machine will check (types, required names, enums, minLength/maxLength/minItems/maxItems/pattern/format/minimum/maximum, two structure levels deep); and when `retry_context.validation_errors` is present, the exact refusal — `Your previous reply was rejected: /plan/summary exceeded maxLength (got 647, want at most 600). Reply again, keeping every field within its declared output constraints.` The whole decoration caps at 4096 bytes.

## Consequences

- Retries of schema-refused replies can correct the named field; the ledger already exposes the block (`attempts.retry_context`, the run API's attempt view) with no schema or route change.
- Prompts no longer equal plan prompt text: anything diffing "what did we ask" against the plan must read the decoration (the checkpoint `inputs_digest` covers the sent prompt, which is the more honest digest anyway).
- `model.chat` / `process.exec` prompts are unchanged — out of scope here.

## Security/privacy

Feedback is projected from JSON-Schema refusal sentences, which name only schema locations and rule values — never reply content, never secrets; it is stored and sent bounded and unredacted-safe by construction. The constraint summary is a rendering of the plan's own schema, already visible to anyone who can read the revision.

## Verification

- `TestInvalidOutputRetryCarriesValidationErrors` / `TestFakeAgentOverrunsOnceThenComplies` (`internal/pipelines/runtime/validation_retry_test.go`, new `testdata/outputs-retry.yaml`): refusal → queued attempt 2 carries `{path:/plan/summary, rule:maxLength, got:"647", want:"600"}` and a fake agent that trims the named field passes on attempt 2.
- C10 extended in `internal/pipelines/runtimetest/subtests_outputs.go`: both stores must queue the retry with the `/evidence` violation in `retry_context.validation_errors` (real PostgreSQL run green).
- `TestAgentTurnFirstPromptStatesOutputConstraints`, `TestAgentTurnRetryPromptCarriesValidationError`, `TestAgentTurnNonOutputRetriesCarryNoFeedback`, `TestAgentTurnFakeAgentOverrunsOnceThenComplies` (`internal/worker/agentturn_prompt_test.go`): the sent prompt states maxLength/enums/required on attempt 1, names the refusal on the retry, and claims nothing for an interrupted retry.
- `go build ./... && gofmt -l internal cmd && go vet ./...` clean; `COMMUNICATION_TEST_DATABASE_URL=… go test -p 1 ./internal/worker/... ./internal/pipelines/... ./internal/store/postgres/` green.

## Migration/rollback

No migration, no wire change: additive `retry_context` key and additive `AttemptClaim` fields. Rollback = revert the commits; old workers keep sending the plan prompt unchanged, and a run whose queued retry already carries `validation_errors` simply has an unused key.
