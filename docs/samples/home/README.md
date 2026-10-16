# Home-cluster sample pipelines

Two pipelines that run on the home-cluster worker **without ACP credentials**: no
`agent.acp` node. The thinking step is `model.chat` — one OpenAI-compatible completion
the worker issues against the operator's endpoint (`qwen3-8-flash-next`, the only model
in the worker's `COMMUNICATION_MODEL_CHAT_MODELS` allowlist).

| File | What it does |
| --- | --- |
| `plan-with-approval.yaml` | Inputs `goal`, `repository`. `survey` (`process.exec`: repo file list + README head) → `plan` (`model.chat`, reads `${{ inputs.goal }}` and `${{ nodes.survey.outputs.stdout_preview }}`) → `approve` (`human.approval`, maintainer, 24 h) → `publish_plan` (`artifact.publish` of `plan.md`). |
| `security-review.yaml` | Input `repository`. `scan` (`process.exec`: grep/find sweep for credential-shaped literals, secret-looking assignments, dangerous exec patterns and key material; report written to `scratch/scan-report.txt`) → `summarize` (`model.chat`: findings by severity) → `publish_report` (`artifact.publish` of `security-review.md`). |

`repository` is the project's repository **binding name** (07), not a URL; the worker
clones it into `repos/<name>` in the run workspace. Both samples pass it to the shell as
`REPO` because `config.cwd` is a schema-literal path.

**Kinds this worker executes today** (`cmd/communication/worker.go`): `process.exec`,
`model.chat`, `artifact.publish`, `agent.acp`. Kinds the control plane settles without a
lease: `condition`, `human.approval`, `until`, `for_each`, `pipeline.invoke`. Scheduling
is not a pipeline field — a 5-field UTC cron hangs off the project assignment (ADR-0032),
added at project → Pipelines → "When to run"; with no schedule there, start a run by hand.

**Click path:** Library → New pipeline → New draft → paste the file → Validate → Publish
→ open the project → Pipelines → Assign → Runs → New run.

**Message bindings work** (ADR-0029): `config.messages` is typed `{role, content}`
(`role`: `system` | `user` | `assistant`) and `content` is a bindingText slot — the
same shape `agent.acp`'s `prompt` is — so `${{ inputs.goal }}` and
`${{ nodes.<id>.outputs.<name> }}` inside a prompt compile to expressions and the
control plane interpolates them at claim time (ADR-0027) before the request leaves the
worker. Inputs and upstream outputs likewise flow through `human.approval.summary` and
`artifact.publish.from.value`.

Proven by `go test ./internal/pipelines/ -run Sample`: both files pass loader, schema
validator and compiler with zero diagnostics.
