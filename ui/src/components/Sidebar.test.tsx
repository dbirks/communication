/**
 * The sidebar column (`components/Sidebar.tsx`): the tree mode shows every
 * project with its repository list hidden until the chevron opens it, and
 * opening writes the `expanded` preference (`project:<id>` key) through the
 * same `PATCH /api/v1/me/preferences` the settings page uses — the switcher
 * mode, the library rows, the "⋯" menu and the worst-state flags are all read
 * off the same real endpoints Inbox reads, so the column cannot disagree with
 * it. The pure flag rules themselves are covered by `lib/sidebarFlags.test.ts`.
 *
 * The column's two widths are the same contract: `sidebarCollapsed` is the
 * saved preference that trades the 220px column for the 52px rail, and the
 * rail's tile flyouts are what carry the project, its flag and its
 * repositories when the labels go away (handoff 2c/3c).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, repositoryId, requestsTo, type RouteStub } from "../test/fakes";
import { wirePipelineList, wireRun } from "../test/fixtures/m4/wire";
import { railInitials } from "./Sidebar";
import type { Project, Repository } from "../api/types";

/** Wait budget for the first round trips the sidebar waits on. */
const READ_MS = 5_000;

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

function prefsDoc(
  expanded: Record<string, boolean> = {},
  projectsMode: "tree" | "switcher" = "tree",
): unknown {
  return {
    layout: {
      projects_mode: projectsMode,
      ask_placement: "sidebar",
      show_workflow_folders: true,
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

/** Per-project reads one more fixture project needs (repos, flags, chats). */
function projectReads(project: Project): RouteStub[] {
  return [
    { path: `/api/v1/projects/${project.id}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${project.id}/approvals`, body: { approvals: [] } },
    { path: `/api/v1/projects/${project.id}/runs`, body: { runs: [] } },
    { path: `/api/v1/projects/${project.id}/conversations`, body: { items: [] } },
  ];
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

  it("lists Today and My chats with the current row marked, and the library rows", async () => {
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

    // The library rows: real counts for what the API counts, none for what it
    // does not (Steps has no template store behind a number).
    await waitFor(() => {
      expect(scope.getByTestId("sidebar-link-workflows").textContent).toContain("2");
    });
    expect(scope.getByTestId("sidebar-link-steps").textContent).toBe("Steps");
    expect(scope.getByTestId("sidebar-link-profiles").textContent).toContain("0");

    // The sidebar placement of the Ask button is the default.
    expect(screen.getByTestId("ask-sidebar")).toBeTruthy();
  });

  // 2c/3c: the row labels the design names — Home became Today (same `/`),
  // Threads became My chats (same `/threads`).
  it("names the two cross-project rows Today and My chats", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    expect(scope.getByTestId("sidebar-link-home").textContent).toContain("Today");
    expect(scope.queryByText("Home", { exact: true })).toBeNull();
    expect(scope.getByTestId("sidebar-link-threads").textContent).toContain("My chats");
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

describe("the sidebar switcher (a saved layout preference)", () => {
  it("shows a 36px project button whose listbox ends in 'All projects'", async () => {
    renderApp({
      path: "/",
      routes: baseRoutes({ prefs: prefsDoc({}, "switcher") }),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    const trigger = await screen.findByTestId("project-switcher", undefined, { timeout: READ_MS });
    expect(scope.getByText("PROJECT")).toBeTruthy();
    expect(scope.queryByText("PROJECTS")).toBeNull();
    expect(within(trigger).getByText("Widgets")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Projects" });
    expect(within(listbox).getByText("Widgets")).toBeTruthy();
    expect(within(listbox).getByTestId("project-switcher-all")).toBeTruthy();
    expect(within(listbox).getByText("All projects")).toBeTruthy();
    // Handoff 3c's rule — every anchored surface carries the shared pointer
    // arrow (`ds/Menu`'s `menu-arrow`). It mounts as the list's sibling rather
    // than inside it: the listbox owns the scroll (`overflow-y-auto`), and the
    // half of the square that rides above the border line would be clipped.
    const arrow = sidebar.querySelector('[data-testid="menu-arrow"]');
    expect(arrow, "the switcher's list carries the shared pointer arrow").toBeTruthy();
    expect(listbox.contains(arrow as Element)).toBe(false);
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
    // 9px square, rotated 45°, centred on the wrapper the trigger spans.
    expect((arrow as HTMLElement).style.width).toBe("9px");
    expect((arrow as HTMLElement).style.transform).toContain("rotate(45deg)");
    expect((arrow as HTMLElement).style.left).toBe("50%");
    // Closed surface, no arrow — it belongs to the open list, not the column.
    fireEvent.click(trigger);
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

  it("expands Workflows to its folders with the API's counts, Unfiled last", async () => {
    renderApp({ path: "/", routes: folderRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    const toggle = await scope.findByTestId("sidebar-workflows-toggle");
    // Issue #68: desktop hit area ≥28×28 via the shared `.icon-hit` utility.
    expect(toggle.className.split(/\s+/)).toContain("icon-hit");
    // The preferences read settles before the chevron honours it.
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"), {
      timeout: READ_MS,
    });
    const rows = scope.getByTestId("sidebar-workflow-folder-delivery");
    const folderRows = scope.getAllByTestId(/^sidebar-workflow-folder-/);
    expect(folderRows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "sidebar-workflow-folder-delivery",
      "sidebar-workflow-folder-unfiled",
    ]);
    // The counts are the API's own rows; Unfiled carries the null-folder row.
    expect(folderRows[0].textContent).toContain("2");
    expect(folderRows[1].textContent).toContain("1");
    expect(rows.getAttribute("href")).toBe("/workflows?folder=Delivery");
    // The Workflows row keeps its own total.
    expect(scope.getByTestId("sidebar-link-workflows").textContent).toContain("3");
  });

  it("persists the chevron through the saved `library:workflows` preference", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: folderRoutes(
        [{ path: PREFS_PATH, method: "PATCH", body: prefsDoc({ "library:workflows": true }) }],
        prefsDoc({}),
      ),
    });
    const toggle = await screen.findByTestId("sidebar-workflows-toggle", undefined, {
      timeout: READ_MS,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("sidebar-workflow-folder-delivery")).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}") as {
      layout: { expanded: Record<string, boolean> };
    };
    expect(sent.layout.expanded["library:workflows"]).toBe(true);
    // The PATCH answer carries the expanded document: the folders appear.
    await screen.findByTestId("sidebar-workflow-folder-delivery", undefined, {
      timeout: READ_MS,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps Workflows a plain link when show_workflow_folders is off", async () => {
    renderApp({
      path: "/",
      routes: folderRoutes([], {
        layout: {
          projects_mode: "tree",
          ask_placement: "sidebar",
          show_workflow_folders: false,
          expanded: {},
        },
        assistant: { trust_level: "ask_risky" },
        updated_at: "2026-01-01T00:00:00Z",
      }),
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    // The preference read settles before the chevron disappears.
    await waitFor(() => expect(scope.queryByTestId("sidebar-workflows-toggle")).toBeNull(), {
      timeout: READ_MS,
    });
    expect(scope.queryAllByTestId(/^sidebar-workflow-folder-/)).toHaveLength(0);
    expect(scope.getByTestId("sidebar-link-workflows").getAttribute("href")).toBe("/workflows");
  });

  // 1b review: `0` is a fact about an EMPTY library, not about a read that
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

describe("railInitials (the tiles are distinguishable)", () => {
  it("keeps the plain initials when nothing collides", () => {
    // Today's rule unchanged for names that do not need help: one letter
    // per leading word, up to two words.
    expect(railInitials(["Northwind", "Acme", "M4 Exit"])).toEqual(["N", "A", "ME"]);
  });
  it("picks the distinguishing token when the first letters collide", () => {
    expect(
      railInitials([
        "Emu rcn rcn-labA-1793626180",
        "Emu rcn rcn-devA-1793626180",
        "Emu rcn rcnA-1793626180",
      ]),
    ).toEqual(["EL", "ED", "EA"]);
  });
  it("widens within the tail before falling back to name characters", () => {
    // The tails collide letter-for-letter at one character (`B`/`B`) and
    // only part at the second: the tile widens to three characters.
    expect(railInitials(["Emu rcn rcn-labA-1", "Emu rcn rcn-laBB-2"])).toEqual(["EBA", "EBB"]);
  });
  it("keeps the shared initials for names nothing can separate", () => {
    // Identical names cannot be told apart by ink; the flyout carries the
    // full name. Nothing else changes.
    expect(railInitials(["Emu rcn dup", "Emu rcn dup"])).toEqual(["ER", "ER"]);
  });
  it("is deterministic", () => {
    const names = ["Emu rcn x-1", "Emu rcn x-2", "Emu rcn x-3"];
    expect(railInitials(names)).toEqual(railInitials([...names]));
  });
});

describe("the collapsed rail (handoff 2c/3c)", () => {
  /** The layout-prefs key the rail's state rides (see `lib/prefs.ts`). */
  const COLLAPSED = "sidebar:collapsed";

  /** The column's reads with the rail already saved as the preference. */
  function railRoutes(extra: RouteStub[] = [], projects?: unknown): RouteStub[] {
    return baseRoutes({ prefs: prefsDoc({ [COLLAPSED]: true }), projects, extra });
  }

  // Design-3a rail review: three “Emu rcn …” projects that all INITIALise
  // “ER” must not collapse into three identical tiles.
  it("gives same-first-letter projects distinct tiles", async () => {
    const emuA: Project = {
      ...projectFixture,
      id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81",
      name: "Emu rcn rcn-labA-1793626180",
    };
    const emuB: Project = {
      ...projectFixture,
      id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b82",
      name: "Emu rcn rcn-devA-1793626180",
    };
    const emuC: Project = {
      ...projectFixture,
      id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b83",
      name: "Emu rcn rcnA-1793626180",
    };
    const projects: Project[] = [emuA, emuB, emuC, projectFixture];
    renderApp({
      path: "/",
      routes: railRoutes(
        projects.flatMap((project) => projectReads(project)),
        { items: projects },
      ),
    });

    const tiles = await Promise.all(
      projects.map((project) =>
        screen.findByTestId(`sidebar-rail-project-${project.id}`, undefined, { timeout: READ_MS }),
      ),
    );
    // The plain names keep their two-word initials; the colliding trio
    // takes the letter that tells the projects apart.
    expect(tiles.map((tile) => tile.textContent)).toEqual(["EL", "ED", "EA", "W"]);
    expect(new Set(tiles.map((tile) => tile.textContent)).size).toBe(4);
  });

  it("prints the project's worst-state flag on the tile (design 3c)", async () => {
    const failedRun = {
      ...wireRun,
      status: "failed",
      failed_cause: "node_execution_failed:/implement",
    } as unknown as typeof wireRun;
    renderApp({
      path: `/p/${P}`,
      routes: baseRoutes({
        prefs: prefsDoc({ [COLLAPSED]: true }),
        runs: { runs: [failedRun] },
      }),
    });
    // The same reduction the expanded row reads, at rail size: glyph +
    // count, and the tile's accessible name states it too.
    const badge = await screen.findByTestId(`sidebar-rail-flag-${P}`, undefined, {
      timeout: READ_MS,
    });
    expect(badge.textContent).toBe("×1");
    const tile = screen.getByTestId(`sidebar-rail-project-${P}`);
    expect(tile.getAttribute("aria-label")).toBe(`${projectFixture.name} · 1 failed`);
  });

  it("collapses on the brand row's control and saves it in the layout prefs", async () => {
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

    // The rail replaces the column: the labels are gone, the tiles and the
    // expand control are not, and the footer identity survives the collapse.
    await screen.findByTestId("sidebar-expand", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("sidebar-collapse")).toBeNull();
    expect(screen.queryByTestId("new-chat")).toBeNull();
    expect(screen.getByTestId("new-chat-rail")).toBeTruthy();
    expect(screen.getByTestId(`sidebar-rail-project-${P}`)).toBeTruthy();
    expect(screen.queryByTestId("sidebar-link-threads")).toBeNull();
    // Review 3c: the rail's Today is an icon tile, not bare text under the
    // `+` — the word lives in the aria-label (and the tooltip).
    expect(screen.getByTestId("sidebar-link-home").getAttribute("aria-label")).toMatch(/^Today/);
    expect(screen.getByTestId("sidebar-rail-library").getAttribute("aria-label")).toBe("Library");
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
    // The column is back: labels, My chats, the tree.
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

  it("opens a project's flyout on tile focus, with the flag and the repos as links", async () => {
    renderApp({ path: `/p/${P}`, routes: railRoutes() });
    const tile = await screen.findByTestId(`sidebar-rail-project-${P}`, undefined, {
      timeout: READ_MS,
    });
    // The project the route lives inside is the active tile: ink border and
    // the accent tint, and `aria-current` for assistive tech.
    expect(tile.getAttribute("aria-current")).toBe("page");
    expect(tile.className.split(/\s+/)).toContain("border-ink");
    expect(tile.className.split(/\s+/)).toContain("bg-accent-tint");

    // A tile with no pointer (keyboard only) still opens its flyout (React
    // maps `onFocus` to the bubbling `focusin`).
    fireEvent.focusIn(tile);
    const flyout = await screen.findByTestId(`sidebar-rail-flyout-${P}`, undefined, {
      timeout: READ_MS,
    });
    expect(within(flyout).getByText("Widgets")).toBeTruthy();
    const project = within(flyout).getByRole("link", { name: "Widgets" });
    // Review 3c: the flyout is what names the project, so the name wraps
    // inside a 260px box instead of ellipsizing to `Widgets…`.
    expect(flyout.style.width).toBe("260px");
    expect(project.className).toContain("break-words");
    expect(project.className).not.toContain("truncate");
    // The flyout's repository rows ride a lazy `useRepositories` read that
    // starts when the flyout mounts, so they land one round trip after the
    // flyout itself (@tanstack/query 5.105+ subscribes the observer before it
    // fetches). Await the row rather than assuming the cache is already warm.
    const repo = await within(flyout).findByRole(
      "link",
      { name: "acme-widgets" },
      { timeout: READ_MS },
    );
    expect(repo.getAttribute("href")).toBe(`/p/${P}/acme-widgets`);
    // The flyout is a `ds/Popover`: the pointer arrow is its own element.
    expect(flyout.querySelector('[data-testid="menu-arrow"]')).toBeTruthy();

    // Escape closes it and the keyboard is back on the tile.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId(`sidebar-rail-flyout-${P}`)).toBeNull(), {
      timeout: READ_MS,
    });
  });

  it("states the project's worst flag in the flyout", async () => {
    const failedRun = {
      ...wireRun,
      status: "failed",
      failed_cause: "node_execution_failed:/implement",
    } as unknown as typeof wireRun;
    renderApp({
      path: `/p/${P}`,
      routes: baseRoutes({
        prefs: prefsDoc({ [COLLAPSED]: true }),
        runs: { runs: [failedRun] },
      }),
    });
    const tile = await screen.findByTestId(`sidebar-rail-project-${P}`, undefined, {
      timeout: READ_MS,
    });
    fireEvent.focusIn(tile);
    const flyout = await screen.findByTestId(`sidebar-rail-flyout-${P}`, undefined, {
      timeout: READ_MS,
    });
    expect(
      await within(flyout).findByLabelText("1 failed", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
  });
});

describe("the project row's ⋯ menu (settings and members left the tree)", () => {
  /** The tree at a project route, with the reads the menu's own pages need. */
  function menuRoutes(): RouteStub[] {
    return baseRoutes({
      extra: [
        { path: `/api/v1/projects/${P}`, body: projectFixture },
        { path: `/api/v1/projects/${P}/members`, body: { items: [] } },
      ],
    });
  }

  it("opens the four actions over a pointer arrow, each linking its own route", async () => {
    renderApp({ path: "/", routes: menuRoutes() });
    const trigger = await screen.findByTestId(`sidebar-project-menu-${P}`, undefined, {
      timeout: READ_MS,
    });
    // Painted only while the row is hovered or holds focus (the design's
    // "appears on hover and focus"); jsdom cannot hover, so the rule is the
    // contract the test can read.
    expect(trigger.className.split(/\s+/)).toContain("opacity-0");
    expect(trigger.className.split(/\s+/)).toContain("group-hover:opacity-100");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const menu = await screen.findByTestId("sidebar-project-menu", undefined, {
      timeout: READ_MS,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("role")).toBe("menu");
    // Round-8 design review item 4: the menu flies out to the RIGHT of the
    // narrow column, beside the row that opened it (design 3c) — the old
    // bottom drop covered the rows below inside the 220px scroller.
    expect(menu.getAttribute("data-side")).toBe("right");
    for (const label of ["Project settings", "Members", "Add repository", "Workflows in use"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeTruthy();
    }
    // "Workflows in use" sits under a divider, and the box has its arrow.
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu.querySelector('[data-testid="menu-arrow"]')).toBeTruthy();
    // These actions are not tree rows.
    const sidebar = screen.getByTestId("sidebar");
    expect(within(sidebar).queryByText("Project settings")).toBeNull();
    expect(within(sidebar).queryByText("Add repository")).toBeNull();

    // Members is a route, and the menu item walks through that door.
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Members" }));
    expect(
      await screen.findByTestId("project-members-page", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
  });

  it("falls back to the bottom drop in the mobile drawer, where right has no room", async () => {
    // The 390px phone frame: the Shell's drawer replaces the desktop column
    // (Sidebar variant="drawer"), and the drawer's column is wider than the
    // 190px menu — so the menu keeps the bottom drop there, where the ds
    // Menu's viewport clamp keeps it on screen, instead of a right flyout
    // that would leave the viewport (round-8 design review item 4).
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
      renderApp({ path: "/", routes: menuRoutes() });
      fireEvent.click(await screen.findByTestId("sidebar-open", undefined, { timeout: READ_MS }));
      const trigger = await screen.findByTestId(`sidebar-project-menu-${P}`, undefined, {
        timeout: READ_MS,
      });
      fireEvent.click(trigger);
      const menu = await screen.findByTestId("sidebar-project-menu", undefined, {
        timeout: READ_MS,
      });
      expect(menu.getAttribute("data-side")).toBe("bottom");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes on Escape with the keyboard back on the ⋯", async () => {
    renderApp({ path: "/", routes: menuRoutes() });
    const trigger = await screen.findByTestId(`sidebar-project-menu-${P}`, undefined, {
      timeout: READ_MS,
    });
    fireEvent.click(trigger);
    await screen.findByTestId("sidebar-project-menu", undefined, { timeout: READ_MS });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("sidebar-project-menu")).toBeNull(), {
      timeout: READ_MS,
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
