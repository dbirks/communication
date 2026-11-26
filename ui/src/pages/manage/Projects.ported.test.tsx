/**
 * Manage → Projects (`/manage/projects`, redesign R7): the list and the create
 * form the old `/projects` board carried, ported across the route flip.
 *
 * What a person still does here is unchanged in kind — see every project they
 * belong to with their own role in it, and create one — so those assertions
 * move with the page. What is *new* is where the numbers come from: the board
 * drew attention counts (decisions, stalled runs, live threads), and the
 * redesign moved those to Home and to the project's own screens
 * (`docs/design/redesign/CONTRACT.md` "What happens to the old app"). This
 * section answers "which project do I configure?", so its cells are the
 * repository and people totals, each read from the route that owns it — never
 * a client-side guess. The board's tally, its needs-me/a–z sort and its card
 * geometry retired with the card grid.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ProjectsSection from "./Projects";
import ProjectDetail from "./ProjectDetail";
import { useMe } from "../../api/queries";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import type { Project } from "../../api/types";
import { routes } from "../../lib/routes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const otherProject: Project = {
  ...projectFixture,
  id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81",
  slug: "other-app",
  name: "Other App",
  description: "",
  my_role: "viewer",
};

function projectDetailRoutes(project: Project): RouteStub[] {
  return [
    { path: `/api/v1/projects/${project.id}`, body: project },
    { path: `/api/v1/projects/${project.id}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${project.id}/members`, body: { items: [] } },
    { path: `/api/v1/projects/${project.id}/workspaces`, body: { workspaces: [] } },
  ];
}

/** The list's per-project count reads, kept honest: one repository, one person. */
function countRoutes(projects: Project[]): RouteStub[] {
  return projects.flatMap((project) => [
    {
      path: `/api/v1/projects/${project.id}/repos`,
      method: "GET",
      body: { items: [{ id: `repo-${project.slug}`, project_id: project.id }] },
    },
    {
      path: `/api/v1/projects/${project.id}/members`,
      method: "GET",
      body: { items: [{ user_id: meFixture.id, display_name: "Ada Lovelace", role: "viewer" }] },
    },
  ]);
}

/** The shell's own read: `/me` is what carries the session's CSRF token into
 * `api/client`, so a harness that posts must mount it, the way the app does. */
function MeProbe() {
  const me = useMe();
  return <div data-testid="me-loaded">{me.data?.id ?? ""}</div>;
}

function renderAt(
  path: string,
  stubs: RouteStub[],
): { requests: ReturnType<typeof mockFetch>["requests"] } {
  const { requests } = mockFetch([
    ...stubs,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const section: ReactNode = (
    <>
      <MeProbe />
      <ProjectsSection />
    </>
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/manage/projects" element={section} />
          {/* Creating a project lands the person on its own page, which is what
            the route under `/manage/projects/:itemId` mounts. */}
          <Route path="/manage/projects/:itemId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("/manage/projects — the list", () => {
  it("lists the visible projects with the caller's role", async () => {
    const { requests } = renderAt("/manage/projects", [
      {
        path: "/api/v1/projects",
        method: "GET",
        body: { items: [projectFixture, otherProject] },
      },
      ...countRoutes([projectFixture, otherProject]),
    ]);

    const list = await screen.findByTestId("manage-projects-table");
    expect(list.querySelectorAll("tbody tr")).toHaveLength(2);

    const widgets = screen.getByTestId(`manage-projects-table-row-${projectFixture.id}-link`);
    expect(widgets.getAttribute("href")).toBe(routes.manage("projects", projectFixture.id));
    expect(widgets.textContent).toContain("Widgets");
    // The role the server reported for the caller, on the row.
    expect(list.textContent).toContain("maintainer");
    expect(
      screen.getByTestId(`manage-projects-table-row-${otherProject.id}`).textContent,
    ).toContain("viewer");
    // And the two counts the section exists to show, each from its own route.
    await waitFor(() =>
      expect(screen.getByTestId(`project-repos-${projectFixture.slug}`).textContent).toBe("1"),
    );
    expect(screen.getByTestId(`project-people-${projectFixture.slug}`).textContent).toBe("1");

    // The page's own data is one org-wide list read; the only per-project reads
    // are the two counts the columns name.
    expect(requestsTo(requests, "/api/v1/projects", "GET").length).toBeLessThanOrEqual(2);
  });

  it("shows an empty state when there are no projects", async () => {
    renderAt("/manage/projects", [
      { path: "/api/v1/projects", method: "GET", body: { items: [] } },
    ]);
    const empty = await screen.findByTestId("manage-projects-table-empty");
    expect(empty.textContent).toContain("No projects yet");
  });

  it("creates a project with the CSRF header and opens it", async () => {
    const { requests } = renderAt("/manage/projects", [
      { path: "/api/v1/projects", method: "GET", body: { items: [] } },
      { path: "/api/v1/projects", method: "POST", status: 201, body: projectFixture },
      ...projectDetailRoutes(projectFixture),
      ...countRoutes([projectFixture]),
    ]);

    // An account with no projects opens the form by itself: adding one is the
    // only action the screen has.
    const name = await screen.findByTestId("create-project-name");
    // The CSRF token arrives with `/me`, the same read the shell makes.
    await waitFor(() => expect(screen.getByTestId("me-loaded").textContent).toBe(meFixture.id));
    fireEvent.change(name, {
      target: { value: "Widgets" },
    });
    fireEvent.change(screen.getByTestId("create-project-description"), {
      target: { value: "Widget incubator" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    // Navigation to the new project proves the 201 was handled and the list invalidated.
    expect((await screen.findByTestId("detail-name")).textContent).toBe("Widgets");

    const [request] = requestsTo(requests, "/api/v1/projects", "POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      name: "Widgets",
      description: "Widget incubator",
    });
    expect(requestsTo(requests, "/api/v1/projects", "GET").length).toBeGreaterThan(1);
  });

  it("shows the problem detail inline when the slug is taken (409)", async () => {
    renderAt("/manage/projects?new=1", [
      { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
      ...countRoutes([projectFixture]),
      {
        path: "/api/v1/projects",
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/slug-taken",
          title: "Slug already taken",
          status: 409,
          detail: 'An organization project with slug "widgets" already exists.',
        },
      },
    ]);

    fireEvent.change(await screen.findByTestId("create-project-name"), {
      target: { value: "Widgets" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    const error = await screen.findByTestId("form-error");
    expect(error.textContent).toContain("Slug already taken");
    expect(error.textContent).toContain("already exists");
    // The form names the way out in its own words, too.
    expect((await screen.findByTestId("create-project-conflict")).textContent).toContain(
      "Pick a different name",
    );
    // Still on the projects list — nothing was created.
    expect(screen.queryByTestId("detail-name")).toBeNull();
    expect(screen.getByTestId("manage-projects-table")).toBeTruthy();
  });

  it("shows the problem detail inline for a validation failure (422)", async () => {
    renderAt("/manage/projects", [
      { path: "/api/v1/projects", method: "GET", body: { items: [] } },
      {
        path: "/api/v1/projects",
        method: "POST",
        status: 422,
        body: {
          type: "https://communication.dev/errors/validation-failed",
          title: "Validation failed",
          status: 422,
          detail: "name is required.",
        },
      },
    ]);

    fireEvent.change(await screen.findByTestId("create-project-name"), {
      target: { value: "Widgets" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    expect((await screen.findByTestId("form-error")).textContent).toContain("name is required.");
  });
});
