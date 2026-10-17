# ADR-0034 — The in-app assistant is a read-only tool broker on serve, with its own model egress path

- **Date:** 2026-10-18
- **Status:** Proposed
- **Owners:** assistant/API maintainers; web UI maintainers (palette surface)
- **Related decisions / contracts:** `08-assistant.md`, M7 (`11-build-roadmap.md`), W9
  (`docs/design/wishlist-gap.md`), ADR-0024 § Security/privacy (`model.chat`'s egress rule), ADR-0029
  (message shape), ADR-0018 (no secret in a prompt), ADR-0014 (API/SSE conventions), ADR-0030's role gates,
  request/response and tool detail in [`docs/design/assistant-v1.md`](../design/assistant-v1.md)

## Context

`08-assistant.md:3` wants an application agent, not a chat pane, and W9's next step is to start on the
navigation arm only. The Ctrl K palette (`ui/src/components/CommandPalette.tsx`) is a jump-only shell whose
footer says "Jump only — the assistant arrives later." The product owner guarantees the deployment can reach
the LLM collective (OpenAI-compatible, model `qwen3-8-flash-next`), so the model choice is settled; what is
not is *who* calls it and with *whose* authority. Today the only model egress in the system is the worker's
`model.chat` node kind (`internal/worker/modelchat.go`), driven by a pinned pipeline revision — never by a
browsing human. `internal/assistant` does not exist and no assistant route is in `api/openapi.yaml`.

## Options considered

| Option | Advantages | Disadvantages | Evidence |
|---|---|---|---|
| A — reuse the worker's path: the assistant enqueues a one-node `model.chat` run | No new egress code; ADR-0024's redaction/allowlist work is done | A palette keystroke creates a run, an event stream and an audit row; the run's authorization is the *revision author's*, not the caller's; nothing reaches the caller until a worker claims it | `03`'s run semantics; ADR-0023's leases |
| B — **broker on serve** calling existing store methods directly with the caller's `Caller` | Same-process authority (the exact `Caller` the HTTP routes pass), answers in one request, no new egress *semantics* — one new egress *site* | serve gains outbound model access it does not have today; the tool loop must be built | `internal/api/approvals.go:76`, `runs.go:358-368`, `pipelines.go:550` |
| C — MCP server + ACP agent session | Spec's eventual shape (`08`'s optional MCP server), reuses M2's conversations | Full tenant-isolation question (ADR-0030's "staging is not isolation") plus a browser-held session before a single read tool is proven | `08-assistant.md` action policy |
| D — let the model call the HTTP routes over loopback with the caller's cookie | Zero new data access code | Cookie replay from the server to itself, and CSRF/session scoping (`middleware.go`) becomes part of the model's trust boundary | ADR-0014's session rules |

## Decision

**Option B.** `internal/assistant` gains a `Broker` mounted by a new `RegisterAssistant`:
`POST /api/v1/assistant/ask` (shape in `docs/design/assistant-v1.md`). The broker runs one bounded model
turn — question + context → tool calls → answers → final markdown — against a **fixed, hard-coded** tool
list of read-only operations, each of which is a direct call to the store method that already serves the
same data on an existing route, invoked with the **caller's own `Caller`**: `project.list` →
`ProjectStore.ListProjects`, `run.list` → `RunStore.ListProjectRuns`, `run.nodes` → `RunStore.ListRunNodes`,
`pipeline.revisions` → `PipelineStore.ListPipelineRevisions`, `approval.pending` →
`ApprovalStore.ListProjectApprovals`, `palette.search` (the palette's own index, client-supplied). The
broker holds no store handle it does not pass a `Caller` to, and the tool registry has no write entry —
`08`'s draft/approval actions stay out until a later ADR.

**Model egress is new on serve.** serve gains `COMMUNICATION_ASSISTANT_BASE_URL`,
`COMMUNICATION_ASSISTANT_API_KEY` (or `_API_KEY_FILE`) and `COMMUNICATION_ASSISTANT_MODEL`
(default `qwen3-8-flash-next`), with the worker's `COMMUNICATION_MODEL_CHAT_*` validation rules copied
verbatim (`cmd/communication/worker.go:173-199`: http(s) root, no credentials in the URL, allowlist or
refusal by name). Unset base URL ⇒ the route is not mounted and the palette footer stays as it is — the
worker's honest-refusal idiom, never a fake answer. Separate names rather than reusing the worker's triple
so one process's endpoint and cost budget is not silently another's.

**v1 stores nothing.** No table, no `assistant_*` rows, no conversation: the palette keeps the turn in
memory for the session and a reload loses it. `08`'s "persist assistant transcript and action trace" lands
with the first write tool, when there is an action to audit.

## Consequences

- Positive: W9's navigation arm ships without touching runs, leases, or the worker; every answer is
  provably the caller's own read view; the jump-only footer can become a real "Ask".
- Limits: one turn, no follow-up state, no diff/highlight/question events (`08`'s event protocol is
  deferred), no phrase buttons, no artifacts, no analytics, no speech input, no cross-org read, no
  tool-call recursion beyond a fixed depth cap.
- Ops risk: serve now egresses to a third party. The ops page must say so (ADR-0024's "state it plainly"
  rule) and an operator who must not let app content leave the host leaves the base URL unset.
- Backwards-compatible: additive route and additive env vars; nothing existing changes bytes.

## Security/privacy

- Authority: the `Caller` flows into every tool; a non-member asking about Project B gets a
  `ListProjects`-shaped emptiness and a `404`-rule denial from the ID-scoped calls
  (`internal/api/conversations.go:31-36`), so the assistant leaks nothing it could not leak via the route.
- Prompt injection: tool outputs are *data*, wrapped as a user-role message with a fixed envelope — never
  as system instructions — and the model has no write capability, so the worst injection outcome is a wrong
  or rude answer. Links are server-validated: same-origin path only, matched against a route allowlist, or
  dropped. `answer_markdown` renders sanitized (ADR-0020's viewer rules), never as the app's origin.
- Fail closed on egress: request body is secret-scanned before send (ADR-0018/ADR-0024); keyring material,
  `.env` values and secret names never enter a prompt; timeouts and a per-request token/char cap, and a
  model error returns a problem+json, not a hallucinated empty answer.
- The assistant is a *reader of the caller's view*, not an admin: no `GET /api/v1/users`, workers, secrets
  listing or sandbox-fleet tools in v1.

## Verification

Design only — nothing here is claimed as working. Required before Accept status (all in
`docs/design/assistant-v1.md` § Test plan): an `httptest` fake OpenAI-compatible server, and the authz test
(a non-member's question about Project B returns nothing about it) as a Go test in `internal/assistant`.

## Migration/rollback

Rollout: unset = feature absent. Rollback: unmount `RegisterAssistant` and unset the vars — no schema, no
stored transcript, nothing to migrate. Supersede: persistence + write tools + the `08` event protocol need
their own ADR, which must decide the transcript table.

Note 2026-10-17: the deployment default moved to `qwen3-8-27b` (flash-next outages); the decision is unchanged.
