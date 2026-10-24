# Home-cluster sample pipelines

Three sample pipelines: two that run on the home-cluster worker **without ACP
credentials** — no `agent.acp` node, the thinking step is `model.chat`, one
OpenAI-compatible completion against the operator's endpoint (`qwen3-8-27b`, the
only model in the worker's `COMMUNICATION_MODEL_CHAT_MODELS` allowlist) — and
one agent-driven sample, `issue-to-pr.yaml`, on pi agents (the `pi` launcher,
ADR-0059) with the allowlisted GitHub push token (ADR-0045).

| File | What it does |
| --- | --- |
| `plan-with-approval.yaml` | Inputs `goal`, `repository`. `survey` (`process.exec`: repo file list + README head) → `plan` (`model.chat`, reads `${{ inputs.goal }}` and `${{ nodes.survey.outputs.stdout_preview }}`) → `approve` (`human.approval`, maintainer, 24 h) → `publish_plan` (`artifact.publish` of `plan.md`). |
| `security-review.yaml` | Input `repository`. `scan` (`process.exec`: grep/find sweep for credential-shaped literals, secret-looking assignments, dangerous exec patterns and key material; report written to `scratch/scan-report.txt`) → `summarize` (`model.chat`: findings by severity) → `publish_report` (`artifact.publish` of `security-review.md`). |
| `issue-to-pr.yaml` | Inputs `goal` (issue title + body), `repository`, `issue_number` (default 0), `branch_prefix` (default `comm/issue-`). `plan` (`agent.acp`, profile `pi-planner`, read-only checkout, strict JSON plan contract) → `approve` (`human.approval`, maintainer, 24 h) → `implement` (`agent.acp`, profile `pi-implementer`, `run_workspace`, `secretRefs` `project/github-push-token`: implements, tests green, pushes the branch, opens a DRAFT PR with `gh`) → `report` (`artifact.publish` of `delivery.md`). Needs the pi profiles (ADR-0059), the token allowlisted to `pi-implementer` (ADR-0045), worker egress for `github.com`/`api.github.com`, and — for a private repo — the repository's GitHub credential (ADR-0061). |

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

Proven by `go test ./internal/pipelines/ -run Sample`: all files pass loader, schema
validator and compiler with zero diagnostics.
