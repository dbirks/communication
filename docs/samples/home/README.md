# Home-cluster sample pipelines

Six sample pipelines: two that run on the home-cluster worker **without ACP
credentials** — no `agent.acp` node, the thinking step is `model.chat`, one
OpenAI-compatible completion against the operator's endpoint (`david-birks/qwen3-8-27b`,
the model the lab deployment allowlists — the collective retired the former `qwen3-8-27b` id) — and
four agent-driven samples: `issue-to-pr.yaml` on pi agents (the `pi` launcher,
ADR-0059) with the allowlisted GitHub push token (ADR-0045), `matt-pocock-spec-to-pr.yaml`
and `pstack-feature.yaml` on Claude Code profiles with the APM collections ADR-0084
seeds, and `implement-then-codex-review.yaml` on a Claude Code profile whose diff a
read-only Codex profile reviews.

| File | What it does |
| --- | --- |
| `plan-with-approval.yaml` | Inputs `goal`, `repository`. `survey` (`process.exec`: repo file list + README head) → `plan` (`model.chat`, reads `${{ inputs.goal }}` and `${{ nodes.survey.outputs.stdout_preview }}`) → `approve` (`human.approval`, maintainer, 24 h) → `publish_plan` (`artifact.publish` of `plan.md`). |
| `security-review.yaml` | Input `repository`. `scan` (`process.exec`: grep/find sweep for credential-shaped literals, secret-looking assignments, dangerous exec patterns and key material; report written to `scratch/scan-report.txt`) → `summarize` (`model.chat`: findings by severity) → `publish_report` (`artifact.publish` of `security-review.md`). |
| `matt-pocock-spec-to-pr.yaml` | Inputs `goal`, `repository`, `branch_prefix` (default `comm/spec-`). `spec` (`agent.acp`, profile `claude-matt` — Claude Code with the "Matt Pocock skills" collection — read-only checkout, `to-spec` on the ask, the spec comes back as one markdown document) → `approve` (`human.approval` on the whole spec, maintainer, 24 h) → `tickets` (`agent.acp` `claude-matt`: `to-tickets` cuts the approved spec into ordered tickets) → `implement` (`agent.acp` `claude-matt`, `run_workspace`, `secretRefs` `project/github-push-token`: works the tickets, tests green, pushes the branch, opens a DRAFT PR with `gh`) → `report` (`artifact.publish` of `delivery.md`). Needs a Claude Code login on the worker (ADR-0040), the collection attached to the profile (ADR-0084), the token allowlisted to `claude-matt` (ADR-0045) and worker egress for `github.com`/`api.github.com` (ADR-0035). |
| `pstack-feature.yaml` | Inputs `goal`, `repository`. `survey` (`process.exec`: file list, README head, test entry points) → `plan` (`agent.acp`, profile `claude-pstack` — Claude Code with the "pstack (Claude Code)" collection — through the `poteto-mode` feature playbook) → `approve` (`human.approval`, maintainer, 24 h) → `implement` (`agent.acp` `claude-pstack`: `tdd` order, commits on a `comm/pstack-feature-*` branch, tests green) → `review` (`agent.acp` `claude-pstack`: `interrogate` on its own diff, fixes what it finds, verdict `ship` or `needs-work`) → `report` (`artifact.publish` of `feature.md`). Needs a Claude Code login on the worker and the collection attached to the profile; pushes nothing, so no token. |
| `implement-then-codex-review.yaml` | Inputs `goal`, `repository`. `implement` (`agent.acp`, profile `claude-implementer`: commits the change on a `comm/implement-*` branch in the run workspace) → `review` (`agent.acp`, profile `codex-reviewer` — the `codex` launcher in its `read-only` prompting mode — over that branch's diff, blocking issues first, verdict `approve` or `request-changes`) → `approve` (`human.approval`, maintainer, 24 h, shown both replies) → `report` (`artifact.publish` of `review.md`). Needs a Claude Code login AND a Codex login on the worker (`codex login --device-auth` into the mounted `CODEX_HOME`): without the Codex one the review step fails closed before its session opens (ADR-0019) — the template card says so. |
| `issue-to-pr.yaml` | Inputs `goal` (issue title + body), `repository`, `issue_number` (default 0), `branch_prefix` (default `comm/issue-`). `plan` (`agent.acp`, profile `pi-planner`, read-only checkout, strict JSON plan contract) → `approve` (`human.approval`, maintainer, 24 h) → `implement` (`agent.acp`, profile `pi-implementer`, `run_workspace`, `secretRefs` `project/github-push-token`: implements, tests green, pushes the branch, opens a DRAFT PR with `gh`) → `report` (`artifact.publish` of `delivery.md`). Needs the pi profiles (ADR-0059), the token allowlisted to `pi-implementer` (ADR-0045), worker egress for `github.com`/`api.github.com`, and — for a private repo — the repository's GitHub credential (ADR-0061). |

`repository` is the project's repository **binding name** (07), not a URL; the worker
clones it into `repos/<name>` in the run workspace. The samples that sweep the checkout in
a shell pass it to that shell as `REPO` because `config.cwd` is a schema-literal path.

**One-line form of each row above** (what the Workflows page's template cards quote, and
what the New workflow dialog quotes as the selected starter's hint —
`ui/src/lib/pipeline/templates.ts`, byte-identical copies under
`ui/src/lib/pipeline/templates/`):

| File | Card line |
| --- | --- |
| `plan-with-approval.yaml` | survey the checkout, plan with a model call, hold behind a maintainer approval, publish plan.md |
| `security-review.yaml` | sweep the checkout for credential-shaped literals and dangerous exec patterns, publish security-review.md |
| `issue-to-pr.yaml` | plan a GitHub issue, approve the plan, implement with a pi agent, push and open a draft PR |
| `matt-pocock-spec-to-pr.yaml` | write a spec with Matt Pocock's to-spec, approve it, cut tickets with to-tickets, implement, open a draft PR |
| `pstack-feature.yaml` | plan the feature on pstack's poteto-mode playbook, approve, implement, interrogate the diff, report |
| `implement-then-codex-review.yaml` | implement on Claude Code, review the diff on a read-only Codex profile, approve, publish review.md |

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
