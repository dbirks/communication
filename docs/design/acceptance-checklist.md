# UX acceptance checklist

Pass/fail only — every item is observable by a person driving the app (or by the Playwright proofs in
ADR-0006), and each cites the requirement it satisfies. Scope: M5's exit
(`communication-spec/11-build-roadmap.md` M5) and `communication-spec/12-test-strategy.md`
"First complete acceptance scenario" (the consulting-team scenario) plus its failure cases where they
are user-visible. **No item below can be satisfied by a mock**: `AGENTS.md` forbids substituting a
mocked green test for a real integration, and several items explicitly require the failure to be
*induced*.

Verdict format for the report: `PASS <item id> — <command/proof> — <observed>`. Anything not observed
is `NOT VERIFIED`, not `PASS`.

---

## 0. Ground rules

1. Environment = the real compose stack (2 API replicas + worker + Postgres) with a real ACP harness,
   as `12` requires; UI driven in a browser, not a rendered snapshot.
2. One participant set: **Rosa** (admin/factory maintainer), **Marco** (consultant, 5 projects),
   **Priya** (contributor), **Sam** (viewer on one project only, and *not* on `Customer Platform`).
3. Two identities must be logged in simultaneously in separate profiles so control conflicts are real.
4. Where the checklist says a gap route is missing, the item is scored against **the state this brief
   requires for the missing case** (explicit "not available in this build"), not against a fake success.

## 1. M5 exit — the untrained test user  (`11-build-roadmap.md` M5)

A person who has never seen the product, given only the URL and the sentence "clone a sample pipeline,
change it, and handle the run that is stuck". No hinting allowed.

| ID | Item | Pass = |
|---|---|---|
| E1 | Finds the sample pipeline without search | Library ▸ Starters is reachable from the frame in ≤2 clicks; card says what it does and its prerequisites |
| E2 | Clones it to a draft | one action, no dead end; draft opens in the editor with a name they can recognise |
| E3 | **Customizes** it: changes an agent profile and a prompt/input | form fields come from the schema; the changed node visibly reads as changed |
| E4 | Adds a bounded loop or a human gate | `until` requires and receives a max-iteration bound; validation finding appears if they omit it |
| E5 | Validates and previews YAML/diff | both views reachable from the editor with the same digest shown; user can state what changed |
| E6 | Publishes a revision | publish is disabled while findings exist, and the reason is in text |
| E7 | Promotes to **one** project only | promotion preview names the project, old→new digest, and says running attempts stay pinned; user can explain why Project B is unaffected |
| E8 | **Sees a stalled run** | the stalled run is on the Attention screen with its reason and age in words — the user does not scroll a list of 40 runs to find it |
| E9 | Understands *why* it is stalled in one sentence | they name the object (approval gate / interrupted attempt / permission prompt) correctly |
| E10 | Opens the conversation and **takes control** | button enabled for contributor+; badge changes; composer becomes enabled with the explanation disappearing |
| E11 | Prompts and **returns control** | one active turn respected (second prompt refused with the shipped explainer); return-control hands back to the run attempt and the intervention is visible in the timeline |
| E12 | **Retries** from a boundary | the retry dialog names the checkpoint boundary and the redo scope; the failed attempt stays in history after retry |
| E13 | **Views evidence** | outputs + at least one artifact (log/report/diff) opened from the attempt, and the diff/artifact view does not show a materialized `.env` (`12` case 12) |
| E14 | Never asks "did it lie to me?" | in the debrief, the user does not use the words "did it lose my work" after an induced interruption — because the screen said what is and is not recoverable |
| E15 | Completes E1–E13 unaided | timed walkthrough; any blocking confusion is logged as a UX defect with the screen name |

## 2. Consulting-team scenario  (`12-test-strategy.md` "First complete acceptance scenario")

| ID | Scenario step | UI requirement |
|---|---|---|
| C0 | Admin creates `Customer Platform` with two repos | project + repo screens as shipped; two repos visible on Overview and in the workspace widget |
| C1 | Shared agent profiles (planner/implementer/reviewer, APM) | profile cards show launcher, permission mode **and why it is `ask`**, APM package + lock digest; no claim that APM staging = isolation (`04`) |
| C2 | Adds a scoped test secret | J8 screen: metadata only, write-only value, mount declared with repo + relative path + key + lifecycle; policy line (0600 / removed at attempt end / excluded from git+artifacts) |
| C3 | Imports sample pipeline, validates sandbox | J1 checklist shows the sandbox step with the enforcement mode and per-worker verdict; unavailable ⇒ blocking explanation, never a silent pass |
| C4 | Another user starts work from a goal | run appears in Attention and Runs within one stream frame; `queued → preparing → running` visible as words |
| C5 | Planner emits spec + structured `plan`; human approves | approval screen shows plan artifact, goal, what starts if approved; decision recorded with actor/comment (`01` Approval) |
| C6 | `for_each` ≥3 child tasks, ≤2 concurrent agents in separate worktrees | stage strip shows progress *by stage*; tree shows children with a concurrency count; no 150-node maze (`10` J5) |
| C7 | Tests and second-agent review fail once, succeed on retry | failed attempt remains visible next to the successful one; both `execution_status` and `business_outcome` readable (`03`) |
| C8 | One person takes over a conversation and returns to factory | two browsers: loser of the CAS sees the winner (case 10), never a guess; return-control leaves evidence |
| C9 | Publication creates draft PR/branch or configured artifact | Publication panel names branch/commit/PR and merge state; "not merged" is stated (`01`: completed ≠ merged) |
| C10 | API rollout leaves history intact | after a replica roll: streams reconnect from `Last-Event-ID`, timeline complete, replica badge changes, `⟨T:stream-status⟩` never claims live while reconnecting |
| C11 | Assistant clones a beta, changes the reviewer, previews a diff | [`assistant-flow.md`](assistant-flow.md) Acts 1–4 |
| C12 | User confirms promotion **only to this Project** | after promotion, another project's assignment still shows the old digest, on screen (not in a DB query) |
| C13 | Cross-project viewer cannot read events/artifacts | Sam sees `404` copy for `Customer Platform` routes; artifact, workspace, sandbox and preview-token routes all deny; nothing in Attention/assistant names the project (`12` case 15, ADR-0014 §3) |

## 3. Failure-mode items (induced, not simulated)  (`12` cases 1–20, UI-visible subset)

| ID | Induced failure | Required UI | Cases |
|---|---|---|---|
| F1 | Kill the worker mid-ACP-tool-call | run `interrupted`, "stopped, outcome unknown", reason named; last completed boundary shown; retry from boundary offered; **no** "resumed without loss" text anywhere | 5, `02`, J7 |
| F2 | Let a stale worker keep running after lease loss | attempt records the rejected write; screen never shows two owners | 2, 3 |
| F3 | Roll an API replica during streaming | no gap, no duplicate transcript row, no event from an inaccessible project | 4 |
| F4 | Restart the worker on a different host/volume | `workspace.recovery_lost` surfaced: "edits are not recoverable; cross-host recovery is not supported in this build" | 20, D-024 |
| F5 | `until` that never passes | run fails at the declared bound with full evidence and the iteration history; no infinite spinner | 7 |
| F6 | Child 3 of 25 fails while siblings pass | siblings' results preserved and visible; aggregate failure policy stated; fan-out bounded and shown | 8 |
| F7 | Approver loses project access, then tries to approve | decision refused; approval re-routed; nothing implies it went through | 9 |
| F8 | Two humans click Take Control together | exactly one wins; the other learns who won and the version adopted | 10 |
| F9 | Publish a new revision while a run executes | that run's screen keeps the old digest and links it | 11 |
| F10 | Materialize `.env`, then look everywhere for it | absent from transcript, diff, artifacts, event payloads and logs; mount form's exclusion policy explains why | 12 |
| F11 | Sandbox restriction unavailable in `required` mode | process never starts; enforcement stage + reason visible next to the turn; turn failed with `sandbox_enforcement_failed` | 13 |
| F12 | APM package changes upstream mid-attempt | attempt keeps showing the pinned lock digest | 14 |
| F13 | Unassigned user probes API/SSE/artifacts/assistant search for Project B | uniform `404` copy; zero metadata in autocomplete/assistant | 15 |
| F14 | HTML artifact containing a script payload | renders only in the sandboxed separate-origin frame; the app origin has no inline-HTML state; download for `restricted` | 16 |
| F15 | Concurrent runs on two repos | workspace widget shows per-repo refs and dirty counts; no cross-run "restore" affordance | 17 |
| F16 | Duplicate webhook | (M6) — UI must not show duplicate child runs; out of scope for M5 pass | 18 |
| F17 | Failed external create-PR then lost response | "unconfirmed external action — will reconcile", never a claimed success or a second PR | 6 |
| F18 | Reviewer returns malformed JSON | attempt shows "ran fine · could not parse result" — never a silent pass | `03` edge cases |
| F19 | Fan-out of zero items | "0 items" state, run completes with an empty result, no error theatre | `03` |
| F20 | `for_each` parent cancelled with 12 children | cascade/detach per child visible; detached child labelled and still inspectable | `03` |

## 4. Accessibility  (must pass with a screen reader and with the keyboard only)

| ID | Item |
|---|---|
| A1 | All of §1 (E1–E13) completed with keyboard only, no pointer — including canvas node selection via arrow keys, and retry from the dialog |
| A2 | Focus visible on every control; `Esc` closes assistant/dialog/drawer and restores focus; no focus trap leak |
| A3 | A 25-child fan-out is readable as a hierarchy with a screen reader (`tree`/`treeitem`/`aria-level`/`aria-setsize`), including counts on collapsed branches |
| A4 | No status relies on colour: a colour-blind-off or greyscale screenshot run still distinguishes ok/warn/danger/neutral by wording |
| A5 | Live regions: transcript append, turn status, stream status, timeline additions are announced politely and not repeating; nothing uses `assertive` except a failed mutation |
| A6 | `prefers-reduced-motion: reduce` — assistant highlights, diff rings, tree expansion and transcript streaming all degrade to static, information intact |
| A7 | Zoom to 200% and 320px width: no lost action; the run inspector becomes lists and stays operable; the editor becomes read-only + YAML without hiding state |
| A8 | Contrast: every token pair in `design-system.md` measured in the built CSS ≥ 4.5:1 (text) / ≥3:1 (UI); observed numbers recorded, not the table's computed claim |
| A9 | Every table keeps a caption + `scope="col"`; every `h1` unique per screen; key/value facts in `dl`; ids never the only label |
| A10 | Disabled controls always have an accessible explanation that a sighted user also sees |
| A11 | Transcript streaming rate control works; `slow`/static mode does not lose content or order |
| A12 | A viewer role can watch a factory conversation and is told exactly which abilities they lack (shipped `composer-explainer` pattern) |

## 5. Assistant-specific (also [`assistant-flow.md`](assistant-flow.md) acceptance)

| ID | Item |
|---|---|
| R1 | From one sentence, the user can state where the assistant looked, what it changed, and what was affected |
| R2 | The assistant's edits stay draft-only until the user explicitly publishes; a draft caption says so |
| R3 | The question's chosen **phrase** appears verbatim in the persisted transcript/trace |
| R4 | Undo works for applied draft steps and leaves the base revision untouched |
| R5 | Publishing through the assistant uses the identical permission path as the manual UI (`06`) — verified with Priya (contributor) denied and Rosa (publisher) allowed |
| R6 | Every assistant mutation is answerable as "who/what/why" from the trace and the timeline |
| R7 | Out-of-scope project names never appear in any assistant suggestion or search result |
| R8 | A failed mid-sequence leaves the UI stating exactly which steps applied — never "partially done" |
| R9 | The panel is collapsible at every step, and no capability exists *only* there |
| R10 | No privileged action executes without an explicit confirmation showing consequences |

## 6. Honesty and safety invariants (instant fail for the whole release)

| ID | Invariant |
|---|---|
| H1 | Nowhere in the UI is there a route/label/placeholder implying a raw secret, masked value, or "last 4" — because no such endpoint exists and must stay absent (`docs/m3-contract.md` §2) |
| H2 | No absolute host path anywhere (workspace, worker, sandbox, artifact) — M3 contract §2 |
| H3 | No `git restore` / discard-changes affordance in any workspace surface (`10`) |
| H4 | Untrusted HTML is only ever in the separate-origin sandboxed frame; `…/content` `text/html` is an attachment |
| H5 | No "resumed without loss", "recovered", or "synced" copy after an interruption |
| H6 | `completed` is never rendered as "merged"/"deployed" |
| H7 | APM/sandbox/ACP capability claims come from observed evidence; an untested compatibility row reads `Test`, never `PASS` (`12`) |
| H8 | No cross-project data in any list, autocomplete, badge, tooltip or error message |
| H9 | No tenant-isolation claim anywhere in copy; membership ≠ OS isolation (`05`, D-025 **Open**) |
| H10 | No screenshot, `.env`, token, or fixture secret committed in proofs |
| H11 | The UI never computes a scheduling/branch/publish outcome locally; anything it cannot read is "unavailable" |
| H12 | Assistant never appears to have deployed a workflow on its own |

## 7. Walkthrough instrumentation (what to record)

1. Session script: exactly the sentences in §1 and §2, in order, with the induced failures of §3
   injected at their step boundaries.
2. Log for each step: the actor, the route, the click path (screen → screen), whether the step was
   completed unaided, and the *verbatim* confusion if any.
3. Screenshots/console captured with Playwright per ADR-0006 (kept out of the repo: they live in
   `.playwright-cli/`, gitignored — never committed).
4. Accessibility pass recorded with a named screen reader (VoiceOver or NVDA) and the keyboard-only run.
5. Defects filed per screen, with the checklist id that failed — that mapping is what makes the next
   design pass reviewable.

**M5 UX gate:** all of §1, all of §6, §4 A1–A7, and ≥ 90% of §2/§3 items (the remainder explicitly
blocked by a numbered contract gap, listed by id). A gap-blocked item is *not* a pass; it is recorded
as `blocked on G#` and the screen must render its explicit "not available in this build" state — that
state itself is what is being verified.

## 8. Known-open UX items (not blocking, tracked)

| Item | Status |
|---|---|
| Attention as the landing page vs Projects | decided in the first E-section walkthrough (§7) |
| Assistant dock vs bottom sheet at 768–1100px | prototype both in the first editor build |
| Node glyph set vs labelled chips | labelled chips default; glyphs only if they survive A4 |
| Dark theme | deferred; needs its own measured contrast table |
| Mobile graph authoring | deliberately out: supervision lists only (`10` responsive) |
| Presence indicators | absent until a server source exists — no client-side fake |
| Multi-org switcher | single seeded org today → display chip only |
