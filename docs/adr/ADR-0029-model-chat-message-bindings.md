# ADR-0029 — model.chat messages are typed: content is a binding position

- **Date:** 2026-10-16
- **Status:** Accepted
- **Owners:** pipeline schema maintainers; model.chat executor owner
- **Related decisions / contracts:** ADR-0021 (canonical asset, digests), ADR-0022 § 1 (`bindingText` is the
  only slot that interpolates inside longer text), ADR-0024, ADR-0027 (claim-time resolution), `docs/m4-contract.md`
  § 4 steps 8 and 14, `03`'s node table

## Context

`configModelChat.messages` was `items: {type: object}`. The compiler does not hard-code where expressions
live — it walks the shipped asset beside the document (`schema/positions.go`) and dispatches on the `$defs`
name each pointer reaches. An untyped item has no `properties`, so the walk stopped at
`/config/messages/<i>`: `Position` returned `unknown`, `classify`'s unresolved branch stored the value as a
literal, and a prompt reading `Goal: ${{ inputs.goal }}` was published, run, and delivered to the model **as
those exact characters** — `model.chat` could see neither run inputs nor upstream outputs, while `agent.acp`'s
`config.prompt` (`#/$defs/bindingText`) does. `docs/samples/home/*` recorded the gap in comments.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A — untyped items, special-case content in the compiler | No asset edit, no digest change | Two answers to "where does an expression live" — the drift ADR-0022 § 1 prevents | `classify`'s comment; contract § 9.2 |
| B — `content: bindingOrString` | Interpolation stays schema-visible | Whole-value only: `${{ … }}` inside prose is refused as `binding_syntax`, and a prompt *is* prose with interpolations | `valueBinding`'s `PositionValue` branch |
| C — type the item `{role, content}`, `content: $ref bindingText` | Asset stays the single source of truth; the walker places content with no Go change; ADR-0027 already resolves any `bindingText` leaf, so model.chat inherits resolution rather than forking it | Bare-message documents now fail validation — accepted: fail closed | the tests under Verification |

## Decision

**Option C.** `configModelChat.messages.items` becomes `type: object`, `required: [role, content]`,
`additionalProperties: false`, with `role: {enum: [system, user, assistant]}` and
`content: {$ref: #/$defs/bindingText}` — the identical string shape `agent.acp`'s prompt uses. `role` is
deliberately literal: the executor forwards messages verbatim and never evaluates, so a `${{ … }}` there is
refused by the enum rather than bound. No other node kind changes; `communication-spec/schemas/` keeps the
same bytes. The runtime half is confirmatory: a model.chat node's bindings already reach
`runtime.ResolveNodeConfig` through `ConfigBindings`, so ADR-0027's claim-time resolution interpolates message
content exactly as it does an agent prompt — no new path. The executor gained the refusal its siblings had: an
`$unresolved` marker in a message or its content closes the attempt `binding_error` before any request.

## Consequences

- Positive: prompts read `inputs` and `nodes.*.outputs`; both home samples interpolate for real and their
  comments describe behaviour, not a gap.
- **Breaking for documents, on purpose:** an extra key, a missing `role`/`content`, or a role outside the enum
  fails `schema_shape` at that key's own pointer. There is no ignore-unknown mode, and a message silently
  dropped at the endpoint is worse than a draft that will not publish.
- The asset digest changes, so `pipeline_revisions.schema_digest` differs across the deploy (ADR-0021); a plan pinned before it keeps its recorded literal content. `bindingText`'s 8192-char cap stands, so a larger payload travels as an artifact, not a longer string.

## Security/privacy

Interpolated values are run inputs and upstream outputs, author-visible already; ADR-0027's injection analysis is
unchanged (expression text never reaches the worker, which still cannot evaluate). The pre-egress secret scan covers
the whole request body including interpolated prompt text; secrets stay on `secretRef` (ADR-0018).

## Verification

- `schema/schema_test.go` — the typed message validates; `content` is a `bindingText` position, `role` is not; extra/missing keys and a bad role are refused at their own pointers.
- `compiler/modelchat_test.go` — exactly one binding at `/spec/nodes/0/config/messages/1/content`, one compiled expression pinned there, the literal system message untouched.
- `runtime/model_chat_bindings.yaml` + `modelchat_config_test.go` — resolution interpolates the content, no `${{` survives, and the run pays the expression budget (ADR-0027 rule 5).
- `worker/modelchat_bindings_test.go` (real `httptest` endpoint) — the resolved content is what the wire carries; an unresolved marker is `binding_error` with zero requests.

## Migration/rollback

Deploy: the asset compiles at process start and is served at `GET /api/v1/schemas/pipeline-v1alpha1`; authors
of a bare-object message see `schema_shape` at the next validate. Rollback: restore the bytes in **both** locations
(both drift guards fail if only one moves) and bindings go back to literals — loud in the model's reply, never
silently wrong. Supersede: multi-turn or tool-calling shapes take a new `configVersion`.
