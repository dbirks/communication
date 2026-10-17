# ADR-0038 — The publish gate's secret-literal `422` carries the stable `code` `secret_literal_detected`

- **Date:** 2026-10-17 · **Status:** Accepted · **Owners:** control-plane contributors
- **Related:** ADR-0014 (problem+json conventions — every refusal names a stable code),
  ADR-0018 (secret references — the only place a value is held), ADR-0021 Security (invariant 5,
  the compiler detector); `docs/m4-contract.md` § 7.1 C13c and § 2.2; the live evidence in
  `docs/m4-exit-status.md` C13c (pass 20 @ 3f35115 — `live20/C13.out:86-:88`, GAP at `:89`)

## Context

C13c (`docs/m4-contract.md` § 7.1) requires that a secret literal is a **block**, not a warning:
validate answers `422 secret_literal_detected` with the value redacted, and *publish cannot succeed
while the finding stands*. The live lab proved the block — publish refused `422` at
`live20/C13.out:88`, the validate response redacted at `:87`, the detector firing at `:86` — but
its "the detector itself is what blocked publish" arm **GAPped** at `:89` (`docs/m4-exit-status.md`
C13c, pass 20): the publish gate short-circuits on the draft's *recorded* validation, and the `422`
it wrote carried the finding only inside the `type` URI tail
(`https://communication.dev/errors/secret-literal-detected`) and the `detail` prose — the body's
`code` read `None` and the spelling was unmeasurable. That violates the ADR-0014 convention the
contract restates at § 2 line 491: a refusal's stable code must be machine-readable, not prose or
a URI suffix a client has to parse. § 2.2 already names the code — `secret_literal_detected` is the
policy/registry validation code validate returns in `errors[].code` for exactly this finding.
Because the fix changes the documented response shape of a public route, it needs this record.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| Keep the body as-is (`type` URI + prose only) | zero work, zero schema change | C13c's `:89` arm stays a GAP; every client re-parses the URI tail or human prose to learn *which* refusal it got — the exact fragility ADR-0014's stable codes exist to remove | `live20/C13.out:89` (code reads `None`) |
| New publish-specific code (`publish_secret_literal`) | names the route | invents a third spelling for one finding class — § 2.2 declares codes a public contract ("adding one is additive, renaming one is not"), and contract § 2.2's own predicate-cost precedent is "one event, two names, both listed so nobody invents a third"; a client that learned the validate code must learn a second one for the same block | § 2.2 code-table rules |
| **Reuse validate's code as a `code` member** (chosen) | one string names one finding wherever it appears — `errors[].code` from validate and the publish refusal; the body becomes branchable without touching the `type` URI (unchanged) so nothing that honored the old contract breaks; C13c's arm becomes measurable | the response gains a documented member (a public-API documentation change — hence this ADR) | `internal/api/m4routes_test.go` `TestM4PublishSecretFindingCode` |

## Decision

1. **API** (`internal/api/pipelines.go`): both sites that refuse a publish on a recorded
   secret-literal finding — the gate's short-circuit on the draft's validation
   (`refuseUnpublishable`) and the store's `DraftConflictSecretLiteral` conflict path (`fail`) —
   render through one helper, `m4SecretLiteralProblem`: `422 application/problem+json` with the
   unchanged `type` `https://communication.dev/errors/secret-literal-detected`, title "Secret
   Literal Detected", **plus** a `code` member carrying the § 2.2 code verbatim:
   `"code": "secret_literal_detected"`. The code belongs to the *finding*, not the route: a draft
   re-validated clean publishes normally and its `201` body carries no secret code anywhere.
2. **OpenAPI** (`api/openapi.yaml`): the publish route's `422` response moves from the plain
   `Problem` schema to a new `PublishUnprocessableProblem` schema — `allOf: Problem` plus a
   required `code`, enumerated `[secret_literal_detected]` today. Codes follow § 2.2's rule:
   adding one to that enum is additive, renaming one is not.
3. **Why reuse validate's code:** § 2.2 makes `secret_literal_detected` the *one* public name of
   this blocking class; the editor's help links and the assistant's fixes already key on it. A
   client that sees the finding from validate and again from publish switches on the same string
   instead of mapping a second code or sniffing the URI tail.

## Consequences

Clients may now branch on `code === "secret_literal_detected"` instead of parsing prose or the
`type` URI tail — and are on notice that the enum is a public contract going forward. The `type`
URI, `title`, `status` and the redaction rule are all **unchanged**, so the change is strictly
additive: any client that ignored `code` (or read the URI) keeps working. C13c's `:89` arm becomes
measurable — the live re-run flips the `docs/m4-exit-status.md` GAP to a read code; that evidence
updates the ledger, not this record. The enum in `PublishUnprocessableProblem` is deliberately
narrow: widening it (e.g. surfacing other blocking codes at publish) is its own decision.

## Security/privacy

Unchanged from ADR-0021 Security and § 2.2: the body names the location and the shape, **never**
the literal; the `code` member is a fixed enum string carrying no value. `hint`/`detail` redaction
rules apply as before, and ADR-0018's envelope path stays the only place a secret value is held.

## Verification

- `go test ./internal/api/ -run 'TestM4PublishSecretFindingCode|TestM4PublishGates'` — PASS: the
  publish `422` on a draft with a recorded `secret_literal_detected` finding carries
  `code: "secret_literal_detected"` beside the unchanged type URI, names the instance location in
  `detail`, and the same draft re-validated clean publishes `201` with no secret code in the body.
- Observed live behavior being corrected: `docs/m4-exit-status.md` C13c — `live20/C13.out:86-:88`
  PASS, `:89` GAP (publish `422` `code` reads `None`) on pass 20 @ 3f35115.
- Remaining: the live lab re-run reads the `code` and closes the GAP; `api/openapi.yaml` lint.

## Migration/rollback

No migration, no data change, no event change. Deploy the serve binary; old clients see one extra
member on a response whose other four members are byte-identical. Revert = drop the `code` extra
from `m4SecretLiteralProblem` and restore the plain `Problem` `$ref` (the `:89` arm returns to a
GAP).
