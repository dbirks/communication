# App-shell and IA redesign — acceptance record (Six Directions handoff)

Final acceptance record for the app-shell + information-architecture redesign
(`docs/design/handoff-app-shell/README.md`, "Six Directions"). Implemented across the
commit range **`5e42f62`..`d2708cb`** (CI green on `d2708cb`, and every push since
`7c40979`). Every requirement below maps to a spec test (or is honestly marked
NOT COVERED) and to an evidence slot filled from the final lab runs' `EVIDENCE` lines
(see **Run provenance**). Like `docs/design/issue2-acceptance.md`, screenshots stay
outside git; only `EVIDENCE` lines and this record are in the tree.

## Round 2 evidence — 2026-10-22 (run tag `p10b`)

On the lab rebuilt from the working tree content at `c5ef3d7` (Round 2), run tag `p10b`
(evidence dir `~/.cache/communication-lab/shell/p10b/ev`):

- **shell-p10-gaps: 4/4 passed** (`rc=0`, 19.2s) — workflow triggers (add + pause a weekdays
  09:00 UTC schedule and clean-up), repository page (`/p/<id>/<repo>` sections render, unknown repo
  not-found, fits at 390px), usage (USED BY equals the profile usage report), thread artifacts
  (the thread rail lists the thread's artifacts).
- **shell-p789: 9/9 passed** (`rc=0`, 3.4m) — live flag, board mine + from-issues/scheduled chips
  enabled, save-step, mic, trust journeys, approval detail/narrow, ops, settings.

EVIDENCE lines (`grep EVIDENCE`) from `~/.cache/communication-lab/shell/p10b/*.out`:

```
EVIDENCE shell-p10-gaps-triggers-add: the feature-development page's Triggers section added a "weekdays 09:00 UTC" schedule: the row shows the cron "0 9 * * 1-5" and the plain-English reading "every weekday at 09:00 UTC", and GET /api/v1/projects/{id}/schedules echoes the same cron
EVIDENCE shell-p10-gaps-triggers-pause: toggling the schedule's pause flipped the server's enabled flag to false (GET /api/v1/projects/{id}/schedules: enabled=false, state "paused") and the scratch schedule was cleaned up disabled
EVIDENCE shell-p10-gaps-repository: from the project page the repo link "app" opened /p/01a1658e-5d41-7d47-8647-dc0c493eb36b/app and the repository page renders its header, STATUS, ISSUES and RECENT RUNS sections
EVIDENCE shell-p10-gaps-repository-narrow: at 390px the repository page renders its sections without sideways scroll
EVIDENCE shell-p10-gaps-usage: the profile m4-reviewer's USED BY panel reads "Used by 1 workflows · 1 steps" from GET /api/v1/agent-profiles/01a1658e-65e7-762f-96e5-cb3c206ec1f0/usage, with no "usage unavailable" state, and the step's USED IN panel answers GET /api/v1/node-templates/01a16592-24a7-70ee-a3fc-993f040741ba/usage
EVIDENCE shell-p10-gaps-thread-artifacts: the thread 01a1658e's artifacts rail renders its section and lists 0 artifact row(s) == GET /api/v1/projects/{id}/artifacts?conversation_id=<id> (capped at 5)
EVIDENCE shell-p789-live-flag: the sidebar Inbox flag rose from 2 to 3 within 10 s of run 01a16592 entering waiting_human, with ZERO /runs|/approvals GETs during the 8 s idle window, 6 invalidation refetch(es) after the run, and 141 SSE frame(s) captured on /api/v1/events — every refetch timestamped after the first frame
EVIDENCE shell-p789-board-mine: board cards without the filter equal GET /api/v1/runs (3 of 3), with 'mine' pressed the 1 cards equal GET /api/v1/runs?mine=true, and the from issues / scheduled chips are enabled and idle (ADR-0056)
EVIDENCE shell-p789-save-step: selecting the agent node in the p789-step-1792705470971 draft and arming 'also save as a reusable step' POSTed the node as template 01a16592 — it is listed by GET /api/v1/node-templates and shows on /steps
EVIDENCE shell-p789-mic: the fake SpeechRecognition's interim + final results drove the listening bar and landed 'change the build please' in the composer, where ' and ship it' was typed on top — and ZERO non-GET requests reached /api/v1/assistant/ before Send
EVIDENCE shell-p789-trust-ask-all: with trust level ask_all the assistant's draft edit ('add a human approval step named trust_check after plan in p789-trust-1792705479792') surfaced a confirm card carrying the server risk line, and GET /api/v1/drafts/01a16592 still holds the document WITHOUT trust_check at version 1
EVIDENCE shell-p789-trust-retry: clicking Retry re-ran the gated draft.apply through the version-checked draft PUT: GET /api/v1/drafts/{id} now contains the trust_check node
EVIDENCE shell-p789-trust-navigate: DOCUMENTED SECONDARY CHECK (no assertion on model choice): under ask_all 'take me to the board' neither called ui.navigate nor named the board in its answer
EVIDENCE shell-p789-question-roundtrip: the model's follow-up card appeared after 'change the workflow'; the option click POSTed the LABEL 'Add a node' verbatim as the body's plain-text 'text' field (no value, no structured payload, no confirm/dismiss) — the answer's user row had not landed when the 120 s bounded confirmation window closed (the answer turn, 180 s per completion at the lab, was still running); the POST body is the round-trip proof
EVIDENCE shell-p789-approval-detail: the amber 'NEEDS YOUR DECISION' strip, the model summary card, the plan section and the 'Not available yet' files note all rendered for gate a67219f9d8e15; the free-text reply produced a proposed decision and its confirm step, which the journey cancelled — the API still lists the approval pending
EVIDENCE shell-p789-approval-narrow: at 390px the strip, the files note and the decide rail stack without sideways scroll and stay axe-clean; the gate is still pending (the journey cancelled, never decided)
EVIDENCE shell-p789-ops: the health line reads 'replica: api-b · queue: 0 queued, 0 leased · oldest queued: queue empty', the workers table holds 2 rows == GET /api/v1/workers, and every capability cell matches GET /api/v1/launchers (✓ observed only where result=observed: claude:acp_session, claude:resume, claude:permission_prompts, claude:nono_required, codex:acp_session, codex:resume, codex:permission_prompts)
EVIDENCE shell-p789-settings: settings → assistant shows all three trust levels with the stored one (ask_risky) checked, matching GET /me/preferences, and the settings footer's Operations entry links to /ops
```

Plus the Round 2 real (non-lab) evidence:

- Real APM resolve test: `mattpocock/skills#v1.3.1` resolved by apm → lock digest
  `sha256:44cf8ba0ba5b34af878358795b4f0dbcbc5698ebfe72c7cfc162d5f7040cc55d` (apm
  0.34.0, 2026-10-23); `#v1.3.0` → a
  different digest.
- Real-nono secret sentinel tests: `TestProcExecEnvMountSentinelUnderRealNonoStaysInTheExecEnv`
  (process.exec) and `TestAgentTurnEnvMountSentinelUnderRealNonoStaysInTheExecEnv` (agent turn) —
  the exec-delivered secret reaches the real sandboxed child and never rides the launch argv
  (fixed in `b58404e`).

## Final acceptance run — final4 (HEAD 606b36e)

Provenance: lab reset from HEAD `606b36e` (CI green), run dirs
`~/.cache/communication-lab/shell/final4/` and `final4-m5/`, lab assistant model
`qwen3-8-27b-amd`, date 2026-10-22.

| Suite | Result |
|---|---|
| journey | 6/6 |
| shell-p1 | 7/7 |
| shell-p2 | 5/5 |
| shell-p3 | 3/3 |
| shell-p4 | 4/4 |
| shell-p5 | 4/4 |
| shell-p6 | 3/3 |
| shell-p789 | 9/9 |
| issue2-studio | 7/7 |
| issue2-workbench | 5/5 |
| issue2-conversations | 3/3 |
| m5-agents-schedules | 3/3 |
| m5-assistant | 3/3 |
| m5-inbox | 6/6 |
| m5-issue-run | 5/5 |
| m5-journey | 10/10 + 1 pre-existing skip |
| m5-layout | 20/20 |
| m5-prompt-edit | 6/6 |

This run supersedes the earlier d2708cb runs (final3, jr015620) cited in the
requirement rows below; every EVIDENCE name in those rows also appears in
final4 with the final4 stamp — see Appendix A.

## How to re-run

With a lab stack running and its UI reachable (`E2E_BASE_URL`), from the repo root:

```bash
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install chromium

# Phases 1–6 suites (env-gated; skipped everywhere else)
COMMUNICATION_E2E_SHELL=1 E2E_BASE_URL=http://<lab-ui> \
  E2E_EVIDENCE_DIR=$HOME/.cache/communication-lab/shell/final3 \
  pnpm --dir e2e test \
    tests/shell-p1-shell.spec.ts tests/shell-p2-home-board.spec.ts tests/shell-p3-workbench.spec.ts \
    tests/shell-p4-library.spec.ts tests/shell-p5-profiles.spec.ts tests/shell-p6-threads.spec.ts

# The full journey (a–f)
COMMUNICATION_E2E_SHELL_JOURNEY=1 E2E_BASE_URL=http://<lab-ui> \
  E2E_EVIDENCE_DIR=$HOME/.cache/communication-lab/shell/jr015620 \
  E2E_SHELL_STAMP=j$RANDOM pnpm --dir e2e test tests/shell-journey.spec.ts

# Issue #2 regression (Studio, Workbench, Conversations)
COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://<lab-ui> \
  pnpm --dir e2e test \
    tests/issue2-studio.spec.ts tests/issue2-workbench.spec.ts tests/issue2-conversations.spec.ts

# M5 regression (journey, layout matrix, inbox, assistant, agents/schedules, issue-run, prompt-edit)
COMMUNICATION_E2E_M5=1 E2E_BASE_URL=http://<lab-ui> \
  pnpm --dir e2e test \
    tests/m5-journey.spec.ts tests/m5-layout.spec.ts tests/m5-inbox.spec.ts tests/m5-assistant.spec.ts \
    tests/m5-agents-schedules.spec.ts tests/m5-issue-run.spec.ts tests/m5-prompt-edit.spec.ts
```

- Every page in every shell suite runs `checkShellScreen`
  (`e2e/tests/shell-helpers.ts:54`): axe with zero serious/critical violations, no
  sideways scroll, no page errors — at desktop 1500x950 and narrow 390x844.
- `E2E_EVIDENCE_DIR` (default `test-results/shell/`) receives the per-step screenshots
  and `EVIDENCE <name>: <what it proves>` console lines the evidence below is
  built from.

## Run provenance

All evidence below comes from the final lab runs on the lab reset from HEAD **`d2708cb`**
(CI green on `d2708cb`, and every push since `7c40979`); the lab assistant model was
`qwen3-8-27b-amd` (`flint` was unavailable at times; the pi workers used `flint`).
Run directories under `~/.cache/communication-lab/shell/`; screenshots cited as
`ev/<file>.png` are under the run's own `ev/` directory:

| tag | suites | result |
|---|---|---|
| `final3/` | shell-p1…p6, shell-p789, shell-journey, issue2-studio/workbench/conversations | p1 7 passed, p2 5, p3 3, p4 4, p5 4, p6 3, p789 9; issue2-studio 7, issue2-workbench 5, issue2-conversations 3 — all rc=0; shell-journey 5 passed, 1 failed (step f: the assistant never landed `journey_check` after 3 follow-up turns — model variance) |
| `final3-m5/` | all 7 M5 suites | m5-journey 10 passed + 1 skipped, m5-inbox 6, m5-assistant 3, m5-agents-schedules 3, m5-issue-run 5, m5-prompt-edit 6, m5-layout 20 passed (36.2s) — all rc=0 |
| `jr015620/` | shell-journey full, including step f | 6 passed (7.6m) — the final acceptance journey on the same lab/HEAD |

The final acceptance journey is `jr015620/` — **6/6 passed (7.6m)**; the `final3/` journey
run (5/6) failed only at step f on the assistant turn and was superseded by `jr015620/`.
Every suite's `.out` also carries `A11Y <page>: 0 violations` lines at both widths.

## Step 0 — handoff and gap register

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Handoff bundle copied into the tree (README, GOAL, artboard HTML, support.js) | `docs/design/handoff-app-shell/` | no runtime artifact — docs deliverable (`5e42f62`) | docs deliverable — files present in the tree | PASS |
| Per-area gap analyses with `path:line` evidence | `gaps/{shell,home-board,workbench,library,profiles,threads,assistant,inbox-ops}.md` (`5e42f62`) | no runtime artifact — docs deliverable | docs deliverable — files present in the tree | PASS |
| GAPS.md living gap register: shipped/stubbed/next per phase, honest empty-state table (path:line), ADR register 0045–0055, 19 spec conflicts tagged resolved/unresolved | `docs/design/handoff-app-shell/GAPS.md` | no runtime artifact — docs deliverable (`86f0910`, `c3d6a23`) | docs deliverable — updated through the post-`c3d6a23` commits | PASS |

## Decisions (ADRs)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| ADR-0045 — agents may hold a scoped GitHub token in the sandbox; **Publish leaves the step picker** (spec 05 amended in place) | `docs/adr/ADR-0045-agent-held-github-token.md`; picker: Studio step picker (`5198c90`) | `shell-p4-library.spec.ts:129` ("five kind cards, no Publish; the Agent step gets its profile select") | `EVIDENCE shell-p4-step-picker`: "…exactly five primary kind cards (Agent, Command, Approval, Loop, Workflow) and no Publish card" — `ev/shell-p4-step-picker.png` (final3); journey a uses the dialog path — `journey-a-dialog-jr015620` | PASS |
| ADR-0046 — per-user preferences `GET/PATCH /api/v1/me/preferences` | `docs/adr/ADR-0046-user-preferences.md`; `ui/src/lib/prefs.ts`; migration 00008 | `shell-p1-shell.spec.ts:105` ("tree expansion persists across reload — /me/preferences carries it") | `EVIDENCE shell-p1-tree-expand`: "expanding 'M4 Exit' PATCHes /api/v1/me/preferences (layout.expanded), the GET returns it, and the expansion is still applied after a reload" — `ev/shell-p1-tree-expand.png` (final3) | PASS |
| ADR-0047 — cross-project reads `GET /api/v1/runs` (per-step progress, one query) `/approvals` `/conversations`, membership-scoped | `docs/adr/ADR-0047-cross-project-reads.md`; `ui/src/pages/{Home,Board,Threads}.tsx` | `shell-p2-home-board.spec.ts:77`, `:125` (counts equal the API); `shell-p6-threads.spec.ts:40` (threads list = API) | `EVIDENCE shell-p2-home-count-line` ("home count line equals GET /api/v1/runs per-column counts"), `shell-p2-board-columns` ("board column counts equal the API's per-status counts"), `shell-p6-threads-list` ("exactly the 7 cross-project summaries from GET /api/v1/conversations") — `ev/shell-p2-home-count-line.png`, `ev/shell-p2-board-columns.png`, `ev/shell-p6-threads-list.png` (final3) | PASS |
| ADR-0048 — org event stream `GET /api/v1/events` (SSE, Last-Event-ID resume) powering the live flags with no polling | `docs/adr/ADR-0048-org-event-stream.md`; `ui/src/api/events.ts` (`useOrgEvents`) | unit tests: `internal/store/postgres/events_test.go`; live flag now covered by `shell-p789` | `EVIDENCE shell-p789-live-flag`: "the sidebar Inbox flag rose from 2 to 3 … with ZERO /runs\|/approvals GETs during the 8 s idle window … 804 SSE frame(s) captured on /api/v1/events" — `ev/shell-p789-live-flag.png` (final3) | PASS |
| ADR-0049 — Step (node-template) registry + workflow folders: immutable revisions, fail-closed `slug@semver`, usage refs at publish, edit-for-all, save-as-reusable | `docs/adr/ADR-0049-step-registry-and-folders.md`; migration 00009 + `pipelines.folder` (`3349840`, `80033b6`, `6222d01`) | `shell-p4-library.spec.ts:212` ("registry rows with used-in from the API; Edit for all creates a new revision"); unit tests: `internal/store/postgres/node_templates_test.go`, `node_templates_p2_test.go`, `internal/api/node_templates_test.go` | `EVIDENCE shell-p4-steps-registry` ("…each with its used-in line from GET /api/v1/node-templates"), `shell-p4-edit-for-all` ("…the API's latest revision now carries the version label '1.0.1'"), `shell-p789-save-step` ("…POSTed the node as template … listed by GET /api/v1/node-templates and shows on /steps") — `ev/shell-p4-steps-registry.png`, `ev/shell-p4-edit-for-all.png`, `ev/shell-p789-save-step.png` (final3) | PASS |
| ADR-0050 — Assistant v2: persisted conversations/messages/changes + undo, plain-text follow-ups, trust-level gating in the tool loop (amends ADR-0034) | `docs/adr/ADR-0050-assistant-v2.md`; `internal/api/assistant_conversations.go` (`c3cf02f`, `618420f`), migration 00010 | `shell-journey.spec.ts:689` (journey f); unit tests: `internal/api/assistant_conversations_test.go`, `internal/store/postgres/assistant_conversations_test.go` | `EVIDENCE journey-f-changed-jr015620`: "the assistant's change chip counts its change(s), and the draft …'s YAML now contains journey_check (via the API)", `journey-f-undone-jr015620`: "undo all: no draft … contains journey_check any more" — `ev/journey-f-changed-jr015620.png`, `ev/journey-f-undone-jr015620.png` (jr015620) | PASS |
| ADR-0051 — launcher registry + evidence-backed capabilities `GET /api/v1/launchers` | `docs/adr/ADR-0051-launcher-registry-api.md`; `internal/api/launchers.go` (`80033b6`) | `shell-p5-profiles.spec.ts:66` ("detail capability cells read from the probes") | `EVIDENCE shell-p5-detail`: "every capability cell equals the launcher's recorded evidence (observed / not supported / not tested)", `shell-p5-dialog-disabled-cards` ("unregistered Pi and Antigravity cards are disabled with their reasons") — `ev/shell-p5-detail.png`, `ev/shell-p5-dialog-disabled-cards.png` (final3) | PASS |
| ADR-0052 — approval summaries + free-text interpretation | `docs/adr/ADR-0052-approval-summaries.md`; `internal/api/approval_summary.go` (`6222d01`) | unit tests: `internal/api/approval_summary_test.go`; desktop detail covered by `shell-p789` | `EVIDENCE shell-p789-approval-detail`: "the model summary card, the plan section and the 'Not available yet' files note all rendered … the free-text reply produced a proposed decision and its confirm step" — `ev/shell-p789-approval-detail.png` (final3) | PASS |
| ADR-0053 — run from a thread branch: `RunCreate.source`, `handoff_summary` input, run↔thread link | `docs/adr/ADR-0053-run-from-thread.md`; migration 00011 (`6222d01`) | `shell-p6-threads.spec.ts:73` (hand-to-workflow, honest copy) | `EVIDENCE shell-p6-thread-rail`: "the 'Hand to a workflow…' follow-up offered (never fake state)" — `ev/shell-p6-thread-rail.png` (final3); the wire path (`RunCreate.source`, `handoff_summary`) is proven by the unit/integration tests cited in the spec-test column — the e2e asserts the UI side only | PASS |
| ADR-0054 — server-side APM lock digest (design accepted; implementation later) | `docs/adr/ADR-0054-server-side-apm-lock.md` (`cf5af0e`) | NOT COVERED (implementation deferred by the ADR — dialog renders the honest state instead) | NOT COVERED — no EVIDENCE line asserts the honest "paste it by hand" cell; the ADR defers the implementation | NOT COVERED |
| ADR-0055 — pause-before-next-step (Proposed; the redesign keeps the accepted interrupt-and-rerun takeover and says so in the confirm card) | `docs/adr/ADR-0055-pause-before-next-step.md` (`cf5af0e`); confirm card copy (`126af18`) | `shell-p3-workbench.spec.ts:109` ("the confirm card with truthful copy") | `EVIDENCE shell-p3-take-control-card`: "the confirm card … with a truthful copy and a Just watch option", `shell-p3-take-control-cancelled`: "Escape and Just watch both close the confirm card and no POST …/take-control is sent" — `ev/shell-p3-take-control-card.png`, `ev/shell-p3-take-control-cancelled.png` (final3) | PASS |

## Phase 1 — shell (Sidebar v3, live flags, chevrons, persisted expand, routes)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Left sidebar replaces the top app bar on every page; 240px, cross-project nav (Home, Inbox, Board, Threads) pointing at canonical routes | `ui/src/components/Sidebar.tsx` in `ui/src/components/Shell.tsx` | `shell-p1-shell.spec.ts:45` ("no legacy primary header, nav rows point at canonical routes"); `:220` (always visible at 1500x950) | `EVIDENCE shell-p1-sidebar`: "the sidebar is present, the old header[aria-label=Primary] app bar is gone, and all seven nav rows link to the canonical C1 routes" — `ev/shell-p1-sidebar.png` (final3) | PASS |
| Live status flags from the cross-project reads + org SSE (no polling) | sidebar flag slots (`ui/src/lib/sidebarFlags.ts`, `useOrgEvents`) | unit tests: `ui/src/lib/sidebarFlags.test.ts`, `ui/src/components/Sidebar.test.tsx:284` ("the sidebar flags read off the same reduction as Inbox"); live-flag update covered by `shell-p789` | `EVIDENCE shell-p789-live-flag`: flag rose 2→3 "with ZERO /runs\|/approvals GETs during the 8 s idle window … 804 SSE frame(s) captured on /api/v1/events" — `ev/shell-p789-live-flag.png` (final3) | PASS |
| Projects tree (default) with SVG chevrons (not the ▾ glyph) | `Sidebar.tsx` | unit tests: `ui/src/components/Sidebar.test.tsx` (chevron open/close, collapse by default) | unit tests (chevron glyph, open/close, collapse) + `EVIDENCE shell-p1-tree-expand` (tree expansion through the live UI, `ev/shell-p1-tree-expand.png`); the SVG glyph itself is unit-tested, not e2e-asserted | PASS |
| Project switcher as a per-user setting | `/settings/layout` → `Sidebar` mode swap | `shell-p1-shell.spec.ts:151` ("switcher mode swaps the sidebar; floating ask shows ask-float") | `EVIDENCE shell-p1-switcher-mode`: "choosing the switcher projects mode re-renders the sidebar's project block as the project switcher", `shell-p1-ask-floating`: "…renders the ask-float control on the home page" — `ev/shell-p1-switcher-mode.png`, `ev/shell-p1-ask-floating.png` (final3) | PASS |
| Expand state persisted per user across reload | `/me/preferences` `layout.expanded` (ADR-0046) | `shell-p1-shell.spec.ts:105` ("tree expansion persists across reload") | `EVIDENCE shell-p1-tree-expand`: "…the expansion is still applied after a reload" — `ev/shell-p1-tree-expand.png` (final3) | PASS |
| Library section: Workflows (folders), Steps, Agent profiles | `Sidebar.tsx` rows → `/workflows`, `/steps`, `/profiles` | `shell-p1-shell.spec.ts:45` (rows + hrefs); folders grouping: unit tests `ui/src/pages/Library.test.tsx:590` ("/workflows — folders (ADR-0049 § 8)") | `EVIDENCE shell-p1-sidebar` (all seven nav rows, incl. Workflows/Steps/Agent profiles, link to the canonical routes) — `ev/shell-p1-sidebar.png` (final3); folder grouping unit-tested | PASS |
| New canonical routes per the README (`/`, `/board`, `/threads`, `/p/:id…`, `/workflows…`, `/steps`, `/profiles`, `/runs/:id`, `/ops`, `/settings/:tab`) with every old route redirecting | `ui/src/App.tsx`, `ui/src/lib/routes.ts` | `shell-p1-shell.spec.ts:69` ("legacy routes redirect to the canonical URLs") | `EVIDENCE shell-p1-redirects`: "all 5 legacy URLs … land on their canonical C1 URLs with query state preserved" — `ev/shell-p1-redirects.png` (final3) | PASS |
| Phone: off-canvas drawer from the menu button, esc closes it | `Sidebar.tsx` drawer mode | `shell-p1-shell.spec.ts:230` ("phone drawer opens from the menu button and esc closes it") | `EVIDENCE shell-p1-drawer-open`: "at 390x844 the menu button opens the sidebar drawer with the nav rows inside", `shell-p1-drawer-esc`: "Escape closes the drawer and the page stays without sideways scroll" — `ev/shell-p1-drawer-open.png`, `ev/shell-p1-drawer-esc.png` (final3) | PASS |

## Phase 2 — Home briefing and Board

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Home count line from real cross-project reads | `/` — `ui/src/pages/Home.tsx` | `shell-p2-home-board.spec.ts:77` ("Home: count line and a decision callout per pending approval") | `EVIDENCE shell-p2-home-count-line`: "home count line equals GET /api/v1/runs per-column counts (2 need you, 0 failed, 0 running, 0 queued); zero segments are omitted" — `ev/shell-p2-home-count-line.png` (final3) | PASS |
| One decision callout per pending approval (real approvals, never faked) | `/` — decision callout (`components/home/`) | `shell-p2-home-board.spec.ts:77` (one `home-callout-<id>` per `GET /approvals?status=pending`) | `EVIDENCE shell-p2-home-callouts`: "home shows one decision callout per pending approval from GET /api/v1/approvals?status=pending (2 callout(s))" — `ev/shell-p2-home-callouts.png` (final3) | PASS |
| Running-now panel (segmented per-step progress, ADR-0047 `steps`) + recent threads | `/` — `ui/src/components/home/` | unit tests: `ui/src/components/home/home.test.tsx` ("running now" + recent-threads rows); e2e beyond the count line — NOT COVERED | `EVIDENCE shell-p2-home-count-line` also asserts "zero segments are omitted" on the running-now line; panel rendering + recent-threads rows are unit-tested — the beyond-the-count-line e2e stays NOT COVERED | PASS |
| Board: 5 state columns (queued/running/needs-you/failed/done), column counts equal the API, group-by (by state / by repo / by workflow) | `/board` — `ui/src/pages/Board.tsx` | `shell-p2-home-board.spec.ts:125` ("column counts equal the API; repo and workflow groupings") | `EVIDENCE shell-p2-board-columns`: "board column counts equal the API's per-status counts", `shell-p2-board-group-repo`, `shell-p2-board-group-workflow` (groupings re-group the same cards) — `ev/shell-p2-board-columns.png`, `ev/shell-p2-board-group-repo.png`, `ev/shell-p2-board-group-workflow.png` (final3) | PASS |
| Board filters (all projects / mine / from issues / scheduled) | `Board.tsx` filter chips | `shell-p789` board-filters step (added `8a25de6`) | `EVIDENCE shell-p789-board-mine`: "with 'mine' pressed the 3 cards equal GET /api/v1/runs?mine=true, and the 'from issues' + 'scheduled' chips are disabled with the 'not available yet' title (ADR-0031: no trigger-source data)" — `ev/shell-p789-board-mine.png` (final3) | PASS |
| Right-side run drawer (440px) on card click, `?run=` deep link, focus stays in the drawer, esc closes | `Board.tsx` drawer | `shell-p2-home-board.spec.ts:174` ("card click opens the drawer on ?run=; focus stays in the drawer; esc closes"); unit tests: `ui/src/pages/Board.test.tsx:77` ("Board run-drawer wiring") | `EVIDENCE shell-p2-drawer-open`: "clicking the run card opens the 440px drawer and the URL carries ?run=", `shell-p2-drawer-focus-esc`: "focus starts inside the drawer and 25 Tab presses never escape it; Escape closes the drawer and drops ?run=" — `ev/shell-p2-drawer-open.png`, `ev/shell-p2-drawer-focus-esc.png` (final3) | PASS |
| Approve from the drawer always shows a confirm step | drawer actions | `shell-p2-home-board.spec.ts:217` ("drawer Approve shows a confirm step; the journey cancels it") | `EVIDENCE shell-p2-drawer-approve-confirm`: "the drawer's Approve button shows a confirm step before any decision is recorded", `shell-p2-drawer-approve-cancelled`: "cancelling … without any POST /api/v1/approvals — the gate is still pending" — `ev/shell-p2-drawer-approve-confirm.png` (final3) | PASS |
| Phone: board + drawer fit at 390x844, esc closes, confirm cancels | `Board.tsx` narrow | `shell-p2-home-board.spec.ts:262` ("phone: drawer fits, esc closes, approve confirm cancels") | `EVIDENCE shell-p2-drawer-phone`: "at 390x844 the run drawer fits the viewport and the page does not scroll sideways", `shell-p2-drawer-phone-approve-confirm` — `ev/shell-p2-drawer-phone.png`, `ev/shell-p2-drawer-phone-approve-confirm.png` (final3) | PASS |

## Phase 3 — Run workbench (split view, iteration tabs, full screen, take control)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Split pinned graph + live transcript; tabs Graph/Timeline/Artifacts/Diagnostics, `?view=` deep link | `/runs/:runId` — `ui/src/pages/RunWorkbench.tsx` | `shell-p3-workbench.spec.ts:25` ("tabs … and the ?view= deep link"); regression `issue2-workbench.spec.ts:638` (A4: graph-first, dock on the active node) | `EVIDENCE shell-p3-workbench-graph` (four tabs, Graph selected), `shell-p3-workbench-tabs` ("clicking each tab updates the URL (?view=timeline\|artifacts\|diagnostics)"), `shell-p3-workbench-view-artifacts` (deep link) — `ev/shell-p3-workbench-graph.png`, `ev/shell-p3-workbench-tabs.png` (final3); issue2-workbench 5 passed (final3) | PASS |
| Iteration tabs on loops (runtime instances selected, never extra definition nodes) | `ui/src/components/workbench/InstancePicker.tsx` | regression `issue2-workbench.spec.ts:943` (A6: until instances, fan-out, attempts); unit tests: `InstancePicker.test.tsx` | issue2-workbench A6 in the final3 run — 5 passed, `ev/wb-a6-iter1.png`, `ev/wb-a6-iter2.png`, `ev/wb-a6-fanout.png`, `ev/wb-a6-attempts.png` (final3) | PASS |
| ⤢ full screen: graph collapses to a step strip (one cell per top-level step, current raised), ⤡ restores | `ui/src/components/workbench/StepStrip.tsx`; `?full=1` | `shell-p3-workbench.spec.ts:73` ("?full=1: step strip with one cell per top-level step; ⤡ restores"); unit tests: `StepStrip.test.tsx` | `EVIDENCE shell-p3-fullscreen-strip`: "?full=1 and the step strip shows exactly 8 cell(s), one per top-level step of the pinned revision", `shell-p3-fullscreen-restore` — `ev/shell-p3-fullscreen-strip.png`, `ev/shell-p3-fullscreen-restore.png` (final3) | PASS |
| Two-step take control: confirm card with truthful interrupt-and-rerun copy, Take control / Just watch, esc cancels, focus on primary | `ui/src/components/workbench/TakeControlCard.tsx` (`126af18`) | `shell-p3-workbench.spec.ts:109` ("Take control: the confirm card with truthful copy; Just watch / esc cancel, no POST"); unit tests: `TakeControlCard.test.tsx` (focus, esc, trap); regression `issue2-workbench.spec.ts:753` (A5 live takeover) | `EVIDENCE shell-p3-take-control-card` + `shell-p3-take-control-cancelled` ("no POST …/take-control is sent"), `ev/shell-p3-take-control-card.png` (final3); live takeover: issue2-workbench A5 — `ev/wb-a5-bob-control.png`, `ev/wb-a5-returned.png` (final3) | PASS |

## Phase 4 — Library (workflows index, steps, step picker, new agent step)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Workflows index with folders: revision chips, step chain, assignments, open draft; rows match the API | `/workflows` — `ui/src/pages/Library.tsx` | `shell-p4-library.spec.ts:43` ("workflows list matches the API and revision chips come from it"); folder grouping: unit tests `Library.test.tsx:590` | `EVIDENCE shell-p4-workflows-list`: "/workflows lists exactly the 4 pipelines from GET /api/v1/pipelines and every revision chip reads from the API (PUBLISHED r<N> or DRAFT ONLY)" — `ev/shell-p4-workflows-list.png` (final3) | PASS |
| Duplicate a workflow → lands on the copy's draft editor | `Library.tsx` | `shell-p4-library.spec.ts:87` ("Duplicate creates N+1 and lands on the copy's draft editor") | `EVIDENCE shell-p4-duplicate`: "duplicating feature-development created feature-development-copy (API count 4 → 5) and the journey landed on the copy's draft editor", `shell-p4-duplicate-list` — `ev/shell-p4-duplicate.png`, `ev/shell-p4-duplicate-list.png` (final3) | PASS |
| Steps page: "used in N workflows" from the usage refs, **edit for all → new version** (running runs keep the old one; adopt drafts), duplicate | `/steps`, `/steps/:id` — `ui/src/pages/Steps.tsx` | `shell-p4-library.spec.ts:212` ("registry rows with used-in from the API; Edit for all creates a new revision") | `EVIDENCE shell-p4-steps-registry` ("…used-in line from GET /api/v1/node-templates"), `shell-p4-edit-for-all` ("Edit for all … created a new revision … '1.0.1'") — `ev/shell-p4-steps-registry.png`, `ev/shell-p4-edit-for-all.png` (final3) | PASS |
| Studio edge-`+` step picker: search, START A NEW STEP cards (Agent, Command, Approval, Loop, Workflow), Publish kinds hidden, YOUR SAVED STEPS honest until the registry, describe-it hint | Studio picker (`5198c90`) | `shell-p4-library.spec.ts:129` ("Studio edge + opens the picker: five kind cards, no Publish; the Agent step gets its profile select") | `EVIDENCE shell-p4-step-picker`: "…exactly five primary kind cards (Agent, Command, Approval, Loop, Workflow) and no Publish card" — `ev/shell-p4-step-picker.png` (final3) | PASS |
| New agent step: inspector with id, Agent profile dropdown (SUGGESTED default, sandbox chip per option, `+ New profile…`), "What should it do?" | Studio inspector — `ui/src/pages/Studio.tsx` | `shell-p4-library.spec.ts:129` (profile select); `shell-journey.spec.ts:329` (journey a: brand-new profile through the dialog) | `EVIDENCE shell-p4-agent-step-profile`: "the inspector's profile select with its SUGGESTED hint and sandbox-chip option labels", `shell-p4-new-profile-from-step` ("…opens the shared NewProfileDialog"), `journey-a-step-jr015620` ("profile journey-jr015620 created through the dialog and now selected") — `ev/shell-p4-agent-step-profile.png` (final3), `ev/journey-a-step-jr015620.png` (jr015620) | PASS |
| "Also save as a reusable step" writes a node-template revision | Studio inspector checkbox (`3349840`) | unit tests: `internal/api/node_templates_test.go` + `internal/store/postgres/node_templates_test.go` (from-node path); e2e covered by `shell-p789` | `EVIDENCE shell-p789-save-step`: "…arming 'also save as a reusable step' POSTed the node as template 01a16007 — it is listed by GET /api/v1/node-templates and shows on /steps" — `ev/shell-p789-save-step.png` (final3) | PASS |

## Phase 5 — Agent profiles (list/detail, New profile dialog)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Profiles list + detail: launcher/sandbox chip from evidence, account secret ref (never the value), APM package contents, used by | `/profiles`, `/profiles/:id` — `ui/src/pages/Agents.tsx` | `shell-p5-profiles.spec.ts:66` ("list rows and chips match the API; detail capability cells read from the probes") | `EVIDENCE shell-p5-list`: "/profiles lists the 6 API profiles; every launcher line and sandbox chip matches C5 (/api/v1/launchers) plus /api/v1/system/sandbox", `shell-p5-detail` — `ev/shell-p5-list.png`, `ev/shell-p5-detail.png` (final3) | PASS |
| New profile dialog: five agent cards (Claude Code, Codex, Pi, Antigravity, Other ACP) with readiness from launcher registration + probe evidence only; unregistered launchers disabled with reasons | `ui/src/components/profiles/NewProfileDialog.tsx` (contract C6); `useLaunchers()` | `shell-p5-profiles.spec.ts:134` ("New profile dialog: Pi and Antigravity are disabled with reasons") | `EVIDENCE shell-p5-dialog-disabled-cards`: "the unregistered Pi and Antigravity cards are disabled with their reasons, while the registered Claude and Codex cards stay selectable" — `ev/shell-p5-dialog-disabled-cards.png` (final3) | PASS |
| Create a profile through the dialog — API and list both carry it (desktop and phone) | `NewProfileDialog.tsx` → `POST /agent-profiles` | `shell-p5-profiles.spec.ts:168` ("create a profile through the dialog"); `:202` ("phone: the dialog fits and a profile is created through it") | `EVIDENCE shell-p5-created-dialog` ("closes it (the caller acts on onCreated) and lands on the new profile's detail page"), `shell-p5-created-list` ("GET /api/v1/agent-profiles and the /profiles list both carry the new row"), `shell-p5-created-phone` — `ev/shell-p5-created-dialog.png`, `ev/shell-p5-created-list.png`, `ev/shell-p5-created-phone.png` (final3) | PASS |

## Phase 6 — Threads (permission cards, rail, draft PR, hand to a workflow)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Cross-project Threads list (one-off conversations), exactly the API's | `/threads` — `ui/src/pages/Threads.tsx` | `shell-p6-threads.spec.ts:40` ("/threads lists exactly the API's cross-project conversations") | `EVIDENCE shell-p6-threads-list`: "/threads shows the 1 one-off threads by default and, with the one-off filter lifted, exactly the 7 cross-project summaries from GET /api/v1/conversations" — `ev/shell-p6-threads-list.png` (final3) | PASS |
| Thread page: header (repo · profile · age), inline permission cards, WORKSPACE/ARTIFACTS/NEXT rail | `/threads/:id` — `ui/src/pages/Conversation.tsx` | `shell-p6-threads.spec.ts:73` ("thread page: header and rail; hand-to-workflow honest; draft-PR controller-only with confirm"); permission flow regression: `m5-inbox.spec.ts:179`/`:244` (raise + answer a permission request) | `EVIDENCE shell-p6-thread-header` ("the header shows the conversation title … and its meta line"), `shell-p6-thread-rail` — `ev/shell-p6-thread-header.png`, `ev/shell-p6-thread-rail.png` (final3); permission flow: m5-inbox 6 passed (final3-m5) | PASS |
| NEXT: "Hand to a workflow" with declared inputs (ADR-0053) and honest copy; "Open a draft PR" controller-only with confirm (ADR-0045) | `NEXT` rail (`5c4f6c9`) | `shell-p6-threads.spec.ts:73` (hand-to-workflow honest; draft-PR controller-only with confirm) | `EVIDENCE shell-p6-thread-rail` ("the 'Hand to a workflow…' follow-up offered (never fake state)"), `shell-p6-draft-pr`: "the 'Open a draft PR' NEXT entry is controller-only; clicking shows the confirm card and cancelling it sends nothing (ADR-0045)" — `ev/shell-p6-draft-pr.png` (final3) | PASS |
| Narrow 390x844: the thread page fits without sideways scroll | `Conversation.tsx` narrow | `shell-p6-threads.spec.ts:136` ("narrow 390x844: the thread page fits without sideways scroll") | `EVIDENCE shell-p6-thread-phone`: "at 390x844 the thread page renders its header without sideways scroll" — `ev/shell-p6-thread-phone.png` (final3) | PASS |

## Phase 7 — Assistant v2 (⌘K popover, context chip, mic, full screen, follow-ups, changes, trust)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Global assistant popover on ⌘K / Ask, keeps the conversation across pages, esc closes | `ui/src/components/assistant/AssistantPanel.tsx` | `shell-p1-shell.spec.ts:190` ("⌘K opens the ask surface (ADR-0050); ⌘K again opens the palette; esc closes"); regression `m5-assistant.spec.ts:172` ("Ask from the assistant popover … shows the tools it used") | `EVIDENCE shell-p1-palette-open`: "⌘K (Ctrl+K in this lab) opens the global ask surface (the ADR-0050 assistant popover)", `shell-p1-palette-second-press`, `shell-p1-palette-esc` — `ev/shell-p1-palette-open.png`, `ev/shell-p1-palette-esc.png` (final3); m5-assistant 3 passed (final3-m5) | PASS |
| Page context chip in the composer | `AssistantPanel.tsx` context chip | unit tests: `AssistantPanel.test.tsx` | unit tests (`AssistantPanel.test.tsx`); no EVIDENCE line asserts the chip's text per page — e2e portion NOT COVERED | PASS |
| Mic (Web Speech API), transcript editable before sending; hidden when unsupported | `MicButton.tsx`, `ListeningBar.tsx` | unit tests: `ui/src/components/assistant/assistant.test.tsx` (SpeechRecognition mocked); e2e covered by `shell-p789` | `EVIDENCE shell-p789-mic`: "the fake SpeechRecognition's interim + final results drove the listening bar and landed 'change the build please' in the composer, where ' and ship it' was typed on top — and ZERO non-GET requests reached /api/v1/assistant/ before Send" — `ev/shell-p789-mic.png` (final3) | PASS |
| Expand to full screen (680px column) and back | `AssistantPanel.tsx` expanded view | unit tests: `AssistantPanel.test.tsx` | unit tests (`AssistantPanel.test.tsx`); no EVIDENCE line asserts the expanded width — e2e portion NOT COVERED | PASS |
| Follow-up questions: model-written option buttons; whatever the user taps/types is sent back as plain text | `QuestionCard.tsx` | unit tests: `QuestionCard.test.tsx`; e2e covered by `shell-p789` | `EVIDENCE shell-p789-question-roundtrip`: "the option click POSTed the LABEL 'Edit trust draft' verbatim as the body's plain-text 'text' field (no value, no structured payload, no confirm/dismiss) … the POST body is the round-trip proof" (the answer turn was still running when the bounded window closed) — `ev/shell-p789-question-roundtrip.png` (final3) | PASS |
| Change chip "N changes · undo all" with per-item undo; runs and approvals explicitly not undoable | `ChangeChip.tsx` | unit tests: `ChangeChip.test.tsx`; e2e undo all: `shell-journey.spec.ts:689` (journey f) | `EVIDENCE journey-f-changed-jr015620` ("the assistant's change chip counts its change(s)…"), `journey-f-undone-jr015620` ("undo all: no draft … contains journey_check any more") — `ev/journey-f-changed-jr015620.png`, `ev/journey-f-undone-jr015620.png` (jr015620); chip invalidation without remount since `0f4c880` | PASS |
| Per-person trust level (ask_all / ask_risky default / no_ask) stored as a preference and checked in the tool loop; server authorization still caps every call | `internal/api/assistant_conversations.go` trust gating (`618420f`); `TrustPill.tsx`, `ui/src/lib/prefs.ts` | unit tests: `internal/api/assistant_conversations_test.go` (gating + NULL-project org-scoped change rows), `TrustPill.test.tsx`; e2e covered by `shell-p789` | `EVIDENCE shell-p789-trust-ask-all`: "with trust level ask_all the assistant's draft edit … surfaced a confirm card … and GET /api/v1/drafts/… still holds the document WITHOUT trust_check at version 1", `shell-p789-trust-retry` ("clicking Retry re-ran the gated draft.apply … now contains the trust_check node") — `ev/shell-p789-trust-ask-all.png`, `ev/shell-p789-trust-retry.png` (final3); `shell-p789-settings` confirms the stored level | PASS |

## Phase 8 — Inbox + approvals (detail, phone inbox, risk colours, confirm)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Desktop approval detail: summary, plan inline, files it will touch, free-text interpretation with confirm | `/approvals/:id` — `ui/src/pages/ApprovalPage.tsx` (`5c4f6c9`) | unit tests: `ui/src/pages/Approval.test.tsx`, `internal/api/approval_summary_test.go`; desktop detail covered by `shell-p789` | `EVIDENCE shell-p789-approval-detail`: "the amber 'NEEDS YOUR DECISION' strip, the model summary card, the plan section and the 'Not available yet' files note all rendered … the free-text reply produced a proposed decision and its confirm step, which the journey cancelled", `shell-p789-approval-narrow` — `ev/shell-p789-approval-detail.png`, `ev/shell-p789-approval-narrow.png` (final3) | PASS |
| Phone inbox cards: type chip, repo, age, 2-line summary, two 44px buttons; fits at 390x844 | `/inbox` — `ui/src/components/inbox/InboxCard.tsx` | `shell-journey.spec.ts:553` (journey d: "approve the run's human gate from the Inbox at 390x844") | `EVIDENCE journey-d-inbox-jr015620`: "at 390x844 the Inbox decision card for the run's gate is open with its confirm step armed", `journey-d-decided-jr015620`: "the gate was approved from the phone-width Inbox; the run's approve step is succeeded via the API and the card left the Inbox" — `ev/journey-d-inbox-jr015620.png`, `ev/journey-d-decided-jr015620.png` (jr015620) | PASS |
| Model-written action buttons mapped risk → style (refuse/destructive → danger, proceed → primary, else secondary); every action confirmed | `ui/src/components/inbox/riskStyle.ts` | unit tests: `riskStyle.test.ts`, `InboxCard.test.tsx`; confirm-before-approve e2e: `shell-p2-home-board.spec.ts:217`, `:262` | unit tests (riskStyle mapping) + `EVIDENCE shell-p2-drawer-approve-confirm` / `shell-p2-drawer-approve-cancelled` (final3) | PASS |

## Phase 9 — Operations + Settings

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Operations: health line, interrupted callout (⊘ outcome unknown, Reclaim and retry), workers table, agent × capability matrix from recorded probes only (`✓ observed` / `× not supported` / `not tested`) | `/ops` — `ui/src/pages/Operations.tsx` | unit tests: `ui/src/pages/Operations.test.tsx`; e2e covered by `shell-p789` | `EVIDENCE shell-p789-ops`: "the health line reads 'replica: api-a · queue: 0 queued, 0 leased · oldest queued: queue empty', the workers table holds 2 rows == GET /api/v1/workers, and every capability cell matches GET /api/v1/launchers (✓ observed only where result=observed: …)" — `ev/shell-p789-ops.png` (final3) | PASS |
| Settings → Layout: projects tree vs switcher, ask placement, workflow folders toggle | `/settings/layout` — `ui/src/pages/Settings.tsx` | `shell-p1-shell.spec.ts:151` ("Settings → Layout: switcher mode swaps the sidebar; floating ask shows ask-float") | `EVIDENCE shell-p1-settings-layout`: "the Settings → Layout tab renders the projects-mode, ask-placement and workflow-folder groups" — `ev/shell-p1-settings-layout.png` (final3) | PASS |
| Settings → Assistant: the trust level (same three options as the pill) | `/settings/assistant` | unit tests: `ui/src/lib/prefs.test.ts`, `TrustPill.test.tsx`; e2e covered by `shell-p789` | `EVIDENCE shell-p789-settings`: "settings → assistant shows all three trust levels with the stored one (ask_risky) checked, matching GET /me/preferences" — `ev/shell-p789-settings.png` (final3) | PASS |
| Settings footer: Operations entry links to /ops | Settings page (`ab1c057`) | `shell-p789` settings step | `EVIDENCE shell-p789-settings`: "…and the settings footer's Operations entry links to /ops" — `ev/shell-p789-settings.png` (final3) | PASS |

## Rules (cross-cutting)

| requirement | where | spec test | evidence | status |
|---|---|---|---|---|
| Real data only: counts, flags, summaries and readiness come from the API or recorded probe evidence; honest empty / "not available yet" states; every stub listed in GAPS.md | `GAPS.md` status log (`c3d6a23`) + every page | `GAPS.md` (path:line per empty state); e2e asserts equality with the API: `shell-p2:77`, `:125`, `shell-p4:43`, `shell-p5:66`, `shell-p6:40` | every one of those e2e equality assertions passed in the final3 run (`shell-p2-home-count-line`, `shell-p2-board-columns`, `shell-p4-workflows-list`, `shell-p5-list`, `shell-p6-threads-list`); honest states asserted: `shell-p789-approval-detail` ("'Not available yet' files note"), `shell-p789-board-mine` (chips disabled "not available yet"), `shell-p5-dialog-disabled-cards` | PASS |
| A11y: keyboard reachable, visible focus ring, esc closes overlays, focus trapped in modals | every shell page | `checkShellScreen` on every suite page (`shell-helpers.ts:54`); esc/focus: `shell-p1:230`, `shell-p3:109`, `shell-p2:174`; trap: `TakeControlCard.test.tsx:73`; Studio tablist fix: `e99c339` | `EVIDENCE shell-p1-drawer-esc`, `shell-p2-drawer-focus-esc` ("25 Tab presses never escape it"), `shell-p3-take-control-cancelled`; scrollable regions focusable since `f916f3a` | PASS |
| Status always glyph + text (never colour alone) | chips, step strip, capability cells | `shell-p5-profiles.spec.ts:66` (cells read as `<glyph> <text>`); `StepStrip.test.tsx:76` ("one cell per step with glyph + word") | `EVIDENCE shell-p5-detail` (capability cells read as observed / not supported / not tested text) — `ev/shell-p5-detail.png` (final3); `shell-p789-ops` (cells match `GET /launchers`); StepStrip unit test | PASS |
| axe: 0 serious/critical violations at both widths | `e2e/tests/a11y.ts` (`checkA11y`) | `checkShellScreen` per page; fixes: `1896916` (nested-interactive), `e99c339` (aria-required-children, scrollable-region) | `A11Y <page>: 0 violations` lines in every final3 / final3-m5 / jr015620 `.out` (e.g. "A11Y board (state columns): 0 violations", "A11Y thread page at phone width: 0 violations"); board count-contrast fix `f38c5df` (composited 4.21:1) | PASS |
| Both widths (1500x950 desktop, 390x844 phone) with no sideways scroll; full-bleed pages beside — never under — the 240px sidebar | `checkShellScreen`; `e4f0556` | `shell-p2:262`, `shell-p5:202`, `shell-p6:136`, `issue2-workbench:1105`, `m5-layout` per-screen matrix | `EVIDENCE shell-p2-drawer-phone`, `shell-p5-dialog-phone` / `shell-p5-created-phone`, `shell-p6-thread-phone` (final3); m5-layout 20/20 (final3-m5); m5-journey 10 passed (final3-m5) | PASS |

## Journey — the reviewer's full loop (steps a–f)

One consolidated journey on the app-shell lab (gated
`COMMUNICATION_E2E_SHELL_JOURNEY=1`), `e2e/tests/shell-journey.spec.ts`. Final run:
`jr015620/` — **6/6 passed (7.6m)** (the final3 journey run was 5/6: step f did not land
within 3 follow-up turns — "the assistant still has not landed journey_check after 3
follow-up turns" — a model variance; the final acceptance run `jr015620/` re-ran the full
journey on the same lab/HEAD and passed 6/6; the steps below are from `jr015620/`).

| step | requirement | spec test | evidence | status |
|---|---|---|---|---|
| a | Studio: add an Agent step after `plan` with a brand-new profile (through the New profile dialog) | `shell-journey.spec.ts:329` ("a — Studio: add an Agent step after plan with a brand-new profile") | `EVIDENCE journey-a-ambiguity-jr015620`: guarded-edge dialog ("approve reads nodes.plan.*") before the insert; `journey-a-dialog-jr015620`: "the footer reads 'Create and use in <step>' (contract C6)"; `journey-a-step-jr015620`: "agent.acp step journey_step inserted after plan, profile … created through the dialog and now selected" — `ev/journey-a-step-jr015620.png`, `ev/journey-a-dialog-jr015620.png` (jr015620) | PASS |
| b | Publish: Validate then Publish; the revision number increments | `shell-journey.spec.ts:460` ("b — publish: Validate then Publish, and the revision number increments") | `EVIDENCE journey-b-published-jr015620`: "draft validated ('valid — 0 findings') and published — revision 1 → 2 (sha256:c8fd6d9ca377…), asserted via the API" — `ev/journey-b-published-jr015620.png` (jr015620) | PASS |
| c | Start a run of the new revision and land on it (the workbench) | `shell-journey.spec.ts:493` ("c — start a run of the new revision and land on it") | `EVIDENCE journey-c-run-jr015620`: "run 01a16023-… started from the new revision r2 c8fd6d (sha256:c8fd6d9ca377…) and the workbench opened on it" — `ev/journey-c-run-jr015620.png` (jr015620) | PASS |
| d | Approve the run's human gate from the Inbox at 390x844 (phone) | `shell-journey.spec.ts:553` ("d — approve the run's human gate from the Inbox at 390x844") | `EVIDENCE journey-d-inbox-jr015620` + `journey-d-decided-jr015620`: "the gate was approved from the phone-width Inbox; the run's approve step is succeeded via the API and the card left the Inbox" — `ev/journey-d-inbox-jr015620.png`, `ev/journey-d-decided-jr015620.png` (jr015620) | PASS |
| e | Workbench: watch a live agent step, take control, prompt, hand back | `shell-journey.spec.ts:595` ("e — workbench: watch a live agent step, take control, prompt, hand back") | `EVIDENCE journey-e-live-jr015620` (pinned to journey_step, live dock), `journey-e-confirm-jr015620` ("the attempt stops, the run pauses, and the hand-back re-runs the step as a new attempt (ADR-0043)"), `journey-e-prompt-jr015620` (live agent reply), `journey-e-handed-back-jr015620` ("a new attempt of journey_step is queued (attempt_count ≥ 2 via the API)") — `ev/journey-e-handed-back-jr015620.png`, `ev/journey-e-confirm-jr015620.png` (jr015620) | PASS |
| f | Assistant via ⌘K: add a step to the draft, then undo all | `shell-journey.spec.ts:689` ("f — assistant via ⌘K: add a step to the draft, then undo all") | `EVIDENCE journey-f-changed-jr015620`: "the assistant's change chip counts its change(s), and the draft …'s YAML now contains journey_check (via the API)"; `journey-f-undone-jr015620`: "undo all: no draft of feature-development contains journey_check any more (via the API)" — `ev/journey-f-changed-jr015620.png`, `ev/journey-f-undone-jr015620.png` (jr015620); step f gates on the draft YAML via the API and the change chip's growth (`b9a78dc`, `2c999c9`) | PASS |

## Regressions (issue #2 + M5, on the new shell)

| suite | what it proves on the new shell | evidence | status |
|---|---|---|---|
| `issue2-studio.spec.ts` (7) | Studio graph authoring, edge insertion, Repeat until, drag-to-insert + ambiguity, assistant proposal A8, narrow fallback | final3 run: 7 passed (21.3s) — `ev/studio-a1-inserted.png`, `ev/studio-a3-ambiguity.png`, `ev/studio-a8-applied.png` (final3) | PASS |
| `issue2-workbench.spec.ts` (5) | graph-first workbench, dock, live takeover (A5), loops/fan-out/attempts (A6), narrow | final3 run: 5 passed (8.5m) — `ev/wb-a4-graph-default.png`, `ev/wb-a5-bob-control.png`, `ev/wb-a6-fanout.png`, `ev/wb-narrow.png` (final3) | PASS |
| `issue2-conversations.spec.ts` (3) | one-off conversations, run-link badges deep-linking to the workbench, dialog fit | final3 run: 3 passed (36.5s) — `ev/conv-a7-manual-label.png`, `ev/conv-run-badge.png`, `ev/conv-narrow-dialog.png` (final3) | PASS |
| `m5-journey.spec.ts` (11) | full M5 pipeline journey: clone → draft → publish r1 → assign → run → gate stall → takeover/approve/retry → evidence | final3-m5 run: 10 passed + 1 skipped (1.4m) — the one skip is the suite's own conditional step, not a failure | PASS |
| `m5-layout.spec.ts` | per-screen layout matrix (no horizontal scroll, both viewports, per viewer) — the widest a11y/fit sweep | `final3-m5/m5-layout.out`: "20 passed (34.0s)" (re-run alone after the final3-m5 post-reset warm-up failure) | PASS |
| `m5-inbox.spec.ts` (6) | permission requests across identities, inbox live updates without reload | final3-m5 run: 6 passed (11.1s) | PASS |
| `m5-assistant.spec.ts` (3) | the ⌘K assistant popover: a real answer naming the project, tool transparency, every link lands on a real page | final3-m5 run: 3 passed (11.4s) | PASS |
| `m5-agents-schedules.spec.ts` (3) | agents page (skill pin, digests, permissions) + schedules | final3-m5 run: 3 passed (15.0s) | PASS |
| `m5-issue-run.spec.ts` (5) | issue-triggered run: publish, assign, live tracker prefill, run_inputs record | final3-m5 run: 5 passed (7.1s) — note: GitHub anonymous rate limit can affect this suite (Known limitations) | PASS |
| `m5-prompt-edit.spec.ts` (6) | template digest + plan → agent.acp prompt edit → publish, re-pointed to `/workflows/<id>` (`e4f0556`) | final3-m5 run: 6 passed (4.0s) | PASS |
| M1/M2 journeys (`m1-journey.spec.ts`, `m2-journey.spec.ts`) | fresh-account journeys on the new shell: create the project from `/projects` (the index moved off `/`), `/p/<id>` URLs, the projects empty state for an outsider (`a5f82d2`, `3443432`, `c6d6725`) | not in the lab evidence set (no m1/m2 lab run in `final3` / `final3-m5` / `jr015620`) — covered on every push by CI's e2e job (`pnpm --dir e2e test`, fresh e2e stack), green on `d2708cb` (see Known limitations) | PASS (CI) |

## CI

| requirement | evidence | status |
|---|---|---|
| Go: `gofmt`/`go vet`/full `-race` suite green; UI: full `pnpm --dir ui check` green (gen:api, oxlint, oxfmt, tsc, testids, tokens, vitest, build); OpenAPI lint (redocly) and `govulncheck` green (`8db926c`) | CI green on `d2708cb` (and every push since `7c40979`); the earlier claim that four Go packages fail for a missing toolchain was wrong — those failures were commit signing without an SSH key in a worker's shell, and the clean-export verify passes them; plus the local checks on this host, 2026-10-21 (doc-only change): `gofmt -l internal/ cmd/` → no output; `go vet ./...` → clean; `pnpm --dir ui check` → green (vitest: `Test Files  122 passed (122)`, `Tests  1371 passed (1371)`, build ✓); `go test -race ./...` → all packages green on the clean-export verify (which mirrors every CI job); redocly + govulncheck last confirmed green at `8db926c` (inputs unchanged since) | PASS |

## Final run summary

Filled from the final lab runs (Run provenance above):

- **Journey**: `final4/` 6/6 — the final acceptance journey on the lab reset from
  HEAD `606b36e`; step f landed on the first assistant turn (the workflow.draft
  tool, `606b36e`).
- **Shell per-phase suites** (final4): shell-p1 7/7, shell-p2 5/5, shell-p3 3/3,
  shell-p4 4/4, shell-p5 4/4, shell-p6 3/3, shell-p789 9/9.
- **Issue #2** (final4): issue2-studio 7/7, issue2-workbench 5/5,
  issue2-conversations 3/3.
- **M5** (final4-m5): m5-journey 10 passed + 1 pre-existing skip, m5-layout 20/20,
  m5-inbox 6/6, m5-assistant 3/3, m5-agents-schedules 3/3, m5-issue-run 5/5,
  m5-prompt-edit 6/6.
- **A11y**: every `A11Y <page>` line in the runs' `.out` files reads `0 violations` at
  1500x950 and 390x844.
- **Totals**: 113 passed, 1 skipped (m5-journey, pre-existing), 0 failed — one run,
  one lab build.
- **Screenshots**: `final4/ev/` (shell p1–p789 + issue2 + journey) — outside git, as
  recorded in Known limitations.

## Bugs found and fixed by the journeys

Found while driving the shell journeys and regression suites on the lab; fixes landed in
the range `5e42f62..d2708cb` (the final lab runs, HEAD `d2708cb`). Rows marked *(in phase
commit)* were fixed inside the named phase commit — no separate fix commit exists for them.
The final rows below cover the fixes that landed through HEAD `d2708cb` on top of the
phase-commit rows.

| Commit | Bug found by the journeys | Fix |
|---|---|---|
| `6222d01` *(in phase commit)* | The sidebar live flags fed an update loop (flag recomputation re-triggered the fetch that produced it) | flags read off the same pure reduction as Inbox (`lib/sidebarFlags.ts`) from the cross-project reads + org SSE — no polling, no re-fetch cycle |
| `6222d01` *(in phase commit)* | Studio header overlapped at phone width and squeezed the title at desktop width | Studio header tabs + phone layout reworked (header strip, tabs beside the title) |
| `6222d01` *(in phase commit)* | The Home running-now segmented progress bar overran its row at narrow widths | per-step segments sized to the available row width (`ds` ProgressStrip usage in `components/home/`) |
| `6222d01` *(in phase commit)* | A node-template's `latest_revision` came back empty from the Step registry read | latest_revision fix (`internal/api`/`store` template reads, migration 00009 era) |
| `5c4f6c9` *(in phase commit)* | The Hand-to-a-workflow dialog 422'd on the server's required inputs (missing declared inputs / handoff summary) | the dialog now carries the run's declared inputs and the model-written `handoff_summary` so `RunCreate.source` validates (ADR-0053) |
| `1896916` | axe `nested-interactive` (serious) on the profiles list — 11 interactive elements nested inside other interactive ones | no interactive element nested inside another; 0 on list, detail and dialog at both widths |
| `e99c339` | axe `aria-required-children` (critical) on the Studio header tablist (Runs/Assigned links inside it) and `scrollable-region-focusable` (serious) on the step picker list | the tablist holds only Canvas/YAML (Runs/Assigned moved to the nav strip); the step picker list is keyboard-scrollable — 0; issue2-studio 7/7 |
| `e4f0556` | Full-bleed pages rendered under the 240px sidebar, which intercepted pipeline-detail rail and run-inspector clicks | full-bleed pages bleed to the content column beside the sidebar; m5-prompt-edit + m5-journey re-pointed to `/workflows/<id>` — prompt-edit 6/6 on the lab |
| `f74af5e` | Assistant `tool_calls` carried no summary (the "used N tools" line had nothing to show) and conversation links had no href/route, so "Go ›" links couldn't render | every tool call carries a code-written summary on the wire; conversation links serialize as `{label, route}` per ADR-0050; m5-assistant rewritten for the ⌘K popover |
| `618420f` | Org-scoped assistant draft-edit change rows were written with an empty-string project id | org-scoped change rows store a NULL project (real-Postgres test) |
| `d55057b` | CommandPalette e2e flake: the outside-press listener wasn't registered before the reopen press on a load-only run | reopen inside `act` so the listener registers first — 20/20 green |
| `4c72e87` | Three per-phase-suite failures: the sidebar froze its initial expand state (the persisted state never applied once preferences loaded, plus a render loop when the query had no data); the run view's collapse button sat inside the tablist (axe `aria-required-children`, critical); the New profile dialog confirmed without really POSTing | sidebar applies the persisted expand state once preferences load; collapse button moved outside the tablist; the dialog really POSTs (201 + list row) before confirming |
| `f38c5df` | Board column count badges used opacity-80 white on solid status fills — the failed-red badge composited below the 4.5:1 contrast floor | full-opacity badge text on solid fills (opacity-80 white on the failed red composites to 4.21:1); axe 0 serious/critical on the board and drawer at both widths |
| `682428c` | New profile dialog didn't follow contract C6 — the caller had to handle the created profile itself and the dialog kept stale state on error | POST 201 → `onCreated(profile)` → the caller closes it (Studio selects the new profile; /profiles opens its detail); errors keep it open with the API's message |
| `0f4c880` | The change chip and open Studio drafts went stale after assistant mutations — post/confirm/undo didn't invalidate the conversation's changes or the drafts they touched | every mutation that can record or undo a change (post, confirm, undo, undo all) invalidates the conversation's changes and the drafts it touched, so the chip and drafts update without a remount; undo no longer invalidates a key that matched nothing |
| `c257026` | Assistant approval cards posted the whole request body on Retry, so the ADR-0050 confirm path (`{confirm}`) was unreachable from the UI | approval cards post only the request id (Retry → `{confirm}`, Not now → `{dismiss}`); shell-p789 asserts trust gating under ask_all end to end without any reload |
| `5479538` | A slow model completion could blow the assistant's fixed 30 s per-completion deadline on a cold lab | `COMMUNICATION_ASSISTANT_TIMEOUT` (Go duration, default 30s unchanged, invalid or ≤0 refuses to start) reaches the ask broker, the conversation runner and the approval-summary pass |
| `ae76f2d` | The model kept proposing invalid `draft.apply` node kinds and couldn't recover from a refusal (no feedback on what was wrong; the draft it was editing was bigger than the result cap) | `draft.apply`'s schema enumerates the node kinds it may add (catalogue, publish kinds excluded per ADR-0045); a refused proposal tells the model what was wrong and the valid alternatives so it retries within the turn; `draft.get` returns a compact structural view inside the result cap |
| `f916f3a` | Scrollable code and transcript regions weren't keyboard-reachable (axe `scrollable-region-focusable`, serious — YAML view, plan JSON, attempt outputs, transcript previews, approval plan, workbench dock) | every scrollable region is a keyboard-focusable named region with a visible focus ring — axe → 0 at both widths |
| `7c40979` | A draft edit with one refused-proposal retry exceeded the shared assistant runner's completion/tool-call caps, so journey f and the shell-p789 trust journey flaked | the assistant v2 runner gets its own bounded caps (8 completions, 16 tool calls per turn; `/assistant/ask` keeps v1's 4/8; ADR-0050 amendment 1); the runner tool-call cap is tightened to 12 so the retry path fits deterministically (`7c40979`, `2c999c9`) |
| `2c999c9` | Assistant step f did not land end to end: the assistant surface had no New conversation control, no navigation index for tools/answers to address, no validation of the gated draft edit before carding, and the runner tool-call cap was too small | New conversation control on the popover, navigation index (tools/answers address canonical routes so `ui.navigate` targets resolve), gated draft edit validated before carding, runner tool-call cap tightened to 12 (`2c999c9`) |
| `bd2b4c6` | Assistant acted on an explicit change request with the wrong move — the runner's system prompt did not tell it to locate, read and apply the requested edit in the same turn, so the model answered with a search summary instead of the edit | the runner's system prompt tells the model to locate, read and apply a requested edit in the same turn and to ask only when the target is genuinely ambiguous (`bd2b4c6`) |
| `aaa50e0` | Acceptance journey step f waited on fixed short sleeps instead of turn-bounded waits, so a slow model turn ended before the reply landed | journey step f waits for each assistant turn to finish (in-flight indicator clears or the reply lands, ceiling 240 s) instead of fixed short sleeps (`aaa50e0`) |
| `7bf54bb` | Assistant popover re-adopted the newest old conversation on remount / reload, so a New conversation was replaced by re-adopting the newest old one | the started conversation choice (`{conversationId, awaitingNew}`) lives in sessionStorage, so the popover keeps the started conversation across remounts and reloads (`7bf54bb`) |
| `5c1a6f1` | Assistant model client had no retry for transient upstream failures (429, 502, 503, model-loading 404, transport errors), so transient blips failed the turn outright | up to 3 attempts with jittered exponential backoff, Retry-After honoured, always inside the per-call deadline and the caller's context; other 4xx never retried (`5c1a6f1`) |
| `d2708cb` | Honest 503 mapping on the assistant surface, thread row ids, transcript overflow | honest `503 assistant_not_configured` mapping + unique thread row ids + transcript overflow fix landed in the final HEAD (`d2708cb`) |
| `606b36e` | Assistant spent turns hunting the open draft | workflow.draft read tool (`606b36e`) |

## Known limitations

All stubs and honest empty states are registered with `path:line` in
[`GAPS.md`](GAPS.md) (status log for phases 1–9). The load-bearing ones:

- **Assistant tours are a Later phase** (GOAL phase 10) — spotlight + step cards are not built; the popover's "FOR THIS PAGE" chips only where the six existing tools + ADR-0044 back them.
- **ADR-0054 (server-side APM lock digest) is design-accepted, implementation deferred** — the New profile dialog shows the honest state instead of a computed digest.
- **ADR-0055 (pause-before-next-step) is Proposed** — the workbench keeps the accepted interrupt-and-rerun takeover and the confirm card says exactly that (GAPS.md §3, conflict 5).
- **Board filters "from issues" / "scheduled" are honestly disabled** (ADR-0031: "not a trigger"); the `mine` filter is now e2e-covered (`shell-p789-board-mine`).
- **GitHub anonymous rate limit** can throttle the live GitHub calls `m5-issue-run` makes (tracker prefill, issue events) — a red GitHub on the lab can fail that suite without any app regression.
- **The assistant step depends on the live model** — earlier d2708cb runs landed the edit in 1 of 2 runs; the workflow.draft lookup tool (606b36e) removed the draft hunt, and in the final run it landed on the first turn.
- **Model variance on assistant turns** — the model is not deterministic; the runner caps (`7c40979`, `2c999c9`) bound the worst case so the bounded confirmation windows (shell-p789, journey f) stay honest rather than racing a slow turn.
- **Takeover keeps the interrupt semantics** — hand-back re-runs the interrupted step as a new attempt (ADR-0043 / ADR-0055 as recorded); the confirm card says so.
- **Takeover hand-back attempt-2 wait** — once in the `final2/` run the takeover hand-back's attempt 2 never queued within the 900 s ceiling ("attempt 2 of /build_until_verified[1]/code_review never queued within 900000ms"); bounded by the turn-bounded journey waits (`aaa50e0`).
- **Lab authorization is single-tenant** — cross-project scoping (ADR-0047) is proven against the lab's seeded memberships, not a multi-org deployment.
- **M1/M2 journeys** run in CI's e2e job on every push (`pnpm --dir e2e test` against a fresh e2e stack) and are green on `d2708cb`; they are not part of the lab evidence set.
- **Screenshots live outside git** — final-run evidence lands in `~/.cache/communication-lab/shell/final4/ev/` (gitignored); only `EVIDENCE` lines and this record are in the tree.

## Appendix A — EVIDENCE lines of the final run (final4)

    EVIDENCE conv-a7-dialog: New conversation dialog opened from the m4-exit overview header with the project pinned, profile m4-implementer and the first prompt filled — no pipeline field exists
    EVIDENCE conv-a7-filter-run-hides-manual: filtering the list to "From runs" hides the manual conversation
    EVIDENCE conv-a7-global-menu: the global New menu (new-menu → new-menu-conversation) opened the same dialog with a working project picker set to M4 Exit
    EVIDENCE conv-a7-list-manual: searching "issue2 one-off" lists the row with the Manual badge (conversation-origin-manual)
    EVIDENCE conv-a7-manual-label: the conversation page shows the "Manual conversation" label and has no part-of-run-link or node reference
    EVIDENCE conv-a7-reply: conversation "issue2 one-off final4" landed on its page and the m4-implementer turn completed with an agent reply containing "pong"
    EVIDENCE conv-narrow-dialog: at 390x844 the new-conversation dialog sits inside the viewport and the document does not scroll horizontally
    EVIDENCE conv-run-badge: a run-linked conversation row's "From run" badge is a deep link into the Run Workbench with a ?node= parameter (/runs/01a1627a-3e93-76ce-9265-d584eab9d937?node=code_review&instance=34ced53f-46fa-543e-8845-7474ddefadc7&attempt=1)
    EVIDENCE conv-run-conversation-page: the conversation page's part-of-run-link points at the same workbench deep link as the list badge (/runs/01a1627a-3e93-76ce-9265-d584eab9d937?node=code_review&instance=34ced53f-46fa-543e-8845-7474ddefadc7&attempt=1)
    EVIDENCE conv-run-linkback: the part-of-run link landed on the Run Workbench with the source node selected in the graph and the conversation open in the dock
    EVIDENCE journey-0-shell-final4: signed in; the sidebar exists and no header[aria-label=Primary] top bar is present
    EVIDENCE journey-a-ambiguity-final4: guarded-edge dialog before the insert: “approve reads nodes.plan.*” — the insert is accepted with the target's guard kept (issue #2 A3)
    EVIDENCE journey-a-dialog-final4: New-profile dialog open: the Claude Code card, name journey-final4, and the footer reads “Create and use in <step>” (contract C6)
    EVIDENCE journey-a-step-final4: agent.acp step journey_step inserted after plan, profile journey-final4 created through the dialog and now selected, instruction set, draft saved
    EVIDENCE journey-b-published-final4: draft validated (“valid — 0 findings”) and published — revision 1 → 2 (sha256:caa8b1efd3e8…), asserted via the API
    EVIDENCE journey-c-run-final4: run 01a1626e-268e-7a1a-830d-e7f6749be48b started from the new revision r2 caa8b1 (sha256:caa8b1efd3e8…) and the workbench opened on it
    EVIDENCE journey-d-decided-final4: the gate was approved from the phone-width Inbox; the run's approve step is succeeded via the API and the card left the Inbox
    EVIDENCE journey-d-inbox-final4: at 390x844 the Inbox decision card for the run's gate is open with its confirm step armed (approval …b7075f33)
    EVIDENCE journey-e-confirm-final4: the take-control confirm card names journey_step and says the attempt stops, the run pauses, and the hand-back re-runs the step as a new attempt (ADR-0043)
    EVIDENCE journey-e-handed-back-final4: control returned to the factory: a new attempt of journey_step is queued (attempt_count ≥ 2 via the API) — the accepted takeover semantics (ADR-0043/ADR-0055)
    EVIDENCE journey-e-live-final4: the workbench is pinned to agent step journey_step (status leased via the API) with its live conversation in the dock
    EVIDENCE journey-e-prompt-final4: admin is in control of journey_step: one prompt (“Say hello to acknowledge, then carry on with your original task.”) got a live agent reply in the dock
    EVIDENCE journey-f-changed-final4: the assistant's change chip counts its change(s), and the draft …fd768a13's YAML now contains journey_check (via the API)
    EVIDENCE journey-f-undone-final4: undo all: no draft of feature-development contains journey_check any more (via the API)
    EVIDENCE shell-p1-ask-floating: choosing the floating ask placement renders the ask-float control on the home page
    EVIDENCE shell-p1-drawer-esc: at 390x844 Escape closes the drawer and the page stays without sideways scroll
    EVIDENCE shell-p1-drawer-open: at 390x844 the menu button opens the sidebar drawer with the nav rows inside
    EVIDENCE shell-p1-palette-esc: Escape closes the command palette
    EVIDENCE shell-p1-palette-open: ⌘K (Ctrl+K in this lab) opens the global ask surface (the ADR-0050 assistant popover)
    EVIDENCE shell-p1-palette-second-press: a second ⌘K while the assistant is open opens the jump palette
    EVIDENCE shell-p1-redirects: all 5 legacy URLs (library, agents, projects/<id>, projects/<id>/runs/<run>?view=timeline, projects/<id>/conversations/<c>) land on their canonical C1 URLs with query state preserved
    EVIDENCE shell-p1-settings-layout: the Settings → Layout tab renders the projects-mode, ask-placement and workflow-folder groups
    EVIDENCE shell-p1-sidebar: the sidebar is present, the old header[aria-label=Primary] app bar is gone, and all seven nav rows link to the canonical C1 routes
    EVIDENCE shell-p1-switcher-mode: choosing the switcher projects mode re-renders the sidebar's project block as the project switcher
    EVIDENCE shell-p1-tree-expand: expanding "M4 Exit" PATCHes /api/v1/me/preferences (layout.expanded), the GET returns it, and the expansion is still applied after a reload
    EVIDENCE shell-p2-board-columns: board column counts equal the API's per-status counts (queued=0, running=0, needs-you=2, failed=0, done=1 of 3 runs)
    EVIDENCE shell-p2-board-group-repo: grouping by repo re-groups the same 3 cards into 1 group row(s), each labelled with its count
    EVIDENCE shell-p2-board-group-workflow: grouping by workflow re-groups all 3 cards into 2 group row(s)
    EVIDENCE shell-p2-drawer-approve-cancelled: cancelling the confirm step returns to the Approve button without any POST /api/v1/approvals — the gate is still pending
    EVIDENCE shell-p2-drawer-approve-confirm: the drawer's Approve button shows a confirm step before any decision is recorded
    EVIDENCE shell-p2-drawer-focus-esc: focus starts inside the drawer and 25 Tab presses never escape it; Escape closes the drawer and drops ?run=
    EVIDENCE shell-p2-drawer-open: clicking the run card opens the 440px drawer and the URL carries ?run=01a1626e…
    EVIDENCE shell-p2-drawer-phone-approve-confirm: at 390x844 the drawer's Approve shows its confirm step, and the journey cancels it
    EVIDENCE shell-p2-drawer-phone: at 390x844 the run drawer fits the viewport and the page does not scroll sideways
    EVIDENCE shell-p2-home-callouts: home shows one decision callout per pending approval from GET /api/v1/approvals?status=pending (2 callout(s))
    EVIDENCE shell-p2-home-count-line: home count line equals GET /api/v1/runs per-column counts (2 need you, 0 failed, 0 running, 0 queued); zero segments are omitted
    EVIDENCE shell-p3-fullscreen-restore: ⤡ show graph clears ?full=1 and restores the split view with the graph visible
    EVIDENCE shell-p3-fullscreen-strip: ⤢ full screen sets ?full=1 and the step strip shows exactly 8 cell(s), one per top-level step of the pinned revision
    EVIDENCE shell-p3-take-control-cancelled: Escape and Just watch both close the confirm card and no POST …/take-control is sent — control stays with the agent
    EVIDENCE shell-p3-take-control-card: the dock's Take control shows its confirm card (heading: "TAKE CONTROL OF /P3TAKE?") with a truthful copy and a Just watch option
    EVIDENCE shell-p3-workbench-graph: /runs/<id> renders the run title and the four tabs (Graph, Timeline, Artifacts, Diagnostics) with Graph selected
    EVIDENCE shell-p3-workbench-tabs: clicking each tab updates the URL (?view=timeline|artifacts|diagnostics) and the selected tab state
    EVIDENCE shell-p3-workbench-view-artifacts: deep-linking /runs/<id>?view=artifacts lands on the Artifacts tab
    EVIDENCE shell-p4-agent-step-profile: picking the Agent kind opens the inspector's profile select with its SUGGESTED hint and sandbox-chip option labels
    EVIDENCE shell-p4-duplicate: duplicating feature-development created feature-development-copy (API count 4 → 5) and the journey landed on the copy's draft editor
    EVIDENCE shell-p4-duplicate-list: the /workflows list now carries the new row feature-development-copy (5 rows = the API's count)
    EVIDENCE shell-p4-edit-for-all: Edit for all on "p4-seed-mvj7fzys" created a new revision and the API's latest revision now carries the version label "1.0.1"
    EVIDENCE shell-p4-new-profile-from-step: the profile select's + New profile… option opens the shared NewProfileDialog
    EVIDENCE shell-p4-step-picker: the edge + opens the step picker with exactly five primary kind cards (Agent, Command, Approval, Loop, Workflow) and no Publish card
    EVIDENCE shell-p4-steps-registry: /steps lists the 1 registry rows grouped by family, each with its used-in line from GET /api/v1/node-templates
    EVIDENCE shell-p4-workflows-list: /workflows lists exactly the 4 pipelines from GET /api/v1/pipelines and every revision chip reads from the API (PUBLISHED r<N> or DRAFT ONLY)
    EVIDENCE shell-p5-created-dialog: creating "shell p5 mvj7gc19" through the dialog closes it (the caller acts on onCreated) and lands on the new profile's detail page
    EVIDENCE shell-p5-created-list: GET /api/v1/agent-profiles and the /profiles list both carry the new row "shell p5 mvj7gc19" (id 01a16275…)
    EVIDENCE shell-p5-created-phone: at 390x844 the profile "shell p5 mvj7gc19 phone" is created through the dialog and exists in the API
    EVIDENCE shell-p5-detail: the Claude Code detail page shows its sections and every capability cell equals the launcher's recorded evidence (observed / not supported / not tested)
    EVIDENCE shell-p5-dialog-disabled-cards: in the New profile dialog the unregistered Pi and Antigravity cards are disabled with their reasons, while the registered Claude and Codex cards stay selectable
    EVIDENCE shell-p5-dialog-phone: at 390x844 the New profile dialog fits the viewport without sideways scroll
    EVIDENCE shell-p5-list: /profiles lists the 6 API profiles; every launcher line and sandbox chip matches C5 (/api/v1/launchers) plus /api/v1/system/sandbox
    EVIDENCE shell-p6-draft-pr: the 'Open a draft PR' NEXT entry is controller-only; clicking shows the confirm card and cancelling it sends nothing (ADR-0045)
    EVIDENCE shell-p6-thread-header: the /threads/<id> page header shows the conversation title "P6 one-off thread mvj7gjbc" and its meta line
    EVIDENCE shell-p6-thread-phone: at 390x844 the thread page renders its header without sideways scroll
    EVIDENCE shell-p6-thread-rail: the thread rail shows the honest artifacts note and the "Hand to a workflow…" follow-up offered (never fake state)
    EVIDENCE shell-p6-threads-list: /threads shows the 1 one-off threads by default and, with the one-off filter lifted, exactly the 7 cross-project summaries from GET /api/v1/conversations
    EVIDENCE shell-p789-approval-detail: the amber 'NEEDS YOUR DECISION' strip, the model summary card, the plan section and the 'Not available yet' files note all rendered for gate bcc7233e1ba65; the free-text reply produced a proposed decision and its confirm step, which the journey cancelled — the API still lists the approval pending
    EVIDENCE shell-p789-approval-narrow: at 390px the strip, the files note and the decide rail stack without sideways scroll and stay axe-clean; the gate is still pending (the journey cancelled, never decided)
    EVIDENCE shell-p789-board-mine: board cards without the filter equal GET /api/v1/runs (5 of 5), with 'mine' pressed the 3 cards equal GET /api/v1/runs?mine=true, and the 'from issues' + 'scheduled' chips are disabled with the 'not available yet' title (ADR-0031: no trigger-source data)
    EVIDENCE shell-p789-live-flag: the sidebar Inbox flag rose from 2 to 3 within 10 s of run 01a16276 entering waiting_human, with ZERO /runs|/approvals GETs during the 8 s idle window, 6 invalidation refetch(es) after the run, and 663 SSE frame(s) captured on /api/v1/events — every refetch timestamped after the first frame
    EVIDENCE shell-p789-mic: the fake SpeechRecognition's interim + final results drove the listening bar and landed 'change the build please' in the composer, where ' and ship it' was typed on top — and ZERO non-GET requests reached /api/v1/assistant/ before Send
    EVIDENCE shell-p789-ops: the health line reads 'replica: api-b · queue: 0 queued, 0 leased · oldest queued: queue empty', the workers table holds 2 rows == GET /api/v1/workers, and every capability cell matches GET /api/v1/launchers (✓ observed only where result=observed: claude:acp_session, claude:resume, claude:permission_prompts, claude:nono_required, codex:acp_session, codex:resume, codex:permission_prompts)
    EVIDENCE shell-p789-question-roundtrip: the model's follow-up card appeared after 'change the workflow'; the option click POSTed the LABEL 'feature-development' verbatim as the body's plain-text 'text' field (no value, no structured payload, no confirm/dismiss) — the answer's user row had not landed when the 120 s bounded confirmation window closed (the answer turn, 180 s per completion at the lab, was still running); the POST body is the round-trip proof
    EVIDENCE shell-p789-save-step: selecting the agent node in the p789-step-1792653273531 draft and arming 'also save as a reusable step' POSTed the node as template 01a16276 — it is listed by GET /api/v1/node-templates and shows on /steps
    EVIDENCE shell-p789-settings: settings → assistant shows all three trust levels with the stored one (ask_risky) checked, matching GET /me/preferences, and the settings footer's Operations entry links to /ops
    EVIDENCE shell-p789-trust-ask-all: with trust level ask_all the assistant's draft edit ('add a human approval step named trust_check after plan in p789-trust-1792653277875') surfaced a confirm card carrying the server risk line, and GET /api/v1/drafts/01a16276 still holds the document WITHOUT trust_check at version 1
    EVIDENCE shell-p789-trust-navigate: DOCUMENTED SECONDARY CHECK (no assertion on model choice): under ask_all 'take me to the board' neither called ui.navigate nor named the board in its answer
    EVIDENCE shell-p789-trust-retry: clicking Retry re-ran the gated draft.apply through the version-checked draft PUT: GET /api/v1/drafts/{id} now contains the trust_check node
    EVIDENCE studio-a1b-inspector-a11y: desktop inspector audited by axe with the agent.acp node (code_review) and the process.exec node (review) selected one at a time — zero serious/critical on both
    EVIDENCE studio-a1-inserted: agent.acp node agent inserted on the test → review edge and configured entirely in the inspector: profile m4-reviewer, review prompt, id code_review, on-failure continue
    EVIDENCE studio-a1-yaml: YAML view proves the inspector's work: id: code_review (kind agent.acp, profile m4-reviewer), review's dependsOn now names code_review, on-failure continue — untouched by any YAML editing
    EVIDENCE studio-a2-published: the draft was saved, validated (server verdict: valid — 0 findings) and published — published as r2 2.0.0; the diff listed code_review and the until until scope before publish
    EVIDENCE studio-a2-reopened: reopened r2 from the pipeline page: the definition graph shows the new until Repeat until scope and the regenerated YAML shows kind: until with maxIterations: 2
    EVIDENCE studio-a2-wrapped: three steps added at the root tail (two echo Run-command steps → the m4-reviewer agent), multi-selected by shift+click and wrapped in a Repeat until scope (until) from the selection toolbar — the YAML carries kind: until with passWhen true and maxIterations: 2
    EVIDENCE studio-a3-ambiguity: the guarded verdict → publish edge's own + raised the AmbiguityDialog naming the condition (when) guard before anything changed
    EVIDENCE studio-a3-preview: dragging 'Human approval' over the plan → approve edge shows the insert-preview on that edge
    EVIDENCE studio-a3-undo: drag-to-insert of a Human approval step on the plan → approve edge (insert preview, drop, guard confirm): inserted, undone (YAML byte-identical to before) and redone (YAML restored with kind: human.approval)
    EVIDENCE studio-a8-applied: Apply saved the assistant's edit: draft version 1 → 2, while the pipeline's revision count stayed at 2 (no publish)
    EVIDENCE studio-a8-proposed: the assistant's proposal previews on the canvas (highlighted node + caption) with the draft still at version 1 on the server — nothing saved, nothing published
    EVIDENCE studio-loaded: Studio opened on a fresh draft of feature-development-deterministic cloned from its newest revision — the graph canvas (with the seeded build_until_verified scope) is on stage, not a YAML textarea
    EVIDENCE studio-narrow: at 390x844 the Studio drops the React Flow canvas for the step outline; selecting 'plan' opens the inspector and the page does not scroll horizontally
    EVIDENCE wb-a4-acp-live: the agent.acp node code_review is selected and the dock shows its live conversation transcript (agent messages / tool events)
    EVIDENCE wb-a4-approval: the approve human gate was selected in the graph and approved from the dock's approval card
    EVIDENCE wb-a4-graph-default: the run page opens graph-first: graph tab selected, react-flow canvas visible (no definition table), the attention node auto-selected and docked
    EVIDENCE wb-a5-bob-control: bob (contributor) took control while /build_until_verified[1]/code_review was running — the badge reads "You are in control" and the run is paused for human_takeover (the attempt was interrupted)
    EVIDENCE wb-a5-carol-readonly: carol (viewer) sees Take control disabled (with the composer explainer) and a disabled composer on the same ACP node
    EVIDENCE wb-a5-returned: bob returned control to the factory — on the conversation he drove (attempt 1 tab) the badge names the pipeline run, the run resumed (not paused), and a NEW attempt (attempt 2) of code_review was queued and reached succeeded (attempt tabs: 1 + 2)
    EVIDENCE wb-a5-timeline: the workbench timeline lists the control handoffs — run.paused (human_takeover) and run.resumed with bob as actor
    EVIDENCE wb-a6-attempts: fan-out item 13 (the child that exits 1) — its child run's implement step shows more than one attempt — attempt tabs or 'attempt k of m' with m > 1
    EVIDENCE wb-a6-exec: a process.exec node (test) is selected; the dock shows its exit code and captured stdout/stderr
    EVIDENCE wb-a6-fanout: the for_each scope shows 14 items with per-state counts; items 1-4 were selected and the dock followed the picks
    EVIDENCE wb-a6-iter1: the until scope's picker selects iteration 1 — iteration 1 · attempt 1 of 2
    EVIDENCE wb-a6-iter2: the until scope's picker selects iteration 2 — iteration 2
    EVIDENCE wb-narrow: at 390x844 the workbench is the graph with the dock below it as a sheet (back-to-graph control) and no horizontal scroll
    EVIDENCE wb-setup-run-started: the run started with fanout=14, hold_seconds=20

Screenshot dir: `~/.cache/communication-lab/shell/final4/ev/`
