/**
 * The sidebar v3 column (`components/Sidebar.tsx`): the tree mode shows every
 * project with its repository list hidden until the chevron opens it, and
 * opening writes the `expanded` preference (`project:<id>` key) through the
 * same `PATCH /api/v1/me/preferences` the settings page uses — the switcher
 * mode, the library rows and the worst-state flags are all read off the same
 * real endpoints Inbox reads, so the column cannot disagree with it. The
 * pure flag rules themselves are covered by `lib/sidebarFlags.test.ts`.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, repositoryId, requestsTo, type RouteStub } from "../test/fakes";
import { wirePipelineList, wireRun } from "../test/fixtures/m4/wire";
import type { Repository } from "../api/types";

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
  runs?: unknown;
  prefs?: unknown;
  extra?: RouteStub[];
}

/** Everything the column reads, against the one fixture project. */
function baseRoutes({ runs, prefs, extra = [] }: StubOverrides = {}): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
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
  it("lists the cross-project nav with the current row marked and the library rows", async () => {
    renderApp({ path: "/", routes: baseRoutes() });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });

    expect(screen.getByTestId("sidebar-link-home").getAttribute("aria-current")).toBe("page");
    for (const id of ["sidebar-link-inbox", "sidebar-link-board", "sidebar-link-threads"]) {
      expect(screen.getByTestId(id).getAttribute("aria-current")).toBeNull();
    }

    const scope = within(sidebar);
    await screen.findByText("Widgets", undefined, { timeout: READ_MS });
    expect(scope.getByText("PROJECTS")).toBeTruthy();
    expect(scope.getByText("Widgets")).toBeTruthy();
    // Collapsed by default: the chevron is closed and no repository shows.
    const toggle = scope.getByTestId(`sidebar-project-toggle-${P}`);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
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
    // Nothing is running, so the Board row stays unflagged.
    expect(scope.queryByLabelText(/running/)).toBeNull();
  });
});
