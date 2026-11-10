# Assistant handoff: tasks

Source: `HANDOFF.md` (verbatim copy of the claude.ai/design `Assistant Handoff.md`, project dc036147-9edb-46ef-b923-46ff68513b70). The visual reference is `exploration.txt`, and the interaction reference is `prototype-logic.js` / `prototype-text.txt`. Each box below is one handoff bullet. Evidence for each box goes in `ACCEPTANCE.md`. Section §7 (Kubernetes execution mode), text-to-speech and streaming are out of scope (§8). The wire shapes are in `CONTRACT.md`.

## A1 · Frame (§1)
- [ ] Three sizes, one conversation: popover (400px, bottom-right), side panel (450px, page narrows beside it), full page.
- [ ] The full page is a real route `/assistant`: thread list on the left, the conversation at ≤720px in the centre, and "Looking at" + "Changes" on the right.
- [ ] Header buttons: new thread, threads, side panel, full page, close.
- [ ] Leaving full page returns to the popover, not the side panel.
- [ ] Below ~1240px the right column hides. Below ~1000px the thread list hides and the thread buttons return to the header.
- [ ] Corners: the popover panel has `overflow: hidden`. The threads, page-context and trust menus render as siblings of the panel, not inside it.
- [ ] Composer: one bordered box. Textarea on top. The bottom row holds the page-context button, trust pill, spacer, mic and send, all 26–30px and matching.
- [ ] No Unicode glyphs as icons: no `▾ ▴ ⤢ › ✓ ×` controls remain.
- [ ] Copy: secondary text is short, one line per option, with no stacked footers.

## A2 · Icons (§1)
- [ ] Lucide is replaced by Tabler (`@tabler/icons-react`) app-wide, and `lucide-react` is removed (a flagged new dependency).
- [ ] The assistant uses the handoff mapping: new thread `edit`, threads `messages`, side panel `layout-sidebar-right`, full page `arrows-diagonal` / `arrows-diagonal-minimize-2`, close `x`, page context `current-location` / `current-location-off`, mic `microphone`, stop `player-stop`, send `arrow-up`, chevrons `chevron-down` / `chevron-right`, check `check`.

## A3 · Setup as a tool, run on open (§2)
- [ ] New read tool `system.status` reports: chat model, speech model and decision model; workers online and sandbox mode; GitHub credential presence (names only); project count; workflows and their assignment.
- [ ] It runs automatically when a thread is empty (first open, or a new thread).
- [ ] The result renders as a checklist message with one action per row ("Set up", "Check", "Add one", "Show") plus three starter prompts, replacing the static "FOR THIS PAGE" chips.
- [ ] The suggestions table's `home` key is fixed: the section is now `today`.

## A4 · Page context (§3)
- [ ] Page context is sent with every message by default, as data inside the user turn and never in the system prompt. It includes the page label, route, entity title/status and project.
- [ ] The prompt block is `<page_context observational="true">` with the handoff's guidance text. It replaces the "this run means what is on screen" line in `runner.go` / `loop.go`.
- [ ] The UI shows page context only as a small icon button in the composer. Clicking it shows what's attached, with a "Send with my messages" checkbox to stop sending it.
- [ ] When an answer relied on page context, a quiet line under the answer says "assumed you meant … (on screen)".

## A5 · Trust levels and the decision model (§4)
- [ ] Three levels: "Ask before every change" (you confirm every change); "Ask when it looks risky" (the default: a decision model checks each call and flagged ones wait for you); "Don't ask" (everything runs and each action is listed in the thread).
- [ ] The judge sees every tool call, reads included: the tool name, bounded args, the caller's role and the page context. It returns allow / ask plus a one-line reason.
- [ ] Always ask, whatever the judge says: approving gates and granting agent permissions.
- [ ] If the judge is down or slow, the call asks the user.
- [ ] With no judge configured, the fixed table decides (reads and draft edits run, anything else asks), and the setup checklist warns about it.
- [ ] Undo: "can be undone" is gone from the trust copy (`types.ts` `TRUST_LEVELS`, `pages/settings/Assistant.tsx`). Only draft edits are reversible, and the change list keeps "can't be undone" on everything else.
- [ ] The confirm card has a "Why it asks" row: the judge's reason, or "Creates real state" under the fixed table.
- [ ] Config: `COMMUNICATION_DECISION_BASE_URL`, `COMMUNICATION_DECISION_API_KEY[_FILE]`, `COMMUNICATION_DECISION_MODEL`, `COMMUNICATION_DECISION_TIMEOUT`.
- [ ] An ADR records the decision model (security boundary), including the endpoint contract chosen while §4's model id and shape stay open.

## A6 · Speech (§5)
- [ ] Server-side transcription: the browser records, and `serve` proxies the audio to an OpenAI-compatible `/audio/transcriptions` endpoint, so the key never reaches the browser.
- [ ] Config: `COMMUNICATION_SPEECH_BASE_URL`, `COMMUNICATION_SPEECH_API_KEY[_FILE]`, `COMMUNICATION_SPEECH_MODEL`.
- [ ] Fallback: the browser's Web Speech API when the endpoint is unset or down (a setting, on by default).
- [ ] The mic is always present, including when there's text in the box. Tap to record, tap to stop. The transcript appends to whatever is already in the box.
- [ ] After dictation, the text stays in the box by default. A setting sends it right away.
- [ ] Audio is discarded after transcription.
- [ ] Spoken user messages carry a small "spoken" tag.
- [ ] Settings → Assistant → Speech shows the endpoint, model, key set (never shown) and status, plus the two settings.
- [ ] An ADR records that speech-to-text is no longer client-only (it changes `08-assistant.md`).

## A7 · Tools (§6)
- [ ] Read tools: `credential.list` (names, kind, scope, which projects use each; never values), `docs.search` (a curated how-to set), `workflow.list` / `workflow.inspect`, `repo.check` (URL → can a credential reach it, default branch, push rights), `issue.list`, `profile.list`, `schedule.list`.
- [ ] Risky tools: `project.create` (from a confirmed proposal), `repo.add` (repo + credential by name), `assignment.set` (shows the promotion preview first), `run.cancel`, `schedule.create`. Each runs through the same permission-checked service the UI uses.
- [ ] `credential.create` is not a tool: the assistant links to the form, and secrets never pass through the model.
- [ ] Add-a-repo flow: paste a URL or pick from repos the credential can see → `repo.check` → one proposal card (project, repo @ branch, credential, workflow, why it asks) → Create → the change is logged → the project appears in the sidebar.

## A8 · Proof
- [ ] Unit (vitest) and Go tests for every new component, tool, route and fallback.
- [ ] lab-e2e specs: setup checklist; credentials answer; add-a-repo creates a real project against a real GitHub repo; page-context "assumed" line; trust levels including judge down; dictation through a stub ASR endpoint.
- [ ] Verification loop screens: popover, side panel and full page at 1280 and 390.
- [ ] Fresh reviewers pass design | 1280 | 390 triptychs for popover, side panel, full page, setup checklist, add-repo proposal, trust menu and dictation.
- [ ] CI and Acceptance are green on the final main SHA.
