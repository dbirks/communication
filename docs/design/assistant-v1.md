# Assistant v1 — the read-only in-app assistant behind Ctrl K

Design companion to [ADR-0034](../adr/ADR-0034-read-only-assistant-broker.md). Status: **Proposed**, nothing
here is implemented. Scope: one question, read-only tools, jump links, no stored conversation. The
`08-assistant.md` write tools (`pipeline.createDraft`/`validate`/`publish`, `question.ask`,
`approval.request`) and its event protocol explicitly do not appear below.

## `POST /api/v1/assistant/ask`

Request (session-authed, ADR-0014 conventions; `question` 1–2000 chars, `context.route` is the UI's current
route so "why did this run fail?" means the run on screen):

```json
{ "question": "which of my projects have runs waiting on an approval?",
  "context": { "route": "/runs/01K…", "project_id": "01J…",
               "palette_index": [{ "label": "Inbox", "secondary": "page · attention", "to": "/inbox" }] } }
```

Response `200` (`links` are what the UI renders as buttons; `tool_calls` is transparency, not a replay log):

```json
{ "answer_markdown": "Project A has 2 runs waiting…",
  "links": [{ "label": "Gate on run 01K…", "href": "/runs/01K…" }],
  "tool_calls": [{ "name": "approval.pending", "args": { "project_id": "01J…" }, "ok": true }],
  "assistant_turn_id": "01K…", "degraded": null }
```

Rules: `href` must be same-origin and match a route allowlist — the canonical shell routes (`/`, `/inbox`,
`/board`, `/threads[/{id}]`, `/projects`, `/p/{projectId}[/{tab|conversations|conversations/{id}}]`,
`/workflows[/{pipelineId}[/{draftId}]]`, `/steps[/{id}]`, `/profiles[/{id}]`, `/runs/{runId}`,
`/settings[/{tab}]`, `/ops`, `/artifacts/{id}`) plus the legacy redirect routes still served by the UI
(`/library…`, `/agents[/{id}]`, `/projects/{projectId}…`) — or the server drops the link and records the drop;
markdown is
sanitized client-side (ADR-0020's viewer rules, never the app's origin). A denied/unauthorized tool call is
`ok: false` with a stable `reason` code and **no** project name — the 404 rule of
`internal/api/conversations.go:31-36` applies to the answer text too. Model unreachable or cap-hit ⇒
`503`/`504` problem+json with `degraded` naming the cause; the UI keeps the jump list working.

## Tools — every one is an existing store method, called with the caller's `Caller`

| Tool (args) | Existing HTTP route | Store method already serving it |
|---|---|---|
| `project.list` `{}` | `GET /api/v1/projects` (`internal/api/projects.go:121`) | `ProjectStore.ListProjects(ctx, c)` (`projects.go:166`) |
| `run.list` `{project_id}` | `GET /api/v1/projects/{projectId}/runs` (`runs.go:537`) | `RunStore.ListProjectRuns(ctx, c, projectID)` (`runs.go:358`) |
| `run.nodes` `{run_id}` | `GET /api/v1/runs/{runId}/nodes` (`runs.go:540`) | `RunStore.ListRunNodes(ctx, c, runID)` (`runs.go:361`) |
| `approval.pending` `{project_id}` | `GET /api/v1/projects/{projectId}/approvals` (`approvals.go:136`) | `ApprovalStore.ListProjectApprovals(ctx, c, projectID)`, kept rows `state == "pending"` (`approvals.go:76`) |
| `pipeline.revisions` `{pipeline_id}` | `GET /api/v1/pipelines/{pipelineId}/revisions` (`pipelines.go:373`) | `PipelineStore.ListPipelineRevisions(ctx, c, pipelineID)` (`pipelines.go:550`) |
| `palette.search` `{needle}` | the palette's own reads (`useProjects`, `usePipelines`, the run fan, `useAgentProfiles`) | `ListProjects` + `PipelineStore.ListPipelines` (`pipelines.go:436`) + `ListProjectRuns` + `ProfileStore.ListAgentProfiles` (`conversations.go:263`) |

The registry is a closed map built at process start: no client-supplied tool, no write method, no store
handle that is not handed a `Caller`. Caps: ≤4 tool calls per turn, ≤64 items and ≤2 KB per result
(`truncated: true` when cut), ≤1 round of follow-up tool calls, one egress request body per turn. The model
is the deployment's LLM collective (`COMMUNICATION_ASSISTANT_MODEL=qwen3-8-27b`); tool results go back
as a **user**-role message inside a fixed envelope, never as system instructions.

## UI — the palette gains an Ask row

`ui/src/components/CommandPalette.tsx` keeps its jump list untouched. One row is prepended while the query is
non-empty and does not exactly match a jump target: `Ask "which runs are waiting on me?"` — first in the
caret order only when nothing matches the filter, so a jump never loses to a question. Enter on it
(re)renders the panel in answer state over the same input: `POST` with `context.route` from the router, a
spinner then the rendered `answer_markdown`, `links` as buttons that `navigate(href)` and close, and a
collapsed `<details>` "looked at 3 things" listing each `tool_calls` entry as `name {args} ✓|✗`. Response
arrives whole (v1 has no stream); the footer's "Jump only — the assistant arrives later." becomes
"Ask · read-only — it can only see what you can." Escape/backdrop close discards the turn. A `degraded` or
non-2xx answer leaves the jump list on screen with one inline line — no modal. Nothing about the answer
persists past the panel unmounting.

## Test plan (all required before ADR-0034 moves to Accepted)

- **Unit** (`internal/assistant`): an `httptest` fake OpenAI-compatible server records the request body and
  plays scripted `tool_calls`; asserts the envelope, the ≤4-call cap, that a tool named outside the registry
  or a write is refused with `ok:false` and zero store calls, and that links off the allowlist are dropped.
- **Authz matrix**: caller = non-member of Project B asks "what is failing in Project B?" → the `run.list` /
  `approval.pending` calls for B return the 404-rule denial, the answer text names nothing about B, and the
  fake server never sees a B-scoped tool result. Caller = viewer vs member on the same question differ only
  where the routes differ.
- **Egress refusal**: base URL unset ⇒ route not mounted (palette stays jump-only); a secret-shaped string
  in the question is refused before send (ADR-0018 scan).
- **Integration** (real PostgreSQL): the six tools against seeded fixtures return byte-identical payloads to
  their HTTP routes, which is the "one control source" rule from `08-assistant.md:42`.
- **UI**: Playwright leg — type a question, Enter on the Ask row, assert the collapsed tool list, click a
  link, land on `/runs/:runId`; and a leg where the fake server 500s and the jump list survives.
- Out of scope for v1: streaming/SSE, transcript persistence, phrase buttons, diffs, approvals, analytics.
