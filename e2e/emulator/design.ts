// design.ts — the per-screen DESIGN LANDMARKS the emulator asserts at both
// widths (fixtures.ts `screen()`).
//
// Landmarks enforce the redesigned UI structure (docs/design/redesign/CONTRACT.md,
// docs/design/redesign/README.md, and docs/design/redesign/Prototype.dc.html) plus
// kept detail surfaces (run workbench 2b–2e, approval detail, repository rcn-1d,
// catch-up tour 8a–8b).
//
// A Landmark may include an optional `measure` expectation to verify key
// prototype layout dimensions (rail 64, top-bar 60, pill item 32, search 250,
// prompt box radius 14, editor nodes 168x56, wrap panel 340, versions 304,
// quick chat 400, manage nav 230, chat list 300, new workflow sheet 720).
import type { Locator, Page } from "@playwright/test";

export type LandmarkSpec =
  | { testid: string; current?: boolean; except?: string[] }
  | { selector: string }
  | { role: string; name?: RegExp | string; level?: number }
  | { text: RegExp };

export interface LandmarkMeasure {
  width?: number;
  height?: number;
  minHeight?: number;
  radius?: number;
  tol?: number;
  /** `"offset"` reads layout offsetWidth/offsetHeight (zoom-invariant for canvas nodes). */
  box?: "rect" | "offset";
}

export interface Landmark {
  id: string;
  desc: string;
  any: LandmarkSpec[];
  only?: 1280 | 390;
  host?: "page";
  measure?: LandmarkMeasure;
}

/* ------------------------------------------------------------------ shared */

const ERROR_PANEL: Landmark = {
  id: "error-panel",
  desc: "the error panel quoting the server's problem",
  any: [{ role: "alert" }],
};

/* ----------------------------------------------------------- App Shell (R1) */

export const SHELL_LANDMARKS: Landmark[] = [
  {
    id: "shell-rail",
    desc: "the 64px desktop project rail with All projects, Manage, Add project, Account",
    host: "page",
    only: 1280,
    any: [{ testid: "project-rail" }],
    measure: { width: 64 },
  },
  {
    id: "shell-rail-controls",
    desc: "All projects, Add project, Manage, and Account tiles in the desktop rail",
    host: "page",
    only: 1280,
    any: [{ testid: "rail-tile-all" }],
  },
  {
    id: "shell-rail-manage",
    desc: "the Manage icon button in the bottom of the desktop rail",
    host: "page",
    only: 1280,
    any: [{ testid: "rail-manage" }],
  },
  {
    id: "shell-top-bar",
    desc: "the 60px desktop top bar",
    host: "page",
    only: 1280,
    any: [{ testid: "top-bar" }],
    measure: { height: 60 },
  },
  {
    id: "shell-top-bar-phone",
    desc: "the 52px phone top bar",
    host: "page",
    only: 390,
    any: [{ testid: "top-bar" }],
    measure: { height: 52 },
  },
  {
    id: "shell-phone-scope-btn",
    desc: "the mobile project/manage sheet trigger below 768px",
    host: "page",
    only: 390,
    any: [{ testid: "scope-open" }],
  },
  {
    id: "shell-section-pill",
    desc: "the section pill (Home · Chats · Factory)",
    host: "page",
    any: [{ testid: "pill-home" }],
    only: 1280,
    measure: { height: 32 },
  },
  {
    id: "shell-section-pill-chats",
    desc: "the Chats item in the section pill",
    host: "page",
    any: [{ testid: "pill-chats" }],
  },
  {
    id: "shell-section-pill-factory",
    desc: "the Factory item in the section pill",
    host: "page",
    any: [{ testid: "pill-factory" }],
  },
  {
    id: "shell-search",
    desc: "the top-bar Search or ask field (250×32 on desktop)",
    host: "page",
    only: 1280,
    any: [{ testid: "search-or-ask" }],
    measure: { width: 250, height: 32 },
  },
  {
    id: "shell-mic",
    desc: "the Quick chat mic button in the top bar",
    host: "page",
    any: [{ testid: "top-bar-mic" }],
  },
];

/* --------------------------------------------------------------- Home (R2) */

const HOME_PROMPT_BOX: Landmark = {
  id: "home-prompt",
  desc: "the main prompt box with 14px radius",
  any: [{ testid: "home-prompt" }],
  measure: { radius: 14 },
};

const HOME_ALL_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "home-all-root", desc: "the Home (All projects) workspace", any: [{ testid: "home-all" }] },
  {
    id: "home-greeting",
    desc: "the time-of-day greeting heading",
    any: [{ testid: "home-greeting" }],
  },
  HOME_PROMPT_BOX,
  {
    id: "home-prompt-project",
    desc: "the project selector chip on the Home prompt box",
    any: [{ testid: "home-prompt-project" }],
  },
  {
    id: "home-prompt-agent",
    desc: "the agent selector chip on the Home prompt box",
    any: [{ testid: "home-prompt-agent" }],
  },
  {
    id: "home-since-you-left",
    desc: "the Since you left narrative feed or empty sentence",
    any: [{ testid: "since-you-left" }, { testid: "since-you-left-empty" }],
  },
  {
    id: "home-needs-you",
    desc: "the Needs you rail",
    any: [{ testid: "needs-you" }],
  },
  {
    id: "home-running",
    desc: "the Running rail",
    any: [{ testid: "running-list" }],
  },
  {
    id: "home-factory-health",
    desc: "the Factory health summary",
    any: [{ testid: "factory-health" }],
  },
];

const PROJECT_HOME_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  {
    id: "project-home-root",
    desc: "the scoped project home page",
    any: [{ testid: "project-home" }],
  },
  HOME_PROMPT_BOX,
  {
    id: "project-starters",
    desc: "the starter prompt pills row",
    any: [{ testid: "starter-pills" }],
  },
  {
    id: "project-happening-now",
    desc: "the Happening now strip",
    any: [{ testid: "happening-now" }],
  },
  {
    id: "project-since-you-left",
    desc: "the project's Since you left list",
    any: [{ testid: "since-you-left" }, { testid: "since-you-left-empty" }],
  },
  {
    id: "project-repos",
    desc: "the Repositories list in the project rail",
    any: [{ testid: "repo-list" }],
  },
  {
    id: "project-workflows-here",
    desc: "the Workflows here list in the project rail",
    any: [{ testid: "workflows-here" }],
  },
];

/* -------------------------------------------------------------- Chats (R3) */

const CHATS_LIST_COL: Landmark = {
  id: "chats-list",
  desc: "the 300px chat list column (or back link on phone thread)",
  only: 1280,
  any: [{ testid: "chat-list" }],
  measure: { width: 300 },
};

const CHATS_INDEX_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "chats-root", desc: "the Chats split view", any: [{ testid: "chats" }] },
  CHATS_LIST_COL,
  { id: "chat-search", desc: "the chat search box", any: [{ testid: "chat-search" }] },
  { id: "chat-new-btn", desc: "the New chat action button", any: [{ testid: "chat-new" }] },
];

const CHATS_NEW_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "chats-root", desc: "the Chats split view", any: [{ testid: "chats" }] },
  CHATS_LIST_COL,
  {
    id: "chat-new-pane",
    desc: "the centered New chat prompt pane",
    any: [{ testid: "chat-new-pane" }],
  },
  {
    id: "new-chat-prompt",
    desc: "the New chat prompt box (radius 14)",
    any: [{ testid: "new-chat-prompt" }],
    measure: { radius: 14 },
  },
  {
    id: "new-chat-input",
    desc: "the New chat prompt input",
    any: [{ testid: "new-chat-prompt-input" }],
  },
];

const CHATS_THREAD_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  CHATS_LIST_COL,
  { id: "chat-thread", desc: "the active chat thread column", any: [{ testid: "chat-thread" }] },
  { id: "chat-header", desc: "the 54px thread header", any: [{ testid: "chat-header" }] },
  { id: "chat-title", desc: "the chat title", any: [{ testid: "chat-title" }] },
  {
    id: "chat-back",
    desc: "the phone back button to the chat list",
    only: 390,
    any: [{ testid: "chat-back" }],
  },
  { id: "chat-menu", desc: "the header ⋯ menu button", any: [{ testid: "chat-menu" }] },
  { id: "chat-composer", desc: "the reply composer", any: [{ testid: "chat-composer" }] },
];

/* ------------------------------------------------------------ Factory (R4/R5) */

const FACTORY_INDEX_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  {
    id: "factory-index",
    desc: "the Factory workflow index",
    any: [{ testid: "factory-index" }],
  },
  {
    id: "factory-heading",
    desc: "the Factory heading",
    any: [{ role: "heading", name: /^Factory$/ }],
  },
  {
    id: "factory-summary",
    desc: "the live factory summary line",
    any: [{ testid: "factory-summary" }],
  },
  {
    id: "factory-new-btn",
    desc: "the New workflow button",
    any: [{ testid: "factory-new" }],
  },
  {
    id: "factory-new-card",
    desc: "the dashed New workflow card or workflow cards",
    any: [
      { testid: "factory-new-card" },
      { testid: "workflow-card-*" },
      { testid: "factory-empty" },
    ],
  },
];

const FACTORY_SHEET_LANDMARKS: Landmark[] = [
  ...FACTORY_INDEX_LANDMARKS,
  {
    id: "new-workflow-sheet",
    desc: "the New workflow creation sheet (720px on desktop)",
    any: [{ testid: "new-workflow-sheet" }],
    only: 1280,
    measure: { width: 720 },
  },
  {
    id: "new-workflow-sheet-phone",
    desc: "the New workflow creation bottom sheet",
    only: 390,
    any: [{ testid: "new-workflow-sheet" }],
  },
  {
    id: "new-workflow-description",
    desc: "the Describe it prompt field",
    any: [{ testid: "new-workflow-description" }],
  },
  {
    id: "new-workflow-sketch",
    desc: "the Sketch it action",
    any: [{ testid: "new-workflow-sketch" }],
  },
  {
    id: "new-workflow-blank",
    desc: "the Blank canvas row",
    any: [{ testid: "new-workflow-blank" }],
  },
  {
    id: "new-workflow-import",
    desc: "the Import YAML row",
    any: [{ testid: "new-workflow-import" }],
  },
];

/* ------------------------------------------------------ Workflow Editor (R5) */

const EDITOR_CANVAS_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "studio-page", desc: "the workflow editor workspace", any: [{ testid: "studio-page" }] },
  {
    id: "studio-canvas",
    desc: "the interactive dotted LR flow canvas",
    any: [{ testid: "studio-canvas" }],
  },
  {
    id: "add-bar",
    desc: "the add bar (editor interactions 1b)",
    any: [{ testid: "add-bar" }],
  },
  {
    id: "editor-top-actions",
    desc: "the top-right editor actions bar",
    any: [{ testid: "editor-top-actions" }],
  },
  {
    id: "editor-versions-btn",
    desc: "the Versions history button",
    any: [{ testid: "editor-versions-btn" }],
  },
  {
    id: "editor-try-it-btn",
    desc: "the Try it action button",
    any: [{ testid: "editor-try-it-btn" }],
  },
  {
    id: "studio-publish",
    desc: "the Make live primary button",
    any: [{ testid: "studio-publish" }],
  },
  {
    id: "editor-more-btn",
    desc: "the editor ⋯ overflow menu trigger",
    any: [{ testid: "editor-more-btn" }],
  },
  {
    id: "studio-nodes",
    desc: "at least one workflow step card at 168×56",
    any: [
      {
        selector:
          '[data-testid^="canvas-step-"]:not([data-testid^="canvas-step-tile-"]):not([data-testid^="canvas-step-fact-"]):not([data-testid^="canvas-step-row-"]) > [role="button"]',
      },
    ],
    measure: { width: 168, minHeight: 56, box: "offset" },
  },
];

const EDITOR_VERSIONS_LANDMARKS: Landmark[] = [
  ...EDITOR_CANVAS_LANDMARKS,
  {
    id: "versions-panel",
    desc: "the 304px Versions slide panel",
    only: 1280,
    any: [{ testid: "versions-panel" }],
    measure: { width: 304 },
  },
  {
    id: "versions-panel-phone",
    desc: "the Versions sheet on phone",
    only: 390,
    any: [{ testid: "versions-panel" }],
  },
];

const EDITOR_WRAP_LANDMARKS: Landmark[] = [
  ...EDITOR_CANVAS_LANDMARKS,
  {
    id: "wrap-panel",
    desc: "the 340px Wrap selected steps floating panel",
    only: 1280,
    any: [{ testid: "wrap-panel" }],
    measure: { width: 340 },
  },
  {
    id: "wrap-panel-phone",
    desc: "the Wrap selected steps sheet on phone",
    only: 390,
    any: [{ testid: "wrap-panel" }],
  },
];

const EDITOR_GOAL_LANDMARKS: Landmark[] = [
  ...EDITOR_CANVAS_LANDMARKS,
  {
    id: "goal-frame",
    desc: "the blue repeat-until GoalFrame around wrapped steps",
    any: [{ testid: "goal-frame" }],
  },
];

/* ------------------------------------------------- Quick chat & Assistant (R6) */

const QUICK_CHAT_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  {
    id: "quick-chat",
    desc: "the 400px docked Quick chat panel",
    host: "page",
    only: 1280,
    any: [{ testid: "quick-chat" }],
    measure: { width: 400 },
  },
  {
    id: "quick-chat-phone",
    desc: "the full-width Quick chat panel on phone",
    host: "page",
    only: 390,
    any: [{ testid: "quick-chat" }],
  },
  {
    id: "quick-chat-header",
    desc: "the Quick chat panel header",
    host: "page",
    any: [{ testid: "assistant-panel-header" }],
  },
  {
    id: "quick-chat-open-as-chat",
    desc: "the Open as chat link to /assistant",
    host: "page",
    any: [{ testid: "quick-chat-open-as-chat" }],
  },
  {
    id: "quick-chat-composer",
    desc: "the assistant composer input",
    host: "page",
    any: [{ testid: "assistant-composer-input" }],
  },
  {
    id: "quick-chat-pill",
    desc: "the trust pill",
    host: "page",
    any: [{ testid: "assistant-pill" }],
  },
  {
    id: "quick-chat-context",
    desc: "the page-context indicator",
    host: "page",
    any: [{ testid: "assistant-context-button" }],
  },
];

/* ----------------------------------------------------------- Manage (R7) */

const MANAGE_SHELL_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "manage-root", desc: "the Manage container", any: [{ testid: "manage" }] },
  {
    id: "manage-nav-desktop",
    desc: "the 230px Manage left sub-nav",
    only: 1280,
    any: [{ testid: "manage-nav" }],
    measure: { width: 230 },
  },
  {
    id: "manage-nav-phone",
    desc: "the horizontal Manage sub-nav pill strip on phone",
    only: 390,
    any: [{ testid: "manage-nav" }],
  },
  {
    id: "manage-nav-projects",
    desc: "Projects nav item",
    any: [{ testid: "manage-nav-projects" }],
  },
  { id: "manage-nav-runners", desc: "Runners nav item", any: [{ testid: "manage-nav-runners" }] },
  {
    id: "manage-nav-agents",
    desc: "Agents & models nav item",
    any: [{ testid: "manage-nav-agents" }],
  },
  {
    id: "manage-content",
    desc: "the Manage main content pane",
    any: [{ testid: "manage-content" }],
  },
];

/* -------------------------------------------------------- Kept Detail Screens */

const WORKBENCH_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  {
    id: "run-header",
    desc: "the live run header",
    any: [{ testid: "run-header-status" }, { testid: "workbench-header" }],
  },
  {
    id: "run-workbench-canvas",
    desc: "the run graph canvas or timeline",
    any: [
      { testid: "workbench-canvas" },
      { testid: "studio-canvas" },
      { testid: "run-nodes-list" },
    ],
  },
];

const REPO_PAGE_LANDMARKS: Landmark[] = [
  ...SHELL_LANDMARKS,
  { id: "repo-page", desc: "the Repository detail page", any: [{ testid: "repo-page" }] },
];

/* ------------------------------------------------------------- Map by screen */

export const DESIGN_LANDMARKS: Record<string, Landmark[]> = {
  // Home
  "home all": HOME_ALL_LANDMARKS,
  "home not-available": HOME_ALL_LANDMARKS.map((lm) =>
    lm.id === "home-needs-you"
      ? {
          id: "home-not-available",
          desc: "honest unavailability note",
          any: [{ testid: "home-not-available" }],
        }
      : lm,
  ),
  "home error": [...SHELL_LANDMARKS, ERROR_PANEL],
  "project home": PROJECT_HOME_LANDMARKS,
  "project error": [...SHELL_LANDMARKS, ERROR_PANEL],
  "project not-found": [
    ...SHELL_LANDMARKS,
    {
      id: "project-not-found",
      desc: "honest project not-found state",
      any: [{ testid: "project-not-found" }],
    },
  ],

  // Chats
  "chats list": CHATS_INDEX_LANDMARKS,
  "chats new": CHATS_NEW_LANDMARKS,
  "chats thread": CHATS_THREAD_LANDMARKS,
  "chats suggestion": [
    ...CHATS_THREAD_LANDMARKS,
    {
      id: "workflow-suggestion",
      desc: "the inline Run workflow instead pill",
      any: [{ testid: "workflow-suggestion" }],
    },
  ],
  "chats run-card": [
    ...CHATS_THREAD_LANDMARKS,
    { id: "run-card", desc: "the inline embedded run card", any: [{ testid: "run-card-*" }] },
  ],
  "chats error": [...SHELL_LANDMARKS, ERROR_PANEL],

  // Factory
  "factory index": FACTORY_INDEX_LANDMARKS,
  "factory empty": [...FACTORY_INDEX_LANDMARKS],
  "factory sheet": FACTORY_SHEET_LANDMARKS,
  "factory error": [
    ...SHELL_LANDMARKS,
    {
      id: "factory-error",
      desc: "Factory error banner",
      any: [{ testid: "factory-load-error" }, { role: "alert" }],
    },
  ],

  // Editor
  "editor canvas": EDITOR_CANVAS_LANDMARKS,
  "editor versions": EDITOR_VERSIONS_LANDMARKS,
  "editor wrap": EDITOR_WRAP_LANDMARKS,
  "editor goal": EDITOR_GOAL_LANDMARKS,
  "editor yaml": [
    ...EDITOR_CANVAS_LANDMARKS,
    { id: "editor-panel-yaml", desc: "the YAML drawer", any: [{ testid: "editor-panel-yaml" }] },
  ],
  "editor used-in": [
    ...EDITOR_CANVAS_LANDMARKS,
    {
      id: "editor-panel-used-in",
      desc: "the Used in drawer",
      any: [{ testid: "editor-panel-used-in" }],
    },
  ],
  "editor inputs": [
    ...EDITOR_CANVAS_LANDMARKS,
    {
      id: "editor-panel-inputs",
      desc: "the Inputs drawer",
      any: [{ testid: "editor-panel-inputs" }],
    },
  ],
  "editor proposal": [
    ...EDITOR_CANVAS_LANDMARKS,
    {
      id: "proposal-bar",
      desc: "the assistant proposal bar (editor interactions 1d)",
      any: [{ testid: "proposal-bar" }],
    },
  ],
  "editor error": [
    ...SHELL_LANDMARKS,
    {
      id: "studio-error-page",
      desc: "Studio error page",
      any: [{ testid: "studio-error-page" }, { role: "alert" }],
    },
  ],

  // Quick chat & Search & Assistant page
  "quick-chat open": QUICK_CHAT_LANDMARKS,
  "quick-chat palette": [
    ...SHELL_LANDMARKS,
    {
      id: "palette-dialog",
      desc: "the Search or ask command palette",
      host: "page",
      any: [{ role: "dialog", name: "Search or ask" }],
    },
    {
      id: "palette-input",
      desc: "the palette search input",
      host: "page",
      any: [{ testid: "palette-input" }],
    },
    {
      id: "palette-ask",
      desc: "the Ask Quick chat fallback row",
      host: "page",
      any: [{ testid: "palette-ask" }],
    },
  ],
  "assistant page": [
    ...SHELL_LANDMARKS,
    { id: "assistant-page", desc: "the full /assistant page", any: [{ testid: "assistant-page" }] },
    {
      id: "assistant-page-threads",
      desc: "the assistant threads list",
      only: 1280,
      any: [{ testid: "assistant-page-threads" }],
    },
    {
      id: "assistant-page-side",
      desc: "the assistant context/trust column",
      only: 1280,
      any: [{ testid: "assistant-page-side" }],
    },
    {
      id: "assistant-composer-input",
      desc: "the assistant composer input",
      any: [{ testid: "assistant-composer-input" }],
    },
  ],

  // Manage
  "manage projects": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-projects",
      desc: "the Manage → Projects section",
      any: [{ testid: "manage-projects" }],
    },
  ],
  "manage project-detail": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-project-detail",
      desc: "the single project detail section",
      any: [{ testid: "manage-project-detail" }],
    },
  ],
  "manage repositories": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-repositories",
      desc: "the Manage → Repositories section",
      any: [{ testid: "manage-repositories" }],
    },
  ],
  "manage people": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-people",
      desc: "the Manage → People section",
      any: [{ testid: "manage-people" }],
    },
  ],
  "manage runners": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-runners",
      desc: "the Manage → Runners section",
      any: [{ testid: "manage-runners" }],
    },
    {
      id: "manage-runners-table",
      desc: "the Runners status table",
      any: [{ testid: "manage-runners-table" }],
    },
  ],
  "manage agents": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-agents",
      desc: "the Manage → Agents & models section",
      any: [{ testid: "manage-agents" }],
    },
    {
      id: "agent-accounts",
      desc: "the Connected agent accounts strip",
      any: [{ testid: "agent-accounts" }],
    },
    {
      id: "agents-tabs",
      desc: "the Profiles · Models · Skills · Steps · Assistant tabs",
      any: [{ testid: "agents-tabs" }],
    },
    { id: "profiles-table", desc: "the agent profiles table", any: [{ testid: "profiles-table" }] },
  ],
  "manage agents-assistant": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-agents",
      desc: "the Manage → Agents & models section",
      any: [{ testid: "manage-agents" }],
    },
    { id: "agents-tabs", desc: "the Agents tabs", any: [{ testid: "agents-tabs" }] },
    {
      id: "settings-assistant",
      desc: "the Assistant settings tab body",
      any: [{ testid: "settings-assistant" }, { testid: "settings-assistant-trust-table" }],
    },
  ],
  "manage secrets": [
    ...MANAGE_SHELL_LANDMARKS,
    {
      id: "manage-secrets",
      desc: "the Manage → Secrets section",
      any: [{ testid: "manage-secrets" }],
    },
  ],
  "manage error": [...MANAGE_SHELL_LANDMARKS, ERROR_PANEL],

  // Kept run, approval, repo, and catch-up screens
  "2b workbench": WORKBENCH_LANDMARKS,
  "2c run-gate": [
    ...SHELL_LANDMARKS,
    {
      id: "gate-decide",
      desc: "the inline gate decision bar",
      any: [{ testid: "decision-bar" }, { role: "button", name: /^Approve$/ }],
    },
  ],
  "2d artifacts": [
    ...SHELL_LANDMARKS,
    {
      id: "artifacts-pane",
      desc: "the Artifacts tab list and Download button",
      any: [{ role: "button", name: /Download/i }, { testid: "artifact-preview-prose" }],
    },
  ],
  "2e schedule-run-*": REPO_PAGE_LANDMARKS,
  "approval detail": [
    ...SHELL_LANDMARKS,
    {
      id: "approval-decide-bar",
      desc: "the approval detail DecisionBar",
      any: [{ testid: "decision-bar" }],
    },
  ],
  "repo detail": REPO_PAGE_LANDMARKS,
  "repo error": [...SHELL_LANDMARKS, ERROR_PANEL],
  "8a catchup-item": [
    ...SHELL_LANDMARKS,
    {
      id: "catchup-item-current",
      desc: "the catch-up piece current frame",
      any: [{ testid: "catchup-item-current" }],
    },
  ],
  "8b catchup-tour": [
    {
      id: "tour-player",
      desc: "the full-screen guided catch-up tour",
      host: "page",
      any: [{ testid: "tour-player" }],
    },
    {
      id: "tour-current",
      desc: "the guided catch-up tour frame",
      host: "page",
      any: [{ testid: "tour-current" }],
    },
  ],
  "shell desktop": SHELL_LANDMARKS,
  "shell phone-sheet": [
    ...SHELL_LANDMARKS,
    {
      id: "scope-sheet",
      desc: "the mobile project & manage sheet (emu.screen visits 1280 before 390, which closes Shell's phone-only sheet; repo-chat-nav checks scope-sheet visibility explicitly at 390 before calling emu.screen)",
      host: "page",
      only: 390,
      any: [{ testid: "scope-sheet" }, { testid: "scope-open" }],
    },
  ],
  "2c trigger-edit-pause": [
    ...SHELL_LANDMARKS,
    { id: "trigger-dialog", desc: "the open trigger edit dialog", any: [{ role: "dialog" }] },
  ],
  "2c dialog-schedule": [
    ...SHELL_LANDMARKS,
    { id: "trigger-dialog", desc: "the open schedule trigger dialog", any: [{ role: "dialog" }] },
  ],
  "2c dialog-issue": [
    ...SHELL_LANDMARKS,
    { id: "trigger-dialog", desc: "the open issue trigger dialog", any: [{ role: "dialog" }] },
  ],
  "2c schedule-trigger-saved": REPO_PAGE_LANDMARKS,
  "2c issue-trigger-saved": REPO_PAGE_LANDMARKS,
  "2e repo": REPO_PAGE_LANDMARKS,
  "2e triggers-paused": REPO_PAGE_LANDMARKS,
  "2e schedule-run-approved": WORKBENCH_LANDMARKS,
  "rcn-3a repo-notes": REPO_PAGE_LANDMARKS,
  "rcn-3a repo-feed-empty": REPO_PAGE_LANDMARKS,
  "rcn-3a repo": REPO_PAGE_LANDMARKS,
  "rcn-3a server-error": [...SHELL_LANDMARKS, ERROR_PANEL],
  "rcn-3b lanes": REPO_PAGE_LANDMARKS,
  "rcn-3b lanes-drag": REPO_PAGE_LANDMARKS,
  "rcn-3b lanes-running": REPO_PAGE_LANDMARKS,
  "rcn-1k run-form": REPO_PAGE_LANDMARKS,
  "rcn-1k run-form-fields": REPO_PAGE_LANDMARKS,
  "rcn-2e chat": CHATS_THREAD_LANDMARKS,
  "rcn-2e switched": CHATS_THREAD_LANDMARKS,
  "rcn-2e works-in-moved": CHATS_THREAD_LANDMARKS,
  "rcn-3d mail-card": CHATS_THREAD_LANDMARKS,
  "rcn-2e chat-details": [
    ...CHATS_THREAD_LANDMARKS,
    {
      id: "chat-details-sheet",
      desc: "the chat details sheet",
      any: [{ testid: "chat-details-sheet" }],
    },
  ],
  "rcn-2e chat-details-switched": [
    ...CHATS_THREAD_LANDMARKS,
    {
      id: "chat-details-sheet",
      desc: "the chat details sheet",
      any: [{ testid: "chat-details-sheet" }],
    },
  ],
  "rcn-2e works-in-menu": [
    ...CHATS_THREAD_LANDMARKS,
    {
      id: "chat-details-sheet",
      desc: "the chat details sheet",
      any: [{ testid: "chat-details-sheet" }],
    },
  ],
  "rcn-1h next-turn-menu": [
    ...CHATS_THREAD_LANDMARKS,
    {
      id: "composer-agent-menu",
      desc: "the next-turn agent picker menu",
      host: "page",
      any: [{ testid: "composer-agent-menu" }, { testid: "agent-picker-popover" }],
    },
  ],
  "rcn-2f workflow-draft": QUICK_CHAT_LANDMARKS,
  "rcn-1j inputs": [
    ...EDITOR_CANVAS_LANDMARKS,
    {
      id: "editor-panel-inputs",
      desc: "the Inputs drawer",
      any: [{ testid: "editor-panel-inputs" }],
    },
  ],
};

export function landmarksFor(badge: string, name: string): Landmark[] | undefined {
  const exact = DESIGN_LANDMARKS[`${badge} ${name}`];
  if (exact !== undefined) return exact;
  const byShape = `${badge} ${name.replace(/[0-9a-f]{6,}/gi, "*")}`;
  return DESIGN_LANDMARKS[byShape];
}

/* ------------------------------------------------------------- the matcher */

const ESCAPE = (value: string): string => value.replace(/["\\]/g, "\\$&");

function scopes(page: Page): Locator[] {
  return [
    page.locator("main"),
    page.locator('[role="dialog"], [role="alertdialog"], dialog[open]'),
  ];
}

function specLocator(scope: Locator, spec: LandmarkSpec): Locator {
  if ("selector" in spec) {
    return scope.locator(spec.selector);
  }
  if ("testid" in spec) {
    const value = ESCAPE(spec.testid);
    const attribute = spec.testid.endsWith("*")
      ? `[data-testid^="${ESCAPE(spec.testid.slice(0, -1))}"]`
      : `[data-testid="${value}"]`;
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

export async function missingLandmarks(
  page: Page,
  landmarks: Landmark[],
  width: number,
): Promise<Landmark[]> {
  const roots = scopes(page);
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
    const measure = landmark.measure ?? null;
    const shown =
      candidate === null
        ? false
        : await candidate.evaluateAll(
            (elements: Element[], m: LandmarkMeasure | null) =>
              elements.some((el) => {
                const cs = window.getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") return false;
                const box = el.getBoundingClientRect();
                if (box.width <= 0 || box.height <= 0) return false;
                if (!m) return true;
                const tol = m.tol ?? 2;
                const w = m.box === "offset" ? (el as HTMLElement).offsetWidth : box.width;
                const h = m.box === "offset" ? (el as HTMLElement).offsetHeight : box.height;
                if (m.width !== undefined && Math.abs(w - m.width) > tol) return false;
                if (m.height !== undefined && Math.abs(h - m.height) > tol) return false;
                if (m.minHeight !== undefined && h < m.minHeight - tol) return false;
                if (m.radius !== undefined) {
                  const r = parseFloat(cs.borderTopLeftRadius || "0");
                  if (Number.isNaN(r) || Math.abs(r - m.radius) > tol) return false;
                }
                return true;
              }),
            measure,
          );
    if (!shown) missing.push(landmark);
  }
  return missing;
}
