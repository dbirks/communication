// design.ts — the per-screen DESIGN LANDMARKS the emulator asserts at both
// widths (fixtures.ts `screen()`).
//
// The reflow checks (reflow.ts) prove a screen REFLOWS; they prove nothing
// about whether a screen is the screen its design render drew. This file is
// the structural claim for every captured badge: for `docs/design/handoff-*/
// png/<badge>.png`, which headings, tabs, buttons, sections and fields must be
// on the page at 1280 and at 390.
//
// Landmarks are STRUCTURE, never data. The lab's rows carry real names, counts
// and ids that differ from the mock's invented ones, so a landmark may insist
// that A workflow row has an `Edit` button, but never that the row is called
// `plan-with-approval`; it may insist the Used in panel says `pinned r<n>`,
// never which revision. Specs therefore address elements by testid, by
// role+name regex, or by a text regex over the copy the design itself owns
// (labels, empty-state sentences) — never by a value the server serves.
//
// A landmark is satisfied when ANY of its `any` specs matches an element that
// is rendered (non-zero box, not `display:none`/`visibility:hidden`) inside
// `<main>` or an open dialog; being scrolled out of view is fine, because the
// screen's own full-page screenshot shows it. `only` narrows a landmark to one
// width when the 1280 design shows it and the documented 390 reflow replaces
// it — but prefer one landmark whose `any` carries BOTH forms (the 1280 list
// pane and its 390 `← Threads` back link), which is the reflow rule stated as
// a landmark: the content is there, or the one tap that reaches it is.
//
// A badge with a design render and no entry here is itself a defect
// (`no landmarks defined`), so coverage of a new screen cannot lapse silently.
// Screens with no design render at all (`run-gate`, `artifact`) are exempt.
import type { Locator, Page } from "@playwright/test";

/** How a landmark may address an element. */
export type LandmarkSpec =
  /** `[data-testid=…]`; `current` additionally requires `aria-current="page"`,
   * which is how this app marks the active tab (tabs are routes, not widgets).
   * A trailing `*` matches any testid that STARTS with the rest — the ids the
   * server names (`workflow-folder-header-delivery`, `workflow-row-<slug>`),
   * whose tail is data. Same selector shape the journeys use
   * (`[data-testid^="workflow-folder-header-"]`). `except` drops named exact
   * ids from that prefix, for the case where one sibling of the family is NOT
   * the thing the design claims (a prefix that matches it too would let the
   * landmark pass on that element alone). */
  | { testid: string; current?: boolean; except?: string[] }
  /** An accessible role, optionally with a name regex (or an exact string) and
   * a heading level. */
  | { role: string; name?: RegExp | string; level?: number }
  /** Text the DESIGN owns (a label, an empty-state sentence) — never data. */
  | { text: RegExp };

/** One structural claim about one screen. */
export interface Landmark {
  /** Stable short key (used to dedupe a miss recorded at both widths). */
  id: string;
  /** What a person reading the report learns is missing. */
  desc: string;
  /** Satisfied when ANY of these matches a rendered element. */
  any: LandmarkSpec[];
  /** Narrow to one width when the documented 390 reflow replaces this part. */
  only?: 1280 | 390;
  /**
   * Where to search. Default: `<main>` plus open dialogs. `"page"` widens to
   * the whole document — the claim an app-SHELL screen needs (the 2c/3c
   * sidebar column, the assistant popover) since the shell lives OUTSIDE
   * `<main>` and only its flyouts are dialogs. Used by nothing else, so the
   * per-page landmark lists keep their strict main-scoped reading.
   */
  host?: "page";
}

/* ------------------------------------------------------------------ shared */

/** A server error the screen must own: the app's one honest failure surface is
 * an `Alert`/ProblemBanner with `role=alert` quoting the problem document. */
const ERROR_PANEL: Landmark = {
  id: "error-panel",
  desc: "the error panel quoting the server's problem",
  any: [{ role: "alert" }],
};

/** The Workflows index header (1b): H1 + the two authoring verbs. */
const INDEX_HEADING: Landmark = {
  id: "index-heading",
  desc: "the 'Workflows' page heading",
  any: [{ role: "heading", level: 1, name: /^Workflows$/ }],
};
const INDEX_NEW: Landmark = {
  id: "index-new-workflow",
  desc: "the 'New workflow' primary action",
  any: [{ testid: "workflows-new-workflow" }],
};
const INDEX_IMPORT: Landmark = {
  id: "index-import-yaml",
  desc: "the 'Import YAML' action",
  any: [{ testid: "workflows-import-yaml" }],
};
const INDEX_START_BLANK: Landmark = {
  id: "index-starter-blank",
  desc: "the START BLANK card ('Empty canvas')",
  any: [
    { testid: "workflow-starter-blank" },
    { testid: "workflow-starters" },
    { text: /^Empty canvas$/ },
  ],
};
const INDEX_STARTER_TEMPLATE: Landmark = {
  id: "index-starter-template",
  desc: "at least one template starter card above the list",
  any: [
    { testid: "workflow-starter-plan-with-approval" },
    { testid: "workflow-starter-security-review" },
    { testid: "workflow-starter-issue-to-pr" },
  ],
};
const INDEX_SEARCH: Landmark = {
  id: "index-search",
  desc: "the 'Search workflows' field",
  any: [{ testid: "workflows-search" }, { role: "textbox", name: /search workflows/i }],
};
const INDEX_CHIP_ALL: Landmark = {
  id: "index-chip-all",
  desc: "the 'all' filter chip",
  any: [{ testid: "workflows-filter-all" }, { role: "button", name: /^all$/ }],
};
const INDEX_CHIP_DRAFT: Landmark = {
  id: "index-chip-draft",
  desc: "the 'has open draft' filter chip",
  any: [{ testid: "workflows-filter-draft" }, { role: "button", name: /has open draft/i }],
};
// The design's third chip — `used in <project>` — is deliberately NOT a
// landmark: it renders only for a viewer whose projects actually pin a library
// workflow (a membership fact, not a screen fact), so asserting it would prove
// who signed in rather than what the screen draws.
const INDEX_LIST: Landmark = {
  id: "index-list",
  desc: "the workflow list (folder groups or the flat list)",
  any: [{ testid: "workflows-list" }],
};
const INDEX_ROW_EDIT: Landmark = {
  id: "index-row-edit",
  desc: "a workflow row's 'Edit' action",
  any: [{ role: "button", name: /^Edit$/ }],
};
const INDEX_ROW_MENU: Landmark = {
  id: "index-row-menu",
  desc: "a workflow row's '…' row-menu button",
  any: [{ role: "button", name: /^⋯$/ }, { text: /^⋯$/ }],
};
/** Design 1b: a folder is a PANEL, headed by its own collapse toggle — the
 * SVG chevron, the group's name in mono caps, and the group's own count on the
 * right. The header's testid carries the folder's slug (`workflow-folder-
 * header-delivery`), so the id's tail is data and only its head is asserted;
 * the header's text (name + count) is what the `1b folders` journey step
 * asserts, on the folder this pass just filed a workflow into.
 *
 * `Unfiled` is a group like any other (design 1b), so its header —
 * `workflow-folder-header-unfiled` — shares this prefix. `except` cuts it out:
 * the claim is about a FOLDER the server named, and a screen whose only group
 * was Unfiled must not satisfy it. The pass's own folder is named in the
 * journey step (`folderHeaderFor` in journeys.spec.ts), which addresses that
 * header by its exact testid. */
const INDEX_FOLDER_HEADER: Landmark = {
  id: "index-folder-header",
  desc: "a named folder panel's header — the group's name in caps and its count on the collapse toggle",
  any: [{ testid: "workflow-folder-header-*", except: ["workflow-folder-header-unfiled"] }],
};
/** A workflow row drawn under a folder. The landmark matcher asks only whether
 * something renders (fixtures.ts `missingLandmarks` has no notion of
 * containment), so this proves the row is on the folder view; the journey step
 * proves it sits INSIDE that folder's panel and not in the unfiled list. */
const INDEX_FOLDER_ROW: Landmark = {
  id: "index-folder-row",
  desc: "a workflow row on the folder-panel view (design 1b files rows inside their folder)",
  any: [{ testid: "workflow-row-*" }],
};
const INDEX_NO_MATCH: Landmark = {
  id: "index-no-match",
  desc: "the honest no-match line for a filter that finds nothing",
  any: [{ testid: "workflows-empty" }, { text: /no workflow matches/i }],
};

/** The New workflow dialog (1c). */
const NW_TITLE: Landmark = {
  id: "new-dialog-title",
  desc: "the 'New workflow' dialog title",
  any: [{ role: "heading", name: /^New workflow$/ }],
};
const NW_NAME: Landmark = {
  id: "new-dialog-name",
  desc: "the NAME field",
  any: [{ testid: "library-new-name-input" }, { text: /^NAME$/ }],
};
const NW_ID_LINE: Landmark = {
  id: "new-dialog-id-line",
  desc: "the generated `id:` line under the name",
  any: [{ testid: "new-workflow-id-line" }, { text: /^id:/ }],
};
const NW_ID_CHANGE: Landmark = {
  id: "new-dialog-id-change",
  desc: "the 'change' control on the id line",
  any: [{ testid: "new-workflow-id-change" }, { role: "button", name: /^change$/i }],
};
const NW_START_FROM: Landmark = {
  id: "new-dialog-start-from",
  desc: "the START FROM options",
  any: [{ testid: "library-new-template-select" }, { text: /^START FROM$/ }],
};
const NW_BLANK: Landmark = {
  id: "new-dialog-blank",
  desc: "the 'Blank' start-from option",
  any: [{ testid: "new-workflow-template-blank" }, { text: /^Blank$/ }],
};
const NW_FOLDER: Landmark = {
  id: "new-dialog-folder",
  desc: "the FOLDER select",
  any: [{ testid: "new-workflow-folder" }, { text: /^FOLDER$/ }],
};
const NW_CANCEL: Landmark = {
  id: "new-dialog-cancel",
  desc: "the dialog's 'Cancel' action",
  any: [{ testid: "new-workflow-cancel" }, { role: "button", name: /^Cancel$/ }],
};
const NW_SUBMIT: Landmark = {
  id: "new-dialog-submit",
  desc: "the 'Create and open canvas' action",
  any: [{ testid: "library-new-submit" }, { role: "button", name: /create and open canvas/i }],
};

/** The workflow page header and tabs (1e, 2a, 2d). */
const WF_BREADCRUMB: Landmark = {
  id: "workflow-breadcrumb",
  desc: "the 'Workflows' breadcrumb above the title",
  any: [{ testid: "workflow-breadcrumb" }],
};
const WF_TITLE: Landmark = {
  id: "workflow-title",
  desc: "the workflow's own title (an H1 — its name is data, its being a title is not)",
  any: [{ role: "heading", level: 1 }],
};
const WF_REVISION_CHIP: Landmark = {
  id: "workflow-revision-chip",
  desc: "the revision/published chip beside the title",
  any: [{ testid: "workflow-revision-chip" }],
};
const WF_TABS: Landmark = {
  id: "workflow-tabs",
  desc: "the tab row (Overview / YAML / Used in / History)",
  any: [{ testid: "workflow-tabs" }],
};
const WF_TAB_OVERVIEW: Landmark = {
  id: "workflow-tab-overview",
  desc: "the Overview tab",
  any: [{ testid: "workflow-tab-overview" }],
};
const WF_TAB_YAML: Landmark = {
  id: "workflow-tab-yaml",
  desc: "the YAML tab",
  any: [{ testid: "workflow-tab-yaml" }],
};
const WF_TAB_YAML_ACTIVE: Landmark = {
  id: "workflow-tab-yaml-active",
  desc: "the YAML tab shown as the page you are on",
  any: [{ testid: "workflow-tab-yaml", current: true }],
};
const WF_TAB_USED_IN: Landmark = {
  id: "workflow-tab-used-in",
  desc: "the Used in tab",
  any: [{ testid: "workflow-tab-used-in" }],
};
const WF_TAB_USED_IN_ACTIVE: Landmark = {
  id: "workflow-tab-used-in-active",
  desc: "the Used in tab shown as the page you are on",
  any: [{ testid: "workflow-tab-used-in", current: true }],
};
const WF_TAB_HISTORY: Landmark = {
  id: "workflow-tab-history",
  desc: "the History tab",
  any: [{ testid: "workflow-tab-history" }],
};
const WF_USE_IN_REPO: Landmark = {
  id: "workflow-use-in-repo",
  desc: "the 'Use in a repo…' action",
  any: [{ testid: "assign-open" }, { role: "button", name: /use in a repo/i }],
};
// The design's second header verb, `Edit workflow`, is NOT a landmark: it is an
// authoring control, so the app hides it from a reader without the library role
// (the same permission fact that makes the index's `used in <project>` chip
// conditional), and the 1e/2a/2d screens are captured as a project member who
// reads the library rather than writing it.

/** The 1e overview: the read-only graph and its three rail sections. */
const WF_GRAPH: Landmark = {
  id: "workflow-graph",
  desc: "the read-only step graph",
  any: [{ testid: "overview-canvas" }, { testid: "workflow-graph" }],
};
const WF_RAIL_USED_IN: Landmark = {
  id: "workflow-rail-used-in",
  desc: "the rail's USED IN section",
  any: [{ testid: "overview-used-in" }, { text: /^USED IN$/ }],
};
const WF_RAIL_INPUTS: Landmark = {
  id: "workflow-rail-inputs",
  desc: "the rail's INPUTS section",
  any: [{ testid: "overview-inputs" }, { text: /^INPUTS$/ }],
};
const WF_RAIL_RUNS: Landmark = {
  id: "workflow-rail-runs",
  desc: "the rail's LAST RUNS section",
  any: [{ testid: "overview-runs" }, { text: /^LAST RUNS$/ }],
};
/** The failure states of the workflow page (1e not-found / server-error). */
const WF_FAILED_HEADING: Landmark = {
  id: "workflow-failed-heading",
  desc: "the page heading that stands over a failed workflow read",
  any: [{ role: "heading", level: 1, name: /^Workflow$/ }],
};
const WF_FAILED_BANNER: Landmark = {
  id: "workflow-failed-banner",
  desc: "the error panel quoting the server",
  any: [{ testid: "pipeline-page-failure" }, { role: "alert" }],
};
const WF_BACK: Landmark = {
  id: "workflow-back",
  desc: "the way back to the workflow list",
  any: [{ testid: "workflow-back-to-list" }, { role: "link", name: /back to workflows/i }],
};
const WF_RETRY: Landmark = {
  id: "workflow-retry",
  desc: "the Retry the design offers on a server error",
  any: [{ testid: "workflow-load-retry" }, { role: "button", name: /^Retry$/i }],
};

/** The Studio (1g) — header, palette, canvas, inspector, assistant, status bar. */
const STUDIO_BREADCRUMB: Landmark = {
  id: "studio-breadcrumb",
  desc: "the 'Workflows / …' breadcrumb",
  any: [{ testid: "studio-breadcrumb" }],
};
const STUDIO_TITLE: Landmark = {
  id: "studio-title",
  desc: "the draft's title (the H1 — the name is data, its being a title is not)",
  any: [{ testid: "studio-title" }, { role: "heading", level: 1 }],
};
const STUDIO_DRAFT_CHIP: Landmark = {
  id: "studio-draft-chip",
  desc: "the draft chip (v · saved/unsaved) beside the title",
  any: [{ testid: "studio-draft-version" }],
};
const STUDIO_VIEW_TOGGLE: Landmark = {
  id: "studio-view-toggle",
  desc: "the Canvas | YAML view control",
  any: [{ testid: "studio-view-canvas" }],
};
const STUDIO_UNDO: Landmark = {
  id: "studio-undo",
  desc: "the undo control",
  any: [{ testid: "studio-undo" }, { role: "button", name: /^undo$/i }],
};
const STUDIO_REDO: Landmark = {
  id: "studio-redo",
  desc: "the redo control",
  any: [{ testid: "studio-redo" }, { role: "button", name: /^redo$/i }],
};
const STUDIO_VALIDATE: Landmark = {
  id: "studio-validate",
  desc: "the Validate action",
  any: [{ testid: "studio-validate" }, { role: "button", name: /^validate/i }],
};
const STUDIO_SAVE: Landmark = {
  id: "studio-save",
  desc: "the Save action",
  any: [{ testid: "studio-save" }, { role: "button", name: /^save$/i }],
};
const STUDIO_PUBLISH: Landmark = {
  id: "studio-publish",
  desc: "the Publish action (shown even while the draft cannot publish)",
  any: [{ testid: "studio-publish" }, { role: "button", name: /^publish$/i }],
};
const STUDIO_PALETTE_ADD: Landmark = {
  id: "studio-palette-add",
  desc: "the palette's ADD A STEP label",
  any: [{ testid: "palette-heading-add" }, { text: /^ADD A STEP$/i }],
};
const STUDIO_PALETTE_SEARCH: Landmark = {
  id: "studio-palette-search",
  desc: "the palette's search field",
  any: [{ testid: "palette-search" }, { role: "textbox", name: /search steps/i }],
};
const STUDIO_KIND_AGENT: Landmark = {
  id: "studio-kind-agent",
  desc: "the Agent row in the palette",
  any: [{ testid: "palette-item-agent.acp" }, { role: "button", name: /agent\.acp/i }],
};
const STUDIO_KIND_MODEL: Landmark = {
  id: "studio-kind-model",
  desc: "the Model row in the palette",
  any: [{ testid: "palette-item-model.chat" }, { role: "button", name: /model\.chat/i }],
};
const STUDIO_KIND_COMMAND: Landmark = {
  id: "studio-kind-command",
  desc: "the Command row in the palette",
  any: [{ testid: "palette-item-process.exec" }, { role: "button", name: /process\.exec/i }],
};
const STUDIO_KIND_APPROVAL: Landmark = {
  id: "studio-kind-approval",
  desc: "the Approval row in the palette",
  any: [{ testid: "palette-item-human.approval" }, { role: "button", name: /human\.approval/i }],
};
const STUDIO_WRAP_HEADING: Landmark = {
  id: "studio-wrap-heading",
  desc: "the palette's WRAP STEPS group",
  any: [{ testid: "palette-heading-group-wrap-steps" }, { text: /^WRAP STEPS$/i }],
};
const STUDIO_WRAP_UNTIL: Landmark = {
  id: "studio-wrap-until",
  desc: "the 'Repeat until' wrapper row",
  any: [{ testid: "palette-item-until" }, { role: "button", name: /repeat until/i }],
};
const STUDIO_WRAP_FOREACH: Landmark = {
  id: "studio-wrap-foreach",
  desc: "the 'For each' wrapper row",
  any: [{ testid: "palette-item-for_each" }, { role: "button", name: /for each/i }],
};
const STUDIO_CANVAS: Landmark = {
  id: "studio-canvas",
  desc: "the step canvas",
  any: [{ testid: "studio-canvas" }, { testid: "canvas-chrome" }],
};
const STUDIO_INSPECTOR: Landmark = {
  id: "studio-inspector",
  desc: "the inspector column (the document panel, or the selected step's card)",
  any: [{ testid: "insp-pipeline" }, { testid: "insp-node" }],
};
const STUDIO_ASSISTANT: Landmark = {
  id: "studio-assistant",
  desc: "the 'Ask to change this draft…' box",
  any: [
    { testid: "assistant-proposal-footer" },
    { testid: "assistant-proposal-box" },
    { role: "button", name: /ask to change this draft/i },
  ],
};
const STUDIO_STATUS_BAR: Landmark = {
  id: "studio-status-bar",
  desc: "the status bar under the canvas",
  any: [{ testid: "studio-status-bar" }, { testid: "studio-status-bar-summary" }],
};
/** The selected step's inspector fields (1g's inspector-edit beat). */
const STUDIO_NODE_CARD: Landmark = {
  id: "studio-inspector-node",
  desc: "the selected step's inspector card",
  any: [{ testid: "insp-node" }, { testid: "insp-header" }],
};
const STUDIO_NODE_WHERE: Landmark = {
  id: "studio-inspector-where",
  desc: "the inspector's `kind · after <step>` line",
  any: [{ testid: "insp-after" }],
};
const STUDIO_NODE_PROMPT: Landmark = {
  id: "studio-inspector-prompt",
  desc: "the selected step's prompt field",
  any: [{ testid: "insp-config-task" }, { testid: "insp-config-prompt" }, { testid: "insp-node" }],
};
const STUDIO_NODE_ADVANCED: Landmark = {
  id: "studio-inspector-advanced",
  desc: "the inspector's advanced-fields disclosure",
  any: [{ testid: "insp-advanced-disclosure" }, { role: "button", name: /retries, timeout/i }],
};
const STUDIO_DRAFT_ERROR: Landmark = {
  id: "studio-draft-error",
  desc: "the panel that says the draft could not be read",
  any: [{ testid: "studio-draft-error" }, { role: "alert" }],
};
/** The failed draft read (issue #23): the Studio stays a Studio —
 * `studio-error-page` keeps the `Workflows / …` breadcrumb and an H1 named only
 * from what the reads answered (the pipeline's title, else `Workflow draft`) and
 * puts the ProblemBanner with its Retry underneath. The landmark therefore asks
 * for the H1, or either half of that header; `studio-page` — the frame the loaded
 * Studio draws — stays as the alternate so the claim is one heading standing over
 * the page, whichever frame is carrying it. */
const STUDIO_ERROR_HEADING: Landmark = {
  id: "studio-error-heading",
  desc: "the page heading that stands over a failed draft read",
  any: [{ role: "heading", level: 1 }, { testid: "studio-page" }, { testid: "studio-breadcrumb" }],
};

/** Used in (2a). */
const USED_IN_PANEL: Landmark = {
  id: "used-in-panel",
  // A count only speaks when a read ANSWERED it (pass-7 review, 2a
  // server-error): a failed or still-pending read says the bare `USED IN`
  // beside the shared `Couldn't load …` block — the `?` the pass-2 review left
  // there was still a value sitting in a number's seat — and one repository is
  // one `REPO`.
  desc: "the USED IN panel (a count only when a read answered it; `USED IN` alone when one broke)",
  any: [{ testid: "used-in" }, { role: "heading", name: /^USED IN(\s+\d+\s+REPOS?)?$/i }],
};
const USED_IN_EMPTY: Landmark = {
  id: "used-in-empty",
  desc: "the honest 'not used in any repo yet' line",
  any: [{ testid: "used-in-empty" }, { text: /not used in any repo yet/i }],
};
const USED_IN_LIST: Landmark = {
  id: "used-in-list",
  desc: "the list of repos that use this workflow",
  any: [{ testid: "used-in-list" }],
};
const USED_IN_PIN: Landmark = {
  id: "used-in-pin",
  desc: "a row's pinned-revision line (`pinned r<n>` — the number is data)",
  any: [{ text: /^pinned r/i }],
};
const USED_IN_OPEN: Landmark = {
  id: "used-in-open",
  desc: "a row's 'Open ›' link to the repo page",
  any: [{ role: "link", name: /^Open ›$/ }, { text: /^Open ›$/ }],
};
const USED_IN_FOOTNOTE: Landmark = {
  id: "used-in-footnote",
  desc: "the footnote saying where triggers are edited",
  any: [{ testid: "used-in-footnote" }, { text: /goes to the repo page/i }],
};
const USED_IN_ERROR: Landmark = {
  id: "used-in-error",
  desc: "the load-failure block saying the uses could not all be read",
  any: [{ testid: "used-in-error" }, { role: "alert" }, { text: /could not all be read/i }],
};
/** The Use in a repo… dialog (2a's dialog beat). */
const USE_DIALOG: Landmark = {
  id: "use-dialog",
  desc: "the 'Use in a repo…' dialog",
  any: [{ testid: "use-in-repo-dialog" }, { role: "dialog" }],
};
const USE_DIALOG_TITLE: Landmark = {
  id: "use-dialog-title",
  // The 1c rule (the title says what the verb will do) AND the 2a item-7 fix of
  // 2026-10-30 (the title names its SUBJECT): `Use <workflow> in a repo…`
  // until a repo is chosen, then `Use <workflow> in <repo>` / `Use <workflow>
  // in every repo of <project>` — the same heading, whichever stage it is at.
  desc: "the dialog's title (the workflow's name in the question, then the repo it names)",
  any: [{ testid: "use-in-repo-title" }, { role: "heading", name: /^use\b/i }],
};
const USE_FORM: Landmark = {
  id: "use-dialog-form",
  desc: "the pin form",
  any: [{ testid: "assign-form" }],
};
const USE_PIN_LINE: Landmark = {
  id: "use-dialog-pin-line",
  desc: "the line saying which revision the pin chooses",
  any: [{ testid: "assign-pin-line" }],
};
const USE_PROJECT: Landmark = {
  id: "use-dialog-project",
  desc: "the project select — the dialog's ONE way to choose a project",
  any: [{ testid: "assign-project-select" }, { role: "combobox", name: /project/i }],
};
/** The dialog's one repo choice (design 2a, pass-2 review): the per-row
 * `Use here` button was retired, so the repository select the project select
 * reveals is the only way to name a repo. */
const USE_REPO: Landmark = {
  id: "use-dialog-repo",
  desc: "the repository select the chosen project reveals (one repo, or the whole project)",
  any: [{ testid: "assign-repo-select" }, { role: "combobox", name: /repositor/i }],
};
const USE_CEILING: Landmark = {
  id: "use-dialog-ceiling",
  desc: "the max-concurrent-runs field",
  any: [{ testid: "assign-ceiling" }, { role: "spinbutton" }],
};
const USE_CONFIRM: Landmark = {
  id: "use-dialog-confirm",
  desc: "the confirm action",
  any: [{ testid: "assign-confirm" }, { role: "button", name: /^(confirm|using…)$/i }],
};
const USE_CANCEL: Landmark = {
  id: "use-dialog-cancel",
  desc: "the cancel action",
  any: [{ testid: "assign-cancel" }, { role: "button", name: /^cancel$/i }],
};

/** The trigger dialog (2c). */
const TRIG_DIALOG: Landmark = {
  id: "trigger-dialog",
  desc: "the trigger dialog",
  any: [{ testid: "trigger-dialog" }, { role: "dialog" }],
};
const TRIG_TITLE: Landmark = {
  id: "trigger-title",
  desc: "the 'Add a trigger' title",
  any: [{ role: "heading", name: /^Add a trigger$/i }, { testid: "trigger-dialog" }],
};
const TRIG_MODE: Landmark = {
  id: "trigger-mode",
  desc: "the START IT WHEN control",
  any: [{ testid: "trigger-dialog-mode" }, { text: /^START IT WHEN$/i }],
};
const TRIG_MODE_ISSUE: Landmark = {
  id: "trigger-mode-issue",
  desc: "the 'A GitHub issue…' segment",
  any: [{ testid: "trigger-dialog-mode-issue" }, { role: "button", name: /github issue/i }],
};
const TRIG_MODE_SCHEDULE: Landmark = {
  id: "trigger-mode-schedule",
  desc: "the 'On a schedule' segment",
  any: [{ testid: "trigger-dialog-mode-schedule" }, { role: "button", name: /on a schedule/i }],
};
const TRIG_EVENT: Landmark = {
  id: "trigger-event",
  desc: "the issue 'IS' select",
  any: [{ testid: "trigger-dialog-event" }, { text: /^IS$/i }],
};
const TRIG_LABELS: Landmark = {
  id: "trigger-labels",
  desc: "the issue labels field",
  any: [{ testid: "trigger-dialog-labels" }, { text: /with any of these labels/i }],
};
const TRIG_CRON: Landmark = {
  id: "trigger-cron",
  desc: "the cron field",
  any: [{ testid: "trigger-dialog-cron" }],
};
const TRIG_CRON_WORDS: Landmark = {
  id: "trigger-cron-words",
  desc: "the cron field's English reading",
  any: [{ testid: "trigger-dialog-cron-words" }],
};
const TRIG_RUN_GETS: Landmark = {
  id: "trigger-run-gets",
  desc: "the 'THE RUN GETS' box",
  any: [{ testid: "trigger-dialog-run-gets" }, { text: /^THE RUN GETS$/i }],
};
const TRIG_GOAL: Landmark = {
  id: "trigger-run-goal",
  desc: "the run's `goal` input in THE RUN GETS",
  any: [{ testid: "new-run-input-goal" }],
};
const TRIG_CANCEL: Landmark = {
  id: "trigger-cancel",
  desc: "the dialog's Cancel action",
  any: [{ testid: "trigger-dialog-cancel" }, { role: "button", name: /^cancel$/i }],
};
const TRIG_ENABLED: Landmark = {
  id: "trigger-enabled",
  // design 3a: the edit dialog carries the trigger's pause — the Active/
  // Paused switch that succeeds the retired inline switch, saved through the
  // same PATCH the Save verb spends.
  desc: "the edit dialog's Active/Paused switch",
  any: [{ testid: "trigger-dialog-enabled" }, { role: "switch" }],
};
const TRIG_SUBMIT: Landmark = {
  id: "trigger-submit",
  desc: "the dialog's 'Add trigger' action",
  // One verb for both arms: the schedule dialog's primary button reads
  // `Add trigger` too (was `Add schedule`), and the pending word is `Saving…`.
  any: [
    { testid: "trigger-dialog-submit" },
    { role: "button", name: /^(add trigger|save trigger|saving…)$/i },
  ],
};
/** The YAML tab (2d). */
const YAML_FRAME: Landmark = {
  id: "yaml-frame",
  desc: "the YAML tab's own frame",
  any: [{ testid: "workflow-yaml-tab" }],
};
const YAML_REVISION: Landmark = {
  id: "yaml-revision-select",
  desc: "the revision select",
  any: [{ testid: "yaml-revision-select" }, { role: "combobox", name: /revision/i }],
};
const YAML_TEXT: Landmark = {
  id: "yaml-text",
  desc: "the YAML itself",
  any: [{ testid: "yaml-view" }, { testid: "yaml-empty" }],
};
const YAML_COPY: Landmark = {
  id: "yaml-copy",
  desc: "the Copy control",
  any: [{ testid: "yaml-view-copy" }, { role: "button", name: /^(copy|copied)$/i }],
};
const YAML_DOWNLOAD: Landmark = {
  id: "yaml-download",
  // The 390px design check: the button's LABEL is the plain word `Download`
  // (2d item 3, 2026-10-30 copy review: `Copy` and `Download` are one case and
  // one size) and the file's name is its title/accessible description — the old
  // `<slug>-r<n>.yaml` label was cut to `…-r1.ya…` on the bar.
  desc: "the 'Download' control (the file's name is its title, not its label)",
  any: [{ testid: "yaml-view-download" }, { role: "button", name: /^download\b/i }],
};
const YAML_LINES: Landmark = {
  id: "yaml-line-numbers",
  desc: "the line-numbered gutter",
  any: [{ testid: "yaml-view-line-1" }, { testid: "yaml-view" }],
};
const YAML_ERROR: Landmark = {
  id: "yaml-error",
  desc: "the panel quoting the server for a revision that cannot be read",
  any: [{ role: "alert" }],
};

/** The repository page (2e from Workflows Review, repo-1e from Projects
 * Review — the same route, so the parts both designs draw are shared). */
const REPO_PAGE: Landmark = {
  id: "repo-page",
  desc: "the repository page frame",
  any: [{ testid: "repo-page" }],
};
const REPO_HEADING: Landmark = {
  id: "repo-heading",
  desc: "the repository's own title (the H1 — its name is data)",
  any: [{ testid: "repo-name" }, { role: "heading", level: 1 }],
};
const REPO_CHAT_BOX: Landmark = {
  id: "repo-chat-box",
  // design 3a (handoff-repo-chat-nav): the header's `New thread here` +
  // `Start run` pair retires — the page's one line to start work is the
  // chat box: an input whose label names the repository, the profile chip
  // and `Start` (repo-chat-start, ADR-0067). A run is started from the
  // WORKFLOWS row's `Run` (REPO_ROW_RUN).
  desc: "the 'Chat in <repo>…' box with its Start verb (design 3a)",
  any: [
    { testid: "repo-chat-box" },
    { testid: "repo-chat-start" },
    { role: "textbox", name: /^chat in /i },
  ],
};
const REPO_WORKFLOWS_PANEL: Landmark = {
  id: "repo-workflows-panel",
  // repo-chain-r4 drew it as `WORKFLOWS ON THIS REPO · n`; design 3a
  // (handoff-repo-chat-nav) shortens the side panel's bar to `WORKFLOWS · n`.
  // The testid is the stable hook; the heading regex carries both names (the
  // count is data).
  desc: "the WORKFLOWS panel of the repo page",
  any: [{ testid: "repo-workflows" }, { role: "heading", name: /^WORKFLOWS/i }],
};
const REPO_LIBRARY_LINK: Landmark = {
  id: "repo-use-library-workflow",
  desc: "the panel's 'use a library workflow' control",
  any: [{ testid: "repo-workflow-library" }],
};
const REPO_ROW_MENU: Landmark = {
  id: "repo-row-menu",
  // design 3a (handoff-repo-chat-nav): the inline STARTS WHEN box and its
  // `+ Add trigger` leave the repo page. Each workflow row carries a `⋯`
  // menu instead — `Add trigger…` plus one `Edit <trigger>` item per trigger
  // — and that menu is the row's only door to the trigger dialog (2c).
  desc: "the workflow row's ⋯ triggers menu (3a's door to add/edit/pause)",
  any: [
    { testid: "repo-workflow-menu-*" },
    { role: "button", name: /\+ add trigger$/i },
    { text: /^\+ (Add trigger|use workflow)/i },
  ],
};
// 2e.png drew a workflow row with `+ Add trigger` and `Run`, and the row's
// `Edit` was never a landmark of its own. From 3a the row's verbs are `Run`
// (REPO_ROW_RUN) and the `⋯` menu (REPO_ROW_MENU); the per-trigger `Edit`
// lives inside that menu as a `menuitem`, so the old REPO_TRIGGER_EDIT (the
// STARTS WHEN rows' `Edit` BUTTON) has no repo-page carrier any more.
const REPO_ROW_RUN: Landmark = {
  id: "repo-row-run",
  desc: "a workflow row's 'Run' action",
  any: [{ testid: "repo-workflow-run-*" }, { role: "button", name: /^Run$/i }],
};
const REPO_WORKFLOWS_EMPTY: Landmark = {
  id: "repo-workflows-empty",
  desc: "the honest 'this repo uses no workflow yet' line",
  any: [{ testid: "repo-workflows-empty" }],
};
const REPO_TRIGGER_LINE: Landmark = {
  id: "repo-trigger-line",
  // 3a: the row's ONE trigger line lists every trigger of the assignment
  // (`GitHub · issue labeled … · Schedule · every minute`, or `By hand`) —
  // what the STARTS WHEN box drew as rows, the line now says in mono.
  desc: "the workflow row's trigger line listing its triggers",
  any: [{ testid: "repo-workflow-triggers-*" }],
};
const REPO_TRIGGER_PAUSED: Landmark = {
  id: "repo-trigger-paused",
  // A paused trigger keeps its words and ends in ` · paused` — the same word
  // the dialog's switch shows, since the dialog is where a trigger is paused
  // now (3a; the inline switch retired with the STARTS WHEN boxes).
  desc: "the paused state named on the row's trigger line",
  any: [{ text: /·\s*paused/i }],
};
const REPO_ISSUES_PANEL: Landmark = {
  id: "repo-issues-panel",
  desc: "the OPEN ISSUES panel",
  any: [{ testid: "repo-issues" }, { role: "heading", name: /^OPEN ISSUES/i }],
};
const REPO_ACTIVITY: Landmark = {
  id: "repo-activity",
  // design 3a (handoff-repo-chat-nav): WORK IN THIS REPO retires — the
  // successor is the ACTIVITY list: runs and chats mixed in ONE panel
  // under the filter chips, newest first.
  desc: "the activity list (runs and chats mixed) that replaced WORK IN THIS REPO",
  any: [{ testid: "repo-activity" }, { role: "group", name: /filter activity/i }],
};
const REPO_RUNS_PANEL: Landmark = {
  id: "repo-recent-runs-panel",
  // design 3a: the runs panel is the activity feed's own box now (`repo-runs`
  // is the panel under the filter chips); the heading word `RECENT RUNS` went
  // with the old right column, so the testid carries the landmark.
  desc: "the runs panel (3a: the activity feed's box)",
  any: [{ testid: "repo-runs" }, { role: "heading", name: /^RECENT RUNS/i }],
};
/** The repository page's failed reads. `repo-1e not-found` says so inside the
 * `repo-page` frame, and since issue #24 so does the failed repositories read:
 * `repo-error-page` keeps the project breadcrumb and the page's own H1
 * (`Repository` — the repository's name is exactly what the failed read cannot
 * answer) above the ProblemBanner and its Retry. Any of the H1, the not-found
 * frame, or the loaded page's `repo-header` is a heading standing over the
 * banner, which is the claim; the failure screen's own `repo-error-header` is not
 * named here because the H1 spec already matches it. */
const REPO_FAILED_HEADING: Landmark = {
  id: "repo-failed-heading",
  desc: "the page heading that stands over a failed repository read",
  any: [{ role: "heading", level: 1 }, { testid: "repo-page" }, { testid: "repo-header" }],
};
const REPO_NOT_FOUND: Landmark = {
  id: "repo-not-found",
  desc: "the honest 'repository not found' line",
  any: [{ testid: "repo-not-found" }, { text: /repository not found/i }],
};

/** The run view the schedule-fired run lands on (2e's decided-gate beat). */
const RUN_PAGE: Landmark = {
  id: "run-page",
  desc: "the run workbench frame",
  any: [{ testid: "workbench" }],
};
const RUN_TITLE: Landmark = {
  id: "run-title",
  desc: "the run's header title",
  any: [{ testid: "run-title" }, { testid: "run-header-title" }, { role: "heading", level: 1 }],
};
// The step chain is not a landmark of its own: the workbench draws the steps
// THROUGH the graph (or its tree/timeline views), and the strip
// (`workbench-step-strip`) belongs to the full-screen transcript mode, which no
// journey captures. `RUN_GRAPH` is the design's "what step is it on" surface.
const RUN_GRAPH: Landmark = {
  id: "run-graph",
  desc: "the run's graph/tree view",
  any: [
    { testid: "definition-graph" },
    { testid: "workbench-graph-view" },
    { testid: "workbench-tree-view" },
    { testid: "run-tree" },
  ],
};
const RUN_GATE: Landmark = {
  id: "run-gate",
  desc: "the approval gate card (decided, or waiting for the decision)",
  any: [{ testid: "approval-decided" }, { testid: "approval-node" }, { testid: "workbench-dock" }],
};

/** The project overview (project-1b) and its tab routes. */
const PROJECT_HEADING: Landmark = {
  id: "project-heading",
  desc: "the project's own title (the H1 — its name is data)",
  any: [{ testid: "project-name" }, { role: "heading", level: 1 }],
};
const PROJECT_NEW_THREAD: Landmark = {
  id: "project-new-thread",
  desc: "the 'New thread' action",
  any: [{ testid: "project-new-conversation" }, { role: "button", name: /^new thread$/i }],
};
const PROJECT_START_RUN: Landmark = {
  id: "project-start-run",
  desc: "the 'Start run' action",
  any: [{ testid: "project-start-run" }, { role: "button", name: /^start run$/i }],
};
const PROJECT_TABS: Landmark = {
  id: "project-tabs",
  desc: "the header tab row",
  any: [{ testid: "project-tabs" }],
};
const PROJECT_TAB_OVERVIEW_ACTIVE: Landmark = {
  id: "project-tab-overview-active",
  desc: "the Overview tab shown as the page you are on",
  any: [{ testid: "project-tab-overview", current: true }],
};
const PROJECT_TAB_RUNS: Landmark = {
  id: "project-tab-runs",
  desc: "the Runs tab",
  any: [{ testid: "project-tab-runs" }],
};
const PROJECT_TAB_THREADS: Landmark = {
  id: "project-tab-threads",
  desc: "the Threads tab",
  any: [{ testid: "project-tab-threads" }],
};
const PROJECT_TAB_WORKFLOWS: Landmark = {
  id: "project-tab-workflows",
  desc: "the Workflows tab",
  any: [{ testid: "project-tab-workflows" }],
};
const PROJECT_TAB_ARTIFACTS: Landmark = {
  id: "project-tab-artifacts",
  desc: "the Artifacts tab",
  any: [{ testid: "project-tab-artifacts" }],
};
const PROJECT_TAB_SETTINGS: Landmark = {
  id: "project-tab-settings",
  desc: "the Settings tab",
  any: [{ testid: "project-tab-settings" }],
};
const PROJECT_PANEL_RUNNING: Landmark = {
  id: "project-panel-running-now",
  desc: "the RUNNING NOW panel",
  any: [{ role: "heading", name: /^RUNNING NOW/i }, { testid: "running-now-list" }],
};
const PROJECT_PANEL_THREADS: Landmark = {
  id: "project-panel-recent-threads",
  desc: "the RECENT THREADS panel",
  any: [{ role: "heading", name: /^RECENT THREADS$/i }, { testid: "project-threads" }],
};
const PROJECT_PANEL_REPOS: Landmark = {
  id: "project-panel-repositories",
  desc: "the REPOSITORIES panel",
  any: [{ role: "heading", name: /^REPOSITORIES/i }, { testid: "repo-list" }],
};
const PROJECT_PANEL_WORKFLOWS: Landmark = {
  id: "project-panel-workflows",
  desc: "the WORKFLOWS panel",
  any: [{ role: "heading", name: /^WORKFLOWS/i }, { testid: "project-workflows" }],
};
const PROJECT_RUNNING_EMPTY: Landmark = {
  id: "project-running-empty",
  desc: "the honest empty line where RUNNING NOW would be",
  any: [
    { testid: "running-now-empty" },
    { testid: "recent-runs-empty" },
    { text: /never started a workflow/i },
  ],
};
const PROJECT_WORKFLOWS_EMPTY: Landmark = {
  id: "project-workflows-empty",
  desc: "the honest empty line where the project's workflows would be",
  any: [{ testid: "project-workflows-empty" }, { testid: "project-workflows" }],
};
const PROJECT_REPOS_EMPTY: Landmark = {
  id: "project-repos-empty",
  desc: "the honest empty line where the repositories would be",
  any: [{ testid: "repo-list-empty" }, { testid: "repo-list" }],
};
const PROJECT_UNAVAILABLE_HEADING: Landmark = {
  id: "project-unavailable-heading",
  desc: "the 'Project' heading of a page that cannot show a project",
  any: [{ role: "heading", level: 1, name: /^Project$/ }],
};
const PROJECT_NOT_FOUND: Landmark = {
  id: "project-not-found",
  desc: "the honest 'project not found' line",
  any: [{ testid: "project-not-found" }, { text: /project.*(not found|could not)/i }],
};
/** Pass-1 review, item 5: a refusal page's H1 NAMES what was missing
 * (`Project not found`), it is not the generic section word; the way back is a
 * button beside the sentence, not only the mono breadcrumb above it. */
const PROJECT_NOT_FOUND_HEADING: Landmark = {
  id: "project-not-found-heading",
  desc: "the H1 that names the project the page could not open",
  any: [{ role: "heading", level: 1, name: /^Project not found$/ }],
};
const PROJECT_NOT_FOUND_BACK: Landmark = {
  id: "project-not-found-back",
  desc: "the explicit `← Projects` button beside the refusal",
  any: [
    { testid: "project-page-back-to-projects-action" },
    { role: "link", name: /←\s*Projects$/ },
  ],
};
const REPO_NOT_FOUND_HEADING: Landmark = {
  id: "repo-not-found-heading",
  desc: "the H1 that names the repository the page could not open",
  any: [{ role: "heading", level: 1, name: /^Repository not found$/ }],
};
const REPO_NOT_FOUND_BACK: Landmark = {
  id: "repo-not-found-back",
  desc: "the explicit button back to the project beside the refusal",
  any: [{ testid: "repo-back-to-project" }, { role: "link", name: /^←\s/ }],
};
const PROJECT_ERROR_SHELL: Landmark = {
  id: "project-error-shell",
  desc: "the error shell that holds a failed project read",
  any: [{ testid: "project-page-error" }],
};
const PROJECT_ERROR_PANEL: Landmark = {
  id: "project-error-panel",
  desc: "the panel quoting the server's problem",
  any: [{ role: "alert" }],
};
const PROJECT_RUNS_PAGE: Landmark = {
  id: "project-runs-page",
  desc: "the project's Runs page",
  any: [{ testid: "project-runs" }, { testid: "runs-list" }, { testid: "runs-empty" }],
};
const PROJECT_RUNS_BODY: Landmark = {
  id: "project-runs-body",
  desc: "the runs list, or the honest line saying there are none",
  any: [{ testid: "runs-list" }, { testid: "runs-empty" }],
};
const PROJECT_THREADS_PAGE: Landmark = {
  id: "project-threads-page",
  desc: "the project's Threads page",
  any: [{ testid: "project-conversations" }],
};
/** Design 1g (project-tabs-2 review): the Threads tab IS the shared 1g list pane
 * filtered to the project — the project's own card list and its title-slugged
 * row ids were retired with it, so the tab must draw the pane the `/threads`
 * route draws, or the two screens diverged again. */
const PROJECT_THREADS_PANE: Landmark = {
  id: "project-threads-pane",
  desc: "the shared 1g list pane (search, chips and rows) the tab mounts",
  any: [
    { testid: "threads-search" },
    { testid: "threads-filters" },
    { testid: "threads-list" },
    { testid: "thread-row-*" },
    { testid: "threads-list-empty" },
    { testid: "threads-nomatch" },
  ],
};
const PROJECT_WORKFLOWS_PAGE: Landmark = {
  id: "project-workflows-page",
  // Design 1b (project-workflows-tab): the pass review of `project-1b-workflows`
  // retired the tab's LIBRARY list, its inline assign shelf and its pinned-
  // revision dump; what the tab owns is the one WORKFLOWS IN THIS PROJECT panel.
  desc: "the project's Workflows page",
  any: [{ testid: "project-pipelines" }, { testid: "project-workflows" }],
};
/** The tab's ONE panel. Whether it holds rows or the honest absence is data
 * (what the project pins), so the landmark names the panel itself — its title
 * counts with a read answered and without one — and the two nothings it can
 * answer with. The rows' STARTS WHEN boxes are asserted by the journey
 * (emulator/projects.spec.ts) where the served pins are known: a landmark may
 * insist a row HAS a box, never that the project has a row. */
const PROJECT_WORKFLOWS_BODY: Landmark = {
  id: "project-workflows-body",
  desc: "the ONE WORKFLOWS IN THIS PROJECT panel (its rows, or the honest line saying none)",
  any: [
    { role: "heading", name: /^WORKFLOWS IN THIS PROJECT/i },
    { testid: "project-workflows" },
    { testid: "project-workflows-empty" },
  ],
};
/** 2e's trigger treatment, now across every repository of the project: a row
 * opens on a STARTS WHEN box, and a workflow with nothing scheduled says
 * `Never triggered` there rather than hiding the absence. */
const PROJECT_WORKFLOWS_STARTS_WHEN: Landmark = {
  id: "project-workflows-starts-when",
  desc: "a workflow row's STARTS WHEN box (2e's trigger treatment, shared by the tab)",
  any: [
    { testid: "project-workflow-starts-*" },
    { testid: "project-workflow-none-*" },
    { text: /^STARTS WHEN$/i },
    { text: /Never triggered/i },
    // A project that uses NO workflow has no row and so no box: the tab's
    // honest absence is the same design fact at the other end of the read
    // (never a LIBRARY list standing in for it — that is what was retired).
    { testid: "project-workflows-empty" },
  ],
};
/** The tab's one way to bring a workflow in, since the inline assign shelf left. */
const PROJECT_WORKFLOWS_LIBRARY: Landmark = {
  id: "project-workflows-library",
  desc: "the panel's '+ use a library workflow' control",
  any: [{ testid: "project-workflow-library" }, { text: /\+ use (a library )?workflow/i }],
};

/** Threads (threads-1g). */
const THREADS_HEADING: Landmark = {
  id: "threads-heading",
  desc: "the 'Threads' heading (at 390, the '← Threads' back link that carries it)",
  any: [
    { role: "heading", level: 1, name: /^Threads$/ },
    { testid: "threads-page" },
    { testid: "thread-list-pane" },
    { testid: "threads-back" },
  ],
};
const THREADS_NEW: Landmark = {
  id: "threads-new",
  desc: "the 'New thread' action",
  any: [{ testid: "threads-new-open" }, { role: "button", name: /^new thread$/i }],
};
const THREADS_SEARCH: Landmark = {
  id: "threads-search",
  desc: "the thread search field",
  any: [{ testid: "threads-search" }, { role: "textbox", name: /search threads/i }],
};
const THREADS_CHIPS: Landmark = {
  id: "threads-chips",
  desc: "the filter chips (all projects / mine / from runs)",
  any: [
    { testid: "threads-filter-all" },
    { testid: "threads-filter-mine" },
    { testid: "threads-filter-runs" },
    { role: "button", name: /^all projects$/ },
  ],
};
/** The list itself — at 390 the documented reflow replaces it with the open
 * thread plus its `← Threads` back link, so both forms satisfy the landmark
 * (the content is there, or the one tap that reaches it is). */
const THREADS_LIST: Landmark = {
  id: "threads-list-or-back",
  desc: "the thread list, or (at 390) the open thread's '← Threads' back link",
  any: [
    { testid: "threads-list" },
    { testid: "thread-list-pane" },
    { testid: "threads-back" },
    { role: "link", name: /← threads/i },
  ],
};
const THREAD_TITLE: Landmark = {
  id: "thread-title",
  desc: "the open thread's title",
  any: [{ testid: "conversation-title" }, { role: "heading", level: 1 }],
};
const THREAD_CONTROL: Landmark = {
  id: "thread-control",
  desc: "the controller badge, or the 'Take control' way to get it",
  any: [
    { testid: "controller-badge" },
    { testid: "take-control" },
    { role: "button", name: /^take control$/i },
  ],
};
const THREAD_TRANSCRIPT: Landmark = {
  id: "thread-transcript",
  desc: "the transcript",
  any: [{ testid: "transcript" }, { testid: "transcript-empty" }],
};
const THREAD_COMPOSER: Landmark = {
  id: "thread-composer",
  desc: "the composer's reply field",
  any: [{ testid: "composer-input" }, { role: "textbox", name: /reply to the agent/i }],
};
const THREAD_SEND: Landmark = {
  id: "thread-send",
  desc: "the composer's Send action",
  any: [{ testid: "composer-send" }, { role: "button", name: /^send$/i }],
};
/** Design thread view (10 / 1g): WORKSPACE, ARTIFACTS and NEXT are no longer a
 * always-open rail beside the transcript — they sit behind one disclosure, so
 * the claim is the door itself (pass-2 review: its summary names the rail's
 * interactive parts, and the design's chevron marks it as a door). */
const THREAD_CONTEXT_DISCLOSURE: Landmark = {
  id: "thread-context-disclosure",
  desc: "the 'Thread details — handoff, artifacts and draft PR' disclosure holding the rail",
  any: [
    { testid: "thread-context-disclosure" },
    { testid: "thread-context-block" },
    { role: "button", name: /thread details/i },
  ],
};
const THREADS_LIST_ERROR: Landmark = {
  id: "threads-list-error",
  desc: "the line saying the thread list could not be read",
  any: [{ testid: "threads-list-error" }, { role: "alert" }],
};

/* ------------------------------------ handoff-repo-chat-nav (rcn-* badges) */

// The repo/chat/nav handoff (docs/design/handoff-repo-chat-nav/) redraws the
// shell (2c/3c), the repo page (3a/3b), the chat (2e + 1h), the thread →
// workflow assistant (2f) and the workflow inputs (1j/1k). Its badges are
// namespaced `rcn-` (env.ts `EMU_DESIGN_DIRS`), so the same numbers the older
// boards spent keep their own renders. Everything below is structure the app
// really owns — testids and design copy only; the mock's Northwind/storefront
// sample data is MOCK_DATA's territory (mockdata.ts), never a landmark.

/** The one left column, at either width; at 390 the documented reflow is the
 * phone top strip whose menu button is the one tap that reaches the drawer
 * (Shell.tsx — the rail is a desktop affordance). Host: the shell lives
 * outside `<main`, so these landmarks read the whole page. */
const RCN_COLUMN: Landmark = {
  id: "rcn-sidebar-column",
  desc: "the one left sidebar column (at 390, the phone strip's menu button that opens it)",
  host: "page",
  any: [{ testid: "sidebar" }, { testid: "sidebar-open" }],
};
const RCN_NEW_CHAT: Landmark = {
  id: "rcn-new-chat",
  desc: "the 'New chat' button (at 390, the one tap that reaches it)",
  host: "page",
  any: [{ testid: "new-chat" }, { testid: "new-chat-rail" }, { testid: "sidebar-open" }],
};
const RCN_TODAY: Landmark = {
  id: "rcn-today",
  desc: "the 'Today' row (was Home)",
  host: "page",
  any: [
    { testid: "sidebar-link-home" },
    { role: "link", name: /^today$/i },
    { testid: "sidebar-open" },
  ],
};
const RCN_MY_CHATS: Landmark = {
  id: "rcn-my-chats",
  desc: "the 'My chats' row",
  host: "page",
  any: [
    { testid: "sidebar-link-threads" },
    { role: "link", name: /my chats/i },
    { testid: "sidebar-open" },
  ],
};
const RCN_PROJECTS_SECTION: Landmark = {
  id: "rcn-projects-section",
  desc: "the PROJECTS section with its project tree",
  host: "page",
  any: [
    { text: /^PROJECTS$/ },
    { testid: "sidebar-project-toggle-*" },
    { testid: "project-switcher" },
    { testid: "sidebar-open" },
  ],
};
const RCN_LIBRARY_SECTION: Landmark = {
  id: "rcn-library-section",
  desc: "the LIBRARY section (Workflows / Steps / Agent profiles)",
  host: "page",
  any: [
    { text: /^LIBRARY$/ },
    { testid: "sidebar-link-workflows" },
    { testid: "sidebar-rail-library" },
    { testid: "sidebar-open" },
  ],
};
const RCN_EXPANDED_CONTROLS: Landmark = {
  id: "rcn-collapse-control",
  desc: "the collapse control on the expanded column's brand row",
  host: "page",
  any: [{ testid: "sidebar-collapse" }, { testid: "sidebar-open" }],
};
/** The 3c rail: its own controls, with the 390 one tap as the alternate. */
const RCN_RAIL_EXPAND: Landmark = {
  id: "rcn-rail-expand",
  desc: "the rail's expand control",
  host: "page",
  any: [{ testid: "sidebar-expand" }, { testid: "sidebar-open" }],
};
const RCN_RAIL_TILES: Landmark = {
  id: "rcn-rail-project-tiles",
  desc: "the rail's project initials tiles",
  host: "page",
  any: [{ testid: "sidebar-rail-project-*" }, { testid: "sidebar-open" }],
};

/* The repo page's List view (rcn-3a). */
const RCN_REPO_PAGE: Landmark = {
  id: "rcn-repo-page",
  desc: "the repository page",
  any: [{ testid: "repo-page" }],
};
const RCN_REPO_BREADCRUMB: Landmark = {
  id: "rcn-repo-breadcrumb",
  desc: "the 'Project / repo' breadcrumb",
  any: [{ testid: "repo-breadcrumb" }],
};
const RCN_REPO_TITLE: Landmark = {
  id: "rcn-repo-title",
  desc: "the repository's own H1 (its name is data; its being a title is not)",
  any: [{ testid: "repo-name" }, { role: "heading", level: 1 }],
};
const RCN_VIEW_TOGGLE: Landmark = {
  id: "rcn-list-lanes-toggle",
  desc: "the segmented List | Lanes control",
  any: [
    { testid: "repo-view-toggle" },
    { testid: "repo-view-list" },
    { testid: "repo-view-lanes" },
  ],
};
const RCN_CHAT_BOX: Landmark = {
  id: "rcn-repo-chat-box",
  desc: "the repo page's one-line chat box",
  any: [{ testid: "repo-chat-box" }],
};
const RCN_CHAT_INPUT: Landmark = {
  id: "rcn-repo-chat-input",
  desc: "the chat box's input ('Chat in <repo>…')",
  any: [{ testid: "repo-chat-input" }, { role: "textbox", name: /chat in /i }],
};
const RCN_CHAT_PROFILE: Landmark = {
  id: "rcn-repo-chat-profile",
  desc: "the chat box's agent-profile picker chip",
  any: [{ testid: "repo-chat-profile" }],
};
const RCN_CHAT_START: Landmark = {
  id: "rcn-repo-chat-start",
  desc: "the chat box's primary Start verb",
  any: [{ testid: "repo-chat-start" }, { role: "button", name: /^start$/i }],
};
const RCN_FILTER_CHIPS: Landmark = {
  id: "rcn-activity-filter-chips",
  desc: "the All · Runs · Chats · Mine filter chips",
  any: [
    { testid: "repo-activity-filters" },
    { testid: "repo-filter-all" },
    { testid: "repo-filter-runs" },
    { testid: "repo-filter-chats" },
    { testid: "repo-filter-mine" },
  ],
};
const RCN_ACTIVITY: Landmark = {
  id: "rcn-activity-list",
  desc: "the one activity panel that holds runs and chats together",
  any: [{ testid: "repo-runs" }, { testid: "repo-activity" }],
};
const RCN_ACTIVITY_EMPTY: Landmark = {
  id: "rcn-activity-empty",
  desc: "the honest empty activity line ('say something in the chat box above')",
  any: [
    { testid: "repo-activity-empty" },
    { testid: "repo-runs-empty" },
    { text: /say something in the chat box/i },
  ],
};
const RCN_WORKFLOWS_PANEL: Landmark = {
  id: "rcn-workflows-panel",
  desc: "the WORKFLOWS side panel",
  any: [
    { testid: "repo-workflows" },
    { testid: "repo-workflows-empty" },
    { role: "heading", name: /^WORKFLOWS/i },
  ],
};
const RCN_WORKFLOW_ROW: Landmark = {
  id: "rcn-workflow-row",
  desc: "a workflow row in the WORKFLOWS panel",
  any: [{ testid: "repo-workflow-row-*" }, { testid: "repo-workflow-name-*" }],
};
const RCN_WORKFLOW_TRIGGERS: Landmark = {
  id: "rcn-workflow-trigger-line",
  desc: "the row's trigger line (GitHub / Schedule / By hand)",
  any: [
    { testid: "repo-workflow-triggers-*" },
    { testid: "repo-lane-workflow-trigger-*" },
    { text: /^by hand$/i },
  ],
};
const RCN_WORKFLOW_RESULT: Landmark = {
  id: "rcn-workflow-result-line",
  desc: "the row's latest-result line",
  any: [{ testid: "repo-workflow-result-*" }, { testid: "repo-workflow-triggers-*" }],
};
const RCN_WORKFLOW_RUN: Landmark = {
  id: "rcn-workflow-run-button",
  desc: "the row's compact Run button",
  any: [{ testid: "repo-workflow-run-*" }, { role: "button", name: /^run$/i }],
};
const RCN_ISSUES_PANEL: Landmark = {
  id: "rcn-open-issues-panel",
  desc: "the OPEN ISSUES side panel",
  any: [
    { testid: "repo-issues" },
    { testid: "repo-issues-not-github" },
    { role: "heading", name: /open issues/i },
  ],
};

/* The repo page's Lanes view (rcn-3b). */
const RCN_LANES: Landmark = {
  id: "rcn-lanes",
  desc: "the Lanes view",
  any: [{ testid: "repo-lanes" }],
};
const RCN_LANE_WORKFLOWS: Landmark = {
  id: "rcn-lane-workflows",
  desc: "the WORKFLOWS chip row",
  any: [{ testid: "repo-lane-workflows" }, { testid: "repo-lane-workflow-*" }],
};
const RCN_LANE_ISSUES: Landmark = {
  id: "rcn-lane-issues",
  desc: "the ISSUES lane (the draggable source, or its honest absence)",
  any: [{ testid: "repo-lane-issues" }, { testid: "repo-lane-issues-not-github" }],
};
const RCN_LANE_NEEDS_YOU: Landmark = {
  id: "rcn-lane-needs-you",
  desc: "the NEEDS YOU lane",
  any: [{ testid: "repo-lane-needs-you" }, { testid: "repo-lane-needs-you-empty" }],
};
const RCN_LANE_RUNNING: Landmark = {
  id: "rcn-lane-running",
  desc: "the RUNNING lane (the drop target)",
  any: [{ testid: "repo-lane-running" }, { testid: "repo-lane-running-empty" }],
};
const RCN_LANE_FINISHED: Landmark = {
  id: "rcn-lane-finished",
  desc: "the FINISHED · 7 DAYS lane",
  any: [{ testid: "repo-lane-finished" }, { testid: "repo-lane-finished-empty" }],
};

/* The chat (rcn-2e) and its agent picker (rcn-1h). */
const RCN_CONV_BREADCRUMB: Landmark = {
  id: "rcn-conversation-breadcrumb",
  desc: "the thread's breadcrumb",
  any: [{ testid: "conversation-breadcrumb" }],
};
const RCN_CONV_TITLE: Landmark = {
  id: "rcn-conversation-title",
  desc: "the thread's title (an H1 — its name is data, its being a title is not)",
  any: [{ testid: "conversation-title" }, { role: "heading", level: 1 }],
};
const RCN_TRANSCRIPT: Landmark = {
  id: "rcn-transcript",
  desc: "the transcript",
  any: [{ testid: "transcript" }, { testid: "transcript-empty" }],
};
const RCN_COMPOSER: Landmark = {
  id: "rcn-composer",
  desc: "the composer's reply field",
  any: [{ testid: "composer-input" }],
};
const RCN_SEND: Landmark = {
  id: "rcn-composer-send",
  desc: "the composer's Send action",
  any: [{ testid: "composer-send" }, { role: "button", name: /^send$/i }],
};
const RCN_AGENT_CHIP: Landmark = {
  id: "rcn-composer-agent-chip",
  desc: "the composer's agent chip ('NEXT TURN RUNS ON')",
  any: [{ testid: "composer-agent-chip" }],
};
const RCN_AGENT_MENU: Landmark = {
  id: "rcn-next-turn-menu",
  desc: "the open 'NEXT TURN RUNS ON' profile menu",
  any: [{ testid: "composer-agent-menu" }, { role: "menu" }],
};
const RCN_AGENT_MENU_CAPTION: Landmark = {
  id: "rcn-next-turn-caption",
  desc: "the menu's NEXT TURN RUNS ON caption",
  any: [{ text: /next turn runs on/i }],
};
const RCN_AGENT_MENU_PROFILES: Landmark = {
  id: "rcn-menu-profiles",
  desc: "the menu's agent-profile rows (the current one carries ✓)",
  any: [
    { testid: "composer-agent-profile-*" },
    { testid: "composer-agent-menu" },
    { text: /✓/ },
  ],
};
const RCN_SWITCH_DIVIDER: Landmark = {
  id: "rcn-agent-switch-divider",
  desc: "the centred 'switched to … · transcript and branch carried over' divider",
  any: [{ testid: "agent-switch-divider" }, { text: /switched to .*carried over/i }],
};
const RCN_SIDE_PANEL: Landmark = {
  id: "rcn-conversation-side-panel",
  desc: "the chat's side panel holding the thread's context",
  any: [
    { testid: "conversation-side-panel" },
    { testid: "thread-side-panel-aside" },
    { testid: "thread-side-panel-stack" },
  ],
};
const RCN_WORKS_IN: Landmark = {
  id: "rcn-works-in",
  desc: "the panel's WORKS IN section naming the repo",
  any: [{ testid: "side-panel-works-in" }, { text: /works in/i }],
};
const RCN_PANEL_AGENTS: Landmark = {
  id: "rcn-agents-in-this-chat",
  desc: "the panel's AGENTS IN THIS CHAT section",
  any: [{ testid: "side-panel-agents" }, { text: /agents in this chat/i }],
};
const RCN_AGENT_TURN_RANGE: Landmark = {
  id: "rcn-agent-turn-range",
  desc: "an agent row with its turn range ('turns 1–2')",
  any: [
    { testid: "side-panel-agent-row-*" },
    { testid: "side-panel-agent-range-*" },
    { text: /\bturns? ?[0-9]/i },
  ],
};
const RCN_ASSISTANT_NOTE: Landmark = {
  id: "rcn-assistant-note",
  desc: "the panel's ASSISTANT note offering 'Make a workflow…'",
  any: [
    { testid: "assistant-note-workflow" },
    { role: "button", name: /make a workflow/i },
    { text: /make a workflow/i },
  ],
};

/* Thread → workflow, in the assistant panel (rcn-2f). */
const RCN_ASSISTANT_PANEL: Landmark = {
  id: "rcn-assistant-panel",
  desc: "the assistant panel, opened with the chat as context",
  host: "page",
  any: [{ testid: "assistant-popover" }, { testid: "assistant-panel" }],
};
const RCN_ASSISTANT_COMPOSER: Landmark = {
  id: "rcn-assistant-composer",
  desc: "the assistant panel's composer",
  host: "page",
  any: [{ testid: "assistant-composer-input" }, { testid: "assistant-send" }],
};
const RCN_ASSISTANT_ASK: Landmark = {
  id: "rcn-assistant-workflow-ask",
  desc: "the 'Turn this chat into a workflow' ask the note sent",
  host: "page",
  any: [{ text: /turn this chat into a workflow/i }],
};

/* Agent mail (rcn-3d, ADR-0072). The design's "gpt-5" model segment and its
 * tool-activity tail are deliberately NOT landmarks — ADR-0072 § 7 journals
 * neither, and the card renders rows, not guesses. */
const RCN_MAIL_CARDS: Landmark = {
  id: "rcn-mail-cards",
  desc: "the inline mail card ('→ asked the agent in <repo>')",
  any: [
    { testid: "mail-card" },
    { testid: "transcript-mail-cards" },
    { text: /asked the agent in/i },
  ],
};
const RCN_MAIL_ANSWER: Landmark = {
  id: "rcn-mail-answer",
  desc: "the mail card's answer block ('← <repo> · <agent>')",
  any: [{ testid: "mail-card-answer" }, { testid: "mail-card-pending" }],
};
const RCN_LINKED_CHATS: Landmark = {
  id: "rcn-linked-chats",
  desc: "the panel's LINKED CHATS section with its mail row",
  any: [
    { testid: "side-panel-links" },
    { testid: "side-panel-link-row-0" },
    { text: /linked chats/i },
  ],
};
const RCN_LINKED_CHAT_STATE: Landmark = {
  id: "rcn-linked-chat-state",
  desc: "the linked chat row's state line (glyph + word: 'asked · read-only' / 'answered')",
  any: [{ testid: "side-panel-link-state-0" }, { text: /(asked|answered) \u00b7 read-only/i }],
};

/* Workflow inputs (rcn-1j) and the run-by-hand form (rcn-1k). */
const RCN_INPUTS_TAB: Landmark = {
  id: "rcn-inputs-tab",
  desc: "the Inputs tab's own panel grid",
  any: [{ testid: "inputs-tab" }],
};
const RCN_TAB_INPUTS_ACTIVE: Landmark = {
  id: "rcn-tab-inputs-active",
  desc: "the Inputs tab shown as the page you are on",
  any: [{ testid: "workflow-tab-inputs", current: true }],
};
const RCN_INPUTS_PANEL: Landmark = {
  id: "rcn-inputs-panel",
  desc: "the INPUTS · n panel",
  any: [
    { role: "heading", name: /^INPUTS\b/i },
    { testid: "inputs-header-row" },
    { testid: "inputs-empty" },
  ],
};
const RCN_INPUTS_HEADER: Landmark = {
  id: "rcn-inputs-header",
  desc: "the NAME · TYPE · REQUIRED · DEFAULT header row",
  any: [{ testid: "inputs-header-row" }],
};
const RCN_INPUT_ADD: Landmark = {
  id: "rcn-input-add",
  desc: "the '+ add input' verb",
  any: [{ testid: "input-add" }, { text: /\+ add input/i }],
};
const RCN_INPUT_ROWS: Landmark = {
  id: "rcn-input-rows",
  desc: "at least one declared input row",
  any: [{ testid: "input-item-*" }, { testid: "input-row-*" }],
};
const RCN_WHO_FILLS: Landmark = {
  id: "rcn-who-fills",
  desc: "the WHO FILLS THE INPUTS panel",
  any: [{ testid: "who-fills" }, { role: "heading", name: /who fills the inputs/i }],
};
const RCN_WHO_FILLS_HAND: Landmark = {
  id: "rcn-who-fills-hand",
  desc: "the 'Run by hand' row",
  any: [{ testid: "who-fills-hand" }, { text: /run by hand/i }],
};
const RCN_WHO_FILLS_TRIGGER: Landmark = {
  id: "rcn-who-fills-trigger",
  desc: "a trigger row saying which input it fills",
  any: [
    { testid: "who-fills-issue-*" },
    { testid: "who-fills-schedule-*" },
    { text: /← the (opened|labeled) issue/ },
    { text: /fills no inputs/i },
  ],
};
const RCN_INPUTS_YAML: Landmark = {
  id: "rcn-inputs-yaml-preview",
  desc: "the panel's YAML preview of the inputs block",
  any: [{ testid: "inputs-yaml-preview" }],
};
const RCN_DRAFT_CHIP: Landmark = {
  id: "rcn-draft-chip",
  desc: "the header's 'draft r<n> · unpublished' chip",
  any: [{ testid: "workflow-draft-state" }, { text: /draft r\d+ · unpublished/i }],
};
const RCN_RUN_DIALOG: Landmark = {
  id: "rcn-run-form-dialog",
  desc: "the run-by-hand dialog",
  any: [{ testid: "run-form-dialog" }, { role: "dialog" }],
};
const RCN_RUN_TITLE: Landmark = {
  id: "rcn-run-form-title",
  desc: "the 'Run <workflow>' title",
  any: [{ testid: "run-form-title" }, { role: "heading", name: /^run /i }],
};
const RCN_RUN_SUBTITLE: Landmark = {
  id: "rcn-run-form-subtitle",
  desc: "the mono '<repo> · pinned r<n>' subtitle",
  any: [{ testid: "run-form-subtitle" }, { text: /pinned r/i }],
};
const RCN_RUN_FIELDS: Landmark = {
  id: "rcn-run-form-fields",
  desc: "at least one field built from the workflow's declared inputs",
  any: [{ testid: "new-run-field-*" }, { testid: "new-run-input-*" }],
};
const RCN_RUN_START: Landmark = {
  id: "rcn-run-form-start",
  desc: "the 'Start run' primary verb",
  any: [{ testid: "new-run-submit" }, { role: "button", name: /start run/i }],
};
const RCN_RUN_CANCEL: Landmark = {
  id: "rcn-run-form-cancel",
  desc: "the form's Cancel verb",
  any: [{ testid: "new-run-cancel" }, { role: "button", name: /^cancel$/i }],
};
const RCN_RUN_HELPER: Landmark = {
  id: "rcn-run-form-helper",
  desc: "the footer's helper line",
  any: [{ testid: "run-form-helper" }],
};

/* ------------------------------------------------------------- the screens */

/**
 * One entry per captured screen, keyed `"<badge> <screen name>"` — the same
 * words `emu.screen(badge, name)` records. A screen name whose tail is a
 * per-pass id (`2e schedule-run-9c1e04f2`) is found by shape: a run of 6+ hex
 * characters collapses to `*`, so it lives under `2e schedule-run-*`.
 */
export const DESIGN_LANDMARKS: Record<string, Landmark[]> = {
  /* ------------------------------------------------------ 1b · /workflows */
  "1b index": [
    INDEX_HEADING,
    INDEX_IMPORT,
    INDEX_NEW,
    INDEX_START_BLANK,
    INDEX_STARTER_TEMPLATE,
    INDEX_SEARCH,
    INDEX_CHIP_ALL,
    INDEX_CHIP_DRAFT,
    INDEX_LIST,
    INDEX_ROW_EDIT,
    INDEX_ROW_MENU,
  ],
  "1b no-match": [INDEX_HEADING, INDEX_NEW, INDEX_SEARCH, INDEX_NO_MATCH],
  // The same index with a workflow filed into a folder (ADR-0049 § 8): every
  // landmark the plain index claims, plus the panel structure design 1b draws
  // — a header per folder (name in caps + its count) and the row inside it.
  "1b folders": [
    INDEX_HEADING,
    INDEX_IMPORT,
    INDEX_NEW,
    INDEX_START_BLANK,
    INDEX_STARTER_TEMPLATE,
    INDEX_SEARCH,
    INDEX_CHIP_ALL,
    INDEX_CHIP_DRAFT,
    INDEX_LIST,
    INDEX_FOLDER_HEADER,
    INDEX_FOLDER_ROW,
    INDEX_ROW_EDIT,
    INDEX_ROW_MENU,
  ],
  "1b server-error": [INDEX_HEADING, INDEX_NEW, ERROR_PANEL],

  /* -------------------------------------------- 1c · the New workflow dialog */
  "1c new-workflow": [
    INDEX_HEADING,
    NW_TITLE,
    NW_NAME,
    NW_ID_LINE,
    NW_ID_CHANGE,
    NW_START_FROM,
    NW_BLANK,
    NW_FOLDER,
    NW_CANCEL,
    NW_SUBMIT,
  ],
  "1c server-error": [
    INDEX_HEADING,
    ERROR_PANEL,
    NW_TITLE,
    NW_NAME,
    NW_START_FROM,
    NW_FOLDER,
    NW_CANCEL,
    NW_SUBMIT,
  ],

  /* ------------------------------------------- 1e · the workflow page (1e/2a/2d share its header) */
  "1e workflow": [
    WF_BREADCRUMB,
    WF_TITLE,
    WF_REVISION_CHIP,
    WF_TABS,
    WF_TAB_OVERVIEW,
    WF_TAB_YAML,
    WF_TAB_USED_IN,
    WF_TAB_HISTORY,
    WF_USE_IN_REPO,
    WF_GRAPH,
    WF_RAIL_USED_IN,
    WF_RAIL_INPUTS,
    WF_RAIL_RUNS,
  ],
  "1e not-found": [WF_FAILED_HEADING, WF_FAILED_BANNER, WF_BACK],
  "1e server-error": [WF_FAILED_HEADING, WF_FAILED_BANNER, WF_RETRY, WF_BACK],

  /* ------------------------------------------------------- 1g · the Studio */
  "1g studio": [
    STUDIO_BREADCRUMB,
    STUDIO_TITLE,
    STUDIO_DRAFT_CHIP,
    STUDIO_VIEW_TOGGLE,
    STUDIO_UNDO,
    STUDIO_REDO,
    STUDIO_VALIDATE,
    STUDIO_SAVE,
    STUDIO_PUBLISH,
    STUDIO_PALETTE_ADD,
    STUDIO_PALETTE_SEARCH,
    STUDIO_KIND_AGENT,
    STUDIO_KIND_MODEL,
    STUDIO_KIND_COMMAND,
    STUDIO_KIND_APPROVAL,
    STUDIO_WRAP_HEADING,
    STUDIO_WRAP_UNTIL,
    STUDIO_WRAP_FOREACH,
    STUDIO_CANVAS,
    STUDIO_INSPECTOR,
    STUDIO_ASSISTANT,
    STUDIO_STATUS_BAR,
  ],
  "1g inspector-edit": [
    STUDIO_BREADCRUMB,
    STUDIO_TITLE,
    STUDIO_DRAFT_CHIP,
    STUDIO_VIEW_TOGGLE,
    STUDIO_UNDO,
    STUDIO_REDO,
    STUDIO_VALIDATE,
    STUDIO_SAVE,
    STUDIO_PUBLISH,
    STUDIO_PALETTE_ADD,
    STUDIO_PALETTE_SEARCH,
    STUDIO_KIND_AGENT,
    STUDIO_KIND_MODEL,
    STUDIO_KIND_COMMAND,
    STUDIO_KIND_APPROVAL,
    STUDIO_WRAP_HEADING,
    STUDIO_WRAP_UNTIL,
    STUDIO_WRAP_FOREACH,
    STUDIO_CANVAS,
    STUDIO_NODE_CARD,
    STUDIO_NODE_WHERE,
    STUDIO_NODE_PROMPT,
    STUDIO_NODE_ADVANCED,
    STUDIO_ASSISTANT,
    STUDIO_STATUS_BAR,
  ],
  // A draft that cannot be read is still the Studio page (#23): the breadcrumb
  // and the H1 stand over the banner that quotes the server, with a Retry under
  // it — the same rule the 1e workflow page's failed read has always followed.
  "1g server-error": [STUDIO_ERROR_HEADING, STUDIO_DRAFT_ERROR],

  /* ------------------------------------------------- 2a · Used in + its dialog */
  "2a used-in-empty": [
    WF_BREADCRUMB,
    WF_TITLE,
    WF_TAB_USED_IN_ACTIVE,
    USED_IN_PANEL,
    USED_IN_EMPTY,
    // The footnote explains the rows' `Open ›` link, so it is no longer drawn
    // over an empty list (2026-10-30 copy review, 2a item 7) — a screen with no
    // rows may not require it. `2a used-in-assigned` still does.
  ],
  "2a used-in-assigned": [
    WF_BREADCRUMB,
    WF_TITLE,
    WF_TAB_USED_IN_ACTIVE,
    USED_IN_PANEL,
    USED_IN_LIST,
    USED_IN_PIN,
    USED_IN_OPEN,
    USED_IN_FOOTNOTE,
  ],
  // Captured with a project already chosen, because that is the state the
  // design draws and the state the one-select dialog acts on: the project
  // select plus the repository select it reveals (no per-row `Use here`).
  "2a use-dialog": [
    WF_TAB_USED_IN,
    USE_DIALOG,
    USE_DIALOG_TITLE,
    USE_FORM,
    USE_PIN_LINE,
    USE_PROJECT,
    USE_REPO,
    USE_CEILING,
    USE_CONFIRM,
    USE_CANCEL,
  ],
  "2a server-error": [WF_BREADCRUMB, WF_TITLE, WF_TAB_USED_IN_ACTIVE, USED_IN_PANEL, USED_IN_ERROR],

  /* ------------------------------------- 2c · the trigger dialog + its saves */
  "2c dialog-schedule": [
    REPO_PAGE,
    TRIG_DIALOG,
    TRIG_TITLE,
    TRIG_MODE,
    TRIG_MODE_SCHEDULE,
    TRIG_CRON,
    TRIG_CRON_WORDS,
    TRIG_GOAL,
    TRIG_CANCEL,
    TRIG_SUBMIT,
  ],
  "2c dialog-issue": [
    REPO_PAGE,
    TRIG_DIALOG,
    TRIG_TITLE,
    TRIG_MODE,
    TRIG_MODE_ISSUE,
    TRIG_EVENT,
    TRIG_LABELS,
    TRIG_RUN_GETS,
    TRIG_CANCEL,
    TRIG_SUBMIT,
  ],
  "2c schedule-trigger-saved": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_TRIGGER_LINE,
  ],
  "2c issue-trigger-saved": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_TRIGGER_LINE,
  ],
  // The 3a pause path open on the edit dialog: the same 2c dialog, reached
  // from the row's ⋯ menu, now carrying the trigger's Active/Paused switch.
  "2c trigger-edit-pause": [
    REPO_PAGE,
    TRIG_DIALOG,
    TRIG_MODE,
    TRIG_ENABLED,
    TRIG_CANCEL,
    TRIG_SUBMIT,
  ],
  "2c server-error": [REPO_PAGE, TRIG_DIALOG, TRIG_MODE, ERROR_PANEL],

  /* ------------------------------------------------------- 2d · the YAML tab */
  "2d yaml": [
    WF_TABS,
    WF_TAB_YAML_ACTIVE,
    YAML_FRAME,
    YAML_REVISION,
    YAML_COPY,
    YAML_DOWNLOAD,
    YAML_TEXT,
    YAML_LINES,
  ],
  "2d server-error": [WF_TABS, WF_TAB_YAML_ACTIVE, YAML_FRAME, YAML_ERROR],

  /* ------------------------------------------------- 2e · the repo page */
  // design 3a: a workflow row's landmarked verbs are the `⋯` triggers menu
  // (REPO_ROW_MENU — `Add trigger…` and one `Edit <trigger>` per trigger
  // live INSIDE it, as menuitems, asserted by the journey itself) and `Run`
  // (REPO_ROW_RUN). The STARTS WHEN box, its rows and their switch/Edit left
  // the page with it: what a trigger IS and whether it PAUSES are now the
  // row's mono trigger line's words (REPO_TRIGGER_LINE / REPO_TRIGGER_PAUSED).
  "2e repo": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_LIBRARY_LINK,
    REPO_ROW_MENU,
    REPO_ROW_RUN,
  ],
  "2e repo-empty": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_LIBRARY_LINK,
    REPO_WORKFLOWS_EMPTY,
  ],
  "2e triggers-paused": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_WORKFLOWS_PANEL,
    REPO_TRIGGER_LINE,
    REPO_TRIGGER_PAUSED,
  ],
  // `2e schedule-run-<run id>`: the repo page showing the run the schedule
  // started (the run's own row is data; the panels that hold it are design).
  "2e schedule-run-*": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_RUNS_PANEL,
  ],
  // `2e schedule-run-approved` is captured on the RUN the schedule fired, so
  // its landmarks are the design's run views: header, steps/graph, the gate.
  "2e schedule-run-approved": [RUN_PAGE, RUN_TITLE, RUN_GRAPH, RUN_GATE],
  "2e server-error": [REPO_PAGE, REPO_HEADING, REPO_WORKFLOWS_PANEL, ERROR_PANEL],

  /* ------------------------------------------- project-1b · the project page */
  "project-1b overview": [
    PROJECT_HEADING,
    PROJECT_NEW_THREAD,
    PROJECT_START_RUN,
    PROJECT_TABS,
    PROJECT_TAB_OVERVIEW_ACTIVE,
    PROJECT_TAB_RUNS,
    PROJECT_TAB_THREADS,
    PROJECT_TAB_WORKFLOWS,
    PROJECT_TAB_ARTIFACTS,
    PROJECT_TAB_SETTINGS,
    PROJECT_PANEL_RUNNING,
    PROJECT_PANEL_THREADS,
    PROJECT_PANEL_REPOS,
    PROJECT_PANEL_WORKFLOWS,
  ],
  // The RUNS panel carries no `New run` of its own any more (project-tabs-2
  // review named the duplicate of the band's verb): the header band's
  // `Start run` is the page's one door into the form, so it is a landmark of
  // this screen — the door has to be on the page whose list it opens.
  "project-1b runs": [PROJECT_RUNS_PAGE, PROJECT_RUNS_BODY, PROJECT_START_RUN],
  "project-1b threads": [PROJECT_THREADS_PAGE, PROJECT_THREADS_PANE],
  "project-1b workflows": [
    PROJECT_WORKFLOWS_PAGE,
    PROJECT_WORKFLOWS_BODY,
    PROJECT_WORKFLOWS_LIBRARY,
    PROJECT_WORKFLOWS_STARTS_WHEN,
  ],
  "project-1b empty": [
    PROJECT_HEADING,
    PROJECT_NEW_THREAD,
    PROJECT_START_RUN,
    PROJECT_TABS,
    PROJECT_TAB_OVERVIEW_ACTIVE,
    PROJECT_PANEL_RUNNING,
    PROJECT_PANEL_THREADS,
    PROJECT_PANEL_REPOS,
    PROJECT_PANEL_WORKFLOWS,
    PROJECT_RUNNING_EMPTY,
    PROJECT_REPOS_EMPTY,
    PROJECT_WORKFLOWS_EMPTY,
  ],
  "project-1b not-found": [PROJECT_NOT_FOUND_HEADING, PROJECT_NOT_FOUND, PROJECT_NOT_FOUND_BACK],
  "project-1b server-error": [
    PROJECT_UNAVAILABLE_HEADING,
    PROJECT_ERROR_SHELL,
    PROJECT_ERROR_PANEL,
  ],

  /* ---------------------------------------------- repo-1e · the repo page */
  "repo-1e repo": [
    REPO_PAGE,
    REPO_HEADING,
    REPO_CHAT_BOX,
    REPO_WORKFLOWS_PANEL,
    REPO_ISSUES_PANEL,
    REPO_ACTIVITY,
    REPO_RUNS_PANEL,
  ],
  "repo-1e not-found": [
    REPO_PAGE,
    REPO_FAILED_HEADING,
    REPO_NOT_FOUND_HEADING,
    REPO_NOT_FOUND,
    REPO_NOT_FOUND_BACK,
  ],
  // The design has no server-error render; the app's own rule (README) is that
  // a failed read keeps its heading and quotes the server, and the repos read now
  // follows it (#24): `repo-error-page` keeps the project breadcrumb and the
  // page's H1 (`Repository`) over the ProblemBanner, with a Retry beneath. The
  // banner no longer renders alone, so `repo-page`/`repo-header` remain in the
  // heading landmark's `any` only as the frames the neighbouring screens draw
  // (`repo-1e not-found` and the loaded page) — the failure screen is proven by
  // its own H1.
  "repo-1e server-error": [REPO_FAILED_HEADING, ERROR_PANEL],

  /* ------------------------------------------------ threads-1g · /threads */
  "threads-1g list": [THREADS_HEADING, THREADS_NEW, THREADS_SEARCH, THREADS_CHIPS, THREADS_LIST],
  "threads-1g thread": [
    THREADS_HEADING,
    THREADS_LIST,
    THREAD_TITLE,
    THREAD_CONTROL,
    THREAD_TRANSCRIPT,
    THREAD_COMPOSER,
    THREAD_SEND,
    THREAD_CONTEXT_DISCLOSURE,
  ],
  // A person who is not the controller sees the badge replaced by `Take
  // control` and the composer locked; the design's `Stop` is a live-turn
  // control, so it is not a landmark on any of these screens.
  "threads-1g not-controller": [
    THREADS_HEADING,
    THREADS_LIST,
    THREAD_TITLE,
    THREAD_CONTROL,
    THREAD_TRANSCRIPT,
    THREAD_COMPOSER,
    THREAD_CONTEXT_DISCLOSURE,
  ],
  "threads-1g took-control": [
    THREADS_HEADING,
    THREADS_LIST,
    THREAD_TITLE,
    THREAD_CONTROL,
    THREAD_TRANSCRIPT,
    THREAD_COMPOSER,
    THREAD_SEND,
    THREAD_CONTEXT_DISCLOSURE,
  ],
  "threads-1g server-error": [THREADS_HEADING, THREADS_NEW, THREADS_LIST_ERROR],

  /* ---------------------------- handoff-repo-chat-nav (rcn-* badges) */

  // The shell (2c/3c). These screens ARE the app shell, so their landmarks
  // read the whole page (Landmark.host) — the sidebar lives outside <main>.
  // At 390 the documented reflow replaces the column (and the rail) with the
  // phone top strip: every landmark carries that one tap as its alternate.
  "rcn-3c expanded": [
    RCN_COLUMN,
    RCN_NEW_CHAT,
    RCN_TODAY,
    RCN_MY_CHATS,
    RCN_PROJECTS_SECTION,
    RCN_LIBRARY_SECTION,
    RCN_EXPANDED_CONTROLS,
  ],
  "rcn-3c rail": [
    RCN_COLUMN,
    RCN_NEW_CHAT,
    RCN_TODAY,
    RCN_RAIL_TILES,
    RCN_LIBRARY_SECTION,
    RCN_RAIL_EXPAND,
  ],

  // The repo page's List view (3a): chat box on top, the one mixed activity
  // feed with its filter chips, and the WORKFLOWS / OPEN ISSUES side panels.
  "rcn-3a repo": [
    RCN_REPO_PAGE,
    RCN_REPO_BREADCRUMB,
    RCN_REPO_TITLE,
    RCN_VIEW_TOGGLE,
    RCN_CHAT_BOX,
    RCN_CHAT_INPUT,
    RCN_CHAT_PROFILE,
    RCN_CHAT_START,
    RCN_FILTER_CHIPS,
    RCN_ACTIVITY,
    RCN_WORKFLOWS_PANEL,
    RCN_WORKFLOW_ROW,
    RCN_WORKFLOW_TRIGGERS,
    RCN_WORKFLOW_RESULT,
    RCN_WORKFLOW_RUN,
    RCN_ISSUES_PANEL,
  ],
  // The same page with nothing said yet: the honest empty feed stands in for
  // the rows (the empty-error rule — a repo the pass created shows absences,
  // never invented rows).
  "rcn-3a repo-feed-empty": [
    RCN_REPO_PAGE,
    RCN_REPO_BREADCRUMB,
    RCN_REPO_TITLE,
    RCN_VIEW_TOGGLE,
    RCN_CHAT_BOX,
    RCN_CHAT_INPUT,
    RCN_CHAT_START,
    RCN_FILTER_CHIPS,
    RCN_ACTIVITY_EMPTY,
    RCN_WORKFLOWS_PANEL,
    RCN_ISSUES_PANEL,
  ],
  // The same page with the runs read failed (server-error.spec.ts's rule):
  // the page keeps its heading and owns the failure — a ProblemBanner with a
  // Retry, never a blank feed or the empty line standing in for the break.
  "rcn-3a server-error": [
    RCN_REPO_TITLE,
    RCN_CHAT_BOX,
    ERROR_PANEL,
    {
      id: "rcn-runs-retry",
      desc: "the activity feed's Retry on its failed runs read",
      any: [
        { testid: "repo-runs-retry" },
        { testid: "repo-activity-chats-retry" },
        { role: "button", name: /retry/i },
      ],
    },
  ],

  // The repo page's Lanes view (3b): the WORKFLOWS chip row and the four
  // lanes; the phone stacks them in one column (same testids, no swap).
  "rcn-3b lanes": [
    RCN_REPO_PAGE,
    RCN_REPO_BREADCRUMB,
    RCN_REPO_TITLE,
    RCN_VIEW_TOGGLE,
    RCN_LANES,
    RCN_LANE_WORKFLOWS,
    RCN_LANE_ISSUES,
    RCN_LANE_NEEDS_YOU,
    RCN_LANE_RUNNING,
    RCN_LANE_FINISHED,
  ],

  // The chat (2e) and the composer's agent picker (1h, the same screen with
  // the 'NEXT TURN RUNS ON' menu open). AGENTS IN THIS CHAT is asserted on
  // the switched beat only — it needs real turns to have turn ranges; a
  // landmark may never demand data the pass could not have served.
  "rcn-2e chat": [
    RCN_CONV_BREADCRUMB,
    RCN_CONV_TITLE,
    RCN_TRANSCRIPT,
    RCN_COMPOSER,
    RCN_SEND,
    RCN_AGENT_CHIP,
    THREAD_CONTROL,
    RCN_SIDE_PANEL,
    RCN_WORKS_IN,
    RCN_ASSISTANT_NOTE,
  ],
  "rcn-2e switched": [
    RCN_CONV_BREADCRUMB,
    RCN_CONV_TITLE,
    RCN_COMPOSER,
    RCN_AGENT_CHIP,
    RCN_SWITCH_DIVIDER,
    RCN_SIDE_PANEL,
    RCN_PANEL_AGENTS,
    RCN_AGENT_TURN_RANGE,
  ],
  "rcn-1h next-turn-menu": [RCN_CONV_TITLE, RCN_AGENT_CHIP, RCN_AGENT_MENU, RCN_AGENT_MENU_CAPTION, RCN_AGENT_MENU_PROFILES],

  // Thread → workflow (2f): the note's `Make a workflow…` opens the assistant
  // panel with the chat as context — the ask is the app's own canned line;
  // what the model answers with is never a landmark.
  "rcn-2f workflow-draft": [
    RCN_CONV_TITLE,
    RCN_ASSISTANT_PANEL,
    RCN_ASSISTANT_COMPOSER,
    RCN_ASSISTANT_ASK,
  ],

  // Agent mail (3d): the answered beat — the card with its answer block, and
  // the side panel's LINKED CHATS row with its state. The 390 side panel
  // rides the `thread-side-panel-stack` swap (REFLOW_ALLOWLIST names it).
  "rcn-3d mail-card": [
    RCN_CONV_TITLE,
    RCN_COMPOSER,
    RCN_MAIL_CARDS,
    RCN_MAIL_ANSWER,
    RCN_SIDE_PANEL,
    RCN_LINKED_CHATS,
    RCN_LINKED_CHAT_STATE,
  ],

  // Workflow inputs authoring (1j) on the workflow page, and the run-by-hand
  // form (1k) the repo row's Run opens.
  "rcn-1j inputs": [
    WF_BREADCRUMB,
    WF_TITLE,
    WF_TABS,
    RCN_TAB_INPUTS_ACTIVE,
    RCN_DRAFT_CHIP,
    RCN_INPUTS_TAB,
    RCN_INPUTS_PANEL,
    RCN_INPUTS_HEADER,
    RCN_INPUT_ADD,
    RCN_INPUT_ROWS,
    RCN_WHO_FILLS,
    RCN_WHO_FILLS_HAND,
    RCN_WHO_FILLS_TRIGGER,
    RCN_INPUTS_YAML,
  ],
  "rcn-1k run-form": [
    RCN_RUN_DIALOG,
    RCN_RUN_TITLE,
    RCN_RUN_SUBTITLE,
    RCN_RUN_FIELDS,
    RCN_RUN_HELPER,
    RCN_RUN_CANCEL,
    RCN_RUN_START,
  ],
  // `run-gate` and `artifact` have no design render (see the header), so the
  // run page's read-only graph needs no landmark entry of its own; the claim
  // that the run page is not an editor lives in the specs: no `edge-add-*` /
  // `add-after-*` affordance renders on /runs/:id (StudioCanvas renders the
  // `+` affordances only on an editable canvas).
};

/**
 * The landmarks a captured screen must show, or `undefined` when no entry
 * exists (which, for a badge that HAS a design render, is itself a defect).
 * Pass-varying names find their entry by shape.
 */
export function landmarksFor(badge: string, name: string): Landmark[] | undefined {
  const exact = DESIGN_LANDMARKS[`${badge} ${name}`];
  if (exact !== undefined) return exact;
  // `2e schedule-run-9c1e04f2` → `2e schedule-run-*`: a per-pass id collapses.
  const byShape = `${badge} ${name.replace(/[0-9a-f]{6,}/gi, "*")}`;
  return DESIGN_LANDMARKS[byShape];
}

/* ------------------------------------------------------------- the matcher */

const ESCAPE = (value: string): string => value.replace(/["\\]/g, "\\$&");

/** What "on this screen" means: the page's MAIN content, plus an open dialog
 * (which lives inside main today — named anyway so a portaled dialog is still
 * a landmark carrier and never a miss). */
function scopes(page: Page): Locator[] {
  return [
    page.locator("main"),
    page.locator('[role="dialog"], [role="alertdialog"], dialog[open]'),
  ];
}

function specLocator(scope: Locator, spec: LandmarkSpec): Locator {
  if ("testid" in spec) {
    const value = ESCAPE(spec.testid);
    // A trailing `*` is the prefix form: the slug-carrying testids the server
    // names can only be addressed by the part the design owns.
    const attribute = spec.testid.endsWith("*")
      ? `[data-testid^="${ESCAPE(spec.testid.slice(0, -1))}"]`
      : `[data-testid="${value}"]`;
    // `except` narrows the prefix: each excluded id is cut out of the match.
    const excluded = (spec.except ?? [])
      .map((testid) => `:not([data-testid="${ESCAPE(testid)}"])`)
      .join("");
    return scope.locator(`${attribute}${excluded}${spec.current ? '[aria-current="page"]' : ""}`);
  }
  if ("role" in spec) {
    return scope.getByRole(spec.role as Parameters<Locator["getByRole"]>[0], {
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...(spec.level === undefined ? {} : { level: spec.level }),
    });
  }
  return scope.getByText(spec.text);
}

/**
 * The landmarks of `landmarks` that this width does NOT show, in design order.
 * One page round trip per landmark: the specs union into one locator, and the
 * page answers whether ANY of its matches is rendered — the same rule the
 * reflow collectors use (`display:none`, `visibility:hidden` and a zero box are
 * not rendered; scroll position is irrelevant). `ANY`, not `first`: at 390 the
 * thread list pane is the hidden twin of the `← Threads` link that replaces it,
 * and it sits earlier in the DOM, so asking only about the first match would
 * read the documented reflow as a missing landmark.
 */
export async function missingLandmarks(
  page: Page,
  landmarks: Landmark[],
  width: number,
): Promise<Landmark[]> {
  const roots = scopes(page);
  // A `host: "page"` landmark searches the whole document — the app-shell
  // claim (the 2c/3c sidebar, the assistant popover) that lives outside
  // `<main>`. Nothing else opts into it; the per-page lists keep the strict
  // main-plus-dialog reading.
  const pageRoots = [page.locator("body")];
  const missing: Landmark[] = [];
  for (const landmark of landmarks) {
    if (landmark.only !== undefined && landmark.only !== width) continue;
    const scope = landmark.host === "page" ? pageRoots : roots;
    let candidate: Locator | null = null;
    for (const spec of landmark.any) {
      for (const root of scope) {
        const located = specLocator(root, spec);
        candidate = candidate === null ? located : candidate.or(located);
      }
    }
    const shown =
      candidate === null
        ? false
        : await candidate.evaluateAll((elements: Element[]) =>
            elements.some((el) => {
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") return false;
              const box = el.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            }),
          );
    if (!shown) missing.push(landmark);
  }
  return missing;
}
