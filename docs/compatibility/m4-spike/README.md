# M4 design spike — schema, CEL, canonicalization and execution-shape evidence

Evidence for [ADR-0021](../../adr/ADR-0021-pipeline-schema-canonicalization-and-revision-digests.md),
[ADR-0022](../../adr/ADR-0022-cel-binding-subset-and-resource-limits.md),
[ADR-0023](../../adr/ADR-0023-pipeline-execution-model-runs-node-executions-and-attempts.md) and
[ADR-0024](../../adr/ADR-0024-node-kind-scope-for-m4.md). It answers three questions that could not be
answered by reading: which Go libraries can actually enforce a strict 2020-12 pipeline schema, what
breaks when the spec's own examples are validated, and what a restricted CEL environment really
refuses, accepts and costs. Nothing here is a capability claim about Communication — no product code
ran. Everything here is an observation about a schema, a parser, an expression evaluator and a hash.

The spike was authored **outside** the repository (`$HOME/.cache/communication-lab/m4-spike`, throwaway
module `communicationlab/m4spike`) on 2026-10-15, as its brief required; this directory is the copy
that keeps the evidence with the decisions that cite it. The ADRs' `Related decisions / contracts`
lines still name the original path because that is where the observation was made.

## Provenance

| Item | Value |
| --- | --- |
| Date | 2026-10-15 |
| Host | Arch Linux x86_64, Go `go1.27.2` |
| Module | `communicationlab/m4spike` (its own `go.mod`, **not** part of the root Go module) |
| Inputs read | `communication-spec/schemas/pipeline.schema.json` (PROVISIONAL), `communication-spec/examples/*.yaml` |
| Pinned candidates | `go.yaml.in/yaml/v3 v3.0.5`, `github.com/santhosh-tekuri/jsonschema/v6 v6.0.3`, `github.com/qri-io/jsonschema v0.2.1`, `github.com/xeipuuv/gojsonschema v1.2.0`, `github.com/google/cel-go v0.31.0`, `golang.org/x/text v0.43.0` |
| Summary | [`SPIKE-NOTES.md`](SPIKE-NOTES.md) — per-probe tables, library behaviours, the chosen library set |
| Transcripts | [`results-schema-validation.txt`](results-schema-validation.txt) (5 examples × 3 validators), [`results-probes.txt`](results-probes.txt) (15 one-bug documents + both samples), [`results-cel.txt`](results-cel.txt) (CEL subset/absence/cost/splitting), [`results-canon.txt`](results-canon.txt) (canonical form, digests, YAML type traps) |

## Layout

```
docs/compatibility/m4-spike/
  README.md                     this file
  SPIKE-NOTES.md                the spike's own findings summary
  results-schema-validation.txt cmd/validate transcript
  results-probes.txt            cmd/probes transcript
  results-cel.txt               cmd/celprobe transcript
  results-canon.txt             cmd/canon transcript
  results-contract-probes.txt   contract-phase transcript (added after the copied spike)
  module/                       the throwaway Go module (own go.mod)
    go.mod  go.sum
    cmd/validate/  examples × 3 validators
    cmd/probes/    one-bug-at-a-time documents, provisional vs candidate schema
    cmd/celprobe/  restricted CEL env, allowlist, cost, ${{ }} splitting
    cmd/canon/     canonical form, digests, YAML type traps
    contractprobe/ contract-phase CEL probes (see "Contract-phase addendum" below)
    candidate/pipeline.schema.json                 the strict schema ADR-0021 adopts
    candidate/feature-development-corrected.yaml   the exit sample (see the two deltas below)
    candidate/feature-development-contract.yaml    the exit sample as docs/m4-contract.md § 9.3 ships it
    candidate/feature-development.yaml             the unmodified spec example
```

`module/` is invisible to the repository's build **because it declares its own `go.mod`**: a nested
module is excluded from the root module's package patterns. Verified from the repository root —
`go list ./...` prints no `m4-spike` package, and `go build ./...`, `go vet ./...`, `go test ./...`
and `gofmt -l .` all behave exactly as before the copy landed (`gofmt` is not module-aware, which is
why the copied sources were run through `gofmt -w`; see "Deltas" below).

## Rerun

From this directory's `module/` (needs the pinned modules in the local module cache, or network
access on first run):

```bash
cd docs/compatibility/m4-spike/module
GOFLAGS=-mod=mod go build ./...                      # compiles standalone
GOFLAGS=-mod=mod go run ./cmd/validate >  /tmp/m4-validate.txt 2>&1   # 0
GOFLAGS=-mod=mod go run ./cmd/probes   >  /tmp/m4-probes.txt   2>&1   # 0
GOFLAGS=-mod=mod go run ./cmd/celprobe >  /tmp/m4-celprobe.txt 2>&1   # 0
GOFLAGS=-mod=mod go run ./cmd/canon    >  /tmp/m4-canon.txt    2>&1   # 0
```

`cmd/validate` and `cmd/probes` read `communication-spec/` — resolved as `$M4SPIKE_SPEC_DIR` or the
nearest ancestor directory holding `communication-spec/schemas/pipeline.schema.json`, so running from
this checkout works with no configuration. `cmd/probes` reads `candidate/` relative to the working
directory (or `$M4SPIKE_CANDIDATE_DIR`). `cmd/canon` and `cmd/celprobe` are self-contained.

## Rerun fidelity — recorded because it is itself a finding

Recorded on 2026-10-15 by rerunning all four commands against this copy:

| Harness | Byte-identical rerun? | Observed |
|---|---|---|
| `cmd/canon` | **yes** | `diff` against `results-canon.txt` is empty |
| `cmd/celprobe` | **yes** | `diff` against `results-cel.txt` is empty |
| `cmd/validate` | **no — verdicts yes, ordering no** | every per-example × per-validator PASS/FAIL verdict reproduces; the *order* of santhosh's nested `Causes`/`Properties` arrays and of qri/xeipuuv's `\| `-joined error lists differs run to run |
| `cmd/probes` | **no — same** | 38/38 verdict triples reproduce (`expected-under-candidate-valid=… => MATCHES` on every probe); error-line order within a `candidate: FAIL:` block differs |

That ordering instability is Go map iteration inside the validators, not a bug in the spike. It is the
reason [`docs/m4-contract.md`](../../m4-contract.md) § 2 requires the product's `validate` response to
sort its error list by `(instance_location, schema_location, code, message)` before it is returned or
hashed: an unstable error order would make `revision_digest`-adjacent UX (and any future digest over
a validation report) irreproducible, and an editor that highlights "the first error" would flicker.

## Deltas between the original spike and this copy

Two classes only, both mechanical, so the transcripts above stay the record of the original run:

1. **Path resolution** (`cmd/validate`, `cmd/probes`): the original baked
   `/home/david/dev/communication/communication-spec` and
   `/home/david/.cache/communication-lab/m4-spike/candidate/…` into `const`s. They are now resolved at
   run time as described above. Inputs are the same files, so the outputs are the same.
2. **`gofmt -w`**: import-order and stray-trailing-comma normalizations in `cmd/canon/main.go`,
   `cmd/celprobe/main.go` and `cmd/probes/cc.go`, required because CI runs `gofmt -l .` over the whole
   repository. One visible consequence: `cmd/celprobe`'s section-C header now prints its literal
   `%d` (it was `fmt.Println("…budget=%d ===", )`; `Println` never formatted it, and the recorded
   transcript shows the same literal `%d`).

**Known content bug kept in the copy** (fixed in the contract, not in the evidence):
`candidate/feature-development-corrected.yaml` reads `${{ loop.previous.outputs.review_feedback }}`,
but ADR-0022 § 2 defines `loop.previous` as the prior iteration's **`resultBindings`**, so the path is
`loop.previous.review_feedback`; and its `test` node lists `workspace_lost` in `retriableErrors`,
which ADR-0023 § 7 makes non-retriable. Both are corrected in
[`docs/m4-contract.md`](../../m4-contract.md) § 9, which is the version M4 implements, and listed in
that section's fix table.

## Reading order

1. `SPIKE-NOTES.md` — the tables (schema strictness probes, CEL subset, canonicalization traps).
2. `results-probes.txt` — the measured boundary between what a JSON Schema can catch and what the
   semantic compiler must (duplicate ids, self-dependency and dangling `dependsOn` pass **every**
   schema here).
3. `results-schema-validation.txt` — the spec's own five examples: 2 pass the provisional schema,
   3 do not, and the reasons are three different document shapes the schema never described.
4. `results-cel.txt`, `results-canon.txt` — the evidence behind ADR-0022's environment and
   ADR-0021's canonical form/NFC/`metadata.ui` rules.

## Contract-phase addendum — probes run while writing `docs/m4-contract.md`

Everything under "Provenance" above is the copied spike (2026-10-15, byte-for-byte except the recorded
deltas). Three files were added afterwards, while the M4 contract compiled **every** expression in its
corrected sample pipeline — a check the spike never made, because `cmd/celprobe` only compiled
`nodes.*`/`inputs.*` fixtures:

| File | Why it exists |
|---|---|
| `module/contractprobe/probes_test.go` | four `go test` cases holding the findings below in executable form |
| `module/candidate/feature-development-contract.yaml` | the § 9.3 sample (byte-identical to the contract's fenced block plus a provenance header) — the document those tests read |
| `results-contract-probes.txt` | the literal transcript, commands in its header lines |

1. **`loop` is a parser-reserved identifier in cel-go v0.31.0**, so the root ADR-0022 § 2 declares for
   `until` bodies cannot be named at all: `cel.NewEnv(cel.Variable("loop", …))` *succeeds* and then
   every use fails (`reserved identifier: loop`) — default env or restricted, declared or not,
   `has()`-guarded or not. `nodes.loop` and `run.loop.previous` are fine: the reservation is
   identifier-level. The contract's answer is § 9.1 row 17 (two roots, `previous` + `iteration`, both
   probe-clean) plus a unit test that compiles a selection through every declared root.
2. **`cel.AstToString` line-wraps its own output** — an 86-character `&&` chain comes back containing
   a raw `\n`. ADR-0021 § 6 digests normalized AST *text*, so digesting the raw value would make a
   formatter's column width part of `plan_digest` (contract § 9.1 row 19).
3. **The allowlist has no index operator**: `nodes['loop']` is refused as `function "_[_]" is outside
   the Communication CEL subset`, so a hyphenated node id cannot be reached by quoting — which is what
   makes contract § 9.1 row 2's identifier pattern load-bearing rather than cosmetic.

`contractprobe` is its own package rather than a file beside `cmd/celprobe` because
`cmd/celprobe/main.go` carries a pre-existing vet finding (a `Println` containing a `%d`, line 106)
whose exact text is inside the checked-in `results-cel.txt` transcript: leaving it byte-for-byte
preserves the evidence, and adding tests to that package would make `go test ./cmd/celprobe` fail on
vet. Nothing outside this directory imports any of it, and the root module still cannot see it (nested
`go.mod`).

## What this spike does **not** cover

No Postgres, no worker, no sandbox, no ACP process, no model endpoint and no digest stored in a
database: everything in `results-*.txt` is a schema/evaluator observation from 2026-10-15. The
executable claims ADR-0023 and ADR-0024 make about leases, checkpoints, fan-out and cancellation are
gated on the M4 exit run in [`docs/m4-contract.md`](../../m4-contract.md) § 7, not on this directory.
No `docs/compatibility/*.md` matrix gains a row from this spike — nothing here observed a protocol or
a sandbox.
