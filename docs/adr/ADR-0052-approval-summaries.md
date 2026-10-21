# ADR-0052 — Approval summarization pass and free-text interpretation (model writes, human decides)

- **Date:** 2026-10-20
- **Status:** Accepted
- **Owners:** assistant/API maintainers
- **Related decisions / contracts:** ADR-0034 (read-only assistant broker — the model egress
  site and the secret-scanned, bounded, single-completion path this ADR reuses), ADR-0050
  (assistant v2 storage — this ADR is a separate, **non-persisted** summarization/interpretation
  pass that does not add tables or a transcript), ADR-0018 (no secret-shaped data in a prompt),
  ADR-0014 (HTTP/problem conventions; a resource the caller may not know exists is `404`),
  `communication-spec/08-assistant.md:40` (configurable OpenAI-compatible endpoint for direct
  model calls), design brief `docs/design/handoff-app-shell/` (artboard 4g approval detail, 2f/3f
  phone inbox) and `gaps/inbox-ops.md` § 3 W1/W2 and § 4 (free-text reply interpretation).

## Context

The app-shell redesign's approval detail (4g) and phone inbox (2f/3f) need a model-written
decider summary and suggested actions, plus a way to answer a gate "in your own words". Today a
gate carries its own `summary` (the gate text in full) and `artifact_refs` (names/kinds/
sensitivities), and the decider must read it and click Approve/Reject by hand. The design asks the
model to (a) write a ≤ 2-sentence summary and 2–4 suggested actions `{label, intent, risk}`, and
(b) interpret a free-text reply into a proposed decision + note.

Constraints that pin the design:

- **Same egress, same trust rules as ADR-0034.** These are new model calls, but they must go
  through the ADR-0034 broker's single-completion path (`CompleteText`), not a second egress site.
  That path is already secret-scanned on the request and bounded, and it fails closed
  (`503 assistant_not_configured` when `COMMUNICATION_ASSISTANT_BASE_URL` is unset, `503`
  unreachable, `504` timeout, `502` malformed). The output is scanned for secret-shaped material
  the same way the broker scans a prompt — a match is a refusal, never a redaction, and the match
  is never echoed.
- **The model is a reader, never a decider.** The model writes text a human reads. It does not
  decide a gate and it is not trusted: its answer must be exactly one JSON object; unknown
  `intent`/`risk` members are coerced to `other`, unknown/ambiguous decision intent is coerced to
  `reject` (never `approve`), labels are capped, and the note is bounded to the decide route's
  8 KiB cap. The decider always calls the existing `decideApproval` route.
- **Authorized exactly like the gate read.** Both routes apply the same predicate as
  `GET /approvals/{id}`: a gate of a project the caller cannot see is the uniform `404`.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. Two dedicated routes over the ADR-0034 broker, in-memory cache, nothing persisted | Reuses the existing, security-reviewed egress + secret-scan; no schema change; the model is structurally unable to write | Recomputes on a fresh replica until the cache warms | `internal/assistant/summary.go`, `interpret.go`; `internal/api/approval_summary.go` |
| B. Persist summaries in a table (a row per gate) | Stable across replicas/reloads | New table + migration + an ADR for the schema; the summary is derivable and the gate's own text already carries the substance | ADR-0013; `communication-spec/09` table rules |
| C. Have the assistant broker (with its read tools) answer the summary through the tool loop | One code path | The tool loop is a bounded multi-call turn; a summarization is a single completion and needs no tools, so the tool surface (and its authorization review) is unnecessary weight | ADR-0034's tool registry |

## Decision

1. **Two routes**, both session- and CSRF-authed like the other mutations, both authorized as the
   caller through `GetApproval` (the `GET /approvals/{id}` read):
   - `POST /api/v1/approvals/{approvalId}/summary` → `{summary, actions:[{label,intent,risk}],
     model, generated_at}`. `summary` is at most two sentences; `actions` has 1–4 entries (the
     design asks for 2–4; a single usable action is still honest and renderable), each label ≤ 40
     chars, `intent ∈ approve|reject|request_changes|other`, `risk ∈ proceed|refuse|destructive|
     other` (unknown members coerced to `other`).
   - `POST /api/v1/approvals/{approvalId}/interpret {text}` → `{interpretation,
     proposed:{decision, comments}}`. `text` is required and ≤ 2000 chars. `proposed.decision ∈
     approve|reject|request_changes`; an ambiguous/unknown model member is coerced to `reject`,
     never `approve`. `comments` ≤ 8 KiB so the note the approver confirms can be pasted straight
     into `decide`. **The model never decides** — the UI shows the proposal and the human calls
     `decideApproval`.
2. **In-memory per-version cache, no table.** The summary is cached keyed on the gate's
   `version` (a small in-process map, bounded at 256 entries, cleared on overflow). This is the
   deliberate answer to the open question in `gaps/inbox-ops.md` § 8: recompute per load, cache
   per gate `version` in-process. A gate's `version` increments exactly once, for exactly one
   decision, so a cached summary stays honest while the gate is pending and invalidates on
   decision. **No new table**: the summary is derivable from the gate's own text and the ADR-0034
   "v1 stores nothing" / ADR-0050 transcript rules do not apply to this one-shot text — persisting
   it would be a schema change for a value that is cheaply recomputed, which is why the summary is
   a request-scoped computation, not a row. `interpret` is never cached (it depends on arbitrary
   free text).
3. **Same egress and failure contract as the assistant.** Both routes call
   `assistant.NewTextOnly` (config validated exactly as the ask route; unset base URL →
   `ErrNotConfigured` → `503 assistant_not_configured`). Egress failures carry the broker's
   `Failure` mapping and the routes answer with the same problem+json body (`degraded` naming the
   cause) the ask route uses, so the UI degrades identically.

## Consequences

- The approval detail and inbox can show a model-written card with an honest fallback: when the
  assistant is unconfigured the routes answer `503 assistant_not_configured` and the UI keeps the
  gate's own `summary` + static Approve/Reject (no faked model output).
- `model` on the summary response names the endpoint model, not a capability claim; `generated_at`
  is the wall clock.
- The cache is process-local and bounded; a replica that just started recomputes once and warms.
- No migration, no journal event, no new table.

## Security/privacy

- Trust boundary unchanged: the model is a third-party endpoint behind ADR-0034's broker; it sees
  only the gate's `summary` and `artifact_refs` (both bounded), which the caller can already read
  at `GET /approvals/{id}`. It holds no store handle (the text-only broker's store is `nil`).
- Authorization is the caller's own gate read (`GetApproval`); a non-member gets the uniform `404`
  (ADR-0014 § 3).
- **Secrets:** the input is already the caller's readable project data; the *output* is scanned for
  secret-shaped material (ADR-0018) and refused (a `secret_in_response` 502) rather than echoed —
  so a model that regurgitates a token the gate text happened to carry is not handed to a browser.
- **Fail-closed:** an unconfigured, invalid, unreachable or malformed model answer never becomes a
  decision; the routes answer a problem document and the gate stays pending.

## Verification

- `internal/assistant/summary_test.go` + `interpret_test.go`: fake-model shape validation, enum
  coercion (unknown → `other` / ambiguous → `reject`), label cap, ≤ 2-sentence clip, secret
  refusal (no echo), malformed refusal, `NewTextOnly` not-configured.
- `internal/api/approval_summary_test.go`: the HTTP contract — happy path + coercion, in-memory
  caching by gate `version` (model hit once per version, recompute on the bump), non-member → `404`,
  unconfigured → `503 assistant_not_configured`, interpret shape + `400` on empty/oversized text.
- OpenAPI: `redocly lint` 0 errors; `pnpm --dir ui gen:api:check` passes.

## Migration/rollback

Additive: two routes, three schemas, one in-process cache. Revert by removing the two `openapi`
paths, the generated types, `internal/api/approval_summary.go`, the two `internal/assistant` files
and the single `RegisterApprovalSummary` call in `serve.go`. No schema, API or persistence
change, so there is nothing to migrate.
