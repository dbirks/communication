# ADR-0022 — The CEL binding subset: syntax, allowed roots, and resource limits

- **Date:** 2026-10-15
- **Status:** Proposed
- **Owners:** M4 contract implementers (compiler, worker runtime)
- **Related decisions / contracts:** D-013 (Proposed — this record is the spike that validates it),
  D-019, D-007; `communication-spec/03-pipeline-engine.md` § "Bindings and expressions",
  `01-domain-model.md` invariants 4/6, `12-test-strategy.md` (property/fuzz: "CEL/resource limits"),
  ADR-0021 (two digests; canonical AST text), ADR-0016 (fenced writes); spike
  `$HOME/.cache/communication-lab/m4-spike/SPIKE-NOTES.md` § "CEL subset probe"; contract
  `docs/m4-contract.md`

## Context

`03` asks for "a deliberately restricted CEL subset … with allowlisted functions and budgeted
evaluation; never evaluate Go templates with method access or arbitrary code", and puts binding
syntax at the most-used point of the product: `${{ inputs.goal }}` in prompts,
`nodes.review.outputs.approved == true` in routing and loop predicates. Four things have to be
decided before the compiler, the UI's expression helper and the worker can exist:

- **What a binding can even be.** `${{ … }}` appears inside a longer string (a prompt), as an
  entire field value (`cwd`, `items`), and bare, with no delimiters at all (`passWhen` in the spec
  example). Those are three different compilation targets and the provisional schema admits all of
  them as `string`.
- **What the expression can see.** Roots, presence semantics, and what an absent value means. The
  answer decides whether a skipped branch is a business `false` or an execution error — which `03`
  already legislates ("An invalid condition is an execution error, not a business fail", and for
  `until`: "failures not implicitly 'false'").
- **How it is bounded**, given that node outputs are arbitrary JSON: heterogeneous maps push a
  CEL environment toward `dyn`, and `dyn` erases exactly the type errors an author wants at
  validate-time.
- **How it is pinned.** Expressions are part of an immutable revision (ADR-0002), so the
  compiler's normalizer must be stable and its output recordable.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| **A. cel-go with macros cleared, one `has()` macro, a function allowlist enforced by an `ASTValidator`, `dyn`-typed roots, and a hard cost limit (chosen)** | Real parser + type checker instead of a hand-rolled one; `CostLimit` is measured to abort; macros are the only unbounded feature and clearing them removes comprehensions outright; allowlist validator is 20 lines and rejects future stdlib growth by default | `dyn` roots mean output-field types are not statically checked; two error classes (compile vs eval) must both map into `binding_error`; the allowlist must name CEL's internal operator spellings (`@in`) | spike `cmd/celprobe`: `exists`/`map` → `undeclared reference to 'exists'`; `now()` → undeclared; `matches()`/`type()` → `function "matches" is outside the Communication CEL subset`; a 5000-item comprehension in a permissive env → `operation cancelled: actual cost limit exceeded` (cost 201 against a 200 budget) |
| B. cel-go with the standard macro set and a cost limit only | Authors keep `filter`/`all`/`exists`; less to explain | Cost is attacker-authored and bounded only by a budget that must then be high enough to be useful; loop-shaped expressions in a routing predicate are exactly the "complex graphs become impossible to debug" risk (R5) | spike: with macros enabled, one 200-cost budget is exceeded by a list the engine itself produced |
| C. Hand-rolled mini-expression language (`==`, `&&`, `!`, field paths) | Absolute control; no dependency; trivially canonical | A second parser, type checker and test matrix to own forever; `03` names CEL, and every future capability (string helpers, list predicates) is our problem; no AST to canonicalize for free | compared; rejected: the spike's operator-name findings would recur as our own bug class |
| D. Go `text/template` orexpr-style evaluation over a JSON map | Zero new dependency, familiar | Explicitly forbidden by `03`; method access and pipeline semantics are a code-execution surface; no cost model | rejected on `03` grounds |
| E. JSON Logic / a declarative predicate tree in YAML (no expression language at all) | Trivially serializable and UI-renderable; no compiler | Loses the ergonomic single line the spec's examples are built on; every future operator becomes a schema change rather than an allowlist entry | compared; kept as the *fallback* if the compiled-AST storage in § 5 proves unstable |

## Decision

### 1. Three binding positions, one expression language

| Position | Field examples | Compilation | Failure class |
|---|---|---|---|
| `bindingText` | `config.prompt`, `config.summary`, `artifact.publish.name` | split into literal/expression segments; each `${{ … }}` compiles to CEL of **any** type and is stringified by the rules of § 4 | `syntax_error` at validate-time; `binding_error` at run |
| `bindingValue` | `items`, `targetRepository`, `artifact.publish.from.value`, `args[*]`, `env[*]` | whole-string `${{ expr }}` only — exactly one expression, nothing around it — and the result keeps its JSON type | as above, plus `type_mismatch` against the declared field type |
| `expression` | `condition.cases[*].when`, `until.passWhen`, `until.failWhen`, `node.when` | **bare CEL, no delimiters** (the delimiters would be noise in a field that is by definition an expression); must type-check to `bool` | `syntax_error`, `non_boolean_expression` |

The spec's example mixes positions 2 and 3 (`passWhen: nodes.review.outputs.approved == true`
written bare next to `prompt: '… ${{ inputs.goal }}'`), which is exactly why the provisional schema
lets it through; the positions are now named, and `validate` rejects `${{ … }}` inside an
`expression` field and a bare expression in a `bindingValue` field.

**No escapes.** There is no way to write a literal `${{` inside `bindingText` (the spike's
`$${{ escaped }}` probe shows a naive splitter producing two segments, and a correct splitter would
still need a rule). A prompt that must contain that sequence is written as a YAML block scalar
whose text simply does not include the delimiter, and the validator's error names the offset. This
is a deliberate limitation, not an omission.

### 2. Roots, and what each resolves to

| Root | Shape | Notes |
|---|---|---|
| `inputs` | the run's validated input object | pipeline `spec.inputs` JSON Schema |
| `nodes.<id>` | the **node result envelope**: `{status, outcome, outputs, artifact_refs}` | see § 3; `<id>` must be a declared node in scope, checked at compile time (invariant 6) |
| `item`, `items` | inside a `for_each` body: the element, and the full list with `{index, item}` elements | only legal in a `for_each`/`parallel` scope |
| `loop` | inside an `until` body: `{iteration, previous}` (`previous` = prior iteration's `resultBindings`, or an empty object on iteration 1) | `carryForward` |
| `run` | `{id, project_id, revision_digest, triggered_by, started_at, attempt_count}` — never budget internals | |
| `parameters` | inside a `NodeTemplate` expansion only, and only the template's declared parameters | resolved at compile time; a template may not read `run` or another node |

No `secrets`, no `workspace`, no `env`, no filesystem or HTTP root. The spike's
`${{ workspace.repo.root }}` (present in the spec's own example) is **not** a legal root: workspace
placement is node config (`config.workspace.repositories` + a relative `cwd`), which ADR-0017's
per-run layout can actually honour. Unknown roots fail at validate-time
(`undeclared reference to 'unknown_root'`).

Node ids are constrained to `^[a-z][a-z0-9_]{0,62}$` precisely so every id is a legal single CEL
selector — the provisional schema's `^[a-zA-Z][a-zA-Z0-9_-]*$` admits `my-step`, which turns
`${{ nodes.my-step.outputs.x }}` into a subtraction. That is a **reserved-word-free** namespace with
one exception: an id may not be `in`, `as`, or `_`.

### 3. Absence, skipping, and the totality rule

CEL on heterogeneous maps **errors** on a missing key, and `&&` does not swallow it: the spike's
`missing-node` case → `no such key: review`, and `unguarded-missing-and` → error even though the
other operand was `true`. Silent-`false` would be worse: it would turn a skipped reviewer into a
failed review.

Therefore the engine materializes an envelope for **every declared node in scope** before any
expression in that scope evaluates: an unscheduled or skipped node is
`{status: "skipped", outcome: null, outputs: {}, artifact_refs: []}`, and `outputs` is always an
object. Consequences:

- A predicate over a node that did not run reads `status == "skipped"` — a real, testable value —
  and `nodes.review.outputs.approved == true` over it yields `false`, which `03` calls a *route*
  outcome, not an execution error. Missing-ness that is not a skip (an unrun sibling inside the
  same iteration, a reference the compiler allowed but the scope forbids) stays a
  `binding_error`, because the envelope is always present.
- `has(nodes.review.outputs.approved)` is the only way to test an *optional output field* and is
  the only macro kept, because without it authors would write `… && …` chains that error on the
  left operand. `03`'s "`until` … accepts a condition that always returns indeterminate" edge case
  is this: an expression that errors is *not* `false`; it fails the scope with
  `predicate_error` and the recorded CEL message, and `12` case 7 requires the bounded
  termination to be visible.
- `condition` and `until` predicates are evaluated in the **control plane** (cheap, deterministic,
  no workspace), never in the worker: a worker cannot influence routing by what it reports.

### 4. Types, `dyn`, and stringification

Roots are declared `dyn` because node outputs are arbitrary JSON. Three rules recover the type
discipline that costs:

1. **Declared output schemas are compiled, not trusted**: every node's `outputs` JSON Schema is
   compiled into a *reference table* the compiler uses to (a) reject an expression that selects a
   field no declared output can produce (`unknown_field`), and (b) reject an operand type
   combination that can never match (`type_mismatch`, e.g. `outputs.approved == "yes"` when
   `approved` is declared `boolean`). Validate-time errors, not runtime ones.
2. **Produced output is JSON-Schema-validated before it is visible** (invariant 4): an agent
   returning `approved: "yes"` against `approved: boolean` is `invalid_output` on that attempt —
   which matters because the spike shows CEL comparing `outputs.approved == true` with
   `approved: "yes"` to plain `false`, no error. Schema validation is the *only* thing standing
   between a malformed reviewer reply and a silent "not approved".
3. **Stringification is declared**: in `bindingText`, a JSON object/array segment serializes as
   compact canonical JSON (ADR-0021 § 5 subset), a number via Go shortest round-trip, a boolean as
   `true`/`false`, and `null` as the empty string. There is no locale, no `%v` of a Go struct, and
   no truncation — prompts that need less than the whole value use `size()`/slicing? No: they
   declare an output field, not a formatter.

String/number equality is *not* coerced (`"3" == 3` is false, and CEL does not error on it), so § 4
rule 1 is what catches that class at publish time.

### 5. Environment, limits, and what is stored

```go
cel.NewEnv(
    cel.ClearMacros(), cel.Macros(cel.HasMacro),
    cel.ParserExpressionSizeLimit(2048), cel.ExpressionNodeLimit(256),
    cel.ExpressionNestingDepthLimit(16),
    cel.ASTValidators(allowlistValidator),      // by name, incl. CEL's internal spellings
    cel.Variable("inputs", cel.DynType), cel.Variable("nodes", cel.DynType),
    cel.Variable("item", cel.DynType),   cel.Variable("items", cel.DynType),
    cel.Variable("run", cel.DynType),    cel.Variable("loop", cel.DynType),
    cel.Variable("parameters", cel.DynType),
)
// evaluation only ever: env.Program(ast, cel.CostLimit(200))
```

- Allowed functions, by **observed** name — the operator spellings are CEL's, not ours
  (`_&&_`, `_||_`, `!_`, `_==_`, `_!=_`, `_<_`, `_<=_`, `_>_`, `_>=_`, `_+_`, `_-_`, `_*_`, `/_`,
  `_%_`, `_?_:_`, `@in`): plus `has`, `size`, `contains`, `startsWith`, `endsWith`, `string`, `int`,
  `double`, `bool`. The spike's first allowlist rejected `"approved" in nodes.review.outputs`
  because the `in` operator compiles to `@in`, not `_in_` — the allowlist is therefore pinned by a
  test that evaluates one expression per allowed name and fails if a name changes.
- Everything else is refused, including `matches` (a regex engine is a CPU budget we did not
  budget), `now`/`timestamp` (nondeterminism inside a pinned revision), `type`, and all
  comprehensions. New functions are added by ADR-shaped PRs with a cost measurement, never by
  "it's in the stdlib".
- Budgets: `200` actual cost per evaluation (observed: a 4-clause equality chain costs 20; a
  single comparison costs 5), plus per-run aggregate caps — ≤ 64 compiled expressions per
  revision, ≤ 10 000 evaluations per run (the `for_each`/`until` fan-out is what this bounds, and
  the reconciler counts them). Cost exhaustion is `predicate_cost_exceeded`, an execution error.
- Determinism: the control plane evaluates with no I/O and no clock reads in the environment
  (`now()` is undeclared), so the same envelope always yields the same route. Time-dependent
  predicates are expressed as deadlines on gates, not as expressions.
- Stored per expression, in the compiled plan: source text, normalized AST text
  (`cel.AstToString` — observed to unify `a==true`, `(a) == true`), and the reference list
  (roots/field paths) the runtime uses to build the envelope. `plan_digest` (ADR-0021 § 6) covers
  this, so a cel-go upgrade that changes normalization is visible rather than silently re-pinning
  revisions.

## Consequences

- Positive: routing and loop predicates get a real parser/type-checker, and the two bug classes the
  spec worries about (implicit-false on a skipped node; malformed output read as a verdict) have
  named, tested answers rather than folklore.
- Positive: `condition` needs no new "route" edge syntax in v1alpha1 (ADR-0021 Decision 4): a
  `condition` emits `outputs.route`, and downstream nodes gate with `when` — which is also what
  makes `skipped` reachable and testable.
- Negative: three binding positions is a real authoring concept to learn, and the spec's own
  example violates two of them (contract § 9 lists the diffs).
- Negative: `dyn` means the type discipline comes from declared output schemas; a node that
  declares no `outputs` schema gets unchecked expressions over `outputs` of unknown shape — so the
  compiler requires an `outputs` schema on any node another node's expression reads from
  (`undeclared_output_schema`), which is friction on terse drafts.
- Negative: no comprehensions means "did any finding mention the auth module?" needs a `model.chat`
  or `process.exec` node instead of a one-liner. Accepted: that is a graph shape, and it is
  debuggable.
- Negative: `200` cost is a measured but arbitrary number; the aggregate caps are the ones that
  matter for R7, and both must be re-measured in the M4 exit run.
- Dependency: `cel-go v0.31.0` is the last release under `github.com/google/cel-go`; a migration to
  `cel.dev/cel-go` is required before an upgrade past v0.31 and must re-check `plan_digest`
  stability (Verification).

## Security/privacy

- Expressions are evaluated **in the control plane** with no filesystem, no network, no clock and
  no environment access, so a published graph cannot make the API read a file or a secret. There is
  no `secrets` root by design; a node receives secret material only through ADR-0018 mounts
  resolved at launch, and no expression can name one.
- The allowlist is a deny-by-default *validator*, not a curated environment: cel-go's stdlib grows,
  and a function added upstream stays unusable here until it is named in the allowlist and
  measured. That is the direction the risk wants.
- `bindingText` segments interpolate produced JSON into **prompts** — a prompt-injection vector
  from one node's output into another node's instruction (e.g. a GitHub issue body into an
  implementer's prompt). The subset cannot mitigate it; the mitigation is that artifacts and
  produced output are project-scoped data, node output validation (invariant 4), and the profile's
  permission mode (`04`). Recorded here because it is this ADR that makes the interpolation
  possible.
- Cost limits bound CPU per evaluation but not memory: `size()` on a 5 MB produced JSON is cheap
  and the payload size is bounded by ADR-0020 artifact/output size limits, not by CEL. Output size
  caps are therefore a precondition of these limits being meaningful (contract § 6).
- CEL error text is echoed into events (`predicate_error.detail`) and into the UI. It quotes
  variable names, not values, but the worker/compiler must still treat it as untrusted-for-length:
  truncated to 512 bytes, redaction-scanned (ADR-0013).

## Verification

Observed 2026-10-15 in the spike module (`cmd/celprobe`, `cel-go v0.31.0`, budget 200).

- Rejected at compile: `nodes.review.outputs.findings.exists(f, f != "")` →
  `undeclared reference to 'exists'`; `.map(f, f)` likewise; `now() > 0` → `undeclared reference
  to 'now'`; `"x".matches(".*")` → `function "matches" is outside the Communication CEL subset`
  (validator); `type(…) == bool` → same validator; `unknown_root.field == 1` → `undeclared
  reference to 'unknown_root'`.
- Accepted and evaluated: `nodes.review.outputs.approved == true` → `true`, cost 5;
  `size(inputs.goal) <= 4096` → `true`, cost 4; `has(nodes.review.outputs.approved) && …` → `true`,
  cost 9; `"approved" in nodes.review.outputs` → `true`, cost 4 (only after `@in` was allowlisted);
  `cond ? "go" : "stop"` → `"go"`, cost 4; `inputs.max_retries > 4 - 1` → `false`, cost 4.
- Absence/type semantics: `missing-node` → eval error `no such key: review`;
  `missing-output-key` → `no such key: approved`; guarded by `has()` → `false`;
  `unguarded-missing-and` → eval error even with a `true` right operand;
  `string-not-bool` (`approved: "yes"` vs `== true`) → **`false` with no error**;
  `null-output` → `false`; `json-float-vs-int` (`exit_code: 0.0` vs `== 0`) → `true`.
- Cost: restricted env, 4-clause chain → cost 20; same source with macros enabled over a 5000-item
  list → `operation cancelled: actual cost limit exceeded` at cost 201; nested
  `map(...).filter(...).size()` → 206, same abort. With macros cleared, the same expression is a
  compile error, so the budget is a backstop rather than the primary bound.
- Normalization: `nodes.review.outputs.approved==true`, `(nodes.review.outputs.approved) == true`
  and `nodes.review.outputs.approved == true` all canonicalize to the same AST text; `!= false`
  does **not** collapse to `== true`.
- Interpolation splitter probes: multi-binding text → 3 segments correctly;
  `unterminated ${{ inputs.goal` and `${{ }}` → named errors; `$${{ escaped-looking }}` → 2
  segments (hence "no escapes" in § 1).
- **Not yet exercised**: `unknown_field`/`type_mismatch` against declared output schemas (needs the
  compiler's reference table), the aggregate per-run evaluation cap, and property/fuzz tests over
  generated expressions (contract § 8). `docs/compatibility/` gains no row from this record.

## Migration/rollback

`v1alpha1` expressions are stored as source text inside the immutable canonical document, so the
subset rule is a *validation* policy: narrowing it later cannot silently change a published
revision's meaning, because a run pins `plan_digest` as well as `revision_digest` (ADR-0021 § 6) —
a revision that would compile differently under a new rule is revalidated, not reinterpreted.

Adding an allowed function or root is additive (new expressions validate; old ones are unaffected).
Removing one requires a converter pass with an ADR (D-013's "explicit converter functions across
v1alpha1 → v1beta1"), and until then `validate` refuses the affected drafts while existing
revisions keep running.

Rollback of the dependency itself: if cel-go's module-path move (`cel.dev/cel-go`) turns out to
break the toolchain, pinning `v0.31.0` forever is viable for one milestone; if CEL as a whole
proves unmaintainable here, option E (declarative predicate tree) is the recorded fallback, and it
would be a new ADR that supersedes this one rather than an edit.
