# Gap analysis — phase 7: Assistant v2 (global popover, trust level, undo, follow-up questions)

Artboards in scope: 2a, 2c, 3d, 4d (2b tours = phase 10, out of scope). Sources:
`qi-redesign/README.md` (§ "Assistant popover", § "Assistant expanded (2c)", Interactions → Trust level /
Undo, State), `qi-redesign/GOAL.md` § 7, `shots/2a.txt` `2c.txt` `3d.txt` `4d.txt`,
`internal/assistant/`, `ui/src/`, `docs/design/assistant-v1.md`, `assistant-flow.md`,
`communication-spec/08-assistant.md`, ADR-0034 / ADR-0044.

## 1. Design asks

- **(2a, 3d, 4d)** Global assistant popover, ⌘K or sidebar Ask button, 400px, anchored bottom-right of
  content; header strip `ASSISTANT` + trust-level pill (`ask for risky ▾`) + `⤢ expand` + `esc`.
- **(2a, 2c, 3d)** Composer carries a **page-context chip** (`home`, `feature-delivery`, `run 9c1e`) that
  updates on navigation; the popover **keeps its conversation across page changes**.
- **(2a, 3d)** **Mic button** (36px): listening state shows the transcript live in a dashed royal bubble,
  waveform + timer, `Done`; transcript is editable before sending.
- **(3d)** Empty state: three dashed **"FOR THIS PAGE"** suggestion chips.
- **(2a, 3d)** Answers render link rows with `Go ›` (navigate), action buttons, collapsed `used N tools ▸`.
- **(3d, 2c)** **Follow-up questions**: the model writes 2–4 answer buttons (2c adds option subtitles and a
  radio layout under `! AWAITING YOUR ANSWER`) plus "Or say it your way…"; **whatever the user taps, types or
  says is sent back as plain text**. Message shape: `{ prompt, options: {label, value}[], allowFreeText }`.
- **(4d §3, 2c)** **Change chip** `3 changes ▴ undo all`, expanding to a per-item list with per-item `undo`;
  2c decision: drop the "Changes in this conversation" side column in favor of the chip.
- **(4d §2)** **Approval card** under *ask for risky*: amber `! NEEDS APPROVAL` panel with a sentence and
  `Retry` / `Not now` (e.g. retrying a failed run from `test`).
- **(4d §1)** **Per-person trust level** — three modes (Ask before everything / Ask for risky (default) /
  Don't ask) — as a pill menu *and* Settings → Assistant; footer line "just for you · never reads secret
  values · never goes beyond your project role".
- **(2c)** **Expanded full-screen** view: conversation column max-width 680px, chip `opened from Feature
  Delivery`, `Shrink to popover`, result mini-diagram cards of each changed draft, `Tour the changes` (tours
  = out of scope) / `Open both drafts` / `Discard`.

## 2. Exists today

**Backend (`internal/assistant/`)** — ADR-0034 read-only broker, **Proposed but implemented**:
- `POST /api/v1/assistant/ask`, one bounded turn, then discarded: "nothing is stored — no table, no
  transcript, no replay log" (`internal/assistant/assistant.go:5-11`; ADR-0034 line 51 "v1 stores nothing").
- Six read-only tools, each an existing store method called with the caller's `Caller`
  (`internal/assistant/tools.go:39`: `project.list`, `run.list`, `run.nodes`, `approval.pending`,
  `pipeline.revisions`, `palette.search`); closed registry, no write entry.
- Link allowlist mirrors `ui/src/App.tsx` routes (`internal/assistant/routes.go:15-33`); egress refusal on
  secret-shaped prompts (`assistant.go` `ErrSecretInPrompt`, ADR-0018); caps `MaxModelCalls=4`,
  `MaxToolCalls=8` (`assistant.go:14-26`).
- ADR-0044 (Accepted): `POST /api/v1/assistant/draft-proposals` (`api/openapi.yaml:3883`) — the assistant
  proposes ONE structural draft change from a closed 3-op set `insert_after` / `insert_on_edge` /
  `update_prompt` (`internal/assistant/proposal.go:17-28`); the UI applies it through the normal
  version-checked `PUT /api/v1/drafts/{draftId}` (`internal/api/pipelines.go:377`). The model's text is
  never trusted; invalid op → 422.
- Drafts record provenance: `pipeline_drafts.source_kind` enum includes `'assistant'`
  (`internal/store/postgres/migrations/00005_m4_pipelines.sql:78-79`; openapi `:6976-6978`) — "who changed
  this" is partially answerable today.
- OpenAPI assistant schemas: `AssistantAsk/Answer/Link/ToolCall/Problem`, `AssistantDraftProposal*`
  (`api/openapi.yaml:8215-8440`). **No `AssistantQuestion` schema, no conversation schemas.**
- Spec 09 already *names* the missing persistence resources but they are unimplemented:
  `POST /assistant/conversations`, `POST /assistant/{id}/messages`
  (`communication-spec/09-api-events-data.md:18`). **No `assistant_*` tables exist** (grepped all
  migrations) and **no `assistant.*` event types** in `internal/events/events.go` (spec 08's event
  protocol, `08-assistant.md:30-34`, is unimplemented).

**UI**:
- ⌘K/Ctrl+K opens the command palette with the Ask row and answer state — this is the *only* assistant
  surface (`ui/src/components/CommandPalette.tsx:214` shortcut; testids `assistant-thinking`,
  `assistant-answer`, `assistant-links`, `assistant-tools` at `:474-597`). It is a top-bar panel, not an
  anchored popover; it closes on navigation and keeps nothing (v1 by design: `assistant-v1.md` § UI,
  "Nothing about the answer persists past the panel unmounting").
- Page-context chip exists in miniature: the palette's context section from the route
  (`ui/src/components/Shell.tsx:27-38` `sectionOf`); the ask request already carries `context.route` +
  `palette_index` (`ui/src/api/assistant.ts`, contract in `assistant-v1.md` § ask).
- Draft proposal UI: `ui/src/components/studio/AssistantProposalBox.tsx` (testids
  `assistant-proposal-box` `:113`, `-apply` `:141`, `-discard` `:146`) with client-side "describe a change"
  input; applied via `ui/src/api/draftProposals.ts` (`DRAFT_PROPOSALS_PATH` `:32`).
- **The only undo that exists is Studio's in-memory snapshot stack** — "undo/redo is an in-memory" YAML-text
  history, lost on unmount/reload (`ui/src/components/studio/useStudioDraft.ts:5, 389-400, 486-500`).
  **No server-side undo tokens, no change log, no mutation record from the assistant anywhere.**
- No speech/mic anywhere: grep for `speech|Speech|webkitSpeechRecognition` in `ui/src/` → zero hits.
- **No user-preference/settings table** (grepped all migrations) — no store for a trust level or layout
  prefs; no `/settings` route in the current UI (settings live under `/projects/:id/settings`).
- Related but distinct: "Threads" (one-off conversations) are user↔agent conversations on the
  `conversations` table (`internal/store/postgres/migrations/00003_m2_conversations.sql:77`,
  `ui/src/pages/ProjectConversations.tsx`) — not the in-app assistant, and the spec's `assistant` state in
  the redesign must not reuse them.

## 3. Gap table

| item | kind | evidence or spec ref | size |
|---|---|---|---|
| ADR for Assistant v2 (persists conversations + changes; per-user trust level; amends ADR-0034 "stores nothing") | needs ADR | spec 08 `:40` "Persist assistant transcript and action trace" vs ADR-0034 `:51`; spec 11 `:102` lists "assistant tool permission model" ADR topic | S |
| Per-user trust level storage + API (GET/PUT preference) | needs backend + ADR | no prefs table (migrations grep); design State `trustLevel` | S |
| Conversation persistence (conversations, messages, per-user, `activeConversationId`) | needs backend + ADR | spec 09 `:18` names routes; no tables; ADR-0034 `:51` | L |
| Multi-turn ask (send conversation + context, return answer + optional question) | needs backend | v1 is one-shot, discarded (`assistant.go:5-11`); `loop.go` single turn | M |
| `assistantQuestion` message type (model-written options → plain-text reply) | needs backend + UI | spec 08 `:7-9` option buttons/free text, persisted; no schema in `api/openapi.yaml` (grep `Assistant*` `:8215+`) | M |
| Change log + undo (`Change { id, kind, targetRef, summary, undoToken }`, per-item + undo all) | needs backend | no undo mechanism server-side; only Studio in-memory undo (`useStudioDraft.ts:5`); draft revertible via inverse op on versioned PUT (`pipelines.go:377`) | L |
| Trust gating in the tool loop (confirm card for risky tools) | needs backend + ADR | design says preference "checked in the assistant's tool loop"; spec 08 `:15-19` tool action policy requires confirmations + auditable mutation records | M |
| Popover shell (400px anchored, header + pill + expand + esc, conversation survives nav) | UI on existing API (shell) / needs backend (survival) | today = top-bar palette (`CommandPalette.tsx:214`), dies on close | M |
| Context chip (page name, updates on nav) + "opened from X" | UI-only | `Shell.tsx:27-38` gives the section; `context.route` already sent | S |
| "FOR THIS PAGE" suggestion chips (empty state) | UI-only (templates) | none today; some chips need unimplemented tools (`pipeline.diff` per 08 `:12`) | S |
| Mic + listening state (Web Speech API, editable transcript) | UI-only | spec 08 `:40` "Speech-to-text is a client input modality, not a new assistant backend contract"; zero speech code in `ui/src` | S |
| Follow-up question widget (option buttons, radio list, free text, reply-as-text) | UI on new API | none today; contract in design State | S/M |
| Change chip + expanded change list with undo | UI on new API | none today | M |
| Approval card (amber, Retry / Not now) | UI + trust gating | none today; run retry route exists (`internal/api/runs.go:67`, retry_context), no assistant path to it | M |
| Expanded full-screen view (680px column, shrink, `Open both drafts`, `Discard`) | UI on existing API | draft reads/PUT exist; mini diagram cards can reuse Studio node-strip styling | M |
| Settings → Assistant tab (trust level) | UI + prefs API | no `/settings/:tab` route or prefs store today | S |
| `assistant.*` events on the journal (replay, `assistant.message.delta`, etc.) | needs backend | spec 08 `:30-34`; `assistant-flow.md:254` "must ride the same journal/cursor"; none in `internal/events/events.go` | L (defer?) |
| Mutation tools beyond read+nav+draft edits (approvals, publish, runs) | needs backend + ADR | GOAL.md §7: "Start with read + navigate + draft edits as tools"; 08 `:12-13` tool list is *proposed*, not implemented | L (mostly later) |

## 4. Spec / design conflicts

1. **Persistence** — ADR-0034 (implemented, `assistant.go:5-11`, ADR-0034 `:51`): "nothing is stored — no
   table, no transcript, no replay log … **v1 stores nothing**". The redesign State section and 2c's
   "keeps a list of every change it made" require per-user persisted conversations and a change log.
   Spec 08 `:40` sides with the redesign: "**Persist assistant transcript and action trace**; redact
   privileged data." Resolution: an ADR that supersedes ADR-0034's storage clause (v1 stays read-only in
   tool scope; v2 persists and gains draft-mutation tools per ADR-0044's pattern).
2. **ADR-0034 is still Status: Proposed** (`docs/adr/ADR-0034-read-only-assistant-broker.md:4`) although
   its route, tools and palette are implemented. The v2 ADR should fold in accepting/superseding it.
3. **Trust level as pure client preference vs "auditable mutation records"** — design (README
   Interactions): "The trust level is stored as a user preference and checked in the assistant's tool loop
   before each action. No separate server-side permission system is needed." Spec 08 `:13`: "Validation
   includes project scope, actor authorization, version preconditions, confirmations and **auditable
   mutation records**." These can coexist (authz is still enforced by the same API, per ADR-0034 rule (a)),
   but the *confirmation gate* and the *change record* must be server-side — a "Don't ask" client cannot
   be the sole control, and the change log must survive browser reloads. State this in the ADR.
4. **Undo semantics** — design: "Draft edits are reversible; runs and approvals are not (say so)".
   `assistant-flow.md:218` (failed state) offers "Retry step / Undo applied" and its privileged matrix
   (`:221-231`) lists run control with "explicit" confirmation. Not a hard conflict, but the UI must render
   change-list rows for non-undoable actions (run started, approval made) as *logged, not undoable* — the
   design's `Change` type's `undoToken` must be nullable.
5. **Secrets** — consistent, no conflict: design "never reads secret values" matches ADR-0018 egress
   refusal (`assistant.go` `ErrSecretInPrompt`) and spec 10 `:63` ("Secret values never displayed in
   transcript/diffs"). The ADR must keep ADR-0018's scan applied to *conversation messages*, not just
   v1's one-shot body.
6. **Vocabulary** — design uses `workflow`/`step`/`run`/`threads`; app routes and API say `pipelines`,
   `node templates`, `conversations` (e.g. `internal/api/pipelines.go:374-378`, routes.go allowlist
   `:15-33`). Settled decision: UI wording renames only; the assistant's link allowlist and `context.route`
   must keep mapping design chips (`feature-delivery`, `run 9c1e`) to real routes
   (`/projects/:id/pipelines/...`, `/projects/:id/runs/...`).

## 5. Honest empty states

- **Change chip / change list** — before the change log exists, the assistant cannot report "what it
  touched" after a page reload. Show: no chip (nothing yet); after a live draft edit in-session, show the
  in-memory list with a note "undo works until you leave the page" until the backend lands.
- **"FOR THIS PAGE" suggestion chips** — several natural chips need unimplemented tools
  (`pipeline.diff` for "What changed since r2?", `run` analytics for "Why did the last 3 runs loop…?" —
  spec 08 `:12` lists them as *proposed* names, not routes). Ship only chips backed by the six current
  tools + ADR-0044 (e.g. "Open the pending approvals for this project", "What nodes does run … have?");
  label the page-specific ones honestly or omit them.
- **2c mini diagram cards** ("FEATURE DELIVERY #12 · plan › approve › …") — need the changed drafts' YAML;
  available from `GET /api/v1/drafts/{draftId}` once the change log carries the draft id, so this renders
  for real after a draft edit; before that, the expanded view shows plain text result rows.
- **Mic** — browser-dependent: `webkitSpeechRecognition` is Chrome/Edge/Safari only and in Firefox is
  behind a flag; **Chromium's Web Speech API sends audio to Google's cloud STT** — a real egress/privacy
  caveat for a repo with ADR-0018-style egress discipline. Fallback: hide the mic button when the API is
  absent (honest degradation, no backend involved; spec 08 `:40` confirms it is client-only).
- **Trust pill footer** ("just for you · never reads secret values · never goes beyond your project
  role") — all three are *true today by construction* (user-scoped `Caller`, ADR-0018 scan, API authz);
  no data needed, safe to render as a static line.
- **"opened from Feature Delivery"** — client-side referrer state, no backend; show nothing when the
  assistant is opened from the sidebar.

## 6. Proposed work units

One worker ≤60 min each. `W#` order; **||** = parallel-safe, **→** = must serialize (same file or depends).

1. **W0 — ADR-00xx "Assistant v2: persisted conversations, per-user trust level, change log with undo"** —
   amends ADR-0034's storage clause; defines tables, prefs route, trust-gating rule, undo scope.
   Owns: `docs/adr/ADR-00xx-*.md`, plus `communication-spec` is NOT touched. *(~30 min; gates all below.)*
2. **W1 — User preference (trust level)** — migration `user_preferences` (or `assistant_preferences`) +
   `GET`/`PUT /api/v1/me/assistant` + OpenAPI schema. Owns: one new migration file,
   `internal/api/assistant_prefs.go` (new), `api/openapi.yaml` (append). **|| W5** (no shared files).
3. **W2 — Conversation persistence** — tables `assistant_conversations`, `assistant_messages`
   (jsonb payload: kind = user | assistant | question | change; tool_calls inside assistant messages),
   routes per spec 09 `:18` (`POST /assistant/conversations`, `GET` list, `POST /…/messages`, `GET`
   messages), OpenAPI. Owns: migration, `internal/assistant/store.go` (new), `internal/api/assistant_conversations.go`
   (new), `api/openapi.yaml`. → after W0. **~60 min, biggest unit.**
4. **W3 — Multi-turn turn runner** — extend `Ask` to accept conversation history + `context.route`, return
   `{answer_markdown, links, tool_calls, question?}`; question shape `{prompt, options[], allowFreeText}`;
   trust level consulted *server-side* before any non-read tool (confirmation gate returns
   `assistant.approval.required`-shaped payload instead of executing). Owns: `internal/assistant/loop.go`,
   `model.go`, `exec.go`, `routes.go` (tool registry grows), tests. → after W1, W2. **~60 min.**
5. **W4 — Change log + undo** — table `assistant_changes`
   (`{conversation_id, kind, target_ref, summary, undo_payload jsonb nullable}`); the draft-apply path
   (ADR-0044 op applied via PUT) records a change row with an inverse op; `POST
   /api/v1/assistant/changes/{id}/undo` replays the inverse op through the version-checked PUT; runs/
   approvals logged with `undo_payload = null`. Owns: migration, `internal/assistant/changes.go` (new),
   `internal/api/assistant_changes.go` (new), `api/openapi.yaml`. → after W2. **~60 min.**
6. **W5 — Popover shell** — new `ui/src/components/assistant/AssistantPopover.tsx`: 400px anchored panel,
   header (wordmark, trust pill slot, expand, esc), context chip from route, composer, testids
   `assistant-popover`, `assistant-pill`, `assistant-expand`. Replaces the Ask half of
   `CommandPalette.tsx` (jump list stays). Owns: `components/assistant/*` (new), `CommandPalette.tsx`,
   `Shell.tsx` (mount point + ⌘K). **~60 min.**
7. **W6 — Conversation + expanded view** — message list (markdown, `Go ›` link rows, collapsed "used N
   tools"), listening state, expanded 680px full-screen overlay with `opened from` chip, `Shrink`,
   `Open both drafts` (nav), `Discard` (undo via W4 API). Owns: `components/assistant/*` (new files
   only — serialize with W5 on shared files), pages/route wiring. → after W3, W5.
8. **W7 — Trust pill + Settings → Assistant** — pill menu (three modes, radio), persisted via W1 route,
   `Settings → Assistant` tab. Owns: `components/assistant/TrustPill.tsx` (new), `pages/Settings*.tsx`
   (new), `api/assistantPrefs.ts` (new). → after W1. **~30 min.**
9. **W8 — Follow-up question widget** — renders `question` messages: option buttons (2–4, 32px,
   left-aligned) / radio list with subtitles, "Or say it your way…"; any choice posts the **plain text**
   as the next user message; unanswered question shows `! AWAITING YOUR ANSWER` and stays in history.
   Owns: `components/assistant/QuestionCard.tsx` (new) + small hook in `api/assistant.ts`. → after W3. **~40 min.**
10. **W9 — Change chip + approval card** — `N changes ▴ undo all` chip, expandable per-item list with
    per-item `undo` and disabled "not undoable" rows for runs/approvals; amber approval card with
    `Retry` / `Not now` wired to W3's confirmation payload. Owns: `components/assistant/ChangeChip.tsx`,
    `ApprovalCard.tsx` (new). → after W4, W3. **~40 min.**
11. **W10 — Mic** — `useSpeechToText` hook (interim results, stop, editable draft, `Done`); hides the mic
    button when `webkitSpeechRecognition` is absent. Owns: `lib/speech.ts` (new) + composer integration in
    W5's composer file (serialize with W5). **~40 min.**
12. **W11 — "FOR THIS PAGE" chips** — static route-keyed templates backed only by existing tools; dashed
    chips in the empty state. Owns: `components/assistant/Suggestions.tsx` (new) + a data table file.
    **~20 min. || W8–W11** (new files).

Serialize map: W0 → {W1,W2} → W3 → W4; UI: W5 → {W6, W10}; W7, W8, W9, W11 parallel once their
predecessors land. W6 and W9 both touch the popover body — serialize W9 after W6.

## 7. Acceptance checks

Real lab, browser (Playwright) + API state:

1. **Popover**: on `/projects/:id/runs/:runId`, press ⌘K → `data-testid=assistant-popover` visible, width
   400px (getBoundingClientRect), header contains `ASSISTANT` and the pill reading `ask for risky` (the
   default); `esc` closes it.
2. **Context chip**: composer shows the chip for the current page (text = `run <short id>` or section
   name); navigate to another page with the popover open → chip text changes and the message list is
   unchanged (same count, same text) — conversation survived navigation.
3. **Empty state**: with zero conversations the body shows exactly 3 suggestion chips
   (`assistant-suggest`, count == 3, dashed border) and nothing else.
4. **Answer**: type a question, Enter → `assistant-answer` appears; the `used N tools` disclosure count
   equals `tool_calls.length` of the `POST /assistant/ask` (v2: messages) response JSON (intercept in the
   test). Click a `Go ›` link → URL changes to the linked route and the message still exists after
   returning.
5. **Follow-up question**: with a seeded/scripted prompt the response body contains a `question` with
   `options.length` in 2..4 and `allowFreeText: true`; the card renders that many buttons; clicking the
   2nd option POSTs a user message whose text **equals the option label verbatim**; free text and typed
   replies both land as plain-text messages (assert via `GET` on the conversation messages).
6. **Trust level**: pill menu shows exactly 3 options with the default checked; select `ask before
   everything` → `GET /api/v1/me/assistant` returns `ask_all`; Settings → Assistant shows the same value
   and changing it there updates the pill.
7. **Approval gate (ask for risky)**: ask to retry a failed run → the `! NEEDS APPROVAL` card
   (`assistant-approval`) appears, and `GET` on the run shows **no new attempt** (state unchanged);
   click `Retry` → run gains a new attempt (attempt count +1) and the change log row for it has no undo
   button (row shows "not undoable"); `Not now` leaves the run unchanged.
8. **Change chip + undo**: in a project with a draft, ask the assistant to add a step (ADR-0044 path);
   after Apply: chip reads `1 changes`; `GET /api/v1/drafts/{id}.document_yaml` contains the new node;
   click the item's `undo` → draft YAML is **byte-identical** to the pre-edit capture; `undo all` on 2+
   changes restores both. API before/after: `GET /assistant/conversations/{id}/changes` count goes
   2 → 0 undone (or rows flip to `state: undone`).
9. **Expanded view**: `⤢` opens the full-screen view with a 680px-max conversation column and chip
   `opened from <section>`; `Shrink to popover` restores the 400px panel with the same conversation; after
   two draft edits the view lists both drafts with working `Open both drafts` (two navigations) and
   `Discard` (both drafts revert per check 8).
10. **Mic**: in the lab's headless Chromium, `navigator.webkitSpeechRecognition` absent → mic button not
    rendered (`assistant-mic` absent from DOM) — and that absence is the asserted honest behavior; in a
    manual Chromium pass, mic → `assistant-listening` with `Done`, speaking puts editable text in the
    composer, `Done` keeps it.
11. **Secrets**: a question containing a secret-shaped string is refused with the ADR-0018 problem code
    and no model egress (server log / fake-model request count == 0).

## 8. Open questions for the product owner

1. **Scope of risky tools in phase 7.** GOAL.md §7 says "Start with read + navigate + draft edits as
   tools", but 4d §2 shows the approval card for *retrying a run*. **Default:** include `run.retry` (and
   `run.pause`) as the first gated tools so the ask-risky flow is demonstrable; keep approvals and
   publish for phase 8.
2. **Persistence granularity.** Full transcript with per-message `tool_calls` (spec 08 `:40` "transcript
   and action trace"), or lighter user/assistant text + change log only? **Default:** full — the
   "used N tools" disclosure and spec 08's redaction rule both need the trace.
3. **Undo scope.** Design says runs/approvals are not undoable. Should such actions even appear in the
   change list (as logged, non-undoable rows) or is the chip drafts-only? **Default:** list them, marked
   "not undoable" — "Who changed this and why?" (spec 08 `:47`) wants them visible.
4. **Mic egress.** Chromium's Web Speech API streams audio to Google's cloud STT. Acceptable to ship,
   given ADR-0018-style egress discipline? **Default:** ship with the button hidden when unsupported and a
   one-line note in Settings → Assistant; on-prem STT as a later option.
5. **Does the trust level gate the Studio Apply button (ADR-0044 path) too**, or only the popover
   tool loop? **Default:** only the popover tool loop for now — the Studio Apply button is already an
   explicit human confirmation, so gating it twice is redundant.
