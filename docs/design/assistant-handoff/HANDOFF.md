# Assistant — design handoff

Source: claude.ai/design project dc036147-9edb-46ef-b923-46ff68513b70, `Assistant Handoff.md`, copied verbatim on 2026-11-10. The exploration canvas text is in `exploration.txt`, the prototype's markup text in `prototype-text.txt` and its behaviour script in `prototype-logic.js`. Task list: `TASKS.md`; evidence: `ACCEPTANCE.md`.

Source repo: `dbirks/communication` (main). Prototype: `Assistant Prototype.dc.html`. Exploration: `Assistant Exploration.dc.html`. Icon comparison: `Icon Packs.dc.html`.

Everything below is a design decision unless marked **Open**. Items that touch protocol, security boundary, deployment model or public API need an ADR per `communication-spec/13-decisions-and-adrs.md`.

---

## 1. Surface and frame

- **Three sizes, one conversation:** popover (400px, bottom-right) → side panel (450px, page narrows beside it) → full page (thread list left, conversation ≤720px centre, "Looking at" + "Changes" right).
  - Header buttons: new thread, threads, side panel, full page, close.
  - Leaving full page returns to the **popover**, not the side panel.
  - Below ~1240px the right column hides; below ~1000px the thread list hides and the thread buttons return to the header.
- **Corners:** the popover panel gets `overflow: hidden`. Menus that leave the panel (threads, page context, trust) render as siblings of the panel, not inside it, so they aren't clipped.
- **Composer:** one bordered box. Textarea on top; bottom row has page-context button, trust pill, spacer, mic, send (all 26–30px, matching).
- **Icons:** switch from Lucide to **Tabler** (`@tabler/icons-react`). Mapping used in the prototype:
  - new thread `edit` · threads `messages` · side panel `layout-sidebar-right`
  - full page `arrows-diagonal` / `arrows-diagonal-minimize-2` · close `x`
  - page context `current-location` / `current-location-off`
  - mic `microphone` · stop `player-stop` · send `arrow-up`
  - chevrons `chevron-down` / `chevron-right` · check `check`
- **No Unicode glyphs as icons:** replace all `▾ ▴ ⤢ › ✓ ×` controls.
- **Copy:** keep secondary text short. One line per option, no stacked footers.

## 2. Setup as a tool, run on open

- New read tool **`system.status`**. It reports:
  - chat model, speech model, decision model
  - workers online and sandbox mode
  - GitHub credential presence (names only)
  - project count, workflows and their assignment
- It runs automatically when a thread is empty (first open, or a new thread). The result renders as a checklist message with one action per row ("Set up", "Check", "Add one", "Show") plus three starter prompts. It replaces the static "FOR THIS PAGE" chips.
- Fix: the suggestions table is keyed `home`, but the section is now `today`.

## 3. Page context

- Sent with every message by default, as data inside the user turn, never in the system prompt. Includes page label, route, entity title/status and project.
- The UI shows it only as a small icon button in the composer. Clicking it shows what's attached, with a checkbox to stop sending it.
- When an answer relied on it, a quiet line under the answer: "assumed you meant the X page (on screen)".
- Prompt block (replaces the current "this run means what is on screen" line in `runner.go` / `loop.go`):

```
<page_context observational="true">
page: Run 9c1e · status waiting
project: feature-delivery
route: /runs/9c1e…
</page_context>
This is the page the person has open. It is background, not the topic.
Use it only when they refer to it ("this", "here", "it") or when the
question makes no sense otherwise. Don't bring it up unprompted. If you
used it, say which item you assumed.
```

## 4. Trust levels and the decision model

Today's gate (`internal/assistant/trust.go`) is a fixed table: read / navigate / draft edit / risky. There is no classifier.

**New behaviour:**

| Level | Behaviour |
|---|---|
| Ask before every change | You confirm every change. |
| **Ask when it looks risky** (default) | A decision model checks each call. Flagged ones wait for you. |
| Don't ask | Everything runs. Each action is listed in the thread. |

- **What the judge sees:** every tool call, reads included. It gets the tool name, the bounded args, the caller's role and the page context, and returns allow / ask plus a one-line reason.
- **Always ask, whatever the judge says:** approving gates, granting agent permissions.
- **Judge down or slow:** ask the user.
- **No judge configured:** the fixed table decides, so reads and draft edits run and anything else asks. The setup checklist warns about it.
- **Undo:** remove "can be undone" from the trust copy (`types.ts` `TRUST_LEVELS`, `pages/settings/Assistant.tsx`). Only draft edits are reversible. The change list keeps "can't be undone" on everything else.
- The confirm card carries a "Why it asks" row: the judge's reason, or "Creates real state" under the fixed table.
- **Config** (mirrors the chat triple): `COMMUNICATION_DECISION_BASE_URL`, `COMMUNICATION_DECISION_API_KEY[_FILE]`, `COMMUNICATION_DECISION_MODEL`, `COMMUNICATION_DECISION_TIMEOUT`.
- **Open:** endpoint shape. A `/v1/system-one`-style classify call was suggested. Candidate models were mentioned as "d1", "clef" or "jev" — confirm the exact ids and request/response format.

## 5. Speech (mic first)

- **Server-side transcription:** the browser records, `serve` proxies the audio to an OpenAI-compatible `/audio/transcriptions` endpoint (Qwen ASR by default), so the key never reaches the browser.
- **Config:** `COMMUNICATION_SPEECH_BASE_URL`, `_API_KEY[_FILE]`, `_MODEL`.
- **Fallback:** the browser's Web Speech API when the endpoint is unset or down (setting, on by default).
- **Mic behaviour:** the mic is always present, including when there's text in the box. Tap to record, tap to stop. The transcript **appends** to whatever is already in the box.
- **After dictation:** stays in the box by default. A setting sends right away.
- Audio is discarded after transcription by default.
- Spoken user messages carry a small "spoken" tag.
- **Spec impact:** `08-assistant.md` says speech-to-text is client-only. This changes that, so it needs an ADR.

## 6. Tools to add

| Tool | Class | Notes |
|---|---|---|
| `system.status` | read | Powers the setup checklist (§2) |
| `credential.list` | read | Names, kind, scope, which projects use each. Never values. |
| `docs.search` | read | Curated how-to set, for "how do I…" |
| `workflow.list` / `workflow.inspect` | read | Direct, instead of via `palette.search` |
| `repo.check` | read | URL → can a credential reach it, default branch, push rights |
| `issue.list` | read | Existing read-only route (ADR-0031) |
| `profile.list`, `schedule.list` | read | |
| `project.create` | risky | From a confirmed proposal |
| `repo.add` | risky | Repo + credential by name |
| `assignment.set` | risky | Show the promotion preview first |
| `run.cancel`, `schedule.create` | risky | |
| `credential.create` | **not a tool** | The assistant links to the form. Secrets never pass through the model. |

**Add-a-repo flow:**
1. Paste a URL, or pick from repos the credential can see.
2. The assistant runs `repo.check`.
3. It shows one proposal card (project, repo @ branch, credential, workflow, why it asks).
4. Create → the change is logged → the project appears in the sidebar.

## 7. Agent execution modes (new)

Requested: two ways to run agent attempts.

**Mode A — in-worker (today).** The worker process launches the agent as a child process under nono, in the worker's own container (ADR-0001 option B, ADR-0019). Simple, single-node, no cluster dependency.

**Mode B — Kubernetes pods.** The worker (or a small dispatcher in it) uses a namespaced ServiceAccount to create one pod (or Job) per attempt in the **same namespace** as Communication, then watches it to completion.
- **Pod contents:** the agent harness, the workspace (worktree volume or a clone step) and any materialized secrets. nono runs inside the pod as well (defense in depth).
- **Lifecycle:** the worker streams logs and ACP traffic from the pod, records the exit, collects artifacts and the patch, then deletes the pod (or relies on `ttlSecondsAfterFinished`).
- **RBAC:** a Role limited to that namespace — `pods`, `pods/log`, `pods/exec` if ACP-over-stdio needs it, `jobs` — plus `secrets` read only if materialization moves into the pod.
- **Wins:** a real per-attempt container boundary (the gap ADR-0019 option C names); per-attempt CPU/memory limits; parallel attempts across nodes; no Landlock nesting inside the worker.
- **Costs and open questions:**
  - How does ACP stdio cross the pod boundary: `kubectl exec`-style attach, or a sidecar speaking ACP over a socket?
  - Workspace transfer: shared RWX volume vs clone-in-pod from the mirror.
  - Secret materialization (ADR-0018) into a pod without writing it to the API server.
  - nono inside the pod still needs `ptrace_scope ≤ 1` on the node (home-cluster finding, `docs/compatibility/SANDBOX.md`).
  - ADR-0001 rejected "Kubernetes Jobs only" for the *first* deployment. This adds Kubernetes as an optional second mode, not a replacement.
- **Config sketch:** `COMMUNICATION_EXECUTION_MODE=inprocess|kubernetes`, `COMMUNICATION_K8S_NAMESPACE` (default: own namespace from the downward API), `COMMUNICATION_K8S_AGENT_IMAGE`, resource defaults.
- **Assistant surface:** `system.status` reports the mode and capacity; the setup checklist row reads e.g. "Runs in pods · namespace default".
- **Needs an ADR** (deployment model + security boundary). Owner to think further before building.

## 8. Still open

- Decision model id, endpoint shape and response format (§4).
- Text-to-speech replies: not in scope yet.
- Streaming answers and live tool steps (answers currently arrive whole).
- Whether to keep "Ask before every change" as a third level.
