# 07 — Configuration, GitOps and Integrations

## One schema, multiple editors

A pipeline definition is validated using `apiVersion/kind/metadata/spec` plus referenced JSON Schema contracts. Primary authoring surfaces:

1. Browser graph editor (draft changes via typed mutation API).
2. YAML import/export (stored separately or in Git).
3. Communication assistant (same typed mutations with UI navigation and diffs).

**Postgres** is the operational store for drafts, published immutable revisions and assignments. **Git** is an optional declarative source/target, never a second competing live mutable copy. Record import/export direction, commit SHA, origin, schema version and content digest. Incoming Git changes produce candidate draft/revision and conflict information; do not silently overwrite an active published definition. Organization may choose `database` or `git-managed` governance policy, but every execution is pinned to an immutable revision in Postgres.

Schema migrations: explicit converter functions across `v1alpha1 → v1beta1` etc. Reject unknown dangerous enum values; preserve extension namespaces. Provide lint/validate/diff/format commands and dry-run import before actual publication.

### Reusable assets

- **Agent Profile:** versioned runnable ACP/model settings + APM reference/lock digest.
- **Node Template:** versioned parameterized wrapper over built-in node kind; generic templates are installable as organization assets.
- **Pipeline:** graph, nodes and inputs, may invoke other pipeline revisions.
- **Pipeline Assignment:** project-specific trigger, parameters, version/channel policy, concurrency, secret refs and authorized users.
- **Starter Gallery:** read-only bundled examples with descriptive “what it does”, minimum prerequisites, and `Clone to organization` action.

## Trigger/query/action provider contract

**Trigger** emits an event used to start pipelines or enqueue invocations (manual, cron-like schedule, webhook, polling).

**Query** reads external state and returns typed JSON (e.g. list GitHub issues matching label).

**Action** performs external side effect (create issue, comment, push branch, create PR, close issue), with idempotency key + probe/reconcile function where possible.

This does **not** create a second generic issue tracker. Communication owns run invocations/backlog; GitHub/Beads/Linear own their issue data.

### Initial GitHub adapter

- Manual repo URLs/local registered Git repos first; GitHub GitHub App or scoped installation token preferred for service-owned webhook/API, rather than OAuth granting all of a user's GitHub privileges.
- Repository enumeration via integration credential when available; optional user OAuth later for convenience.
- Filter issues by labels/states/assignee; webhook signature verification; event dedupe by delivery ID; periodic polling reconciliation; trigger idempotency tuple `(project, assignment, external_item, revision/window)`.
- Work item metadata `provider`, `external_id`, `canonical_url`, `etag/update_marker` and minimal cached fields, not authoritative issue body.
- For action retries: transactionally record intent with operation ID, check whether external resource exists (e.g. PR for branch) before repeating. Exactly-once effects cannot be assumed.
- Publish node suite: create commit/branch, push to permitted remote, draft PR, comment/update/close issue; each independently permissioned.

### Other adapters

Define public provider interfaces so Beads, Linear, Jira and others can be contributed without coupling scheduler to task semantics. The start template can simply accept a free-text goal/markdown plan; no issue integration is mandatory.

## Example library to ship

1. **Plan → Human approve → Implement → Run tests → Review → Loop until pass → Create draft PR.** Demonstrates human gates, ACP profiles and explicit publication.
2. **Process ready GitHub issues** at maximum `N` concurrent; trigger/poll query, `for_each`, invoke child implementation pipeline, preserve child observability.
3. **Dependency maintenance:** scheduled inspect/update/tests/review pipeline; default creates a draft PR, never merges automatically.
4. **One-off cross-repo investigation:** ad hoc ACP conversation against multi-repo workspace (no pipeline needed).
5. **Alternative reviewer experiment:** clone stable revision to beta, switch model/profile, assign only one Project; collect metadata for later comparison.

## Version rollout

On publish, assign immutable semantic version and content digest. Projects pin exact revision by default. Promotion of a new revision is an explicit action (per-project or bulk) with preview of affected assignments. Optional channels `stable`/`beta` resolve to a pinned revision **at new run creation**, and current runs remain pinned.

## Budget/limit layers

System quotas bound concurrency, CPU, memory, disk, run duration, loop count, child pipeline depth and recursion. Assignment/project may request lower limits. If usage/cost telemetry is supplied by a provider, store it for visibility but do not assume all agents report equivalent token/billing data.
