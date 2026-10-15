# M4 design spike (throwaway module, outside the repository)

Run: `go run ./cmd/validate`, `go run ./cmd/probes`, `go run ./cmd/celprobe`, `go run ./cmd/canon`.
Outputs captured in `results-schema-validation.txt`, `results-probes.txt`, `results-cel.txt`,
`results-canon.txt`. Nothing here is imported by the repo; it exists to make the library and
schema decisions in ADR-0021/ADR-0022 observable.

## Pinned candidates (module `communicationlab/m4spike`, go.mod)

| Library | Pinned | Why this version |
|---|---|---|
| `go.yaml.in/yaml/v3` | v3.0.5 | the maintained yaml.v3 home; strict duplicate-key and alias accounting |
| `github.com/santhosh-tekuri/jsonschema/v6` | v6.0.3 | the only candidate here that implements draft 2020-12 and structured error output |
| `github.com/qri-io/jsonschema` | v0.2.1 | control candidate: keyword sets stop at 2019-09 |
| `github.com/xeipuuv/gojsonschema` | v1.2.0 | control candidate: draft-07 only |
| `github.com/google/cel-go` | v0.31.0 | **last release published under that module path** |
| `golang.org/x/text` | v0.43.0 | NFC normalization for the digest probe |

* cel-go v0.32.0 declares `module cel.dev/cel-go`; `go get github.com/google/cel-go@v0.32.0`
  fails with `module declares its path as: cel.dev/cel-go but was required as:
  github.com/google/cel-go`. Any M4 ADR that names `github.com/google/cel-go` must therefore pin
  `v0.31.0`, or the repo must migrate imports to `cel.dev/cel-go` deliberately.

## Schema harness (cmd/validate): every example × three validators

2 of 5 examples (`feature-development.yaml`, `process-ready-issues.yaml`) PASS structurally
under all three validators; 3 of 5 (`node-template-reviewer.yaml` = `NodeTemplate`,
`project-binding.yaml` = `PipelineAssignment`, `secret-mounts.yaml` = no `apiVersion`/`kind`)
FAIL — the provisional schema is `kind: const Pipeline` only, while `communication-spec/examples/`
ships four different document shapes. All five round-trip stable through YAML→JSON→canonical
bytes.

## Strictness probes (cmd/probes, 15 one-bug-at-a-time documents)

Observed under the provisional schema vs. a candidate strict schema (`candidate/pipeline.schema.json`):

| probe | provisional | candidate | note |
|---|---|---|---|
| vacuous node config (`typo`, `prompt2`) | PASS | FAIL | per-kind `config` schemas are what make typos visible |
| `${{ }}` string in an integer budget | PASS | FAIL (`got string, want integer`) | examples/process-ready-issues.yaml does exactly this |
| duplicate node id | PASS | PASS | **not catchable structurally** — compiler job |
| self-dependency | PASS | PASS | compiler job (DAG) |
| dangling `dependsOn` | PASS | PASS | compiler job (reference integrity) |
| `spec.inputs` as a name→type map | PASS | FAIL (`missing property 'type'`) | inputs/outputs must be JSON Schemas |
| nonsense `policies` | PASS | FAIL (`minimum: 1`, unknown key) | budgets are typed fields |
| nonsense `until.config.body.nodes` | PASS | FAIL (id pattern + kind enum) | composite bodies need recursion |
| `kind: human.gate` | FAIL | FAIL | roadmap says "human gate"; enum says `gate` + `human.approval` |
| `carryForward: yes` | PASS | FAIL (`got string, want boolean`) | YAML 1.2 keeps `yes`/`on` strings |
| inline secret in `config.env` | PASS | PASS | invariant 5 is compiler-only, never schema |
| `secretRefs: ["postgres://u:p@h/d"]` | PASS | FAIL (reference pattern) | shape is enforceable, value-ness is not |
| `kind: NodeTemplate` | FAIL | PASS | needs one schema per document kind |
| `kind: PipelineAssignment` | FAIL | FAIL | no schema exists for it at all (07 makes it first-class) |
| `secret-mounts.yaml` | FAIL | FAIL | not an `apiVersion`/`kind` document |

Library behaviours observed:

* santhosh v6 refuses a schema whose `pattern` uses ECMA-262 lookarounds
  (`error parsing regexp: invalid or unsupported syntax: (?!`) and a nested repeat
  (`invalid repeat count: {0,31}`) → the canonical schema must be lookahead-free;
  path safety is expressed as a positive pattern plus `not` clauses.
* santhosh v6 registers a schema under its `$id`; adding it under a synthetic URL produced
  `missing reference` for internal `$ref`s. Use `$id` as the compile location.
* qri-io v0.2.1 and xeipuuv v1.2.0 both validate the *Pipeline* documents correctly but neither
  understands 2020-12 `$defs`/`oneOf` framing fully: qri reports only top-level failures
  (`#/$defs/node` with hidden sub-errors), xeipuuv resolves `$ref: "#/$defs/node"` only because it
  ignores unknown keywords. Error detail is not good enough for an editor. Chosen: santhosh v6.
* The corrected sample (`candidate/feature-development-corrected.yaml`) **FAILS** the provisional
  schema (`additional properties 'retry', 'timeoutSeconds' not allowed`) and **PASSES** the
  candidate: the provisional schema cannot express per-node retry/timeout at all, which `03`
  requires.

## CEL subset probe (cmd/celprobe)

Restricted env = `cel.NewEnv(cel.ClearMacros(), cel.Macros(cel.HasMacro),
ParserExpressionSizeLimit(2048), ExpressionNodeLimit(256), ExpressionNestingDepthLimit(16),
ASTValidators(allowlist), Variables(inputs, nodes, item, items, run, parameters))`,
evaluated with `cel.CostLimit(200)`.

* Rejected at compile: `exists(...)`/`map(...)` macros (`undeclared reference to 'exists'`),
  `now()` (undeclared), `matches()` and `type()` (allowlist validator: `function "matches" is
  outside the Communication CEL subset`), `unknown_root.field` (undeclared root).
* Accepted: `==`,`!=`,`&&`,`||`,`!`,`<…>=`, arithmetic, `?:`, `has()`, `"k" in map`,
  `size()`, `contains()`, `startsWith()`, `endsWith()`, casts `string()/int()/double()/bool()`.
* The `in` operator compiles to function name **`@in`**, not `_in_` — the first allowlist attempt
  rejected `"approved" in nodes.review.outputs` until `@in` was listed.
* Missing keys are **errors**, not false: `nodes.review.outputs.approved` with no `review`
  → `no such key: review`; `&&` does not suppress it (`unguarded-missing-and` → eval error).
  `has(...)` before the access converts it to `false`.
* Wrong types compare **false silently**: `outputs.approved == true` with `approved: "yes"` →
  `false`, no error. JSON numbers compare across int/float (`exit_code: 0.0 == 0` → true),
  and `null == true` → false. So output-schema validation at the node boundary — not CEL — is
  what stops a malformed reviewer reply from reading as "not approved".
* Cost: with macros cleared, a 4-clause chain costs 20 and nothing can amplify. In a permissive
  env the same budget aborts: `items.exists(i, i == 4999)` over 5000 items →
  `operation cancelled: actual cost limit exceeded` (cost 201), nested `map/filter` → 206.
  Clearing macros is the primary bound; `CostLimit` is the backstop.
* `cel.AstToString` normalizes whitespace and redundant parens
  (`a==true`, `(a) == true` → `nodes.review.outputs.approved == true`), so the compiler can store
  a canonical expression string; it does **not** normalize `!= false` into `== true`.
* `${{ }}` splitting: multi-binding text splits correctly; `unterminated ${{ …`, `${{ }}` are
  detectable errors; a `$${{ … }}` "escape" is not handled by the naive splitter (2 segments) —
  the contract must therefore forbid escapes rather than support them.

## Canonicalization/digest probe (cmd/canon)

* Key order, flow-vs-block style, quoting and comments do not change canonical bytes
  (`same-canonical-bytes-regardless-of-key-order=true`, `same-canonical-after-yaml-reparse=true`).
* `yaml.v3` **rejects duplicate keys** (`mapping key "a" already defined at line 1`) and
  **refuses alias bombs** (`document contains excessive aliasing`) — both desirable, free.
* Aliases and **merge keys (`<<`) are silently applied** (`use: {p:1,q:3}`), and anchors do not
  survive the JSON round trip: the digest covers the *expanded* document. Export must therefore be
  normalized, and GitOps textual diff is not identity.
* Type surprises that a hash must not absorb silently: `2026-10-14` decodes as `time.Time`
  (canonical `2026-10-14T00:00:00Z`), `0123` as **octal 83**, `0o17` as 15, `1_000` as 1000,
  `1:30` as the string `"1:30"`, `1e999` as the string `"1e999"`, `.inf` as `+Inf`
  (`json: unsupported value: +Inf`), and `9223372036854775808` (int64 overflow) as a number.
  `yes`/`on` are strings while `true`/`True` are booleans.
  → v1alpha1 must reject non-finite/oversized numeric scalars and type-inferred timestamps in
  contract positions, and require quoting where a string is meant.
* NFC matters: `café` composed and decomposed hash differently
  (`raw-digests-equal-for-NFC-variants=false`); normalizing first makes them equal
  (`after-NFC-digests-equal=true`).
* Multi-document streams parse as `docs=2` (second document silently ignored by the plain
  decoder) → the loader must reject more than one document per file.
