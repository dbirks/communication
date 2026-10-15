# Communication — M5 design handoff

Design deliverables for **M5 — Usable visual application** (`communication-spec/11-build-roadmap.md`
M5), written by the design agent for the implementation team. These documents are the design
authority for layout, navigation, copy, progressive disclosure, component states and accessibility;
they are **not** backend design. Nothing here changes a state machine, scheduler rule, protocol
negotiation, sandbox policy, API auth or persistence schema — that is the engineer's half of the
independence boundary in `communication-spec/10-ui-design-handoff.md` ("Independence boundary").

Roadmap exit being designed for:

> an untrained test user clones and customizes sample pipeline, sees a stalled run, takes control,
> retries and views evidence. (`11-build-roadmap.md` M5)

## Reading order

| # | File | Contains |
|---|---|---|
| 1 | [`sitemap.md`](sitemap.md) | Route map, entity-navigation model, what stays from `ui/` today, why each level exists |
| 2 | [`flows.md`](flows.md) | Journeys J1–J9 as Mermaid flow diagrams, including the error and abort paths |
| 3 | [`wireframes.md`](wireframes.md) | Low-fi ASCII wireframes per screen with annotations, mobile variants, empty/error gallery |
| 4 | [`components.md`](components.md) | Component inventory, interaction specs, keyboard and screen-reader behaviour |
| 5 | [`design-system.md`](design-system.md) | Tokens (table + Tailwind v4 `@theme` block), typography, layout, responsive rules |
| 6 | [`data-dependencies.md`](data-dependencies.md) | Screen → exact API routes, SSE scope, invalidation and optimistic-state rules |
| 7 | [`assistant-flow.md`](assistant-flow.md) | Annotated assistant "navigate, edit, ask question, apply" choreography |
| 8 | [`acceptance-checklist.md`](acceptance-checklist.md) | Pass/fail UX acceptance tied to the consulting-team scenario and M5's exit |

Authoritative inputs, in the order consulted: `communication-spec/10-ui-design-handoff.md` (the
brief), `DESIGN_AGENT_BRIEF.md`, `00` (personas, F-requirements), `01` (entities, state machines,
authorization matrix), `03` (definition vs runtime graph, node catalogue, binding syntax), `04`
(ACP capabilities, profiles), `05` (workspaces, `.env`, sandbox honesty), `06` (controller lock,
takeover, audit), `07` (one schema / three editors, rollout, starter gallery), `08` (assistant
tools, question phrases, event protocol), `09` (routes, event envelope, streaming), `11` (M5 exit),
`12` (consulting-team acceptance scenario, failure cases 1–20). Backend reality checked against
`api/openapi.yaml`, `api/schemas/event-envelope.schema.json`, `docs/adr/ADR-0014`, `docs/adr/ADR-0016`,
`docs/adr/ADR-0017`…`ADR-0020`, `docs/m3-contract.md` and the shipped `ui/src/**`.

## Method and constraints honoured

- **Nothing invented as engine semantics.** Where a screen needs a fact the server owns, the screen
  reads it; where the fact has no route, it is listed below under *Contract gaps* rather than
  guessed. Screens never decide scheduling, branching, retry, publish or control outcomes
  (`10` "Interaction and backend rules").
- **Respect what already ships.** Existing routes (`/login`, `/`, `/projects/:projectId`,
  `/projects/:projectId/conversations/:conversationId`, `/ops`), existing `data-testid`s
  (`project-list`, `repo-list`, `member-list`, `conversation-list`, `controller-badge`,
  `take-control`, `return-control`, `stop-turn`, `composer-input`, `permission-card`,
  `transcript`, `activity-list`, `workers-table`, `replica-badge`, `user-badge`, `form-error`,
  `interrupted-notice`, `stream-status`, `turn-status`, …) and existing conventions (problem+json
  banners, "status written as words, never colour-only", replica footer badge, `role`-annotated
  tables, `aria-live="polite"` for feed/turn state) are preserved and extended, not renamed.
  Renaming a testid costs the Playwright proofs in ADR-0006 for no user benefit.
- **Honesty over theatre.** Interrupted work says "stopped, outcome unknown" (`02`, `10` J7,
  ADR-0016 §6); a `required`-mode sandbox failure shows the enforcement stage and reason
  (`docs/m3-contract.md` §3: `sandbox.enforcement_failed`) instead of a spinner; a lost workspace on
  a different volume shows `workspace.recovery_lost` rather than "resumed"; "completed" is labelled
  "met its acceptance passes — not merged" (`01`, `00`).
- **Visual decisions live in tokens**, not in engine-owned components (ADR-0005 Consequences), and
  are delivered as a `@theme` block in [`design-system.md`](design-system.md) rather than by editing
  `ui/` (out of these boundaries).
- **No visual branding debate needed**: neutral professional defaults with named alternatives
  (`DESIGN_AGENT_BRIEF.md`), all expressed as tokens so an organization can re-skin without touching
  a component.

## Personas the IA must serve

From `00` "Users / journeys", each mapped to the surface they live on:

| Persona | Primary surfaces | Dominant question |
|---|---|---|
| Consultant / developer | Attention (`/inbox`), project overview, run inspector, conversation | "What needs me right now, across my five projects?" |
| Factory maintainer | Pipeline library, drafts, revision diff, promotion, ops compatibility | "Did my change help, and did I only give it to Project A?" |
| Project lead | Project overview, plan/approval gate, artifacts, publication | "Is the work described, approved and published the way we agreed?" |
| Operator | Operations (`/ops`), worker detail, sandbox health, run inspector failure paths | "Which worker died, what may be lost, and what do I retry?" |
| Personal user | `/inbox`, conversation, starter gallery | "Can I get one thing done without reading a manual?" |

## Contract gaps (for the engineers)

Each gap below blocks a UI surface named in [`data-dependencies.md`](data-dependencies.md). None is
workaroundable in the frontend without inventing engine semantics, which `10` forbids. Routes and
event names marked *(09)* exist in `communication-spec/09-api-events-data.md` as *proposed* only;
they are absent from `api/openapi.yaml`, which today documents M1/M2 (plus the M3 additions in
`docs/m3-contract.md`, also not yet in the OpenAPI file).

| # | Gap | Needed by | Notes / ask |
|---|---|---|---|
| G1 | No pipeline, draft, revision, assignment or run routes in `api/openapi.yaml` (`GET/POST /pipelines`, `POST /pipelines/{id}/drafts`, `POST /drafts/{id}/validate`, `POST /drafts/{id}/publish`, `GET /revisions/{digest}`, `GET/POST /projects/{id}/assignments`, `POST /assignments/{id}/preview`, `POST /assignments/{id}/promote`, `POST /runs`, `GET /runs/{id}`, `POST /runs/{id}:pause\|:resume\|:cancel\|:retry`, `GET /runs/{id}/nodes`) | Pipeline library, editor, promotion, run inspector — i.e. the whole M5 exit | Needs an M4/M5 contract doc in the shape of `docs/m3-contract.md` before UI work starts; M4 exists only as spec (`03`) |
| G2 | Event envelope carries only `organization_id`, `project_id`, `conversation_id` (`api/schemas/event-envelope.schema.json`), but `01` "Event lineage" requires `run_id`, `node_execution_id`, `attempt_id`, `worker_id`, `revision_digest`, `actor_id` | Run inspector, timeline correlation, "no cross-project leakage" filtering per run, assistant citations of run/event ids | Decide: add optional envelope members under a new `schema_version` (the M3 contract already chose payload-only for `workspace_id` — same argument applies), or promise stable payload member names the UI may filter on. The UI needs one documented answer |
| G3 | No run-scoped SSE stream: only `GET /projects/{id}/events` and `GET /conversations/{id}/events` exist (ADR-0014 §5, ADR-0016 §1) | Run inspector with 25 children and hundreds of attempts | Either bless "subscribe the project stream, filter client-side by run id" (needs G2) or add `GET /runs/{id}/events` reusing the same `global_seq` mechanism. Preference stated in `data-dependencies.md`; the cursor argument must not be duplicated |
| G4 | No node-execution/attempt detail or evidence routes (`GET /node-executions/{id}`, `GET /attempts/{id}`, log/evidence reads, `GET /runs/{id}/timeline`) | Attempt detail, "view evidence", failure diagnosis (J7, J5) | `09` gives only `GET /runs/{id}/nodes`; the run-inspector wireframes assume per-attempt evidence (diagnostics envelope from `03`) is readable |
| G5 | No checkpoint read route (`GET /runs/{id}/checkpoints`) nor a "what will be redone" pre-flight for retry | J7 failure/recovery, M5 exit "retries" | `05`/`02` define checkpoint content and honest recovery; UI must display the surviving boundary, base/head refs and the redo scope *before* the user presses Retry (`POST /runs/{id}:retry` per 09 also needs its request/response shape, including run-local input override and downstream invalidation) |
| G6 | `run.override.applied` event (`03` "Runtime edge cases") is not in `09`'s event list nor any registry | Retry-with-override audit trail ("who changed this and why?") | Add the event type + payload (`actor`, before/after, reason) and pin it in `internal/events/events.go` |
| G7 | No pipeline-level approval resource or decision route. `human.approval` (`03`) is a durable wait; ADR-0016's `permission_requests` are ACP-turn-scoped and `approval_requests` was renamed away (`09`) | J2/J3 human gate, approval list on `/inbox`, deadline + "approver lost access ⇒ denied" (case 9) | Need `GET /approvals?state=pending` (cross-project, permission-filtered), `GET /approvals/{id}`, `POST /approvals/{id}/decide`, plus `approval.requested/decided` payload shapes and deadline/escalation fields |
| G8 | `return-control` to a *run attempt* is unspecified for pipeline-owned conversations: ADR-0016 §2 reserves `controller_kind='run_attempt'` but says no M2 transition may set it, and `03` says return-control "queues a continuation with recorded human intervention context" | J6, M5 exit "takes control" on a stalled run's conversation | Contract the M4 behaviour: which event records the intervention summary, does the queue continuation return a visible id, what does the UI show while the factory waits |
| G9 | No workspace-diff content route. `docs/m3-contract.md` gives `GET /workspaces/{id}/repos/{repoId}/status` (`modified_paths` + dirty summary) only | "Workspace widget", evidence view, "view evidence" in the exit, J7 checkpoint inspection | Decide whether the diff is an artifact (`03` says patches are artifacts) or a route; either way the UI must exclude materialized `.env` targets (`05`, `ADR-0018`) and never offer a "git restore" affordance (`10`) |
| G10 | Artifact list is project-scoped (`GET /projects/{id}/artifacts`) with no run/node/attempt filter params and no `kind`/`sensitivity` facet counts | Run inspector evidence tab, attention triage | Add query params on the existing route rather than a new surface; `ADR-0020` §3 already fixes the visibility matrix the UI must mirror |
| G11 | Assistant surface absent from OpenAPI: `POST /assistant/conversations`, `POST /assistant/{id}/messages`, typed tool + question-response APIs *(09)*; `assistant.*` event types (`08`) unregistered; no `ui.navigate`/`ui.focus` **target vocabulary** | Assistant panel (M7), the "navigate, edit, ask, apply" annotation in `assistant-flow.md` | Ask: define allowed navigation targets as an enumerated `{route name + permitted id}` shape so the client executes authorized presentation, not arbitrary instructions (`08`: "typed commands with safe targets, not arbitrary executable frontend scripts") |
| G12 | Draft editing granularity undefined: fine-grained typed node mutations (`08`'s `pipeline.addNode/updateNode/connect`) vs whole-document `PUT /drafts/{id}`, and the draft's optimistic-concurrency token | Editor, assistant draft edits, "draft edits are not published until authorized" | The editor cannot render "another tab changed this draft" without a `version`/`etag` on drafts; ADR-0014 §8 notes `If-Match`/`Idempotency-Key` are still unimplemented |
| G13 | No revision-diff or draft-diff route (`pipeline.diff` is a *domain action name* in `08`) | J3 "previews YAML/diff", J4 "exact diff", promotion preview | Needs a diff representation the UI can render as a graph overlay *and* as YAML, with node identity stable across diffs (`01` invariant 6) |
| G14 | YAML export/import has no route (`07`, `F-16`, M6) though J3 shows "preview YAML" inside M5 | Editor YAML tab, GitOps later | Even a read-only `GET /revisions/{digest}?format=yaml` (canonical doc re-serialized) unblocks the editor; import must stay a dry-run/validate step (`07`) |
| G15 | No pagination on any list route (`api/openapi.yaml`: "M1 has no pagination") | Run inspector (hundreds of attempts), `/inbox`, artifacts, audit, template browser | Cursor-paginated list shape + ordering guarantee, consistent with the journal's `(scope, global_seq)` convention; the fan-out wireframes assume it |
| G16 | No aggregate attention endpoint: `/inbox` must stitch runs + approvals + conversations + failures across projects | J2 (five projects, "two stalled runs, one approval, three conversations"), M5 exit | Either an explicit `GET /api/v1/attention` or a documented client composition (list projects → per-project lists). Flag: an aggregate must apply the same project predicates server-side (`06`, `09`) |
| G17 | "Stalled" has no definition in any contract | The exit's "sees a stalled run" | Server should expose the reason (lease expiry, waiting_human age, `run.interrupted`, approval deadline) rather than the UI inferring a timeout; today only `conversation.turns.lease_expires_at` and event ages exist |
| G18 | Node template and agent-profile write routes absent (`GET /api/v1/agent-profiles` is read-only by design; `09` lists `POST /agent-profiles`, `/node-templates`) | Template browser clone/edit, profile settings in the editor | Also needs the profile *revision* shape from `04` (`apm_package_ref`, `apm_lock_digest`, `limits`, `resume_mode`, `failure_fallback`) which the current `AgentProfile` schema does not carry |
| G19 | Ops gaps: `GET /system/compatibility`, `GET /audit`, rate-limit/quotas data are in `09`/`10` only; `GET /api/v1/workers` reports no capacity, lease counts or sandbox fields (sandbox lives in `docs/m3-contract.md`'s `GET /system/sandbox`, not OpenAPI) | Operations screen | Move `docs/m3-contract.md` routes into `api/openapi.yaml` as they land so `ui/src/api/schema.d.ts` (`pnpm gen:api`) can generate them |
| G20 | `GET /secrets` top-level (`09`) vs `GET /projects/{id}/secrets` (`docs/m3-contract.md`) disagree | J8 secret settings | Pick one; the UI brief assumes project-scoped routes with metadata-only responses and no masked-value read anywhere |
| G21 | `POST /drafts/{id}/publish` "optional change approval" (`09`) is undefined, and promotion preview's response shape (which assignments/runs are affected, which stay pinned) is unspecified | J3 publish + promote to one project, J4 rollout preview | Contract the preview payload: affected assignment ids, channel change, running-attempt count pinned to the old digest |
| G22 | Artifact preview origin is dev-only (`http://preview.localhost:18084/preview/{token}`, `ADR-0020` D6/D8); no production origin contract, and no rule for how the SPA learns it beyond `preview_url` on the artifact | Sandboxed HTML preview, `10` "generated untrusted HTML artifacts open in sandboxed preview, separate origin" | Confirm the SPA must *only* use the server-supplied absolute `preview_url` and never construct it (cookies are host-scoped, `docs/m3-contract.md` §2) |
| G23 | No search/read route for cross-project lookup (assistant search, template search, "find project A") with the case-15 no-metadata-leak rule | Assistant, library search, `/inbox` filters | Any search endpoint must resolve the permission predicate server-side and return nothing (not `403`s) for invisible projects |
| G24 | `Idempotency-Key` unimplemented (ADR-0014 Consequences; `api/openapi.yaml` "M2 does not honour `Idempotency-Key`") | Publish, promote, start run, retry — all "double-submit" risks the UI must describe | Until it lands, the UI's copy must say what a duplicate looks like (a `409`, not a silent replay) and buttons must be disabled while a mutation is in flight (spec'd per component in `components.md`) |

## How to consume this as an implementation team

1. Read `sitemap.md` + `flows.md` first; they name the screens the M5 exit needs.
2. `data-dependencies.md` is the file to argue with: every row either cites a route that exists in
   `api/openapi.yaml` / `docs/m3-contract.md`, or points at a gap id above.
3. `components.md` + `design-system.md` are enough to build; the wireframes are low-fi on purpose —
   they show information priority, not pixel layout.
4. `acceptance-checklist.md` is the pass/fail sheet for the M5 exit and for ADR-0006 browser proofs.
5. Unresolved UX-only choices are called out inline as **Open UX choice**; they need a designer
   decision, not an ADR. Conflicts with a backend contract belong in a contract review
   (`10` "Independence boundary"), not in frontend code.

## Non-goals of this handoff

- No code, no edits in `ui/`, `api/`, `worker/`, `internal/`, `cmd/`, `docs/adr/` or
  `communication-spec/**` (boundaries: `docs/design/**` only).
- No tenant-isolation, resume or checkpoint *claims*: the screens report what the server observed,
  per `05` "Trust caveat", `ADR-0019`, D-024/D-025 **Open**.
- No analytics dashboards, GitOps conflict UX (M6), triggers/webhooks (M6), or the assistant
  *backend* (M7). The assistant UI is specified now because the panel shape, question widget and
  action trace constrain M5's layout, and `12` case 15's search rule must not be retrofitted.
