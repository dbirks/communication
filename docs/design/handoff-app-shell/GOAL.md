# Goal for the coding agent

Paste the block below into Claude Code (or your agent) from the root of `dbirks/communication`, with this handoff folder copied into the repo at `docs/design/handoff-app-shell/`.

---

**Goal:** Rebuild the Communication web UI's shell and information architecture to match `docs/design/handoff-app-shell/README.md`, keeping the existing visual identity and `ui/src/components/ds` components. Ship it in small, reviewable phases. Each phase must build, pass existing tests, and leave the app usable.

**Read first:** `AGENTS.md`, `docs/design/design-system.md`, `docs/design/sitemap.md`, `communication-spec/00-product-vision.md`, `communication-spec/01-domain-model.md`, then the handoff README. Open `Rethink - Six Directions.dc.html` in a browser for visual reference. Turns 4–5 are current; earlier turns are history.

**Rules**
- Use the tokens in `ui/src/styles/tokens.css` and the `ds` primitives. No new style system, no hard-coded hex values when a token exists.
- Show only real data. Where a design needs data the backend doesn't provide yet, render an honest empty or “not available yet” state and list the gap in `docs/design/handoff-app-shell/GAPS.md`. Never fake “verified”, “observed” or counts.
- Keep old routes working as redirects.
- Accessibility: keyboard reachable, visible focus (`#dfe4fa` ring), `esc` closes overlays, status always has a glyph and text as well as color.
- After each phase, write a short note in `GAPS.md`: what shipped, what's stubbed, what's next.

**Phases**
1. **Shell.** Replace the top `AppBar` with the left sidebar (Sidebar v3): cross-project nav (Home, Inbox, Board, Threads) → Projects tree (default; switcher as a per-user setting) → Library (Workflows with folders, Steps, Agent profiles) → user footer. Live status flags. SVG chevrons. Persist expand state. Add routes per the README.
2. **Home briefing** (needs you, running now with segmented progress, recent threads) and **Board** (5 state columns, group-by control, filters, right-side run drawer).
3. **Run workbench**: split graph + transcript, iteration tabs, ⤢ full-screen transcript with step strip, take-control confirm flow wired to the existing controller model (stub pause-before-next-step if the backend lacks it, and note it in GAPS).
4. **Library**: Workflows index with folders (no separate Publish step for now; agents push and open PRs themselves with a GitHub token from their profile); Steps page with “used in N workflows”, edit-for-all → new version, duplicate; workflow editor “+ on edge” step picker; new agent step with the profile dropdown (suggested + all + “New profile…”) and “also save as reusable step”.
5. **Agent profiles**: list + detail (sandbox/nono status, account secret ref, APM package contents, used by) and the New profile dialog with 5 agent cards (Claude Code, Codex, Pi, Antigravity, Other ACP) whose readiness comes from launcher registration and probes.
6. **Threads**: one-off thread page with inline permission cards, workspace rail, “Open a draft PR”, and “Hand to a workflow” dialog (stub the backend if needed).
7. **Assistant v2**: global popover (⌘K), page context chip, mic (Web Speech API, transcript is editable before sending), expand to full screen, follow-up questions with model-written option buttons that send plain text back, change chip with undo, and a per-person trust level (Ask before everything / Ask for risky (default) / Don't ask), stored as a user preference and checked in the assistant's tool loop. The assistant calls the API as the user, so existing authorization caps it. Start with read + navigate + draft edits as tools.
8. **Inbox + approvals**: desktop approval detail and a responsive phone inbox. Summaries and action buttons come from a summarization pass that returns `{summary, actions:[{label,intent,risk}]}`; the UI maps risk to button style and always confirms.
9. **Operations** (workers, interrupted callout, agent × capability matrix from probes) and **Settings → Layout/Assistant**.
10. **Later:** assistant tours (spotlight + step cards from `{route, targetSelector, title, body}`).

**Done when:** every screen in Turns 4–5 exists at its route with real data or an honest empty state, `GAPS.md` lists every stub, and a reviewer can do the whole loop in the browser without the old top bar: add a step with a new profile → publish the workflow revision → start a run → approve from the inbox → watch and take control in the workbench → ask the assistant to change the workflow and undo it.
