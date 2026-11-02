# Communication UI: running handoff

Decisions, leanings and open threads from the design rounds in `Directions.dc.html`. Updated every round. "Leaning" means liked but not final.

## Decided / leaning

- **Repo page** (decided 3a): one mixed activity feed of runs + chats, a chat box at the top, workflows in a side panel showing each trigger (GitHub issue / schedule / by hand) plus its latest result. A run row shows its progress through the steps.
- **Repo view picker**: List / Lanes, remembered per repo. Workflows are not a lane; in Lanes, issues are the first lane ("Backlog") and dragging one into Running starts a workflow (3b).
- **Nav** (decided 2c/3c): one left sidebar, collapsible to a rail of project tiles. No top bar on desktop (3e rejected).
- **Library** is org-level (Workflows, Steps, Agent profiles) and gets its own section, separate from Projects.
- **Project settings / members / add repo** go behind a "⋯" on the project row, not in the tree. Day-to-day nav shows things you can act on.
- **Popovers and menus get a small pointer arrow** toward their trigger.
- **Chats default to a repo.** The project exists for membership/access, not as a working directory.
- **Mid-chat agent switching**: the composer's agent picker sets the agent for the next turn; transcript and branch carry over; a divider marks the switch.
- **Agent mail across repos** (3d): optional, off by default; asked agents are read-only unless a person approves edits.
- **Assistant suggestions are LLM-generated**, not hard-coded rules. They're quiet: one line in a side panel with a link and a dismiss, never a card in the thread.
- **Thread → workflow is assistant-driven** (2f): the assistant drafts steps from the chat and asks structured questions (option buttons). No separate translator screen.
- **Workflow inputs** are defined on the workflow (Inputs tab, 1j); the run-by-hand form is generated from them (1k).

## Open questions

- Name for the home page: Today / Inbox / Overview?
- Icon library to replace Unicode arrows/chevrons: Phosphor, Tabler, or stay on Lucide.
- Assistant notes should be more prominent than drawn in 3a. How prominent?
- Project-wide chats: is there a real case for them, given project-level AGENTS.md / context files wouldn't be committed anywhere?
- How assistant notes surface outside chats (repo panel, Today page, notifications) and how often.

## Not design work (engineering / product)

- **Bug:** `+ use a library workflow` and `+ Add trigger` (RepoWorkflows.tsx) are bare `<button>`s with no pointer cursor; Tailwind v4 dropped the default. Fix: add `button:not(:disabled){cursor:pointer}` to the base layer in tokens.css (or add `cursor-pointer` to each).
- **Workflow inputs schema**: types `github_issue`, `branch`, `agent_profile`, `text`, `long_text`; `required`, `default`, `label`, `help`. Validate at publish: a trigger that can't fill a required input (e.g. a schedule with a required `issue`) is an error or warning.
- **Trigger → input mapping**: an issue trigger fills `issue` with the matched issue. Record the mapping on the trigger.
- **Agent switch mid-thread**: the ACP session changes per turn; carry the transcript as context; same workspace/branch. Capability differences per agent need to be shown.
- **Agent-to-agent messaging across repos** (3d): a tool the agent can call to open or message a chat in another repo of the same project; replies come back into the calling chat. Must respect project membership.
- **Assistant capabilities**: give it tool schemas + examples for rendering structured UI (question cards with options, step lists, draft diffs) so it can drive workflow drafting and suggestions.
- **Drag issue → workflow** (3b) needs an endpoint/flow to start a run with `issue` prefilled and a workflow chosen when several accept an issue.
- **View preference per repo** (List / Lanes) stored in user prefs alongside the existing layout prefs.
