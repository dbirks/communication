# ADR-0021 — Pipeline v1alpha1: strict schema, canonicalization and revision digests

- **Date:** 2026-10-15
- **Status:** Proposed
- **Owners:** M4 contract implementers (schema/compiler, control plane, worker runtime)
- **Related decisions / contracts:** D-005 (Accepted), D-013 (Proposed — this record is the build
  that validates it), D-019, D-022; ADR-0002 (immutable run-pinned revisions, which this record
  makes implementable); `communication-spec/03-pipeline-engine.md` § "Canonical document & schema",
  `07-config-integrations.md` § "One schema, multiple editors", `09-api-events-data.md`
  (`pipeline_drafts`, `pipeline_revisions`, "Published revision hash unique in organization"),
  `01-domain-model.md` (invariants 1, 5, 6), `12-test-strategy.md` cases 1, 11; spike
  `$HOME/.cache/communication-lab/m4-spike/SPIKE-NOTES.md`; contract: `docs/m4-contract.md`

## Context

ADR-0002 decides that every run pins one immutable published revision, and `09` wants a unique
content hash per organization. Neither says **what is hashed**, **in what form**, or **which
library computes it** — and `communication-spec/schemas/pipeline.schema.json` (PROVISIONAL) turns
out not to be implementable as the authority:

- It validates **one document kind**. Spike (`cmd/validate`, three validators): of the five files in
  `communication-spec/examples/`, two pass and three fail — `NodeTemplate`, `PipelineAssignment`
  and `secret-mounts.yaml` (which has no `apiVersion`/`kind` at all). The examples directory ships
  more document shapes than the schema describes.
- It is **vacuous where it matters**. Spike (`cmd/probes`): an unknown node `config` key
  (`typo: x`) passes; `spec.inputs` written as a name→type map rather than a JSON Schema passes;
  `policies: {maxConcurrentNodes: -1, timeoutSeconds: "later"}` passes; a nonsense `until` body
  (`{id: 1, kind: nope}`) passes.
- It **cannot express what `03` mandates**. The M4 exit sample needs per-node `retry`,
  `timeoutSeconds` and `onFailure`, and the provisional `node` has
  `additionalProperties: false` without them — the corrected sample fails the provisional schema
  with `additional properties 'retry', 'timeoutSeconds' not allowed`.
- The YAML→hash path has **silent type traps**. Spike (`cmd/canon`): `2026-10-14` decodes as a
  `time.Time` (canonicalizing to `2026-10-14T00:00:00Z`), `0123` decodes as **octal 83**, `0o17` as
  15, `1_000` as 1000, `.inf` as `+Inf` (which `json.Marshal` refuses outright), and `café` in NFC
  vs NFD produces **different digests**. Aliases and `<<` merge keys are applied silently, so the
  hashed document is not the authored one.
- Library dialect is not free: `go get github.com/google/cel-go@v0.32.0` fails because the module
  moved to `cel.dev/cel-go`, and `github.com/qri-io/jsonschema`/`github.com/xeipuuv/gojsonschema`
  cannot give the editor the error detail a 2020-12 schema produces.

Whatever is chosen here becomes the identity of every published pipeline: a canonicalization rule
that changes later invalidates "this run pinned digest X".

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A. Keep the provisional schema; push everything into the Go compiler** | One small schema; compiler already needed for DAG/secret/policy checks | Errors arrive as hand-written Go messages with no machine-readable location; two future implementations (UI editor, `communication` CLI) would re-implement the same rules; typos in `config` stay invisible until runtime | spike: `vacuous-config`, `unconstrained-policies`, `until-body-unvalidated` all PASS the provisional schema |
| **B. One strict JSON Schema per document kind + typed `config` per node kind, validated by `santhosh-tekuri/jsonschema/v6`; the compiler keeps only what a schema cannot say (identity, topology, references, policy, CEL) (chosen)** | Machine-readable `instanceLocation` pointers the editor can highlight; unknown keys fail closed; the corrected sample validates; the division of labour is exactly what `03` already claims ("semantic compiler MUST validate…") | The schema must be lookahead-free and Go-regexp-compatible; nested `body.nodes` recursion grows the schema; two places to change when a node kind gains a field | spike: candidate schema rejects 11 of 11 malformed probes for the right reason and accepts the corrected sample |
| C. Author the schema as Go structs (`yaml.Unmarshal` into typed models), JSON Schema generated from them | Single source of truth in code; no dialect drift; native error messages | The browser and GitOps tooling lose a published contract; `07` requires lint/validate/diff/format commands and a "simple draft schema" as the portable artifact; assistant/UI validation would need a Go round trip | compared; rejected on `07` grounds |
| D. CUE (or protobuf-schema) as the authoring contract, compiled to JSON Schema | Real type system, defaults, recursion, one language for graph + policy | A second toolchain and a large dependency for a schema this size; the community's portable artifact is still JSON Schema; unknown-passthrough semantics would need an ADR of its own | compared; rejected as disproportionate (D-013 names CEL + JSON Schema + YAML, not CUE) |
| E. Hash the authored YAML text (or full RFC 8785 JCS over the decoded document) | Trivially reproducible from Git; "what you wrote is what is pinned" | Comments, key order, quoting, anchors, merge keys and YAML type inference all change identity or change the document; export then cannot be regenerated byte-identically, so GitOps diffs lie | spike: `same-canonical-bytes-regardless-of-key-order=true` (ordering must be *ignored*), `merge-key` silently expanded, NFC/NFD split |

## Decision

### 1. Candidates, pinned (from the spike module)

| Role | Pin | Why |
|---|---|---|
| YAML parse | `go.yaml.in/yaml/v3 v3.0.5` | maintained yaml.v3; rejects duplicate keys and alias bombs; decode **via `yaml.Node`** so scalar text and tags survive for the rules in § 4 |
| JSON Schema | `github.com/santhosh-tekuri/jsonschema/v6 v6.0.3` | the only candidate with draft 2020-12 support and structured `ValidationError` (`keywordLocation`/`instanceLocation`), which the editor and the assistant both need |
| CEL | `github.com/google/cel-go v0.31.0` | **last version published under that module path**; v0.32 declares `cel.dev/cel-go`. Import-path migration is a separate decision (ADR-0022 Verification) |
| Unicode | `golang.org/x/text v0.43.0` (indirect already in the repo's graph) | NFC normalization is mandatory (§ 5) |

These are new module dependencies for the repository and are declared under DEVIATIONS of the M4
build task; nothing else is added.

### 2. One schema per document kind, versioned by `$id`

Ship `api/schemas/pipeline-v1alpha1.schema.json` (per ADR-0007, `api/` holds schemas) whose root is
`oneOf` over `PipelineDocument` and `NodeTemplateDocument`, `$id`
`https://communication.dev/schemas/pipeline-v1alpha1.schema.json`, and a `kind` const per branch.
`PipelineAssignment`, `SecretMountSet` and the `trigger` shapes stay **unschema'd in M4** — the
spike proves the current examples of those kinds validate against nothing — with the rule recorded
here that **a kind without a schema cannot be published**: `POST /drafts/{id}/validate` on a
document whose `kind` has no registered branch returns `invalid_document_kind` rather than falling
back to the Pipeline branch. M6 (GitOps/assignments) adds those branches under the same `$id`.

Compile location must be the schema's `$id`, not a synthetic URL: adding the resource under
`mem://…` produced `missing reference` for internal `$ref`s in the spike.

### 3. What the schema owns, and what the compiler owns

Schema (structural, machine-checkable, editor-highlightable): document envelope; per-kind `spec`;
`additionalProperties: false` at every level; node `id`/`kind` enums; `config` required and typed
per kind; scalar types (`timeoutSeconds: 900` must be a number, so `${{ … }}` in a budget slot
fails with `got string, want integer`); numeric ranges on every budget; `maxItems`/`minItems` on
graphs, branches and bindings; string size bounds; JSON-Schema-shaped `inputs`/`outputs`
(`type: object` const required); `relativePath` shape; `secretRef` shape (`^(project|org)/slug$`).

Compiler (semantic, never duplicated in the schema): unique node ids, `dependsOn` existence,
DAG/acyclicity within each scope, scope entry points, reachability of terminal outcomes, CEL
compilation and reference legality (ADR-0022), secret-literal detection (invariant 5), profile and
template existence, child-invocation depth, budget-vs-quota reconciliation, output-schema
validation of produced JSON. The spike measured the boundary exactly: duplicate ids,
self-dependency and dangling `dependsOn` **pass even the strict schema** — JSON Schema cannot
compare array items — so those four families are compiler obligations and their error codes are
part of the API (contract § 2).

### 4. Authoring-surface rules the loader enforces, not the schema

Observed hazards require loader-side rules (all cheap, all with a named error):

| Rule | Error | Evidence |
|---|---|---|
| exactly one YAML document per file | `multiple_documents` | `multi-document` parsed as `docs=2`, second silently ignored |
| no duplicate mapping keys | `duplicate_key` (from the parser) | `mapping key "a" already defined at line 1` |
| aliases and `<<` merge keys are **accepted**, but the digest covers the expanded document and export is regenerated from canonical JSON | `note:` in the validate response | `merge-key` decoded to `{p:1,q:3}`; anchors vanish in the round trip |
| alias/anchor budget (≤ 512 alias nodes, ≤ 64 depth) | `alias_budget_exceeded` | yaml.v3 aborts at its own internal limit (`document contains excessive aliasing`); the explicit budget is the portable contract |
| no `.inf`/`.nan`, no float where an integer field is declared, no integer literal with a leading `0` and ≥ 2 digits, no int64 overflow | `invalid_number` | `0123` → 83, `.inf` → `json: unsupported value: +Inf` |
| reject a `!!timestamp`-resolved scalar anywhere except inside `metadata.ui` (strings must be quoted) | `unquoted_date` | `2026-10-14` → `time.Time` |
| `yes`/`on`/`off`/`no` are strings, never booleans, and say so | type error text quotes the scalar | `carryForward: yes` → `got string, want boolean` |
| no tabs in indentation | parser error | `found a tab character that violates indentation` |

Because these need the raw scalar text, validation walks the `yaml.Node` tree and the decoded value
is used only for JSON Schema validation.

### 5. Canonical form (the thing that is hashed)

Deterministic JSON, in this order of operations: parse strict YAML → loader rules (§ 4) → JSON
value tree (numbers as decoded, no reformatting of integers, floats via Go shortest round-trip) →
**NFC-normalize every string and key** → delete the `metadata.ui` subtree → emit with keys sorted
by UTF-8 byte order, no insignificant whitespace, arrays in document order.

NFC is not cosmetic: the spike shows composed and decomposed `café` digesting differently before
normalization and identically after. Full RFC 8785 JCS was rejected because its number
shortest-repr rules would rewrite values the loader already validated (and Go's `encoding/json`
already gives shortest round-trip floats); the parts that matter — key order, no whitespace, NFC —
are exactly what is applied.

### 6. Two digests, not one

- `revision_digest` = `sha256:` over the canonical form of the **submitted document** (§ 5). This is
  ADR-0002's identity, the value `09`'s "Published revision hash unique in organization" indexes,
  and the value a run pins. It changes when an expression's *text* changes, however cosmetically.
- `plan_digest` = `sha256:` over the compiled binding plan (canonical node list with each compiled
  expression's normalized CEL AST text, per ADR-0022). Recorded on the run. Rationale: `cel-go`
  normalizes `a==true` and `(a) == true` to one AST, so a recompile under a different compiler
  version can change the plan while the authored document has not moved — and that must be
  visible, not silently absorbed. Two digests keep authoring identity and execution identity from
  being conflated.
- `source_sha256` = digest of the exact imported bytes, stored on the draft/import record only, so
  GitOps drift detection (`07`, D-022) has a textual answer that does not pretend text equals
  identity.

Digest scope is itself versioned (`v1alpha1-canonical-1`) and recorded on the revision row: if
canonicalization ever changes, old digests stay verifiable and the change requires an ADR.

### 7. Validation response shape

`POST /api/v1/drafts/{draftId}/validate` returns
`{valid, revision_digest, plan_digest, errors: [{code, message, instance_location, schema_location, source: "schema"|"compiler", hint}], notes: []}`.
`schema` errors are the validator's own structured output (`santhosh` `BasicOutput` units,
converted 1:1); `compiler` errors use the code list in contract § 2. The UI and the assistant
consume one shape for both sources, which is the reason § 3 keeps the split explicit rather than
folding it into prose.

## Consequences

- Positive: the corrected M4 sample pipeline validates; typo'd config keys and nonsense budgets
  fail at validate-time with a location the editor can highlight, instead of at attempt 3 of a
  loop.
- Positive: "which revision did this run pin" becomes answerable from one stored digest plus a
  versioned canonicalization scope; immutability (ADR-0002) is now implementable rather than
  aspirational.
- Positive: three of the five spec examples are provably not valid v1alpha1 documents today, and
  the fix list is concrete (contract § 9).
- Negative: two schemas must be kept in sync with the Go node registry; the guard is a test that
  every registered node kind has a `config` branch in the schema and vice versa (contract § 8).
- Negative: rejecting `unquoted_date` and leading-zero integers will break authoring habits that
  YAML 1.1 formed; the error names the fix (quote it), and the alternative — accepting the silent
  type change — would put `timeoutSeconds: 0900` into a run as 576.
- Negative: `PipelineAssignment`/`SecretMountSet` remain unvalidated documents until M6, so a
  malformed assignment is only caught where it is consumed.
- Operational: three new Go dependencies (§ 1) and one JSON asset in `api/schemas/`; the schema is
  served read-only (`GET /api/v1/schemas/pipeline-v1alpha1`) so the UI never bundles a copy that
  can drift from the server's.

## Security/privacy

- `additionalProperties: false` everywhere is fail-closed: a field this version does not know
  cannot be smuggled through it (the spike's `gate-vs-kind-name` probe shows a plausible-sounding
  kind name failing rather than being ignored).
- Alias budget + single-document rule + parser-side duplicate-key rejection bound the classic YAML
  amplification attacks; the spike observed yaml.v3's own abort as a backstop, not as the
  contract.
- Secret literals cannot be caught structurally (spike `secret-literal-in-config` passes both
  schemas). Invariant 5 is therefore a **compiler and event-redaction** obligation, with the
  reference-shaped `secretRef` pattern as the only structural help; the compiler's detector and the
  M3 envelope-encryption path (ADR-0018) remain the boundary.
- The digest is not a security boundary: sha256 over an attacker-chosen pipeline is fine because
  publishing is authorized separately (`01`'s matrix), and revision uniqueness per organization is
  an index, not a proof of authorship. Audit (`06`) is.
- Error payloads echo only locations and the offending scalar text; the spike harness deliberately
  printed them, the product must not echo a value that a secret scanner flags.

## Verification

Observed 2026-10-15 in `$HOME/.cache/communication-lab/m4-spike` (throwaway module
`communicationlab/m4spike`, Go 1.27.2). Full transcripts: `results-*.txt`; summary:
`SPIKE-NOTES.md`.

- `go run ./cmd/validate` (provisional schema × 5 spec examples × 3 validators): 2 PASS / 3 FAIL,
  with the three failures on `kind` (`NodeTemplate`, `PipelineAssignment`) and a missing envelope
  (`secret-mounts.yaml`); qri-io reports no inner cause (`/spec: additional properties are not
  allowed`), xeipuuv reports flat strings, santhosh reports a location-addressed tree.
- `go run ./cmd/probes` (15 one-bug documents, provisional vs candidate): the candidate schema
  rejects all 11 documents marked invalid for the *named* reason
  (`got string, want integer`, `minimum: got -1, want 1`, `value must be one of …kind enum`,
  `'1' does not match pattern '^[a-z][a-z0-9_]{0,62}$'`, `got string, want boolean`,
  `'postgres://u:p@h/d' does not match pattern '^(project|org)/…'`) and accepts the 4 documents
  whose only defects are semantic (`duplicate-node-id`, `self-dependency`,
  `dangling-depends-on`, `secret-literal-in-config`) — the measured schema/compiler boundary.
- `go run ./cmd/probes` on the samples: `feature-development.yaml` (as shipped) FAILS the
  candidate on `passWhen`-style expression placement, `timeoutSeconds` vs `deadlineSeconds` and
  `${{ workspace.repo.root }}` in a path field; `feature-development-corrected.yaml` **PASSES**
  the candidate and **FAILS** the provisional (`additional properties 'retry', 'timeoutSeconds' not
  allowed`) — the evidence that the provisional schema cannot hold M4's own semantics.
- `go run ./cmd/canon`: `same-canonical-bytes-regardless-of-key-order=true`,
  `same-canonical-after-yaml-reparse=true`, `raw-digests-equal-for-NFC-variants=false`,
  `after-NFC-digests-equal=true`; `0123` → 83; `.inf` → `json: unsupported value: +Inf`;
  `2026-10-14` → `time.Time`; `mapping key "a" already defined at line 1`;
  `document contains excessive aliasing`; `docs=2` for a multi-document file.
- **Not yet exercised** (M4 implementation, not this record): the loader rules as Go code with
  property/fuzz tests over generated YAML (contract § 8), digest stability across a Go patch
  release, and the `pipeline_drafts`/`pipeline_revisions` constraints on a database that actually
  ran the migration.

## Migration/rollback

Forward-only (ADR-0013). The provisional schema stays in `communication-spec/schemas/` untouched
(the spec is read-only); the candidate becomes `api/schemas/pipeline-v1alpha1.schema.json` when M4
implements it, and `communication-spec` gains its fix list through contract § 9, not through an
edit here.

Rollback paths, in order of preference: (1) a new schema **branch** for a node kind is additive —
old drafts keep validating against the branch they were compiled with, because a revision stores
its own canonical JSON and the digest never has to be recomputed; (2) a canonicalization change
requires a new `digest_scope` value plus an ADR, and old revisions stay verifiable because the
scope is stored on the row; (3) abandoning strict validation would mean re-hashing published
revisions, which contradicts ADR-0002 and the runs that pin them — therefore not offered.
