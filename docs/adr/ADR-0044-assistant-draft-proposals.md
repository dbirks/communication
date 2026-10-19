# ADR-0044 — Assistant draft proposals: `POST /assistant/draft-proposals`, closed operation set, apply through the normal version-checked PUT

- **Date:** 2026-10-19 · **Status:** Proposed · **Owners:** assistant maintainer; UI maintainer
- **Related:** ADR-0034 (read-only assistant broker and its model egress), ADR-0042
  (`graphDoc.ts` ops and §4 ambiguity rules), ADR-0014 (HTTP/problem conventions), design
  checkpoint [`docs/design/studio-workbench.md`](../design/studio-workbench.md) §8 (issue #2)

## Context

ADR-0034 shipped a read-only assistant: a broker on `serve` (its own model egress site,
`COMMUNICATION_ASSISTANT_{BASE_URL,API_KEY,MODEL}`), six read-only store methods called with
the caller's own `Caller`, no write tools, no stored conversation in v1. Issue #2 asks for
**one real end-to-end safe drafting operation**: the assistant proposes a change to a draft
(“insert a code reviewer after tests”, “change this agent's prompt”), the proposal is
previewed and highlighted on the Studio canvas, and the human applies it through the normal
contracts. The issue is equally explicit about what must *not* happen: the assistant must not
publish autonomously, and there must be no separate, unvalidated YAML generator.

The constraints that pin the design:

- The caller already needs **write access to the draft** (`PUT /api/v1/drafts/{id}`) — the
  proposal mechanism must not widen that boundary by even a bit; a caller who cannot write
  the draft must not be able to get proposals for it.
- The model's output must not be trusted: free-form YAML from a model is exactly the
  "unvalidated YAML generator" the issue forbids.
- Whatever the model proposes, the **UI must be able to apply it with the same pure
  text→text `graphDoc` ops** a human gesture would use (ADR-0042), so the preview, the
  highlight and the applied edit are one code path.

## Decision

1. **New endpoint** `POST /api/v1/assistant/draft-proposals` with body
   `{draft_id, version, instruction}` (problem+json per ADR-0014; unknown draft → `404`;
   wrong `version` → `409` like the draft PUT; no write permission → `403`).
   **Authorization = "may `PUT` this draft"** — the same `authz` check the draft PUT uses,
   evaluated with the caller's `Caller`. The response is `200` with
   `{op, node_ids, summary, version}` and **no write of any kind happens server-side**:
   the endpoint is a read of the draft plus a model call; it never touches the draft row.
2. **Closed operation set.** The model is prompted to answer with exactly one operation from
   a fixed enum, JSON-only:

   | op | fields |
   |---|---|
   | `insert_after` | `{after, kind, id, config}` |
   | `insert_on_edge` | `{from, to, kind, id, config}` |
   | `update_prompt` | `{node, prompt}` |

   The server validates the proposal structurally: `kind` is an executable kind, `id` is
   well-formed and does not collide with an existing draft node id, and every referenced
   node id (`after`, `from`, `to`, `node`) exists in the draft at `version`. Anything else
   — unknown op, unknown id, malformed JSON, a second op — is refused with a `422`
   (`assistant_proposal_invalid`); the model is not re-asked. The **§4 ambiguity rules of
   ADR-0042 apply to the proposal too**: a proposal that would insert on a guarded,
   condition or error-route edge is refused, not returned for the UI to explain.
3. **The model egress reuses ADR-0034's broker**: the same single assistant endpoint
   (`COMMUNICATION_ASSISTANT_*`), the same one-request-per-question rule and the same
   refusal behaviour on egress failure. No new egress site, no new secret surface.
4. **Apply is the normal version-checked `PUT /api/v1/drafts/{id}`.** The UI applies the
   proposal locally with the corresponding `graphDoc` op (`insert_after`/`insert_on_edge`/
   `updateConfig`), highlights the touched nodes with
   `data-highlight="assistant-proposed"` and the caption *"Assistant proposed this change —
   review, then Apply or Discard"*, then on **Apply** sends the ordinary PUT (version-checked;
   a `409` takes the standard stale-draft banner). **Discard** reverts the local text.
   **Publishing is never part of this flow** — the assistant can propose; only a human
   validates and publishes through the existing gate.
5. **Scope discipline.** This is the one real drafting operation the issue allows for this
   effort. Broad tool coverage (navigation tools, structured questions, multi-op plans) is
   explicitly deferred; the endpoint's response shape is additive (an `ops` list later) but
   v1 returns exactly one op.

## Consequences

- One new public API resource and one new `authz` usage; the draft write path, its digest
  and the publish gate are untouched — a proposal that is applied changes the draft exactly
  the way a human keyboard edit would.
- The assistant's prompt now contains the draft's node list (ids, kinds, prompts, edges) —
  the same data the Studio canvas already renders for the same caller; no new data leaves
  the boundary the caller could already read.
- Because apply is a normal PUT, the proposal's `version` must match the draft's current
  version when the PUT fires; the UI re-checks on Apply and surfaces `409` through the
  existing banner, never by retrying silently.
- The closed op set keeps the UI's preview path identical to the human gesture path
  (ADR-0042 `graphDoc`), so the ambiguity dialog, the highlight and the saved YAML are one
  tested code path.
- Security posture unchanged vs ADR-0034: one broker, one egress allowlist, secrets never in
  the prompt or the response (the draft's secret refs are sent as refs, not values).

## Alternatives

| Option | Advantages | Disadvantages |
|---|---|---|
| **A (chosen)** — server-side closed-op proposal endpoint, apply via normal PUT | authz is the caller's own draft-write right; model output is validated against the draft before the browser sees it; one apply path, auditable diff | a new endpoint to specify and test; the op set is small by design |
| B — client-side model call (browser calls a model directly, builds YAML) | no new server endpoint | requires browser-held model credentials, bypasses the broker/allowlist, and makes free-form YAML editing the norm — the exact unvalidated-generator path the issue forbids |
| C — the server writes the draft directly on the user's behalf ("assistant applied it") | one less click | the assistant becomes a writer with its own mutation path outside the version-checked PUT; auditing and the "never publishes / human applies" contract both break; the issue requires review-then-Apply, not silent server mutation |
| D — extend ADR-0034's read-only assistant with a "suggested YAML diff" text field | no new endpoint | the diff is prose the UI cannot safely apply or preview on the canvas; preview-and-highlight (the acceptance criterion) needs a structured op, and a YAML diff bypasses the §4 rules |

## Verification

- `internal/assistant` (or the API layer hosting the endpoint): fake-model tests pinning the
  closed op set — valid `insert_after`/`insert_on_edge`/`update_prompt` return
  `200 {op, node_ids, summary, version}`; unknown op / unknown node id / malformed JSON /
  second op all return `422 assistant_proposal_invalid`; the draft row is byte-identical
  before and after the call (the endpoint wrote nothing).
- Authz matrix (mirroring ADR-0034's pattern): caller without draft-write right → `403`;
  other project's draft → not `403`-leaked (`404`); wrong `version` → `409`.
- §4 rules at the proposal boundary: a proposal that would insert on a `when`-guarded edge
  or a `condition` edge is refused, with the guard named in the problem.
- UI: unit test that applying a proposal uses the same `graphDoc` op as the human gesture
  and sets `data-highlight="assistant-proposed"`; browser pass (ADR-0006,
  `studio-assistant-proposal.png`): propose → highlight + caption → Apply → draft saved at
  the new version → and, separately, Discard leaves the draft byte-identical; publish was
  never invoked.
- Egress: the request goes through the ADR-0034 broker with the existing
  `COMMUNICATION_ASSISTANT_*` configuration; no new environment variables.
