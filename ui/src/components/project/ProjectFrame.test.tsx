/**
 * The shared 1b frame (Projects Review design 1b).
 *
 * What this component is FOR: every screen under `/p/:id` that is a tab draws
 * the same header band, the same tab row with the current tab marked, and the
 * same answer when the project cannot be opened. The pass-2 review found the
 * Runs, Threads and Workflows routes drawing the OLD page instead — the
 * `ProjectSectionNav` rail and their own headlines — so the assertions below
 * are exactly those failures, written down: the band, the mark, one navigation,
 * and the refusal that shows no band at all.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { setCsrfToken } from "../../api/client";
import { resetReplicaName } from "../../api/replica";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import { ProjectFrame } from "./ProjectFrame";
import { routes } from "../../lib/routes";

afterEach(cleanup);

const projectPath = `/api/v1/projects/${projectFixture.id}`;

function mount(
  {
    active,
    testid = "project-tab",
    heading = "Runs",
    extraRoutes = [],
  }: {
    active: "runs" | "threads" | "workflows";
    testid?: string;
    heading?: string;
    extraRoutes?: RouteStub[];
  },
  at = routes.projectTab(projectFixture.id, "runs"),
) {
  setCsrfToken(null);
  resetReplicaName();
  const stubs: RouteStub[] = [
    ...extraRoutes,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: "/api/v1/users", body: { items: [] } },
    { path: `${projectPath}/members`, body: { items: [] } },
    { path: `${projectPath}/approvals`, body: { approvals: [] } },
    { path: `${projectPath}/conversations`, body: { items: [] } },
    { path: `${projectPath}/assignments`, body: { assignments: [] } },
    { path: projectPath, body: projectFixture },
  ];
  mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route
            path="/p/:projectId/:tab"
            element={
              <ProjectFrame
                projectId={projectFixture.id}
                active={active}
                testid={testid}
                heading={heading}
              >
                {(project, openNewThread) => (
                  <div data-testid="tab-body">
                    {project.name}
                    <button type="button" data-testid="body-new-thread" onClick={openNewThread}>
                      body verb
                    </button>
                  </div>
                )}
              </ProjectFrame>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectFrame", () => {
  it("draws the band, the tab row and the body under it", async () => {
    mount({ active: "runs" });

    expect(await screen.findByTestId("project-header")).toBeTruthy();
    expect(screen.getByTestId("project-name").textContent).toBe(projectFixture.name);
    // The band's `Start run` is the Runs tab's one door into the form — it
    // navigates with `?new=1`, which opens `NewRunForm` over the list.
    expect(screen.getByTestId("project-start-run").getAttribute("href")).toBe(
      `${routes.projectTab(projectFixture.id, "runs")}?new=1`,
    );
    expect(await screen.findByTestId("tab-body")).toBeTruthy();
  });

  it("marks the active tab — and only that one — with aria-current", async () => {
    mount({ active: "workflows" }, routes.projectTab(projectFixture.id, "pipelines"));

    const tabs = within(await screen.findByTestId("project-tabs"));
    expect(tabs.getByTestId("project-tab-workflows").getAttribute("aria-current")).toBe("page");
    expect(tabs.getByTestId("project-tab-runs").getAttribute("aria-current")).toBeNull();
    expect(tabs.getByTestId("project-tab-threads").getAttribute("href")).toBe(
      routes.projectTab(projectFixture.id, "conversations"),
    );
  });

  it("is the only navigation the page has, on the shell's full-bleed column", async () => {
    mount({ active: "threads" }, routes.projectTab(projectFixture.id, "conversations"));

    const shell = await screen.findByTestId("project-tab");
    // Every project tab route is in `App.tsx`'s full-bleed list (the pass-2
    // review: the centred `max-w-5xl` column shifted the band's title and
    // capped the body), so the frame owns its inset outright — no negative
    // margin bleeding into shell padding any more, and no sideways scroll.
    expect(shell.className).not.toContain("-mx-4");
    expect(shell.className).not.toContain("-mt-6");
    expect(within(shell).getAllByRole("navigation", { name: /project sections/i })).toHaveLength(1);
  });

  it("gives an empty state the band's own verb, not a second dialog", async () => {
    mount({ active: "threads" }, routes.projectTab(projectFixture.id, "conversations"));

    fireEvent.click(await screen.findByTestId("body-new-thread"));
    const dialog = await screen.findByTestId("new-conversation-dialog");
    // The project is FIXED (the band's verb is scoped to the page you are on):
    // the dialog names the project instead of offering a picker.
    const fixed = within(dialog).getByTestId("new-conversation-dialog-project");
    expect(fixed.tagName).not.toBe("SELECT");
    expect(fixed.textContent).toBe(projectFixture.name);
  });

  it("shows one sentence and no band when the project cannot be opened", async () => {
    mount({
      active: "runs",
      testid: "project-runs",
      extraRoutes: [{ path: projectPath, status: 404, body: { status: 404, title: "Not Found" } }],
    });

    const refusal = await screen.findByTestId("project-runs-not-found");
    expect(refusal.textContent).toBe("Project not found or you do not have access");
    // The shell is the leak: no band, no tabs, no counts, no body.
    expect(screen.queryByTestId("project-header")).toBeNull();
    expect(screen.queryByTestId("project-tabs")).toBeNull();
    expect(screen.queryByTestId("tab-body")).toBeNull();
    expect(screen.queryByTestId("project-runs")).toBeNull();
  });

  it("quotes the server when the failure is not an access refusal", async () => {
    mount({
      active: "runs",
      testid: "project-runs",
      extraRoutes: [
        {
          path: projectPath,
          status: 503,
          body: { status: 503, title: "Service unavailable", detail: "still migrating" },
        },
      ],
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Service unavailable");
    expect(alert.textContent).toContain("still migrating");
    await waitFor(() => expect(screen.getByTestId("project-runs-error")).toBeTruthy());
    // Pass-3 review: the failure is a PAGE, not a crash banner. Its H1 wears the
    // same header band the refusal draws — the `Projects /` breadcrumb, the
    // section's title and the band's bottom rule — and the server's answer sits
    // under it, with one way back in the band rather than a second link in the
    // box.
    const shell = screen.getByTestId("project-runs-error");
    const heading = screen.getByRole("heading", { level: 1 });
    const band = heading.closest("header");
    expect(band).toBeTruthy();
    expect(band?.className.split(/\s+/)).toContain("border-b");
    expect(band?.querySelector("nav[aria-label='Breadcrumb']")).toBeTruthy();
    expect(within(band as HTMLElement).getByTestId("project-runs-back-to-projects")).toBeTruthy();
    expect(alert.textContent).not.toContain("←");
    // A plain sentence, not the reviewer's `draws none of it rather than part of
    // a guess`.
    expect(shell.textContent).toContain("The project could not be loaded");
    expect(shell.textContent).not.toContain("rather than part of a guess");
  });

  it("says which section is loading while the project read has not answered", async () => {
    // A route param that never arrives is the honest case for this branch: the
    // project read is `enabled` only on a non-empty id, so it stays pending and
    // the page says which section is waiting — the band cannot be drawn before
    // the name it prints exists.
    setCsrfToken(null);
    resetReplicaName();
    const { requests } = mockFetch([{ path: "/api/v1/me", body: meFixture }]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[routes.projectTab("", "runs")]}>
          <ProjectFrame projectId="" active="runs" testid="project-runs" heading="Runs">
            {() => <div data-testid="tab-body" />}
          </ProjectFrame>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("project-runs-loading")).toBeTruthy();
    expect(screen.getByText(/Loading runs/)).toBeTruthy();
    expect(screen.queryByTestId("tab-body")).toBeNull();
    // And it never asked for a project that has no id.
    expect(requests.filter((r) => r.url === "/api/v1/projects/")).toHaveLength(0);
  });
});
