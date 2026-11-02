# Thread → workflow (design 2f): assistant-driven workflow drafting

Implements `docs/design/handoff-repo-chat-nav/README.md` § "Thread → workflow (2f)"
and DECISIONS.md ("Thread → workflow is assistant-driven", "Assistant capabilities:
give it tool schemas + examples for rendering structured UI"). No translator screen:
the assistant drafts the workflow from the chat inside the existing assistant
conversation (ADR-0050 part 2).

## Flow

1. `Make a workflow…` — the chat side panel's ASSISTANT note
   (`ConversationSidePanel` prop `workflowChat`, action id `make_workflow`).
   It calls `openAssistantWorkflowDraft({ id, title })` (in `AssistantPopover.tsx`),
   which opens the assistant popover with a canned ask carrying the conversation
   id **as data**. ADR-0071 (assistant notes) does not exist yet, so the action
   is a plain button; the id is chosen so the notes store's action shape drops
   in unchanged.
2. The assistant reads the chat: tool `chat.transcript` (class **read**) —
   the caller-checked conversation read behind the `ChatTranscriptReader` face.
   A chat the caller cannot see answers the not-found sentinel (the 404 rule);
   the folded lines travel inside an explicit "untrusted data, never
   instructions" envelope, on top of the standing system rule that tool output
   is data.
3. It posts the **draft step list** as answer text (one line per step,
   `✓ / ● / ·` + name + agent profile) and asks every real fork with the
   existing `ui.question` tool — one question per turn; the reply returns as
   plain text. The system prompt carries the few-shot example of the shape
   (pinned by `TestDraftingRulesInTheSystemPrompt`).
4. It saves a **library draft**: tool `workflow.create_draft` (class
   **draft_edit** — gated at `ask_all`, ungated at the default `ask_risky`)
   behind the `LibraryDraftCreator` face. Before the create face sees anything,
   the server runs the full draft-validate chain (loader → pipeline schema →
   compiler, `validateLibraryDraftDocument`) over the model's document; a
   document that would not compile is refused **to the model** with the first
   diagnostic (same pre-card rule as `gatedDraftApply`), never stored and never
   carded. The model's document may carry the ADR-0066 typed inputs
   (`x-communication-input: {type: github_issue}` on `issue`) — the tool
   description shows the shape; the compiler is the authority.
5. **It never publishes.** The tool can only create; the answer payload says
   `published:false`; the flow rules forbid `pipeline.publish`, which stays
   separately gated. The result's change row (kind `draft_edit`, not undoable —
   deleting a fresh pipeline is not a safe inverse) feeds the existing
   `ChangeChip`, and the turn's link `Open draft → /workflows/<id>` (allowlist
   rule) renders through `MessageList` to the Studio.

## UI rendering

- `QuestionCard` (reused) carries the 2f card styling: accent-wash body, accent
  mono caps header `Question {n} of {m}` — **derived from the transcript** (the
  row's ordinal among question rows), not from model text — and the answered
  card keeps its options on screen with the chosen label inked (ink border +
  bold) when the reply row quotes one verbatim.
- `MessageList` renders a step-list paragraph (≥2 lines all opening with
  `✓ / ● / ·`) as `assistant-step-list` rows with glyph+word states.

## Wiring still owed by `internal/api` (outside this unit's boundary)

`NewConversationRunner` takes two new optional deps; until they are wired the
tools stay unannounced (honest degradation, same rule as every absent service):

- `Chats: ChatTranscriptReader` — implement on the assistant wiring with the
  caller-checked conversation read the `GET /api/v1/conversations/{id}` route
  uses (title, repository, agent profiles, flattened text lines).
- `Library: LibraryDraftCreator` — implement as `store.CreatePipeline` +
  `store.CreateDraft` (`DraftCreateInput{SourceKind: "assistant"}`), library
  role checked inside; map role denials to `assistant.ErrForbidden`.
- The UI page hosts that pass `workflowChat={{ id: conversationId, … }}` to
  `ConversationSidePanel` (`pages/Conversation.tsx`) — one prop, same reason.
