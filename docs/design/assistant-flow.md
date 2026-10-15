# Assistant flow: "navigate, edit, ask a question, apply"

The annotated substitute for a clickable prototype (`10` requested output item 7, `08`'s non-negotiables).
The scenario is `08`'s own example and `10`'s J4, run against the consulting-team shape in `12`:

> "For Project A only, try the Codex reviewer in parallel with Claude and cap each issue at four review
> loops."

What is specified here is the **UI choreography and its affordances**, not the assistant's backend:
its tools are the same permission-checked application services the human UI calls (`08`, D-023), and
every route/event the panels need is tagged with a gap id from [`README.md`](README.md) (**G11** for
the assistant API itself, **G1/G13/G21** for what the actions touch).

## Standing UI rules

| Rule | Why |
|---|---|
| The panel always names the context it inferred: "Context: Project Customer Platform · run r-482" | the assistant is context-aware, and an unstated context is a silent wrong scope |
| Every proposed mutation shows *what* changes, *where*, and *what it affects* — never a bare "OK?" | `08`: "propose → show diff + relevant consequences → user approves → mutate/publish → audit event" |
| Draft edits may be applied with a visible undo; publishing/promotion/secrets/security/push-merge always require explicit confirmation | `08` "Tool action policy" |
| Highlighting is a labelled ring + caption, and degrades to a text line under reduced motion | `08`: no cinematic animation required; `10` accessibility |
| Questions render as phrase buttons **plus** free text; the chosen phrase *is* the answer, stored verbatim | `08`: not an opaque button index |
| The panel can be collapsed at any point; nothing the assistant does is only reachable there | supervision, not hostage-taking |
| No assistant action appears in the app without an entry in the action trace with actor + reason | `08`: "'Who changed this and why?' must be answerable for every assistant mutation" |
| An ordinary coding ACP session never sees these tools | D-020, `08` ("never possess Communication administration tools by default inside ordinary coding ACP sessions") |
| The panel's scope is the user's scope: an out-of-scope project cannot be named, suggested or counted | `06`, `12` case 15 (gap **G23**) |

---

## Act 0 — invoked

```
user is on   /projects/p-1/runs/r-482
opens panel  [Assistant ▸] or Ctrl/Cmd+K        ⟨T+assistant-panel⟩
panel header Context: Project Customer Platform · run r-482 · revision 8f2c1a…
             ⟨ the header states an inference, so it can be wrong-and-correctable ⟩
input        "For Project A only, try the Codex reviewer in parallel with Claude and
              cap each issue at four review loops."
```

Nothing happens yet except `assistant.message.delta` (planning). The panel shows one progress line per
inspection step, not a spinner — "long-running assistant actions show meaningful intermediate progress"
(`08`).

## Act 1 — **Navigate** (inspect → move the user to the right place)

```
assistant.ui.navigate   { route: "pipeline.editor", params: { draftId: "d-19" } }
```

```
┌ Canvas after navigation ───────────────────────────────────────────────────────────┐
│ ⌕ Assistant brought you here · [why?] · ← back to run r-482                        │
│                                                                                    │
│   plan ─▶ approve ─▶ until (max 4) ┐                                               │
│                       implement    │                                               │
│                       review  ◀━━━━┼━━ assistant wants to change this node          │
│                       └…           │                                               │
│                                                                                    │
│ status: inspecting assignment + published revision 8f2c1a…                         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Spec (`⟨T+ui-highlight-ring⟩`):

- Navigation is `router.navigate` to a **route name + params** the server enumerated — never a URL
  string built in the client, never a DOM click (**G11** target vocabulary).
- `assistant.ui.focus` / `ui.highlight` address `data-focus-target="node:review"`, a stable
  screen-owned attribute, so a layout change cannot silently redirect the user's attention elsewhere.
- Focus moves to the highlighted node (keyboard users arrive where sighted users look); the previous
  focus is restored on `Esc`.
- The "why?" disclosure opens the trace entry: which read it performed, on which object, which
  permission it used. Reads are listed because they justify the proposal.
- Read-only inspection may proceed without asking, inside the user's scope (`08`).

## Act 2 — **Edit** (draft mutations, visibly)

```
assistant.tool.proposed   pipeline.cloneRevision   { from: "8f2c1a…", to: "draft d-19" }
assistant.tool.executing  pipeline.updateNode      { node: "review", profile: "+ Codex (parallel with Claude)" }
assistant.tool.proposed   pipeline.updateNode      { scope: "build_until_verified", maxIterations: 4 }
assistant.ui.focus        { node: "review" }
assistant.diff.ready      { draft: "d-19", base: "8f2c1a…" }
```

```
┌ Proposal · 2 draft changes (not published) ──────────────────────────────────────┐
│ 1 ▸ add parallel reviewer  node "review"     Claude Code  →  Claude Code ∥ Codex│
│ 2 ▸ cap loop               until maxIterations  6  →  4                          │
│                                                                                    │
│ ring legend:  ○ proposed (not applied)   ● applied to draft   ◐ needs your answer  │
│ applied-to-draft changes do not affect any run until a revision is published       │
│                             [Apply to draft]  [Show diff]  [Undo]  [Dismiss]       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

```
┌ Diff (after Apply) ──────────────────────────── revision 8f2c1a… → draft d-19 ────┐
│ nodes:                                                                                    │
│ -  id: review          kind: gate(agent)  profile: org/claude-reviewer@3                  │
│ +  id: review_codex    kind: gate(agent)  profile: org/codex-reviewer@2                   │
│ +  id: reviewers       kind: parallel     join: all                                       │
│ -  until build_until_verified: maxIterations: 6                                           │
│ +  until build_until_verified: maxIterations: 4                                           │
│ outputs: unchanged · validation: 1 finding — "parallel join 'all' waits for both          │
│          reviewers; a Codex launch failure blocks the loop unless an error route          │
│          is declared"   [go to node]                                                      │
│                                                                     [Undo ▾] [Publish…]   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Spec:

- Proposals are **typed actions with before/after values on identified nodes** — a node id, never a
  coordinate (`01` invariant 6), so an "undo" is unambiguous.
- Applying draft edits is allowed with real-time highlighting + undo history (`08`), and every applied
  step lands in the trace.
- The diff is the same object the human editor's Diff tab renders (**G13**), so there is no
  "assistant-shaped diff" to keep in sync.
- A finding produced by the assistant's own edit is surfaced as a *validation* finding with the same
  component a human gets — the assistant gets no special pass to publish something invalid.
- Draft ≠ effective: a caption states the consequence boundary in words, because `10` requires the UI
  to distinguish draft changes from published effective behaviour.

## Act 3 — **Ask a question** (open-ended choice, phrase buttons)

The genuine ambiguity is not resolvable by inspection, so the assistant asks (`08`'s own example):

```
assistant.question   id q-7   turn t-31
  text: "Should this beta replace only new runs, or also the queued ones?"
  context: "3 runs are queued for Project A's assignment."
  options (verbatim, each a semantic answer):
    ( ) "New runs only"
    ( ) "Also replace the 3 queued runs"
    ( ) "Show me what would change for each queued run"
  free text: [________________________________]
  (optional file/document picker where the question asks for material)
```

Spec (`⟨T+assistant-question-option-*⟩`):

- Options are radio/checkbox groups, not buttons-that-hide-meanings: each option's **text is the
  answer** and is what gets persisted in the conversation (`08`).
- Multi-selection where the question is plural; `optional file selection` supported; free text always
  available, and free text is a *valid* answer, not a fallback.
- The unanswered question stays in the transcript as an open item, and the panel's state chip reads
  `awaiting your answer`. It remains legible in history years later — a phrase button that resolved to
  `option_index=2` would not.
- Keyboard: arrows move within the group; `Enter` submits the checked option; there is no implicit
  "Enter picks the first option".
- Questions are correlated to the assistant conversation/turn id so a mid-turn answer cannot drift
  onto another turn.

Answer chosen: **"New runs only"** → that exact string becomes the semantic answer for
`assignment.previewPromotion`.

## Act 4 — **Apply** (preview → approve → effective → audited)

```
assistant.tool.completed  assignment.previewPromotion  { project: "A" }
```

```
┌ Rollout preview · publish and promote are two separate actions ─────────────────────┐
│ Draft d-19 → new published revision 41d0b7… (immutable)                             │
│ target: Project A only — assignment "Feature Delivery"                              │
│   channel beta: 8f2c1a…  →  41d0b7…     stable: unchanged (8f2c1a…)                │
│ affected assignments: 1        other projects: unaffected (Project B stays 8f2c1a…) │
│ running attempts: 2 stay pinned to 8f2c1a… (a run never changes graph mid-flight)   │
│ queued runs: new runs only, per your answer to q-7                                  │
│ cost/limits: reviewer count 1 → 2 per loop iteration; max 4 iterations (was 6)      │
│ validation: ✓ 0 findings                                                            │
│                                                                                     │
│ [Publish revision]  needs publish permission      [Cancel]                          │
│ (promotion to Project A is a second, separate confirmation after publishing)         │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

```
┌ Confirm publish ───────────────────────────────────────────────────────────────────┐
│ You are publishing an immutable revision 41d0b7… as org publisher "Ana Rivera".      │
│ This does not change any project's behaviour until it is promoted.                   │
│ [Publish] [Go back]                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
   ↓ server: pipeline.revision.published  ·  audit row  ·  assistant.tool.completed
┌ Confirm promotion — Project A only ────────────────────────────────────────────────┐
│ assignment "Feature Delivery": beta 8f2c1a… → 41d0b7…                                │
│ 2 running attempts stay pinned · Project B unaffected                                │
│ [Promote to Project A] [Cancel]                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
   ↓ server: assignment.promoted  ·  audit row  ·  trace completed
```

```
┌ Done · trace ──────────────────────────────────────────────────────────────────────┐
│ 14:22 pipeline.cloneRevision   ✓  d-19 from 8f2c1a…                    [undo]        │
│ 14:22 pipeline.updateNode ×2    ✓  draft only                            [undo]       │
│ 14:24 assignment.previewPromotion ✓                                                     │
│ 14:26 pipeline.publish         ✓  revision 41d0b7… (needs approval — you approved)    │
│ 14:26 assignment.promoted      ✓  Project A only                                      │
│ explanation: "Reviewer parallelism applies to new Project A runs; the stable channel   │
│ and every other project are unchanged."                                               │
│ [Open revision 41d0b7…] [Open Project A assignment] [Compare beta vs stable later]     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## Assistant state table

| State `⟨T+assistant-state-chip⟩` | Rendered as | Controls available | Source event (`08`) |
|---|---|---|---|
| planning | "planning — <current read>" (progress line, not spinner) | Stop | `assistant.message.delta` |
| asking | "awaiting your answer" | question widget, free text | `assistant.question` |
| proposing typed tool action | proposal card: tool, target ids, before→after, consequences | Apply to draft / Show diff / Dismiss | `assistant.tool.proposed` |
| awaiting approval | amber card + explicit approve/deny | Approve / Deny (with reason) | `assistant.approval.required` |
| executing | "executing 2 of 3 · pipeline.updateNode" | Stop (draft steps only) | `assistant.tool.executing` |
| completed | "completed · <n> actions" + trace links | Undo (draft scope) / Open object | `assistant.tool.completed` |
| failed | danger banner naming the failed tool, the object and the state it left behind ("draft d-19 has 1 of 2 edits") | Retry step / Undo applied / Open in editor | `assistant.tool.completed` with a failure payload |
| navigating/highlighting | ring + caption on the target, "why?" disclosure | Dismiss highlight | `assistant.ui.navigate`, `assistant.ui.focus` |

## Privileged-action matrix

| Action class | Preflight shown | Confirmation | Permission |
|---|---|---|---|
| reads (`project.list`, `pipeline.inspect`, `run.inspect`, `artifact.inspect`) | none | none | user's own scope, enforced server-side |
| draft edits (`pipeline.createDraft/addNode/updateNode/connect/validate/diff`, `nodeTemplate.createDraft`) | diff + undo | none (applied to draft) | contributor on project / draft author |
| publish (`pipeline.publish`) | preview + validation state | explicit | library/publish role (`01` matrix) — same path as the manual UI (`06`) |
| promote (`assignment.previewPromotion` → promote) | affected + pinned counts | explicit, per project | edit-project-assignment |
| run control (`run.pause`, `run.retry`) | target attempt, checkpoint boundary, redo scope (**G5**) | explicit | contributor+ |
| secrets / sandbox policy / push-merge | never by default | explicit, elevated | maintainer/admin (`08`, `01`) |

## Accessibility of the choreography

- Navigation moves focus to the *target*, announced via a polite live region: "Assistant moved you to
  draft d-19 and selected node review." Screen-reader users are never left where they were while the
  page changed under them.
- Highlights have `data-highlight-reason` text and a caption; under `prefers-reduced-motion` the ring
  appears instantly with no pulse and the caption carries the whole meaning (`10`).
- Proposal cards are `role="group"` with the tool name as the accessible name; approve/deny buttons
  are labelled with their object ("Publish revision 41d0b7…"), never a bare "Yes".
- The trace is a real list (`ol`), readable top-to-bottom, each row `time · tool · object · outcome`;
  `/assistant/history` is the same list unfiltered and keyboard-navigable.
- Long-running actions keep a `status` line updated (not a progress bar with a fake percentage).

## What the engineers must fix before this is buildable

1. **G11** — assistant conversation/message/tool/question/approval routes, and an **enumerated
   navigation/focus target vocabulary**; without it `ui.navigate` is an unparseable string.
2. **G1/G13/G21** — publish and promote must be two endpoints with a preview whose response carries
   affected-assignment and pinned-run counts; the whole Act 4 text is built from that response.
3. **G6** — draft mutations must emit `run.override.applied` / auditable mutation records so the trace
   and the timeline agree.
4. **G23** — every assistant read must be project-predicated server-side; the UI cannot filter what it
   is not allowed to see.
5. Assistant events must ride the **same journal/cursor** as everything else (ADR-0016 §1's argument),
   so a reconnect replays the trace instead of losing it.

## Acceptance for this flow (used by `acceptance-checklist.md` §5)

Given the one sentence above, an untrained user must be able to say all of: *where the assistant
looked*, *what it changed*, *what it asked and what I answered*, *what became effective*, *which
project it affected*, and *how to undo or roll back* — without opening a terminal or asking a maintainer.
