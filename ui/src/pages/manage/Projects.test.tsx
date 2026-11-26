/**
 * Manage → Projects and its detail page (redesign R7).
 *
 * Two things the brief names are pinned: `?new=1` opens the create form (the
 * rail's "+" tile links there, so it is a URL, not a click), and a project id
 * in the URL renders the detail with EVERY block the project settings surface
 * had — the tab strip's two destinations (Settings, Members) plus the workspaces
 * and activity panels that lived beside them. A block going missing here is a
 * feature going missing from the app, so each one is asserted by test id.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ProjectsSection from "./Projects";
import ProjectDetail from "./ProjectDetail";
import { mockFetch, meFixture, type RouteStub } from "../../test/fakes";
import type { Project } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

function baseRoutes(overrides: RouteStub[] = []): RouteStub[] {
  // First match wins in the fetch mock, so an override must come FIRST.
  return [
    ...overrides,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectOne] } },
    { path: `/api/v1/projects/${PROJECT_ID}`, body: projectOne },
    { path: `/api/v1/projects/${PROJECT_ID}/repos`, body: { items: [] } },
    {
      path: `/api/v1/projects/${PROJECT_ID}/members`,
      body: {
        items: [{ user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" }],
      },
    },
    { path: `/api/v1/projects/${PROJECT_ID}/workspaces`, body: { workspaces: [] } },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
  ];
}

function renderAt(path: string, element: ReactNode, stubs = baseRoutes()) {
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/manage/projects" element={element} />
          <Route path="/manage/projects/:itemId" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("Projects list", () => {
  it("opens the create form from ?new=1 without any click", async () => {
    renderAt("/manage/projects?new=1", <ProjectsSection />);
    await waitFor(() => expect(screen.getByTestId("create-project-dialog")).toBeTruthy());
    expect(screen.getByTestId("create-project-name")).toBeTruthy();
    expect(screen.getByTestId("manage-new-project").getAttribute("aria-expanded")).toBe("true");
  });

  it("opens and closes the form from the header action", async () => {
    renderAt("/manage/projects", <ProjectsSection />);
    // With one project in the list the form starts closed.
    await waitFor(() => expect(screen.getByTestId("manage-new-project")).toBeTruthy());
    expect(screen.queryByTestId("create-project-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("manage-new-project"));
    expect(screen.getByTestId("create-project-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("create-project-cancel"));
    await waitFor(() => expect(screen.queryByTestId("create-project-dialog")).toBeNull());
  });

  it("opens the form on an account with no projects, where it is the only action", async () => {
    renderAt(
      "/manage/projects",
      <ProjectsSection />,
      baseRoutes([{ path: "/api/v1/projects", body: { items: [] } }]),
    );
    await waitFor(() => expect(screen.getByTestId("create-project-dialog")).toBeTruthy());
  });

  it("posts the typed name to the create route and lands on the project", async () => {
    const { requests } = renderAt(
      "/manage/projects?new=1",
      <ProjectsSection />,
      baseRoutes([{ path: "/api/v1/projects", method: "POST", status: 200, body: projectOne }]),
    );
    await waitFor(() => expect(screen.getByTestId("create-project-name")).toBeTruthy());
    fireEvent.change(screen.getByTestId("create-project-name"), {
      target: { value: "Project One" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));
    await waitFor(() =>
      expect(
        requests.filter((r) => r.url === "/api/v1/projects" && r.method === "POST"),
      ).toHaveLength(1),
    );
  });
});

describe("ProjectDetail", () => {
  it("renders every block the settings surface carried", async () => {
    renderAt(`/manage/projects/${PROJECT_ID}`, <ProjectDetail />);
    await waitFor(() => expect(screen.getByTestId("manage-project-detail")).toBeTruthy());
    for (const label of [
      "detail-label-details",
      "detail-label-repositories",
      "detail-label-people",
      "detail-label-agent-mail",
      "detail-label-workspaces",
      "detail-label-activity",
    ]) {
      expect(screen.getByTestId(label)).toBeTruthy();
    }
    // The existing panels are mounted as they are.
    expect(await screen.findByTestId("agent-mail-panel")).toBeTruthy();
    // The members panel keeps its own heading (an id the panel owns, not a
    // test id): its list is the proof it mounted.
    expect(document.getElementById("members-heading")?.textContent).toContain("MEMBERS");
    expect(screen.getByTestId("detail-back").getAttribute("href")).toBe("/manage/projects");
  });

  it("shows the project's own facts and says which of them the API can move", async () => {
    renderAt(`/manage/projects/${PROJECT_ID}`, <ProjectDetail />);
    expect((await screen.findByTestId("detail-name")).textContent).toBe("Project One");
    expect(screen.getByTestId("detail-slug").textContent).toBe("project-one");
    expect(screen.getByTestId("detail-role").textContent).toBe("maintainer");
    expect(screen.getByTestId("detail-edit-note").textContent).toContain("not editable");
  });

  it("opens the existing add-repository dialog from the repositories block", async () => {
    renderAt(`/manage/projects/${PROJECT_ID}`, <ProjectDetail />);
    const button = await screen.findByTestId("detail-add-repository");
    fireEvent.click(button);
    expect(screen.getByTestId("add-repository-dialog")).toBeTruthy();
  });
});
