/**
 * `/manage/:section?/:itemId?` — the frame (redesign R7).
 *
 * What is pinned here is the navigation contract and nothing else: the six
 * destinations in CONTRACT's order, each linking to `routes.manage(section)`,
 * the selected one carrying `aria-current="page"`, an unknown section landing
 * on the app's own `NotFound`, and every section mounting for its own URL. The
 * sections' own reads are mocked to a neutral fixture each — a section's data
 * rules are tested in its file.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Manage from "./Manage";
import { mockFetch, meFixture, type RouteStub } from "../test/fakes";
import type { Project } from "../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* Neutral fixtures: nothing here is the prototype's data. */
const PROJECT_ID = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const projectOne: Project = {
  id: PROJECT_ID,
  slug: "project-one",
  name: "Project One",
  description: "",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "maintainer",
};

const SECTION_TESTIDS = [
  ["projects", "manage-projects"],
  ["repositories", "manage-repositories"],
  ["people", "manage-people"],
  ["runners", "manage-runners"],
  ["agents", "manage-agents"],
  ["secrets", "manage-secrets"],
] as const;

function routes(overrides: RouteStub[] = []): RouteStub[] {
  // First match wins in the fetch mock, so an override has to come FIRST.
  return [
    ...overrides,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectOne] } },
    { path: `/api/v1/projects/${PROJECT_ID}`, body: projectOne },
    { path: `/api/v1/projects/${PROJECT_ID}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${PROJECT_ID}/members`, body: { items: [] } },
    { path: `/api/v1/projects/${PROJECT_ID}/secrets`, body: { secrets: [] } },
    { path: `/api/v1/projects/${PROJECT_ID}/secret-mounts`, body: { secret_mounts: [] } },
    { path: `/api/v1/projects/${PROJECT_ID}/workspaces`, body: { workspaces: [] } },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: "/api/v1/workers", body: { items: [] } },
    { path: "/api/v1/launchers", body: { launchers: [] } },
    { path: "/api/v1/system/scheduler", body: schedulerBody() },
    { path: "/api/v1/runs", body: { runs: [] } },
  ];
}

function schedulerBody() {
  return {
    attempts_by_status: { queued: 0, leased: 0, running: 0 },
    oldest_queued_age_seconds: null,
    lease_expirations: 0,
    max_retry_loop_depth: 0,
    waiting_approvals: 0,
    queued_unbindable_runs: 0,
    workers: [],
  };
}

function renderManage(path: string, stubs: RouteStub[] = routes()) {
  mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/manage" element={<Manage />} />
          <Route path="/manage/:section" element={<Manage />} />
          <Route path="/manage/:section/:itemId" element={<Manage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the sub-nav", () => {
  it("renders the six sections in order, each linking to its own URL", async () => {
    renderManage("/manage/runners");
    const nav = await screen.findByTestId("manage-nav");
    const links = [...nav.querySelectorAll("a")].map((link) => ({
      testid: link.getAttribute("data-testid"),
      href: link.getAttribute("href"),
    }));
    expect(links.map((link) => link.testid)).toEqual(
      SECTION_TESTIDS.map(([key]) => `manage-nav-${key}`),
    );
    expect(links.map((link) => link.href)).toEqual(
      SECTION_TESTIDS.map(([key]) => `/manage/${key}`),
    );
  });

  it("marks the current section and only it", async () => {
    renderManage("/manage/people");
    const current = await screen.findByTestId("manage-nav-people");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("manage-nav-runners").getAttribute("aria-current")).toBeNull();
    // Exactly one destination in the nav claims the current page.
    expect(document.querySelectorAll('nav[aria-label="Manage"] [aria-current]')).toHaveLength(1);
  });

  it("defaults the bare /manage URL to Projects", async () => {
    renderManage("/manage");
    expect((await screen.findByTestId("manage-nav-projects")).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() => expect(screen.getByTestId("manage-projects")).toBeTruthy());
  });
});

describe("an unknown section", () => {
  it("renders the app's NotFound page, not an empty Manage", async () => {
    renderManage("/manage/bananas");
    await waitFor(() => expect(screen.getByText("That page does not exist.")).toBeTruthy());
    expect(screen.queryByTestId("manage-nav")).toBeNull();
  });
});

describe("each section mounts for its URL", () => {
  it.each(SECTION_TESTIDS.map(([key, testid]) => [key, testid] as const))(
    "%s renders %s",
    async (key, testid) => {
      renderManage(`/manage/${key}`);
      await waitFor(() => expect(screen.getByTestId(testid)).toBeTruthy(), { timeout: 5000 });
    },
  );

  it("puts the project id to work as the detail page", async () => {
    renderManage(`/manage/projects/${PROJECT_ID}`);
    await waitFor(() => expect(screen.getByTestId("manage-project-detail")).toBeTruthy());
    expect(screen.getByTestId("detail-name").textContent).toBe("Project One");
  });
});
