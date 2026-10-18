# ADR-0041 — model.chat gains an optional `config.reasoningEffort`: `low` | `medium` | `high`, forwarded to the endpoint as `reasoning_effort`

- **Date:** 2026-10-18 · **Status:** Proposed (owner sign-off pending) · **Owners:** pipeline schema maintainer; worker runtime maintainer
- **Related:** ADR-0021 (v1alpha1 schema), ADR-0029 (model.chat message shape), ADR-0024 (node kinds, model.chat egress);
  schema asset `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json` `configModelChat`;
  executor `internal/worker/modelchat.go` (`parseModelChat`, `requestBody`)

## Context

Reasoning models spend `maxTokens` on internal thinking before producing any answer. Live evidence on the
home cluster: `qwen3-8-27b` (a reasoning model) consumed its entire `maxTokens: 4000` budget thinking about a
real repository and returned no answer at all; the fix was raising the node to 16000 tokens and surfacing a
`completion_truncated` error instead of a silent empty reply (`52bfad9`). Raising `maxTokens` bounds the *sum*
of thinking and answer, but an author who wants a long answer has no way to bound the *thinking* — the two
budgets are one number, and the only lever is to throw more tokens at the problem.

The OpenAI chat-completions API already carries this as `reasoning_effort` (`low` | `medium` | `high`). The
`model.chat` node POSTs to an OpenAI-compatible endpoint and today forwards exactly `model`, `messages`,
`temperature`, `max_tokens` — one key per configured option, and nothing when the option is unset.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A — optional `config.reasoningEffort`**, schema enum `low\|medium\|high`; set → the wire body gains `reasoning_effort`; unset → the request is byte-identical to today | one additive, backward-compatible field on one kind; matches the endpoint's own vocabulary, so no worker-side translation; the default path (unset) changes nothing for every existing pipeline | value semantics are endpoint-specific — the same word can mean different budgets per provider | OpenAI chat-completions documents `reasoning_effort`; the lab's llm-collective vLLM/qwen behaviour with the field is now measured (see **Evidence (measured 2026-10-18)**) |
| B — a numeric `reasoningBudget` token count the worker subtracts from `maxTokens` | portable across endpoints that ignore `reasoning_effort` | invents a budget the endpoint never saw, and cannot — the endpoint owns where the thinking tokens go; a client-side subtraction would misreport the prompt and break § 4 step 8's one-body-per-retry rule | § 4 step 8 (attemptport), `modelchat.go` `requestBody` |
| C — status quo: document "raise maxTokens for reasoning models" | zero change | leaves the observed failure mode (entire budget spent on thinking, no answer) with no knob; 52bfad9's error now names the symptom but not the remedy | home-cluster live incident behind `52bfad9` |

## Decision

**Proposed: Option A.** `configModelChat` gains one optional property, and nothing else:

```json
"reasoningEffort": {
  "enum": ["low", "medium", "high"],
  "description": "Optional reasoning effort (ADR-0041). When set, the worker forwards it to the OpenAI-compatible endpoint as reasoning_effort; unset sends nothing, as before. Endpoints may ignore it."
}
```

1. **Schema** — `configModelChat` (additive, optional; `additionalProperties: false` unchanged, so any other
   spelling is refused at validate time with the schema's own enum diagnostic at the key's pointer). The
   worker's `parseModelChat` re-checks the three values and refuses anything else as `invalid_output`
   (the worker never trusts a claim to have been validated).
2. **Wire** — `requestBody` adds `reasoning_effort` to the map only when set. Unset keeps today's body
   exactly: `model`, `messages`, `temperature`, `max_tokens` — byte-identical, pinned by
   `TestModelChatReasoningEffortWireBody`.
3. **Compiler** — no change: a literal at this position is a `PositionValue` leaf that survives
   `configValues` → `configBindings` (the same path as `temperature`/`maxTokens`), pinned by
   `TestModelChatReasoningEffortSurvivesCompilation`. The claim hydration rebuilds the worker's config from
   the plan's `configBindings`, so a field the compiler drops is a field the worker can never send — the
   330af07 responseSchema bug, which this field does not repeat.
4. **UI** — `nodeFields.ts` names `config.reasoningEffort` in model.chat's YAML-only list, so the editor
   says honestly what stays in the YAML textarea (like `config.provider`/`config.responseSchema`).

**Endpoint honesty (recorded, not assumed):** endpoints *may* ignore `reasoning_effort`. The collective's
vLLM/qwen backend's behaviour with the field is now measured against the live endpoint — see **Evidence
(measured 2026-10-18)** below — but per-endpoint behaviour stays the endpoint's authority: the compatibility
tables must not be prefilled with PASS for other endpoints, and the node's own
`completion_truncated`/empty-reply evidence (52bfad9) still tells the author whether the knob did anything
on *that* endpoint.

## Evidence (measured 2026-10-18)

Live measurement on the collective endpoint, model `qwen3-8-27b`, prompt “How many prime numbers are there
between 1 and 60? Answer with just the number.”, `max_tokens` 6000:

| request | response |
|---|---|
| no `reasoning_effort` | finish `stop`, `reasoning_content` 612 chars, answer “17”, `completion_tokens` 277 |
| `reasoning_effort: "low"` | finish `stop`, `reasoning_content` 264 chars, answer “17”, `completion_tokens` 204 |
| `reasoning_effort: "medium"` | ok, `reasoning_content` 289 chars |
| `reasoning_effort: "high"` | HTTP 400 `{"code":"reasoning_effort_not_supported","message":"reasoning effort 'high' is not supported by the loaded chat template","param":"reasoning_effort","type":"invalid_request_error"}` |

Consequence: on this endpoint `low`/`medium` shorten the reasoning (264/289 chars vs 612 with no field), and
`high` is refused by the endpoint at request time — the attempt fails with the endpoint's 400. The schema
still accepts `high` because other OpenAI-compatible endpoints support it; the endpoint is the authority,
and the 400 surfaces to the node/author as the failed request's error rather than a schema change.

## Consequences

- Additive and optional: every existing document validates unchanged and sends a byte-identical request.
- The wire body stays one shape per retry: the field is part of the claim's resolved config, so a retry
  sends the same `reasoning_effort`, never a changed body (§ 4 step 8).
- A node that sets `reasoningEffort` against an endpoint that ignores it costs nothing and gains nothing —
  the ADR makes that the author's measurement, not the platform's guarantee.
- Schema digest changes (`pipeline_revisions.schema_digest`), as with any asset edit (ADR-0021 § 2).

## Security/privacy

No new egress: the field rides the existing single `model.chat` POST through the same endpoint, allowlist
and ADR-0018 secret-scan gate (`requestBody` scans the final body, `reasoning_effort` included). No secrets,
no new surface; the value is one of three fixed words.

## Verification

- `internal/worker/modelchat_test.go` `TestModelChatReasoningEffortWireBody` — real httptest endpoint: the
  wire body carries `reasoning_effort` for `low`/`medium`/`high`, carries nothing (exactly the four pre-
  ADR-0041 keys) when unset, and out-of-enum/non-string values are refused as `invalid_output` with the
  enum named, before any byte leaves.
- `internal/pipelines/compiler/modelchat_test.go`
  `TestModelChatReasoningEffortSurvivesCompilation` — the literal survives compilation as one `PositionValue`
  leaf at `/spec/nodes/0/config/reasoningEffort`, and out-of-enum values are the schema's refusal at the key's
  pointer.
- `TestSchemaAssetMatchesSpecCopy` still passes on the updated spec-side copy.

## Migration/rollback

No migration: additive optional schema property plus worker/UI edits. Rollback = revert the commit; an
existing document that used the field would then fail validate (unknown property under
`additionalProperties: false`), which is the honest failure — the field simply no longer exists.
