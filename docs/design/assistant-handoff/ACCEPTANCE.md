# Assistant handoff: acceptance checklist with evidence

Every box in `TASKS.md` is quoted here with the evidence that proves it.

**Kinds of evidence**
- **lab:** the Acceptance `lab-e2e` job, running on the real lab stack (two `serve` replicas, workers, Postgres, the real LLM gateway, and the deterministic speech/judge stub `e2e/stubs/assistant_stub.py`).
- **verif:** the Acceptance `verification (emulator loop)` job, which captures screens at 1280 and 390.
- **unit:** `pnpm --dir ui test` / `go test ./...` in the CI workflow. Store tests run there on real PostgreSQL 18.
- **walk:** the orchestrator's own `pnpx @playwright/cli` run against the local lab.

The final SHA and its CI/Acceptance runs are recorded at the end.

`e2e/tests/assistant-handoff.spec.ts` is abbreviated **AH** below; its legs are `:321` (1. setup), `:345` (2. frame), `:434` (3. credentials), `:489` (4. add a repo), `:574` (5. page context), `:626` (6. trust + judge), `:717` (7. dictation) and `:760` (8. settings).

## A1 · Frame (§1)
- [x] **Three sizes, one conversation:** popover (400px, bottom-right), side panel (450px, the page narrows beside it), full page.
  - lab AH:345 asserts the panel is 400 wide, the dock is 450 wide with `main` narrowed, and `/assistant` opens.
  - verif `e2e/emulator/assistant.spec.ts` (as-popover / as-dock / as-page, with design landmarks).
  - unit `AssistantPopover.test.tsx` covers the mode transitions.
- [x] **The full page is the real route `/assistant`:** threads | conversation ≤720px | "Looking at" + "Changes".
  - `ui/src/pages/AssistantPage.tsx` and the route in `ui/src/App.tsx`.
  - `internal/assistant/routes.go` adds `^/assistant$` to the navigate allowlist.
  - lab AH:345; verif as-page; design review: the page triptych.
- [x] **Header buttons:** new thread, threads, side panel, full page, close.
  - unit `AssistantPanel.test.tsx` (five buttons and their titles).
  - lab AH:345 and walk.
- [x] **Leaving full page returns to the popover,** not the side panel.
  - lab AH:345 (exit lands on the previous route with the panel 400 wide).
  - unit `AssistantPopover.test.tsx`; walk (the run page comes back in the popover).
- [x] **Columns hide on narrow windows:** below ~1240px the right column hides; below ~1000px the thread list hides and the thread buttons return to the header.
  - lab AH:345 checks the threads column at 1300 and 990 and the side column at 1300 and 1100.
  - unit `AssistantPopover.test.tsx` (`PAGE_THREADS_QUERY` / `PAGE_CONTEXT_QUERY`).
- [x] **Corners and menus:** the popover has `overflow: hidden`; the threads, page-context and trust menus are siblings of the panel, not inside it.
  - lab AH:345 asserts computed overflow `hidden` and that `assistant-pill-menu` and `assistant-context-menu` are not descendants of `assistant-panel`.
  - verif assistant.spec.ts asserts the same.
- [x] **Composer:** one bordered box; textarea on top; bottom row of page-context button, trust pill, spacer, mic and send, all 26–30px.
  - `ui/src/components/assistant/Composer.tsx`; unit `Composer.test.tsx` (structure and size classes).
  - design review: the popover triptychs.
- [x] **No Unicode glyphs as icons:** no `▾ ▴ ⤢ › ✓ ×` controls remain.
  - c283a0e; lab AH:345 checks the panel text against `RETIRED_GLYPHS`, and verif assistant.spec.ts does the same.
  - lab `m5-assistant.spec.ts` checks tool rows for a Tabler check/x mark.
- [x] **Copy:** short secondary text, one line per option.
  - The trust options use the handoff's one-line blurbs (`types.ts` `TRUST_LEVELS`); unit `TrustPill.test.tsx`.

## A2 · Icons (§1)
- [x] **Lucide is replaced by `@tabler/icons-react`** (3.50.0, a flagged new dependency) and `lucide-react` is removed.
  - 89212ed; `grep -rn lucide ui/src` returns nothing; `ui/package.json`.
- [x] **The assistant uses the handoff's icon mapping.**
  - `AssistantPanel.tsx` header: `IconEdit`, `IconMessages`, `IconLayoutSidebarRight`, `IconArrowsDiagonal`/`…Minimize2`, `IconX`.
  - `ContextButton.tsx`: `IconCurrentLocation`/`…Off`.
  - `MicButton.tsx`: `IconMicrophone`/`IconPlayerStop`.
  - `Composer.tsx`: `IconArrowUp`.
  - Chevrons and checks: `IconChevronDown`/`IconChevronRight`/`IconCheck`.

## A3 · Setup as a tool, run on open (§2)
- [x] **`system.status`** reports the chat, speech and decision models; workers online and sandbox mode; GitHub credential names; the project count; and workflows with their assignment.
  - `internal/api/assistant_status.go`; the route `GET /api/v1/assistant/status` and the tool in `runner.go`.
  - unit `assistant_status_test.go`: RouteShape, IsCallersOwn, WeakestSandboxMode, ToolAnswersWithRouteShape, and no secret values.
- [x] **It runs automatically when a thread is empty** (first open, or a new thread).
  - lab AH:321 opens a new thread on Today and sees the checklist.
  - unit `AssistantPopover.test.tsx` / `MessageList` `showSetup`.
- [x] **The checklist message** has one action per row (Set up / Check / Add one / Show) and three starters, replacing "FOR THIS PAGE".
  - `SetupChecklist.tsx`; unit `SetupChecklist.test.tsx` (every row state, the actions send exact prompts, the starters).
  - The retired test ids `assistant-empty` and `assistant-suggest` are in `ui/scripts/retired-testids.json`.
  - lab AH:321.
- [x] **The suggestions table's `home` key is fixed** to `today`.
  - f2dbaae. The static table was later removed with the checklist (3381d82), so no section key remains to mismatch.

## A4 · Page context (§3)
- [x] **Page context is sent with every message by default,** as data inside the user turn, never the system prompt. It includes the label, route, entity title/status and project.
  - `pageContext.ts`; `AssistantMessagePost.context.page` (openapi).
  - unit `conversation_test.go`: PageContextBlockTravelsInTheUserTurnNotTheSystemPrompt, ValidateTurnContextBoundsAndStripsThePage, AskEnvelopeCarriesThePageLabelAndStatus.
- [x] **The `<page_context observational="true">` block** carries the handoff's guidance and replaces the old "on screen" line in `runner.go` / `loop.go`.
  - `internal/assistant/conversation.go` `PageContextBlock`; unit PageContextBlockRendersTheHandoffShape, PageContextBlockOmitsEmptyLines.
- [x] **The UI shows page context only as an icon button,** whose menu has a "Send with my messages" checkbox.
  - `ContextButton.tsx`.
  - lab AH:574 unchecks it and asserts the next POST body has no `context`.
  - verif as-popover context screen.
- [x] **"assumed you meant … (on screen)"** appears when an answer relied on page context.
  - `prose.go` `SplitAssumedLine` plus a deterministic fallback in `runner.go` (8a89194).
  - unit TestSplitAssumedLine*, TestDeterministicAssumedBranches.
  - lab AH:574 asks "why is it stuck?" on a run page and sees `assistant-assumed`.

## A5 · Trust levels and the decision model (§4)
- [x] **Three levels with the handoff copy.**
  - `types.ts` `TRUST_LEVELS`; unit `TrustPill.test.tsx`, `settings/Assistant.test.tsx`.
  - lab AH:345 checks the trust menu text exactly; lab `shell-p789.spec.ts` test 9 checks the settings copy.
- [x] **The judge sees every call,** reads included (tool, bounded args, role, page), and returns allow/ask plus a reason.
  - `internal/assistant/judge.go`; unit TestDecideGateHandsTheJudgeTheWholeCall, TestChatJudgeUserMessageIsTheBoundedInput, TestJudgeEgressRefusesSecretMaterial.
  - The caller's project role is resolved per turn (51cfdca).
  - lab AH:626: `judge_calls` rises under ask-when-risky, and the tool line reads "judge allowed".
- [x] **Approving gates and granting permissions always ask.**
  - `judge.go` `alwaysAsk`; unit TestDecideGateTable.
- [x] **Judge down or slow → it asks.**
  - unit TestChatJudgeTimeoutAndUpstreamFailure, TestDecideGateTable, TestRunnerJudgeDownStillLetsReadsRun.
  - lab AH:626 flips the stub judge down; a risky ask then shows a card whose reason contains "didn't answer". walk: the same, by hand.
- [x] **No judge → the fixed table decides,** and the checklist warns.
  - unit TestDecideGateTable (nil judge); SetupChecklist "No decision model" warn row.
- [x] **Undo copy is honest:** "can be undone" is removed; only draft edits are reversible.
  - `types.ts`, `settings/Assistant.tsx`, `ChangeChip.tsx`.
  - unit `ChangeChip.test.tsx` ("undo all" appears only when a change is undoable).
  - lab p789 test 9 asserts no "undo" in the trust section.
- [x] **The confirm card has a "Why it asks" row.**
  - `ApprovalRequestCard.tsx`; unit `ApprovalRequestCard.test.tsx`.
  - lab AH:489 sees the judge's reason; AH:626 sees the judge-down reason.
- [x] **Config:** `COMMUNICATION_DECISION_*`.
  - `cmd/communication/serve.go`; lab `compose.real.yml` sets them.
- [x] **ADR.**
  - `docs/adr/ADR-0079-assistant-decision-model.md` records the provisional chat-completions contract while §4's model id stays open.

## A6 · Speech (§5)
- [x] **Server-side transcription proxy;** the key never reaches the browser.
  - `internal/api/assistant_speech.go`; unit `assistant_speech_test.go`: ForwardsToUpstream, NeverWritesAudioToDisk, FollowsSessionAndCSRFRules, InputRefusals, UpstreamFailuresAre502.
- [x] **Config:** `COMMUNICATION_SPEECH_*`.
  - `serve.go` `serveSpeechConfig`; lab `compose.real.yml`.
- [x] **Web Speech fallback** (a setting, on by default).
  - `useDictation.ts`, with the transcript hand-off fixed in c9fd6c7.
  - unit `Composer.test.tsx`: "falls back … 503", "hands the browser fallback's transcript to the box".
  - lab `shell-p789.spec.ts` test 4 (the status reports no speech model, so the fake recognizer fills the box).
- [x] **The mic is always present,** tap to record and tap to stop, and the transcript appends.
  - lab AH:717 types "hey,", records through the stub ASR and gets "hey, what workflows do I have"; walk: the same.
  - unit `Composer.test.tsx`.
- [x] **The transcript stays in the box by default,** and a setting sends it right away.
  - unit `Composer.test.tsx` ("sends straight away when speech_auto_send is on, marked spoken").
  - `settings/Assistant.tsx`.
- [x] **Audio is discarded after transcription.**
  - unit TestSpeechTranscriptionNeverWritesAudioToDisk; ADR-0080 §2.
- [x] **The "spoken" tag.**
  - lab AH:717 (`assistant-spoken` on the sent bubble); unit `MessageList.test.tsx`.
- [x] **Settings → Assistant → Speech.**
  - `pages/settings/Assistant.tsx`; unit `settings/Assistant.test.tsx`.
  - lab AH:760; verif as-settings.
- [x] **ADR.**
  - `docs/adr/ADR-0080-assistant-server-side-speech.md` supersedes 08-assistant's client-only sentence.

## A7 · Tools (§6)
- [x] **Read tools.**
  - `internal/assistant/tools_setup.go`, `internal/api/assistant_setup_tools.go`, `internal/assistant/howto/*.md`.
  - unit `assistant_setup_tools_test.go`: CredentialListNeverCarriesAValue, RepoCheck* including UsesACredentialNoRepositoryUses, WorkflowList/Inspect.
  - unit `tools_setup_test.go`, including DocsSearchFindsTheHowToForItsOwnWords.
  - store test `repo_credential_test.go` TestResolveSecretForCheckNamedCredentialWithoutRepository (real Postgres).
- [x] **Risky tools,** each through the same permission-checked service the UI uses.
  - `internal/assistant/tools_actions.go`, `internal/api/assistant_actions_setup.go`, migration 00030.
  - unit `assistant_actions_setup_test.go`: ProjectCreateWithRepoAndCredential, RepoAddAssignmentCancelSchedule, ViewerDenied, ScheduleCreateRefusesABadCron, AssignmentSetRefusesAnUnpublishedWorkflow.
- [x] **`credential.create` is not a tool;** the assistant links to the form.
  - It is absent from `toolClasses` (trust.go).
  - The how-to `add-a-github-token.md` and the tool descriptions point at the secrets form.
  - lab AH:434: the answer names the slug and never contains the token value.
- [x] **The add-a-repo flow:** URL → `repo.check` → one proposal card → Create → the change is logged → the project appears in the sidebar.
  - lab AH:489 runs it against the real `github.com/dbirks/comms-test-repo-1`. The card shows the project, repo @ main, credential and "Why it asks". Create shows CONFIRMED, and the sidebar link appears without a reload. The API shows the project, the repo row (git_url, default_branch main, credential configured) and a `project_create` change.
  - walk: done twice by hand on the local lab, creating `home-lab` and `home-lab-emv1`.

## A8 · Proof
- [x] **Unit and Go tests** for every new component, tool, route and fallback (listed per box above). Green on the final runs below.
- [x] **lab-e2e specs for each flow:** `e2e/tests/assistant-handoff.spec.ts` (8 legs), `shell-p789.spec.ts` (fallback mic, trust copy, ask_all card) and `m5-assistant.spec.ts` (tool rows). Green on the final runs below.
- [x] **Verification screens:** `e2e/emulator/assistant.spec.ts` (as-popover setup/trust/context, as-dock, as-page, as-settings at 1280 and 390, with design landmarks in `design.ts` and renders in `docs/design/assistant-handoff/png/`). Green on the final runs below.
- [x] **Fresh reviewers pass the triptychs.** See "Design parity" below.
- [x] **CI and Acceptance are green on the final main SHA.** Green on the final runs below.

## Design parity (fresh reviewers, design | ours 1280 | ours 390 | design 390)
- **The triptychs:** popover + setup checklist, trust menu, page-context menu, side panel, full page, add-a-repo proposal, dictation recording and dictation review.
  - The design side is the prototype rendered locally, in `docs/design/assistant-handoff/png/design-as-*`.
  - Ours is the real lab app with real data.
- **Five rounds, each by new reviewers who never saw an earlier verdict:**
  - **Round 1 (8317844's predecessor):** DEFECT. Checklist labels truncated at 390, "1 repos", "Untitled · unknown", round status marks, header contents, the proposal inset.
  - **Round 2:** MINOR. The trust pill's pressed fill and offset, the page's unsaved-thread row, uneven rows, stretched phone controls, the tool-line chevron, the band tint, the Running now overlap beside the side panel.
  - **Round 3:** MINOR. Phone composer controls widened outside `<main>`, the page row check, page header targets.
  - **Round 4:** 7 PASS, and 1 MINOR for the side panel header band.
  - **Final round, on a9aaab6:** 7 PASS, and 1 MINOR because the checklist should stay as the thread's first message, as in the prototype's `push({kind:'setup'})`.
  - **Re-review of a9aaab6 after that fix:** **all eight PASS.** OVERALL PASS.
- **Every round's findings were fixed:** 789a59f, 8317844, 6f4c889, b0b31a3, 0bffcf8, 9442072, d5eae0f, a9aaab6.

## Final runs
The final main SHA is the docs-only commit that adds this paragraph. The two code commits before it are the last changes.

**934d380 — two assistant prompt rules.**
- Answer questions in words, and call `ui.navigate` only when asked to open a page.
- Name each credential `credential.list` returned.

Acceptance 42799969404 caught the model opening the secrets page instead of naming the credential, so lab leg AH:434 failed. With the rules in place it passed 3 of 3 locally.

**02e6508 — verification fixes found by Acceptance 42808462555.**
- `REFLOW_ALLOWLIST` entries for the full page's thread and side columns, which hide on purpose at 390 per §1.
- The IA screen guard no longer scans the assistant's own terms: the checklist's chat-model label, the `chat.transcript` tool name, and a /threads row's agent-written preview.
- A guard spec proves the same words anywhere else still file.

**Results recorded before this commit**
- **934d380:** CI 42808462529 succeeded. Acceptance 42808462555 had lab-e2e green, all m4 shards, regrade and github-loop green, and verification red on the defects 02e6508 fixes.
- **Local lab at d5eae0f:** the three assistant specs gave **20 passed**.

The final SHA's own CI and Acceptance runs are the final word.

## Known, recorded limits
- §4's decision model id and endpoint shape are still open in the handoff. ADR-0079 records the provisional OpenAI-compatible contract; the lab proves it against a deterministic stub, and any chat model can serve it.
- §7 (Kubernetes execution mode), text-to-speech and streaming are out of scope, as the goal states.
- Secret slugs are lowercase (`^[a-z0-9]…`), so the design's `GITHUB_TOKEN` is `github-token` in a real install.
