# Frontend/backend data dependencies and event subscriptions

Per screen: the exact reads, the exact writes, the SSE scope subscribed, and the cache rule that keeps
the screen honest. Route names come from `api/openapi.yaml` (M1/M2, implemented), `docs/m3-contract.md`
§2 (M3, contracted but not yet in OpenAPI), or `communication-spec/09-api-events-data.md` *(09)*
(proposed only). Anything without one of those three sources is a **gap** and carries a `G#` from
[`README.md`](README.md).

## Mechanisms already fixed by ADRs (the design may not restate these differently)

| Mechanism | Rule | Source |
|---|---|---|
| Transport | `/api/v1` JSON over same-origin cookies; mutations carry `X-CSRF-Token` from `GET /api/v1/me` and pass the `Origin` check | ADR-0014 §1/§4, `ui/src/api/client.ts` |
| Errors | `application/problem+json` for every non-2xx; project-scoped resources the caller cannot see are `404`, never `403` | ADR-0014 §2/§3 |
| Streaming | SSE only; `id: <global_seq>`, `event: <type>`, `data: <envelope>`; reconnect resumes from `Last-Event-ID`; `LISTEN/NOTIFY` is a wake-up, never a delivery | ADR-0014 §5/§6 |
| Gap-safety | a frame with `global_seq <= max rendered` is dropped; delivery may be *late* but never out of order or missing | ADR-0014 §9, `ui/src/api/events.ts` |
| Scopes | exactly two streams today: project and conversation. Conversation rows also carry `project_id`, so the project stream is a superset and **one cursor** serves both | ADR-0016 §1 |
| Conflict | a control `409` body carries the live `control` (+ sometimes `active_turn`) and the UI **adopts** it instead of retrying | ADR-0016 §9, `adoptConflict()` in `ui/src/api/queries.ts` |
| Replica | every response carries `X-Communication-Replica`; the footer badge shows the last one seen | ADR-0014 §7, `ui/src/api/replica.ts` |
| Caching | TanStack Query keyed reads; every SSE frame invalidates its project or conversation subtree | `ui/src/api/queries.ts` |
| Not yet honoured | `Idempotency-Key` and `If-Match`/etag — do not advertise safe retries | ADR-0014 Consequences, `api/openapi.yaml` (gap **G24**) |

Client-side rule that follows from the above: **a screen renders state, never a prediction.** If a
read is not available and no event carries the fact, the screen shows "unavailable", not a client-side
estimate (gap **G17** is the one place an estimate would be tempting).

## Cache-key map (extends the shipped `queryKeys`)

```
me                                  users
project-list                        attention                          ⟨G16⟩
project:<id>   project:<id>:repos    project:<id>:members
project:<id>:conversations          project:<id>:runs                  ⟨G1⟩
project:<id>:assignments            project:<id>:artifacts             ⟨M3⟩
project:<id>:secrets                project:<id>:secret-mounts        ⟨M3⟩
project:<id>:workspaces             project:<id>:approvals             ⟨G7⟩
conversation:<id>                   conversation:<id>:workspace        ⟨M3⟩
run:<id>                            run:<id>:nodes       run:<id>:nodes:<executionId>  ⟨G1/G4⟩
attempt:<id>                        attempt:<id>:sandbox               ⟨M3⟩
pipeline:<id>                       pipeline:<id>:revisions   draft:<id>   draft:<id>:validations  ⟨G1⟩
revision:<digest>   revision:<digest>:diff                             ⟨G13⟩
artifact:<id>       approval:<id>                                      ⟨M3/G7⟩
worker-list         worker:<id>       system:health  system:readiness
system:sandbox      system:compatibility                              ⟨M3/G19⟩
assistant:<conversationId>:trace                                      ⟨G11⟩
```

Invalidation contract (the shipped pattern, generalised): a frame on the **project** stream
invalidates `project:<id>` and everything keyed under it; a frame on the **conversation** stream
invalidates `conversation:<id>` + `project:<id>:conversations` for resource-bearing types only, and
transcript chunks are rendered from the stream rather than refetched (the shipped reason: a refetch per
coalesced chunk is a request storm — see `RESOURCE_TYPES` in `ui/src/api/events.ts`).

---

## 1. Global frame (all screens)

| Need | Route | Notes |
|---|---|---|
| identity, org chip, CSRF token | `GET /api/v1/me` | 30s stale time; `setCsrfToken` on success (shipped) |
| user directory (names for actors) | `GET /api/v1/users` | used by `nameOf`; ids are never the only label |
| health / readiness / replica count | `GET /api/v1/system/health`, `…/readiness` | 15s poll as shipped; readiness `503` is shown, not retried |
| sign out | `POST /auth/logout` | clears the whole cache (shipped) |
| open-approval count in footer | *(none)* | gap **G7/G16** — footer omits the count when absent |

## 2. `/` Attention

| Read | Route | Gap |
|---|---|---|
| visible projects | `GET /api/v1/projects` | — (exists; no pagination, gap **G15**) |
| blocked/stalled runs per project | `GET /api/v1/projects/{id}/runs?state=waiting_human\|interrupted\|failed` | **G1/G16** |
| open approvals | `GET /api/v1/approvals?state=pending` | **G7** |
| conversations with an open turn | `GET /api/v1/projects/{id}/conversations` + `control`/`active_turn` | exists, but per project → N+1; needs **G16** |
| stalled-reason wording | run/approval fields (lease age, `waiting_human` since) | **G17** |

Writes: none — Attention is a navigation surface. Its only mutation is a `Link`.
Events: project streams for the visible projects, debounced; or one aggregate stream if the engineers
prefer that to **G16**. The UI must not open 5 project streams per visible project group without a
plan; **open engineering question** (documented, not decided here).

## 3. `/projects` and `/projects/new`

| Read / write | Route | Status |
|---|---|---|
| list | `GET /api/v1/projects` | shipped (`⟨T:project-list⟩`, `⟨T:project-link-<slug>⟩`) |
| create | `POST /api/v1/projects` + `Idempotency-Key` intended | shipped route, header not honoured (**G24**); `409` copy is the duplicate-name line already written |
| activity rollups on rows | project stream summary events | shipped types only today (`project.created`, `project.member.updated`, `repository.added`); run/approval types are **G1** |

## 4. Project Overview

Everything on the shipped page is kept: `GET /api/v1/projects/{id}`, `…/repos`, `…/members`,
`…/conversations`, `GET /api/v1/agent-profiles`, plus the project SSE stream.

Added rows:

| Region | Read | Gap |
|---|---|---|
| Blocked / Now cards | `GET /api/v1/projects/{id}/runs?state=…` | **G1** |
| Assignments strip | `GET /api/v1/projects/{id}/assignments` | **G1** |
| Workspaces + dirty paths | `GET /api/v1/projects/{id}/workspaces` | M3 contracted (no host paths ever serialized) |
| Recent artifacts | `GET /api/v1/projects/{id}/artifacts?limit=…` | M3 contracted; run filter params missing (**G10**) |
| Sandbox health for this project's workers | `GET /api/v1/system/sandbox` | M3 contracted (**G19** for OpenAPI) |
| Members / repos UI | unchanged routes | — |

Events subscribed: project stream, extended event-type list to include
`run.*`, `node.attempt.*`, `approval.requested|decided`, `artifact.created`,
`workspace.prepared|released|recovery_lost`, `sandbox.verified|enforcement_failed`,
`pipeline.revision.published`, `assignment.promoted` — **all of which need to exist**
(**G1/G2/G7**). `M1_EVENT_TYPES` + `M2_EVENT_TYPES` in `ui/src/api/events.ts` are the precedent for
how the list is pinned per milestone.

## 5. Runs list → Run Inspector

| Data | Route | Notes |
|---|---|---|
| run header (status, pinned digest, actor, inputs, source refs) | `GET /api/v1/runs/{id}` | **G1** |
| stage rollups | rollup fields on the run or `GET /api/v1/runs/{id}/nodes?view=rollup` | **G1/G15** |
| execution tree (paged per branch) | `GET /api/v1/runs/{id}/nodes?parent=…&cursor=…` | **G1/G15** |
| node execution detail | `GET /api/v1/node-executions/{id}` | **G4** |
| attempt detail (outputs, diagnostics, evidence refs) | `GET /api/v1/attempts/{id}` | **G4** |
| sandbox verdict for an attempt | `GET /api/v1/attempts/{id}/sandbox` (M3 gives the turn-scoped `GET /api/v1/turns/{turnId}/sandbox`) | shape exists in M3; run-side alias is **G4** |
| timeline | journal frames filtered to this run | needs `run_id`/`node_execution_id`/`attempt_id` correlation — **G2/G3** |
| artifacts of this run | `GET /api/v1/projects/{id}/artifacts?run_id=…` | **G10** |
| workspace + per-repo refs | `GET /api/v1/workspaces/{id}`, `…/repos/{repoId}/status` | M3 contracted |
| diff content / evidence patch | *(none)* | **G9** |
| checkpoint boundary + redo scope | `GET /api/v1/runs/{id}/checkpoints` | **G5** |
| related conversation | `conversation_id` on the attempt → `GET /api/v1/conversations/{id}` | exists; run-attempt link fields are **G2** |
| definition view | `GET /api/v1/revisions/{digest}` | **G1** (digest-pinned read must exist for old digests forever) |
| Pause / Resume / Cancel | `POST /api/v1/runs/{id}:pause`, `:resume`, `:cancel` | **G1** |
| Retry | `POST /api/v1/runs/{id}:retry` with target node execution/attempt + optional run-local override + required reason | **G1/G5**; override must emit `run.override.applied` (**G6**) |
| Start a run manually | `POST /api/v1/runs` (revision id **or** assignment ref, resolved server-side; `Idempotency-Key` intended) | **G1/G24** |

Events: `run.started|paused|resumed|interrupted|completed|failed|cancelled`,
`node.attempt.started|completed|failed`, `node.execution.*` for state moves,
`artifact.created`, `workspace.*`, `sandbox.*`, `run.override.applied`,
`external_action.intent|reconciled`, `conversation.*` for human-interaction rows (all **G1/G2/G3**).
Subscription scope: project stream filtered by run id (needs envelope ids, **G2**) or a
`GET /api/v1/runs/{id}/events` reusing the same `global_seq` cursor (**G3** — engineering's choice;
the UI requires only *one* gap-safe cursor per screen).

Detail rules: `active_turn`-style "adopt, don't retry" applies to retry conflicts — a `409` on retry
means somebody else already closed that attempt, so the timeline refreshes and the dialog explains it
rather than re-submitting.

## 6. Conversation (existing URL, extended)

All reads/writes shipped and unchanged:

| Need | Route |
|---|---|
| resource, control, active turn, pending permissions, session binding | `GET /api/v1/conversations/{conversationId}` |
| project role (drives whether Take control is ever enabled) | `GET /api/v1/projects/{projectId}` — the shipped page already comments that the conversation route does not report role, so it asks the project; keep that |
| transcript | `GET /api/v1/conversations/{id}/events` (SSE) folded by `projectTranscript` |
| prompt | `POST /api/v1/conversations/{id}/messages` → `202` queued turn |
| take / return control | `POST …/take-control`, `POST …/return-control` with `{version}` |
| stop a turn | `POST …/cancel` (`202`; the turn ends when the harness acknowledges) |
| answer a permission prompt | `POST …/permissions/{requestId}` with an `option_id` the agent offered |
| profiles for the new-conversation form | `GET /api/v1/agent-profiles` |

New in M5:

| Need | Route | Gap |
|---|---|---|
| workspace widget data (repos, refs, dirty count, mode) | `GET /api/v1/projects/{id}/workspaces`, `GET /api/v1/workspaces/{id}`, `…/repos/{repoId}/status` | M3 contracted |
| turn's sandbox record | `GET /api/v1/turns/{turnId}/sandbox` | M3 contracted |
| artifacts attached to this conversation | `GET /api/v1/projects/{id}/artifacts?conversation_id=…` | **G10** |
| run/attempt context link + "what the factory will see after return-control" | *(none)* | **G8** |
| capability notes for the attached session (`loadSession` etc.) | `agent_session.agent_capabilities` on `getConversation` | exists as *observed data*; must be presented as data, not support (`04`) |
| participant presence | *(none)* | no route → component absent |

Events: the shipped `M2_EVENT_TYPES` list. Note `conversation.turn.interrupted` carries `reason` and
never `stop_reason` — the UI must not synthesize one (`ui/src/api/transcript.ts` already enforces this
copy).

## 7. Pipeline Library / drafts / editor

| Need | Route | Gap |
|---|---|---|
| list definitions, search | `GET /api/v1/pipelines?q=…` | **G1/G23** |
| starter gallery (bundled, read-only) | `GET /api/v1/pipelines?source=starter` or a static manifest | **G1** — decide server vs embedded static; a static manifest keeps M5 unblocked |
| clone starter → draft | `POST /api/v1/pipelines/{id}/drafts` (clone semantics) | **G1** |
| draft document + `version` | `GET /api/v1/drafts/{id}` | **G1/G12** |
| edit (typed node mutations vs whole-doc PUT) | `POST /api/v1/drafts/{id}/actions` or `PUT /api/v1/drafts/{id}` + `If-Match` | **G12** |
| validate | `POST /api/v1/drafts/{id}/validate` | **G1** |
| YAML render | `GET /api/v1/drafts/{id}?format=yaml`, `GET /api/v1/revisions/{digest}?format=yaml` | **G14** |
| diff | `GET /api/v1/drafts/{id}/diff?base=<digest>` | **G13** |
| publish | `POST /api/v1/drafts/{id}/publish` (validated digest + publish permission; approval step **G21**) | **G1** |
| revision viewer (immutable, by digest) | `GET /api/v1/revisions/{digest}` | **G1** |
| node templates | `GET /api/v1/node-templates`, `POST …/clone` | **G1/G18** |
| agent profiles (read today) | `GET /api/v1/agent-profiles` | write routes + revision shape (**G18**) |
| secret pickers (references only) | `GET /api/v1/projects/{id}/secrets` | M3 contracted (**G20** naming conflict to resolve) |
| project list for scope pickers | `GET /api/v1/projects` | — |

Events: `pipeline.revision.published`, `assignment.promoted` (**G1**) on the org/project stream;
draft-edit events are not required for the editor — the draft `version` plus a 409/412 conflict is
enough, and inventing a "draft changed" stream without a writer would be theatre (**G12**).

## 8. Assignments, promotion and rollout

| Need | Route | Gap |
|---|---|---|
| assignment list with pinned revision/channel/params/limits | `GET /api/v1/projects/{id}/assignments` | **G1** |
| create/update assignment | `POST /api/v1/projects/{id}/assignments` | **G1** |
| **preview** promotion (affected assignments, old→new digest, running attempts pinned) | `POST /api/v1/assignments/{id}/preview` | **G1/G21** |
| promote (per project; bulk explicitly later) | `POST /api/v1/assignments/{id}/promote` | **G1/G21** |

`assignment.promoted` must carry: assignment id, from/to digest, actor, and the count of runs that
stay pinned — the UI shows that count *after* the action as evidence, not as a toast of hope.

## 9. Artifacts and preview

| Need | Route | Notes |
|---|---|---|
| list | `GET /api/v1/projects/{projectId}/artifacts` | M3 contracted; sensitivity-filtered in SQL (ADR-0020 §3) |
| metadata + `preview_url` | `GET /api/v1/artifacts/{artifactId}` | `storage_key` never serialized |
| bytes | `GET /api/v1/artifacts/{artifactId}/content` | `text/html` arrives as `text/plain` + attachment — so the app never renders HTML inline on its own origin |
| preview token | `POST /api/v1/artifacts/{artifactId}/preview-token` | `standard|internal` only; audited as an access; Contributor+ |
| the frame itself | `preview_url` on the separate origin | **G22**: dev-only origin today; the SPA must never build this URL itself |

## 10. Secrets and mounts (J8)

M3 contract §2 routes: `GET/POST /api/v1/projects/{id}/secrets`,
`PUT /api/v1/projects/{id}/secrets/{secretId}` (`value` in the body is a `400`),
`POST …/secrets/{secretId}/versions`, `POST …/secrets/{secretId}:revoke`,
`GET …/secrets/{secretId}/materializations`, `POST/GET/DELETE …/secret-mounts[/{mountId}]`.
There is **no** read of a value in any form, so no UI state exists for "masked reveal" (gap **G20** is
only about the route *name*). Events: `secret.created`, `secret.version.added`,
`secret.policy.updated`, `secret.revoked`, `secret.materialized` (metadata only), `secret.removed`,
`secret.materialization_failed` — the last one's `reason` enum is what the mount form's error copy
should quote (`path_escape`, `tracked_target`, `exists`, `revoked_version`, …).

## 11. Approvals (human gates)

| Need | Route | Gap |
|---|---|---|
| list pending approvals (cross-project, mine) | `GET /api/v1/approvals?state=pending` | **G7** |
| detail (context, artifact refs, deadline, designated approvers, escalation) | `GET /api/v1/approvals/{id}` | **G7** |
| decide with comment | `POST /api/v1/approvals/{id}/decide` | **G7** |
| approve a *publish* through the same durable-approval object | same | **G21** |

Distinct from ACP permission prompts (`…/permissions/{requestId}`), which are turn-scoped and answered
by the *current controller*: different object, different route, different screen (`06`, `components.md` §E).

## 12. Assistant (M7 backend, M5 UI contract)

| Need | Route | Gap |
|---|---|---|
| conversation + messages | `POST /api/v1/assistant/conversations`, `POST /api/v1/assistant/{id}/messages` *(09)* | **G11** |
| typed tool proposal / execution | `POST /api/v1/assistant/{id}/tools/{toolCallId}:execute` (name TBD) | **G11** |
| question answer (literal phrase semantics) | `POST /api/v1/assistant/{id}/questions/{questionId}/response` | **G11** |
| approval of a privileged action | same durable approval as §11 | **G7/G11** |
| trace/history | `GET /api/v1/assistant/{id}/events` (reuse journal scope) | **G11** — must reuse `global_seq`, not a second cursor (ADR-0016's argument) |
| navigation/focus targets | enumerated target vocabulary in the contract (e.g. `{route: "pipeline.editor", params: {pipelineId}, focus: {nodeId}}`) | **G11** — without it, `ui.navigate` is a string the client has to guess about |

The UI never executes assistant output as code: it dispatches a **typed, allow-listed intent** to the
same router the human uses (`08`: "presentation of an already authorized state/API operation").

## 13. Operations

| Need | Route | Status |
|---|---|---|
| workers | `GET /api/v1/workers` | shipped (M2 shape: name/hostname/version/status/heartbeat). No capacity, lease counts or sandbox fields |
| sandbox health | `GET /api/v1/system/sandbox` | M3 contracted (**G19**) |
| queues/meters | *(none)* | **G19** |
| compatibility table | *(none)* — data lives in `docs/compatibility/{ACP,APM,SANDBOX,WORKSPACES}.md` | **G19**; UI renders `Test`/`PASS`/`FAIL` **as recorded evidence**, never prefilled (`12`) |
| audit | `GET /api/v1/audit` *(09)* | **G19** |
| identities / credential metadata | *(none in OpenAPI)* | **G19** |
| worker detail (leases held, drain progress, volume identity) | needs `GET /api/v1/workers/{id}` | **G19** |

## 14. Subscription inventory (what the browser actually opens)

| Screen | Streams open | Notes |
|---|---|---|
| `/` Attention | 0–1 aggregate (proposed) or N project streams | **G16**: N streams is the honest fallback; cap and label staleness |
| Project Overview | 1 project stream | shipped |
| Run Inspector | 1 project stream (filtered) or 1 run stream | **G2/G3** |
| Attempt detail | 0 (reads) | evidence is immutable per attempt |
| Conversation | 1 conversation stream | shipped; transcript from the stream |
| Editor | 0 | draft `version` + conflict, not a stream (**G12**) |
| Library / Assignments | project stream where the page is project-scoped | — |
| Operations | 0 (polled: health 15s, readiness 15s, workers on demand) | shipped pattern |
| Assistant | 1 assistant-conversation stream | **G11** |

Never: a stream per run in a list, a stream per attempt, or a second cursor mechanism anywhere
(ADR-0016 §1's "no second journal" argument applies to the UI too).

## 15. Failure-mode behaviour of each dependency

| Failure | Screen behaviour |
|---|---|
| `401` on any read | full-page "sign in" state; deep link preserved for return |
| `404` (hidden or forbidden, indistinguishable by design) | "not found or you do not have access" — never a role guess |
| `409` on control | adopt returned `control` (+ `active_turn`); rename the button; one-line explanation (shipped) |
| `409` on repository/project/pipeline name | inline duplicate-name copy (shipped pattern) |
| `422` validation | field-level findings from the problem detail; publish/validate buttons stay disabled |
| `503` readiness | banner with schema version + "an upgrade is in progress", no retry storm (shipped `retry: false`) |
| SSE reconnecting | `⟨T:stream-status⟩` = "reconnecting", plus "replaying from event N"; stale data marked, never hidden |
| Missing dependency route (**G***) | the affected region renders an explicit "not available in this build" state (see `wireframes.md` §12) — a silently absent panel is worse |
