/**
 * The sidebar column (`components/Sidebar.tsx`): projects are ALWAYS the tree
 * (redesign finding 10 removed the switcher mode and its preference), with the
 * repository list hidden until the chevron opens it; opening writes the
 * `expanded` preference (`project:<id>` key) through the same
 * `PATCH /api/v1/me/preferences` the settings page uses — the library rows, the
 * "⋯" menu and the worst-state flags are all read off the same real endpoints
 * Inbox reads, so the column cannot disagree with it. The pure flag rules
 * themselves are covered by `lib/sidebarFlags.test.ts`.
 *
 * Finding 08: the row above the nav holds `New thread` and the `Search ⌘K`
 * field (`sidebar-search`), which opens the jump palette; `Ask` is no longer a
 * sidebar row at all (it is the floating ⌘J button `Shell` draws). Finding 8a:
 * the `Catch up` row sits right after Today and badges the unseen count.
 *
 * The column's two widths are the same contract: `sidebarCollapsed` is the
 * saved preference that trades the 220px column for the 52px rail (redesign
 * 3a/4a). The rail is icons under dark hover/focus labels; the one tile with
 * children (Projects) opens a click-surface `ds/Popover` that carries the
 * projects, their state counts and the active project's repositories; the
 * edge drags past 120px snap between the two widths.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import {
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  repositoryId,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { wireApproval, wirePipelineList, wireRun } from "../test/fixtures/m4/wire";
import type { Repository } from "../api/types";

/** Wait budget for the first round trips the sidebar waits on. */
const READ_MS = 5_000;

/** Answer the shell\u2019s frame queries (phone <768, rail 768\u20131023) as a
 * `width` px viewport would (the same helper `Shell.test.tsx` uses). */
const nativeMatchMedia = window.matchMedia;

function stubViewport(width: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /\(max-width: ([\d.]+)px\)/.exec(query);
    const min = /\(min-width: ([\d.]+)px\)/.exec(query);
    let matches = true;
    if (min) matches = matches && width >= Number(min[1]);
    if (max) matches = matches && width <= Number(max[1]);
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  });
}

const P = projectFixture.id;
const PREFS_PATH = "/api/v1/me/preferences";

const repoFixture: Repository = {
  id: repositoryId,
  project_id: P,
  name: "acme-widgets",
  git_url: "https://git.example.com/acme/widgets.git",
  default_branch: "main",
  created_at: "2026-07-01T10:00:00Z",
};

/**
 * A stored layout document. It still carries the three settings finding 10 cut
 * (`projects_mode`, `ask_placement`, `show_workflow_folders`): the server owns
 * that shape and the client reads and ignores them, so every test here runs
 * over a document an install would really answer with.
 */
function prefsDoc(
  expanded: Record<string, boolean> = {},
  cut?: { projects_mode?: string; ask_placement?: string; show_workflow_folders?: boolean },
): unknown {
  return {
    layout: {
      projects_mode: cut?.projects_mode ?? "tree",
      ask_placement: cut?.ask_placement ?? "sidebar",
      show_workflow_folders: cut?.show_workflow_folders ?? true,
      expanded,
    },
    assistant: { trust_level: "ask_risky" },
    updated_at: "2026-01-01T00:00:00Z",
  };
}

interface StubOverrides {
  projects?: unknown;
  runs?: unknown;
  prefs?: unknown;
  extra?: RouteStub[];
}

/** Everything the column reads, against the one fixture project. */
function baseRoutes({ projects, runs, prefs, extra = [] }: StubOverrides = {}): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: projects ?? { items: [projectFixture] } },
    { path: `/api/v1/projects/${P}/repos`, body: { items: [repoFixture] } },
    { path: `/api/v1/projects/${P}/approvals`, body: { approvals: [] } },
    { path: `/api/v1/projects/${P}/runs`, body: runs ?? { runs: [] } },
    { path: `/api/v1/projects/${P}/conversations`, body: { items: [] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: PREFS_PATH, method: "GET", body: prefs ?? prefsDoc() },
    ...extra,
  ];
}

describe("the sidebar tree (the default placement)", () => {
  // Issue #61: the brand (mark + wordmark) is a logo, not text — a link
  // home that never highlights or drags. (Centring of the mark's box with
  // the wordmark's is a layout property, verified live in the browser at
  // 1280 and 390; jsdom lays nothing out.)
  it("brands the column a non-selectable, non-draggable home link", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const brand = within(sidebar).getByTestId("brand-home");
    expect(brand.tagName).toBe("A");
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.getAttribute("draggable")).toBe("false");
    expect(brand.className).toContain("select-none");
    expect(brand.textContent).toContain("Communication");
    // The C mark inside carries its own select-none/draggable guard.
    const mark = within(brand).getByRole("img", { name: "Communication" });
    expect(mark.className).toContain("select-none");
    expect(mark.getAttribute("draggable")).toBe("false");
  });

  it("lists Today and Threads with the current row marked, and the library rows", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });

    expect(screen.getByTestId("sidebar-link-home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("sidebar-link-threads").getAttribute("aria-current")).toBeNull();
    // Handoff 2c/3c: Board and Inbox are not nav rows — Today carries what
    // needs a person, and the Board's behavior moved to the repository page.
    expect(screen.queryByTestId("sidebar-link-inbox")).toBeNull();
    expect(screen.queryByTestId("sidebar-link-board")).toBeNull();

    const scope = within(sidebar);
    await screen.findByText("Widgets", undefined, { timeout: READ_MS });
    expect(scope.getByText("PROJECTS")).toBeTruthy();
    expect(scope.getByText("Widgets")).toBeTruthy();
    // Collapsed by default: the chevron is closed and no repository shows.
    const toggle = scope.getByTestId(`sidebar-project-toggle-${P}`);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Issue #68: the 16px chevron stays painted as is; the shared `.icon-hit`
    // utility gives it a ≥28×28 hit area at desktop.
    expect(toggle.className.split(/\s+/)).toContain("icon-hit");
    expect(scope.queryByText("acme-widgets")).toBeNull();

    // Finding 02: Workflows and Agents are top-level rows (the LIBRARY block
    // is gone, Steps is a tab of the Workflows page, not a row). Real counts
    // for what the API counts; the Agents row says "Agents" over the testid
    // and route the profiles page kept.
    await waitFor(() => {
      expect(scope.getByTestId("sidebar-link-workflows").textContent).toContain("2");
    });
    expect(scope.queryByTestId("sidebar-link-steps")).toBeNull();
    expect(scope.queryByText("LIBRARY")).toBeNull();
    expect(scope.getByTestId("sidebar-link-profiles").textContent).toContain("Agents");
    expect(scope.getByTestId("sidebar-link-profiles").textContent).toContain("0");

    // Finding 8a: the Catch up row sits directly after Today.
    expect(scope.getByTestId("sidebar-link-catch-up").getAttribute("href")).toBe("/catch-up");
    const rows = Array.from(sidebar.querySelectorAll('[data-testid^="sidebar-link-"]'));
    expect(rows.map((row) => row.getAttribute("data-testid")).slice(0, 2)).toEqual([
      "sidebar-link-home",
      "sidebar-link-catch-up",
    ]);

    // Finding 08: the sidebar's second entry is the labelled SEARCH field, not
    // a bare chord button and not Ask (Ask is `Shell`'s floating ⌘J button).
    const search = scope.getByTestId("sidebar-search");
    expect(search.textContent).toContain("Search");
    expect(search.textContent).toContain("⌘K");
    expect(search.getAttribute("aria-label")).toBe("Search or jump (⌘K)");
    expect(scope.queryByTestId("ask-sidebar")).toBeNull();
    fireEvent.click(search);
    expect(
      await screen.findByTestId("palette-input", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
  });

  // Finding 8a: the badge is the reader's own unseen count, in accent ink.
  it("badges the Catch up row with the unseen count from the catch-up read", async () => {
    renderApp({
      path: "/",
      routes: [
        ...baseRoutes(),
        {
          path: "/api/v1/catch-up/items",
          body: { items: [], total_unseen: 3, oldest_unseen_at: "2026-01-01T00:00:00Z" },
        },
      ],
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const badge = await within(sidebar).findByText("3 unseen", undefined, { timeout: READ_MS });
    expect(badge.className).toContain("text-accent-edge");
  });

  it("prints no Catch up number while the read has not answered or has failed", async () => {
    renderApp({
      path: "/",
      routes: baseRoutes().map((stub) =>
        stub.path === "/api/v1/catch-up/items" ? { ...stub, status: 500 } : stub,
      ),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    await within(sidebar).findByTestId("sidebar-link-workflows", undefined, { timeout: READ_MS });
    expect(within(sidebar).queryByText(/unseen/)).toBeNull();
  });

  // 2c/3c: the row labels the design names — Home became Today (same `/`),
  // Threads kept its name (finding 01: the row, the button and the page all
  // say thread).
  it("names the two cross-project rows Today and Threads", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    expect(scope.getByTestId("sidebar-link-home").textContent).toContain("Today");
    expect(scope.queryByText("Home", { exact: true })).toBeNull();
    expect(scope.getByTestId("sidebar-link-threads").textContent).toContain("Threads");
    expect(scope.queryByText("My chats")).toBeNull();
    // Finding 01: the button that starts one says the same word.
    expect(scope.getByTestId("new-chat").textContent).toBe("New thread");
  });

  it("persists the expansion through a preferences PATCH and opens the repo list", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: baseRoutes({
        extra: [
          {
            path: PREFS_PATH,
            method: "PATCH",
            body: prefsDoc({ [`project:${P}`]: true }),
          },
        ],
      }),
    });
    const toggle = await screen.findByTestId(`sidebar-project-toggle-${P}`, undefined, {
      timeout: READ_MS,
    });
    fireEvent.click(toggle);

    // The saved preference carries the `project:<id>` key, exactly once.
    await waitFor(() => {
      const patch = requestsTo(requests, PREFS_PATH, "PATCH");
      expect(patch).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}");
    expect(sent.layout.expanded[`project:${P}`]).toBe(true);

    // The PATCH answers with the expanded document: the column re-reads it and
    // the repository row appears under the project.
    await screen.findByText("acme-widgets", undefined, { timeout: READ_MS });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the route opens its project and marks its repository (Projects Review 1b/1e)", () => {
  const projectPath = `/api/v1/projects/${P}`;
  const reposPath = `/api/v1/projects/${P}/repos`;

  /** The column's reads at a project route, with the PATCH the auto-expand
   * answers (an optional per-call body drives the collapse-sticks case). */
  function projectRoutes(patchBody?: unknown): RouteStub[] {
    return baseRoutes({
      extra: [
        { path: projectPath, body: projectFixture },
        {
          path: PREFS_PATH,
          method: "PATCH",
          body: patchBody ?? prefsDoc({ [`project:${P}`]: true }),
        },
      ],
    });
  }

  it("opens the project the route is inside without a click", async () => {
    const { requests } = renderApp({ path: `/p/${P}`, routes: projectRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const toggle = within(sidebar).getByTestId(`sidebar-project-toggle-${P}`);

    // Arriving at the project expands the node and its repository list
    // rides the sidebar's own lazy repos read — no new endpoint.
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"), {
      timeout: READ_MS,
    });
    expect(within(sidebar).getByText("acme-widgets")).toBeTruthy();
    await waitFor(() => expect(requestsTo(requests, reposPath).length).toBeGreaterThan(0), {
      timeout: READ_MS,
    });
    // The expansion goes through the same saved preference PATCH a click uses.
    const patches = requestsTo(requests, PREFS_PATH, "PATCH");
    expect(patches.length).toBeGreaterThan(0);
    expect(JSON.parse(patches[0].body ?? "{}").layout.expanded[`project:${P}`]).toBe(true);
  });

  it("marks the repository row of a repository page aria-current=page", async () => {
    renderApp({ path: `/p/${P}/acme-widgets`, routes: projectRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const toggle = within(sidebar).getByTestId(`sidebar-project-toggle-${P}`);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"), {
      timeout: READ_MS,
    });

    const row = within(sidebar).getByRole("link", { name: "acme-widgets" });
    expect(row.getAttribute("aria-current")).toBe("page");
    // The same active treatment the Workflows row carries: the ink border.
    expect(row.className.split(/\s+/)).toContain("border-ink");
    // A repository page that is not open in the tree stays unmarked: only
    // the sidebar's own row answers for the route.
    expect(
      within(sidebar)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.getAttribute("href")),
    ).toContain(`/p/${P}/acme-widgets`);
  });

  it("keeps a manual collapse while the route stays in the project", async () => {
    // The PATCH answers: call 1 confirms the auto-expand, call 2 confirms
    // the manual collapse and holds it closed.
    const { requests } = renderApp({
      path: `/p/${P}`,
      routes: projectRoutes((n: number) => prefsDoc(n === 1 ? { [`project:${P}`]: true } : {})),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const toggle = within(sidebar).getByTestId(`sidebar-project-toggle-${P}`);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"), {
      timeout: READ_MS,
    });

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"), {
      timeout: READ_MS,
    });
    expect(within(sidebar).queryByText("acme-widgets")).toBeNull();

    // The route never moved, so the auto-expand must not fight back: after
    // everything settles the node is still closed, and exactly the two
    // writes (expand, collapse) went to the preferences endpoint.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(sidebar).queryByText("acme-widgets")).toBeNull();
    const patches = requestsTo(requests, PREFS_PATH, "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(patches[1].body ?? "{}").layout.expanded[`project:${P}`]).toBe(false);
  });
});

// Finding 10: `projectsMode` is gone — the switcher component does not exist,
// and a document saved while the setting did (including `projects_mode:
// "switcher"`) still renders the tree with no error and no second navigator.
describe("projects are always the tree (finding 10)", () => {
  it("ignores a stored projects_mode and renders the tree, not a switcher", async () => {
    renderApp({
      path: "/",
      routes: baseRoutes({ prefs: prefsDoc({}, { projects_mode: "switcher" }) }),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);

    await screen.findByText("Widgets", undefined, { timeout: READ_MS });
    expect(scope.getByText("PROJECTS")).toBeTruthy();
    expect(scope.queryByText("PROJECT")).toBeNull();
    // The switcher's own surface is gone from the column entirely.
    expect(scope.queryByTestId("project-switcher")).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Projects" })).toBeNull();
    // And the tree behaves as the tree always did: one closed chevron.
    expect(scope.getByTestId(`sidebar-project-toggle-${P}`).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("the tree's ⋯ menu is the only anchored surface with a pointer arrow", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    // Closed: no arrow anywhere (the arrow belongs to an open anchored list).
    expect(sidebar.querySelector('[data-testid="menu-arrow"]')).toBeNull();
  });
});

describe("the sidebar workflow folders (ADR-0049 § 8)", () => {
  /** The wire list with two rows filed under `Delivery` and one unfiled. */
  const folderedList = {
    pipelines: [
      {
        id: "p-1",
        slug: "delivery-flow-a",
        display_name: "Delivery A",
        latest_revision_number: 1,
        revision_count: 1,
        archived: false,
        folder: "Delivery",
      },
      {
        id: "p-2",
        slug: "delivery-flow-b",
        display_name: "Delivery B",
        latest_revision_number: 0,
        revision_count: 0,
        archived: false,
        folder: "Delivery",
      },
      {
        id: "p-3",
        slug: "loose-flow",
        display_name: "Loose flow",
        latest_revision_number: 0,
        revision_count: 0,
        archived: false,
        folder: null,
      },
    ],
  };

  function folderRoutes(
    extra: RouteStub[] = [],
    prefs: unknown = prefsDoc({ "library:workflows": true }),
  ): RouteStub[] {
    return [
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: `/api/v1/projects/${P}/repos`, body: { items: [] } },
      { path: `/api/v1/projects/${P}/approvals`, body: { approvals: [] } },
      { path: `/api/v1/projects/${P}/runs`, body: { runs: [] } },
      { path: `/api/v1/projects/${P}/conversations`, body: { items: [] } },
      { path: "/api/v1/pipelines", body: folderedList },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
      { path: PREFS_PATH, method: "GET", body: prefs },
      ...extra,
    ];
  }

  // Finding 02: the sidebar no longer folds the workflow folders (the
  // `?folder=` sub-rows and their chevron are gone from the column — the
  // folders stay on the Workflows page itself). Even with the saved
  // `library:workflows` expansion and the show_workflow_folders preference
  // on, the column renders no folder row.
  it("renders no workflow folder rows at all", async () => {
    renderApp({ path: "/", routes: folderRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    // The Workflows row settling proves the pipelines read answered; the
    // folders still do not appear.
    await waitFor(() => {
      expect(scope.getByTestId("sidebar-link-workflows").textContent).toContain("3");
    });
    expect(scope.queryByTestId("sidebar-workflows-toggle")).toBeNull();
    expect(scope.queryAllByTestId(/^sidebar-workflow-folder-/)).toHaveLength(0);
    expect(scope.getByTestId("sidebar-link-workflows").getAttribute("href")).toBe("/workflows");
  });

  // 1b review: `0` is a fact about an EMPTY library  // 1b review: `0` is a fact about an EMPTY library, not about a read that
  // failed — the row stays unnumbered until the list actually answers.
  it("shows no Workflows number while the library read has failed", async () => {
    renderApp({
      path: "/",
      routes: folderRoutes().map((stub) =>
        stub.path === "/api/v1/pipelines" ? { ...stub, status: 500, body: undefined } : stub,
      ),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    // The other library read settling proves the failed one has been answered:
    // Agent profiles shows its real 0, Workflows shows nothing.
    await waitFor(
      () => expect(scope.getByTestId("sidebar-link-profiles").textContent).toContain("0"),
      { timeout: READ_MS },
    );
    expect(scope.getByTestId("sidebar-link-workflows").textContent).toBe("Workflows");
    expect(scope.queryAllByTestId(/^sidebar-workflow-folder-/)).toHaveLength(0);
  });
});

describe("the sidebar flags read off the same reduction as Inbox", () => {
  it("shows the project's worst state and the Inbox row's count for a failed run", async () => {
    const failedRun = {
      ...wireRun,
      status: "failed",
      failed_cause: "node_execution_failed:/implement",
    } as unknown as typeof wireRun;
    renderApp({ path: "/", routes: baseRoutes({ runs: { runs: [failedRun] } }) });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);

    // The project's worst state: failed outranks everything and carries its
    // own count; glyph plus text, never colour alone.
    await scope.findByLabelText("1 failed", undefined, { timeout: READ_MS });
    // Inbox needs a person because a run stalled (and there are no open
    // gates): the same count the Inbox page would state.
    expect(scope.getByLabelText("1 waiting")).toBeTruthy();
    // Nothing is running, so no running flag shows anywhere in the column.
    expect(scope.queryByLabelText(/running/)).toBeNull();
  });
});

describe("the collapsed rail (redesign 3a/4a)", () => {
  /** The layout-prefs key the rail's state rides (see `lib/prefs.ts`). */
  const COLLAPSED = "sidebar:collapsed";

  /** The column's reads with the rail already saved as the preference. */
  function railRoutes(extra: RouteStub[] = [], projects?: unknown): RouteStub[] {
    return baseRoutes({ prefs: prefsDoc({ [COLLAPSED]: true }), projects, extra });
  }

  const failedRun = {
    ...wireRun,
    status: "failed",
    failed_cause: "node_execution_failed:/implement",
  } as unknown as typeof wireRun;

  /** The six nav icons, as buttons/links with self-naming aria-labels. */
  const NAV_TILES = [
    "rail-item-today",
    "rail-item-catch-up",
    "rail-item-threads",
    "rail-item-projects",
    "rail-item-workflows",
    "rail-item-agents",
  ];

  it("renders the icon set and badges the same counts the expanded rows carry", async () => {
    renderApp({
      path: "/",
      routes: railRoutes([
        {
          path: "/api/v1/catch-up/items",
          body: { items: [], total_unseen: 3, oldest_unseen_at: "2026-01-01T00:00:00Z" },
        },
      ]).map((stub) =>
        stub.path === `/api/v1/projects/${P}/conversations`
          ? { ...stub, body: { items: [conversationSummaryFixture] } }
          : stub.path === `/api/v1/projects/${P}/runs`
            ? { ...stub, body: { runs: [failedRun] } }
            : stub,
      ),
    });
    // The rail is the column now: 52px, and every nav tile is an icon — no
    // initials tiles survive the redesign.
    expect(await screen.findByTestId("sidebar-rail", undefined, { timeout: READ_MS })).toBeTruthy();
    for (const testid of NAV_TILES) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
    expect(screen.queryAllByTestId(/^sidebar-rail-project-/)).toHaveLength(0);
    // `+` and the expand button stay reachable.
    expect(screen.getByTestId("new-chat-rail").getAttribute("aria-label")).toBe("New thread");
    expect(screen.getByTestId("sidebar-expand")).toBeTruthy();
    expect(screen.getByTestId("user-badge").textContent).toContain("Ada Lovelace");

    // The badges are the expanded rows' own numbers: the waiting count off
    // the stalled run (waiting tint), the unseen count off the catch-up read
    // (accent), the live count off the conversations read (running tint).
    const today = await screen.findByTestId("rail-badge-today", undefined, { timeout: READ_MS });
    expect(today.textContent).toBe("1");
    expect(today.className).toContain("bg-st-waiting-tag");
    const catchUp = await screen.findByTestId("rail-badge-catch-up", undefined, {
      timeout: READ_MS,
    });
    expect(catchUp.textContent).toBe("3");
    expect(catchUp.className).toContain("bg-accent-tint");
    const threads = await screen.findByTestId("rail-badge-threads", undefined, {
      timeout: READ_MS,
    });
    expect(threads.textContent).toBe("1");
    expect(threads.className).toContain("bg-st-running-tag");
    // 3a: the Projects tile carries the projects' own worst state — the very
    // flag the expanded project rows print. A failed run is `× 1` in the
    // failed tint, never colour alone.
    const projects = await screen.findByTestId("rail-badge-projects", undefined, {
      timeout: READ_MS,
    });
    expect(projects.textContent).toBe("× 1");
    expect(projects.className).toContain("bg-st-failed-tag");
    expect(screen.getByTestId("rail-item-projects").getAttribute("aria-label")).toBe(
      "Projects · 1 failed",
    );
    // The number is never ink-only: the tile's accessible name says it in words.
    expect(screen.getByTestId("rail-item-today").getAttribute("aria-label")).toBe(
      "Today · 1 waiting",
    );
    expect(screen.getByTestId("rail-item-catch-up").getAttribute("aria-label")).toBe(
      "Catch up · 3 unseen",
    );
    // The routes are the column's routes.
    expect(screen.getByTestId("rail-item-catch-up").getAttribute("href")).toBe("/catch-up");
    expect(screen.getByTestId("rail-item-workflows").getAttribute("href")).toBe("/workflows");
    expect(screen.getByTestId("rail-item-agents").getAttribute("href")).toBe("/profiles");
  });

  // 3a: the Projects tile is the one tile with children, and it carries the
  // projects' own state badge — the same flag the expanded project rows print,
  // glyph and count together.
  it("badges the Projects tile with the waiting state the project rows carry", async () => {
    renderApp({
      path: "/",
      routes: railRoutes().map((stub) =>
        stub.path === `/api/v1/projects/${P}/approvals`
          ? { ...stub, body: { approvals: [wireApproval] } }
          : stub,
      ),
    });
    const badge = await screen.findByTestId("rail-badge-projects", undefined, {
      timeout: READ_MS,
    });
    expect(badge.textContent).toBe("! 1");
    expect(badge.className).toContain("bg-st-waiting-tag");
    expect(screen.getByTestId("rail-item-projects").getAttribute("aria-label")).toBe(
      "Projects · 1 waiting",
    );
  });

  // Running is not attention: a project whose only state is a live run keeps
  // the tile quiet (the Threads badge already says "something is moving").
  it("keeps the Projects tile quiet when nothing waits and nothing has failed", async () => {
    renderApp({
      path: "/",
      routes: railRoutes().map((stub) =>
        stub.path === `/api/v1/projects/${P}/runs` ? { ...stub, body: { runs: [wireRun] } } : stub,
      ),
    });
    const rail = await screen.findByTestId("sidebar-rail", undefined, { timeout: READ_MS });
    await within(rail).findByTestId("rail-item-threads", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("rail-badge-projects")).toBeNull();
    expect(screen.getByTestId("rail-item-projects").getAttribute("aria-label")).toBe("Projects");
  });

  // 3a: the active tile is the sidebar row's own mark — a 1px INK border on
  // the blue grid-paper fill, never a blue-grey border.
  it("marks the active rail tile with the ink border on the blue grid", async () => {
    renderApp({ path: "/", routes: railRoutes() });
    const today = await screen.findByTestId("rail-item-today", undefined, { timeout: READ_MS });
    expect(today.className).toContain("border-ink");
    expect(today.className).toContain("ds-texture-accent");
    expect(today.className).not.toMatch(/border-(accent|line|st-)/);
    // The inactive tiles keep their transparent border (no shift on hover).
    const workflows = screen.getByTestId("rail-item-workflows");
    expect(workflows.className).toContain("border-transparent");
    expect(workflows.className).not.toContain("ds-texture-accent");
  });

  it("prints no badge for a count that is zero or still unread", async () => {
    renderApp({
      path: "/",
      routes: baseRoutes({ prefs: prefsDoc({ [COLLAPSED]: true }) }),
    });
    // Catch up answers zero unseen, nothing waits, no live threads: no badges.
    const rail = await screen.findByTestId("sidebar-rail", undefined, { timeout: READ_MS });
    await within(rail).findByTestId("rail-item-workflows", undefined, { timeout: READ_MS });
    expect(rail.querySelector('[data-testid^="rail-badge-"]')).toBeNull();
    expect(screen.getByTestId("rail-item-today").getAttribute("aria-label")).toBe("Today");
  });

  it("shows the dark label on hover and on keyboard focus — never on a touch tap", async () => {
    renderApp({ path: `/p/${P}`, routes: railRoutes() });
    const tile = await screen.findByTestId("rail-item-projects", undefined, {
      timeout: READ_MS,
    });

    // Hover (mouse): the label appears and the tile points at it.
    fireEvent.pointerOver(tile, { pointerType: "mouse" });
    const tip = await screen.findByTestId("rail-tooltip", undefined, { timeout: READ_MS });
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toContain("Projects");
    expect(tile.getAttribute("aria-describedby")).toBe("rail-tooltip");
    fireEvent.pointerOut(tile, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByTestId("rail-tooltip")).toBeNull(), {
      timeout: READ_MS,
    });

    // Keyboard focus: the same label.
    fireEvent.focusIn(tile);
    await screen.findByTestId("rail-tooltip", undefined, { timeout: READ_MS });
    expect(tile.getAttribute("aria-describedby")).toBe("rail-tooltip");
    fireEvent.focusOut(tile);
    await waitFor(() => expect(screen.queryByTestId("rail-tooltip")).toBeNull(), {
      timeout: READ_MS,
    });

    // A touch tap gets neither: pointer touch never shows the label, and the
    // focus a tap drags in behind it is ignored too.
    fireEvent.pointerOver(tile, { pointerType: "touch" });
    expect(screen.queryByTestId("rail-tooltip")).toBeNull();
    fireEvent.pointerDown(tile, { pointerType: "touch" });
    fireEvent.pointerUp(tile, { pointerType: "touch" });
    fireEvent.focusIn(tile);
    expect(screen.queryByTestId("rail-tooltip")).toBeNull();

    // Past the tap's suppression window, the keyboard owns the label again
    // (this is the 700ms tail the touch guard keeps).
    await new Promise((resolve) => setTimeout(resolve, 750));

    // The expand tile's label carries its chord (4a: "Expand sidebar ⌘\\").
    const expand = screen.getByTestId("sidebar-expand");
    fireEvent.focusIn(expand);
    const expandTip = await screen.findByTestId("rail-tooltip", undefined, {
      timeout: READ_MS,
    });
    expect(expandTip.textContent).toContain("Expand sidebar");
    expect(expandTip.textContent).toContain("⌘\\");
  });

  it("clicking Projects opens the popover; ↑/↓ move, Enter activates, Esc restores focus", async () => {
    renderApp({ path: `/p/${P}`, routes: railRoutes() });
    const tile = await screen.findByTestId("rail-item-projects", undefined, {
      timeout: READ_MS,
    });
    // Hover alone never opens a menu (3a: predictable, click = menu).
    fireEvent.pointerOver(tile, { pointerType: "mouse" });
    expect(screen.queryByTestId("rail-projects-popover")).toBeNull();
    expect(tile.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(tile);
    const popover = await screen.findByTestId("rail-projects-popover", undefined, {
      timeout: READ_MS,
    });
    expect(popover.getAttribute("role")).toBe("dialog");
    // The 3a box: ~196px with a 10px rotated-square arrow on its left edge.
    expect(popover.style.width).toBe("196px");
    expect(popover.querySelector('[data-testid="menu-arrow"]')).toBeTruthy();
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    expect(tile.getAttribute("aria-controls")).toBe("rail-projects-panel");

    // The mono header, the project row with its state count, and — because
    // the route lives in this project — its repositories nested under it.
    expect(within(popover).getByText("PROJECTS")).toBeTruthy();
    const projectLink = within(popover).getByRole("link", { name: /Widgets/ });
    expect(projectLink.getAttribute("href")).toBe(`/p/${P}`);
    const repoLink = await within(popover).findByRole(
      "link",
      { name: "acme-widgets" },
      {
        timeout: READ_MS,
      },
    );
    expect(repoLink.getAttribute("href")).toBe(`/p/${P}/acme-widgets`);

    // Opening parks the keyboard inside; ↑/↓ rove with wrap.
    expect(document.activeElement).toBe(projectLink);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(repoLink);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(projectLink);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(repoLink);

    // Enter activates the focused row (a real click on the link — which the
    // router turns into a navigation and the row\u2019s own handler into a close).
    let activated = 0;
    repoLink.addEventListener("click", () => {
      activated += 1;
    });
    fireEvent.keyDown(repoLink, { key: "Enter" });
    expect(activated).toBe(1);
    await waitFor(() => expect(screen.queryByTestId("rail-projects-popover")).toBeNull(), {
      timeout: READ_MS,
    });

    // Esc from inside closes it and the keyboard returns to the tile.
    fireEvent.click(tile);
    await screen.findByTestId("rail-projects-popover", undefined, { timeout: READ_MS });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("rail-projects-popover")).toBeNull(), {
      timeout: READ_MS,
    });
    expect(document.activeElement).toBe(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("false");

    // A pointerdown outside closes it too.
    fireEvent.click(tile);
    await screen.findByTestId("rail-projects-popover", undefined, { timeout: READ_MS });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("rail-projects-popover")).toBeNull(), {
      timeout: READ_MS,
    });
  });

  it("states the project\u2019s worst flag in the popover", async () => {
    renderApp({
      path: `/p/${P}`,
      routes: baseRoutes({
        prefs: prefsDoc({ [COLLAPSED]: true }),
        runs: { runs: [failedRun] },
      }),
    });
    const tile = await screen.findByTestId("rail-item-projects", undefined, {
      timeout: READ_MS,
    });
    fireEvent.click(tile);
    const popover = await screen.findByTestId("rail-projects-popover", undefined, {
      timeout: READ_MS,
    });
    expect(
      await within(popover).findByLabelText("1 failed", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
  });

  it("collapses on the brand row\u2019s control and saves it in the layout prefs", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: baseRoutes({
        extra: [{ path: PREFS_PATH, method: "PATCH", body: prefsDoc({ [COLLAPSED]: true }) }],
      }),
    });
    const collapse = await screen.findByTestId("sidebar-collapse", undefined, {
      timeout: READ_MS,
    });
    fireEvent.click(collapse);

    // The saved preference carries `sidebar:collapsed`, exactly once — the
    // same PATCH the settings page writes its layout choices through.
    await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1), {
      timeout: READ_MS,
    });
    const sent = JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}");
    expect(sent.layout.expanded[COLLAPSED]).toBe(true);

    // The rail replaces the column: the labels are gone, the icons, the
    // `+`, the expand control and the footer identity are not.
    await screen.findByTestId("sidebar-expand", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("sidebar-collapse")).toBeNull();
    expect(screen.queryByTestId("new-chat")).toBeNull();
    expect(screen.getByTestId("new-chat-rail")).toBeTruthy();
    expect(screen.getByTestId("sidebar-rail")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-link-threads")).toBeNull();
    expect(screen.getByTestId("user-badge").textContent).toContain("Ada Lovelace");
  });

  it("expands back from the rail and saves that too", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: railRoutes([
        { path: PREFS_PATH, method: "PATCH", body: prefsDoc({ [COLLAPSED]: false }) },
      ]),
    });
    const expand = await screen.findByTestId("sidebar-expand", undefined, { timeout: READ_MS });
    fireEvent.click(expand);
    await screen.findByTestId("sidebar-collapse", undefined, { timeout: READ_MS });
    await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1), {
      timeout: READ_MS,
    });
    const sent = JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}");
    // Expanding overwrites the stored key with `false`: the server merges
    // `expanded` key by key and never deletes, so absence would leave the rail
    // stuck open-closed by its own last write.
    expect(sent.layout.expanded[COLLAPSED]).toBe(false);
    // The column is back: labels, Threads, the tree.
    expect(screen.getByTestId("sidebar-link-threads")).toBeTruthy();
  });

  it("keeps the rail key out of a layout write that never touched it", async () => {
    // The tree's chevron writes the same layout section. It must not stamp
    // `sidebar:collapsed` (true or false) into the document it PATCHes.
    const { requests } = renderApp({
      path: "/",
      routes: baseRoutes({
        extra: [{ path: PREFS_PATH, method: "PATCH", body: prefsDoc({ [`project:${P}`]: true }) }],
      }),
    });
    fireEvent.click(
      await screen.findByTestId(`sidebar-project-toggle-${P}`, undefined, {
        timeout: READ_MS,
      }),
    );
    await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1), {
      timeout: READ_MS,
    });
    const sent = JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}");
    expect(sent.layout.expanded[`project:${P}`]).toBe(true);
    expect(sent.layout.expanded[COLLAPSED]).toBeUndefined();
  });

  it("snaps open on an edge drag past 120px, and closed on the way back below it", async () => {
    stubViewport(1280);
    try {
      const { requests } = renderApp({
        path: "/",
        routes: baseRoutes({
          prefs: prefsDoc({ [COLLAPSED]: true }),
          extra: [
            {
              path: PREFS_PATH,
              method: "PATCH",
              body: (n: number) => prefsDoc({ [COLLAPSED]: n === 1 ? false : true }),
            },
          ],
        }),
      });

      // Rail: dragging the right edge to 140px snaps the column open — the
      // same preference write the expand button makes. The rail must be
      // mounted first (the saved prefs land a tick after the first paint,
      // and the expanded column's edge handle is a different element).
      await screen.findByTestId("sidebar-expand", undefined, { timeout: READ_MS });
      const railHandle = await screen.findByTestId("sidebar-resize-handle", undefined, {
        timeout: READ_MS,
      });
      fireEvent.pointerDown(railHandle);
      fireEvent.pointerMove(window, { clientX: 90 });
      expect(screen.queryByTestId("sidebar-collapse")).toBeNull();
      fireEvent.pointerMove(window, { clientX: 140 });
      await screen.findByTestId("sidebar-collapse", undefined, { timeout: READ_MS });
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1), {
        timeout: READ_MS,
      });
      expect(
        JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}").layout.expanded[
          COLLAPSED
        ],
      ).toBe(false);
      fireEvent.pointerUp(window);

      // Expanded: dragging the same edge back to 90px snaps the rail shut.
      // Re-query: the column replaced the rail, so the handle is a new node.
      const columnHandle = screen.getByTestId("sidebar-resize-handle");
      fireEvent.pointerDown(columnHandle);
      fireEvent.pointerMove(window, { clientX: 150 });
      expect(screen.getByTestId("sidebar-collapse")).toBeTruthy();
      fireEvent.pointerMove(window, { clientX: 90 });
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(2), {
        timeout: READ_MS,
      });
      expect(
        JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[1].body ?? "{}").layout.expanded[
          COLLAPSED
        ],
      ).toBe(true);
      fireEvent.pointerUp(window);
    } finally {
      // Re-stub the native `matchMedia`: `vi.unstubAllGlobals()` would also
      // drop the session-wide `EventSource` stub while the app is mounted.
      vi.stubGlobal("matchMedia", nativeMatchMedia);
    }
  });
});

describe("the project row has no hover-only menu (finding 09)", () => {
  /** The tree at a project route. */
  function treeRoutes(): RouteStub[] {
    return baseRoutes({
      extra: [
        { path: `/api/v1/projects/${P}`, body: projectFixture },
        { path: `/api/v1/projects/${P}/members`, body: { items: [] } },
      ],
    });
  }

  it("carries no ⋯ trigger, no menu and no opacity-0 action in the tree", async () => {
    renderApp({ path: "/", routes: treeRoutes() });
    // The row itself is real (the test would pass vacuously on an empty tree).
    const row = await screen.findByRole("link", { name: "Widgets" }, { timeout: READ_MS });
    expect(row.getAttribute("href")).toBe(`/p/${P}`);

    // Everything finding 09 removed: the trigger, the menu it opened, and the
    // hover/focus-only class that hid them. On a touch screen, and in the
    // collapsed rail, an `opacity-0` action is simply an action that is not
    // there — which is why `+ Repository` and `Settings` moved to the project
    // header (`ProjectHeader.test.tsx` covers them there).
    expect(screen.queryByTestId(`sidebar-project-menu-${P}`)).toBeNull();
    expect(screen.queryByTestId("sidebar-project-menu")).toBeNull();
    expect(document.querySelectorAll("[data-testid^='sidebar-project-menu-']")).toHaveLength(0);
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar.querySelectorAll("[class*='opacity-0']")).toHaveLength(0);
    expect(within(sidebar).queryByText("Project settings")).toBeNull();
    expect(within(sidebar).queryByText("Add repository")).toBeNull();
    expect(within(sidebar).queryByText("Workflows in use")).toBeNull();
    // And the row is not a menu host: no `aria-haspopup` anywhere under the
    // project's own row.
    expect(row.closest("div")?.querySelectorAll("[aria-haspopup]")).toHaveLength(0);
  });

  it("keeps the phone drawer's tree free of the ⋯ too", async () => {
    // The 390px frame: `Shell` replaces the desktop column with the drawer
    // (`Sidebar variant="drawer"`). The menu used to fall back to a bottom drop
    // here because the right side had no room; the whole affordance is gone, so
    // neither placement exists and the drawer shows only the tree.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    try {
      renderApp({ path: "/", routes: treeRoutes() });
      fireEvent.click(await screen.findByTestId("sidebar-open", undefined, { timeout: READ_MS }));
      const row = await screen.findByRole("link", { name: "Widgets" }, { timeout: READ_MS });
      expect(row.getAttribute("href")).toBe(`/p/${P}`);
      expect(screen.queryByTestId(`sidebar-project-menu-${P}`)).toBeNull();
      expect(screen.queryByTestId("sidebar-project-menu")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
