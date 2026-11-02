# ADR-0066 — Typed workflow inputs: one JSON Schema with an `x-communication-input` annotation, trigger mapping stored on the trigger

- **Date:** 2026-11-02
- **Status:** Proposed (encoding + compiler parse/validate implemented and unit-verified; the run form, trigger mapping and publish warning are specified here and built in later steps — see Migration)
- **Owners:** pipeline engine + control-plane API maintainers
- **Related decisions / contracts:** ADR-0021 (the loader→schema→compiler diagnostic contract, § 4/§ 7), ADR-0022 (bindings and `${{ … }}` roots), ADR-0023 § 2 (the compiled plan a run pins), ADR-0056/ADR-0058 (run triggers, agent profiles), `internal/pipelines/schema/assets/pipeline-v1alpha1.schema.json` (`jsonSchemaObject`), `docs/design/handoff-repo-chat-nav/README.md` § "Workflow inputs, authoring (1j)" + § "Run by hand (1k)", `docs/design/handoff-repo-chat-nav/DECISIONS.md` ("Workflow inputs schema"), `communication-spec/03` (pipeline definitions), `communication-spec/09` (`pipeline_revisions.compiled_plan`)

## Context

`spec.inputs` is a bare JSON Schema object today: the compiler copies it verbatim into
`Plan.Inputs` and derives the expression type tree with `expr.SchemaFromJSON`. That lets
`${{ inputs.goal }}` type-check and nothing else. The repo/chat-nav handoff (1j, 1k) needs
each input to also carry a **type** (`github_issue`, `branch`, `agent_profile`, `text`,
`long_text`) plus **label** and **help**, so the Inputs tab can render rows, the run-by-hand
form can pick the right widget (issue picker, mono branch field, profile select, textarea),
and an issue trigger can know which input its matched issue fills.

Two constraints shape the choice: the JSON Schema is not decoration — `expr` type-checks
bindings against it and a run's supplied inputs validate against it, so a typing mechanism
that replaced it would break both; and published revisions are immutable and digest-pinned
(ADR-0002/ADR-0023), so this must not change a plan's bytes.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A. JSON Schema + `x-communication-input` extension keyword (chosen) | One source of truth; `required`/`default` stay the JSON Schema members the validator already honours; unknown keywords are legal by spec; existing documents stay valid | Type is orthogonal to the JSON Schema `type`, so an author can write a contradictory pair | `jsonSchemaObject` allows `additionalProperties: true` on `properties`, so the annotation already passes today's schema unchanged |
| B. Parallel `spec.inputTypes: {issue: {type: …}}` block | Kept `spec.inputs` a pure schema | Two name sets that must agree; every rename is a two-place edit, and a missing entry is silently optional | — |
| C. Bespoke authoring block that replaces the schema | Richest expression | Breaks `expr.SchemaFromJSON`, breaks input validation, invalidates every existing document | `compiler.go` derives the expression scope from this exact object |
| D. Infer from JSON Schema `format` / `enum` | No new keyword | Cannot carry label/help; `format` is reserved for validation semantics; a bare `type: string` cannot tell `branch` from `agent_profile` | — |

## Decision

**Encoding.** `spec.inputs` remains a JSON Schema `object`. Each member of
`spec.inputs.properties` **may** carry one extension keyword:

```yaml
spec:
  inputs:
    type: object
    required: [issue]
    properties:
      issue: {type: object, x-communication-input: {type: github_issue, label: Issue, help: The issue to work on}}
      base: {type: string, default: main, x-communication-input: {type: branch, label: Base branch}}
```

- `x-communication-input.type` ∈ `github_issue | branch | agent_profile | text | long_text`; an
  unknown value is the compiler error `input_type_unknown`. `label` and `help` are optional
  presentation strings, not validated.
- **`required` stays JSON Schema's `required` array** and **`default` stays JSON Schema's
  `default`** — no shadow copies. A `default` on an **annotated** property that cannot be
  the annotated type is `input_default_invalid`; when the annotated type itself is
  unusable, only `input_type_unknown` is raised.
- A property **without** the annotation is valid and is presented as `text`, as is any
  document written before this ADR — but its `default` is judged by its JSON Schema alone,
  never by the `text` fallback: "treated as text" is a presentation rule, not a retroactive
  type error, so the annotation renames nothing in the schema, the plan or the wire format.
- The JSON Schema `type` must describe the runtime shape below (`object` for `github_issue`,
  `string` for the rest). The compiler does not cross-check it in this step; run-input
  validation does, and mismatch fails closed there.

**Runtime value shapes** — what a node sees through `${{ inputs.<name> }}`:

| type | shape |
|---|---|
| `github_issue` | `{number: int, title: string, body: string, url: string, repo: string}` |
| `branch` | string (short ref name, e.g. `main`) |
| `agent_profile` | string — an agent profile id (ADR-0058) |
| `text`, `long_text` | string (`long_text` is only a widget hint: textarea vs input) |

**Bindings.** Unchanged: `${{ inputs.issue.body }}`, `${{ inputs.base }}` — the annotation
never touches the schema tree, so `expr.SchemaFromJSON` types those paths from the
property's `type`/`properties`.

**Trigger mapping (specified here; built in a later step).** Stored **on the trigger**, not
in the pipeline document: a trigger row names the inputs it fills, so one workflow can be
fired by an issue trigger and a schedule with different fillers. An **issue trigger** fills
its `github_issue` input with the matched issue in the shape above; a **schedule** fills
nothing, so defaults apply and anything unresolved blocks the start; **by hand** fills
every input from the generated form.

**Publish rule (specified here; built in a later step).** For each `required` input with no
`default`: if an **assigned trigger** can fill it, publish reports nothing; if none can, it
emits a **WARNING** — not an error — because assignments stay editable *after* publish, so a
hard failure would refuse a workflow one edit from complete. The authority is the **run
start**: a required input with no value from trigger, form or default is refused with an
error naming the input.

**Compatibility.** No migration, no schema-version bump, no plan-format change:
`InputSpecs()` is **derived** from `Plan.Inputs` on demand rather than stored as a new plan
field, and the annotation lives inside the `spec.inputs` object the plan already copies
verbatim — plan bytes, and the digest a run pins, are unchanged either way. Unknown
annotation and sibling keywords are ignored (JSON Schema's forward-compatibility rule): a
future type (e.g. `github_pr`) raises `input_type_unknown` on an older compiler rather than
silently working.

### Note (2026-11-02, design review round 2) — the warning's reach, and what never fills `repository`

Two questions came out of the 1j review; both are answered here so the rule is not
re-litigated from the prose:

1. **The warning covers every trigger kind and every required input.**
   `input_unfillable_by_trigger` is evaluated per (assigned trigger, required input with no
   default) pair over the whole trigger table of the pipeline — an issue trigger that fills
   only its mapped `github_issue` input is warned once for each *other* required input
   (`goal`, `repository`, …) exactly like a schedule is, and the validate/publish bodies are
   sorted by (trigger, input) so the UI renders one `!` line per warning under the trigger
   row it names. There is no schedule-only arm.
2. **The assignment's repository is not an implicit input filler.** ADR-0060's repo pin (and
   an issue trigger's own `repository_id`) puts a repository behind the **run's** repository
   field at fire time; it never materialises a `repository` **input** the plan declares —
   the fire paths stamp only the literal input names the trigger itself carries (a
   schedule's `inputs` object, an issue trigger's template inputs) plus the resolved
   `github_issue` mapping. ADR-0060's fixed `repository` name is read *from* the inputs
   when the trigger supplies it, to resolve a project-wide assignment's run; it is never
   written *into* them. So a required `repository` input with no default is genuinely
   unfillable by a trigger that does not name it: the warning is correct, and the
   run-start refusal (`missing_input`, § “Publish rule”) remains the authority.

## Consequences

Positive: the form, the Inputs tab and trigger mapping read one derived `[]InputSpec`
(`{Name, Type, Label, Help, Required, Default}`, sorted by name) instead of parsing YAML;
annotation-free documents keep working untouched.

Limitations: the annotated `type` and the JSON Schema `type` can disagree in an authored
document (cross-check deferred); `label`/`help` are unvalidated free text the UI must
escape; `Default` is `any` in the loader's number model (`int64`/`float64`); the
warning-vs-error rule needs the trigger store, so it cannot live in the compiler alone.

## Security/privacy

Inputs are untrusted author-supplied values that reach agent prompts. The annotation adds no
new trust boundary: values still enter through the validated run-request body against the
pinned schema and render inside the run's sandbox (ADR-0019), and never carry secrets —
`agent_profile` is an id, not a credential (ADR-0058, ADR-0061). Failure mode is
fail-closed: an unknown type or ill-typed default blocks publish, and an unfillable required
input blocks the run start rather than arriving as an empty string.

## Verification

`internal/pipelines/compiler/inputs_test.go` (unit, the real loader→schema→compiler path,
no mocks): the five types parse with label/help, name-sorted; an un-annotated property
yields `text`; an unknown type — including a non-string or non-mapping annotation — yields
`input_type_unknown` and degrades the input rather than dropping it; an ill-typed default on
an annotated input yields `input_default_invalid` (a number for `branch`, a scalar for
`github_issue`, a non-integer `number` member) while well-typed ones and the un-annotated
`fanout: {type: boolean, default: false}` of the committed m4 seed yield none; `Required`
comes from the `required` array; `InputSpecs()` survives a plan JSON round trip with no
`input_specs` field in the plan bytes. `body_scope_test.go` and `policy_test.go` compile the
real seed document and guard that rule. Pending before Accepted: the run form/API, the
trigger-mapping migration, the publish WARNING, and an E2E firing an issue trigger that reads
`inputs.issue.title` in a node.

## Migration/rollback

Additive: no migration, no rewrite; authors opt in per property. Rollback is deleting the
annotation — the property stays a valid `text` input, pre-existing documents are unaffected,
and plans are byte-identical either way, so no revision needs recompiling.
