/**
 * The project header band's actions (redesign finding 09).
 *
 * What the finding named: the project's configure actions lived behind a "⋯" on
 * the sidebar row that was `opacity-0` until hover or focus. On a touch screen
 * and in the 52px rail it never appeared, and its "Add repository" item did not
 * open the form — it navigated to the overview and left the reader to find the
 * `+ add` link. The two actions now stand in the header beside the project's
 * two verbs, and `+ Repository` opens `AddRepositoryDialog` where it is
 * pressed. The sidebar's own half of the contract is pinned in
 * `components/Sidebar.test.tsx`.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { setCsrfToken } from "../../api/client";
import { resetReplicaName } from "../../api/replica";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import type { Project } from "../../api/types";
import { ProjectHeader } from "./ProjectHeader";

afterEach(cleanup);

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;

function mount(project: Project = projectFixture, extra: RouteStub[] = []) {
  setCsrfToken(null);
  resetReplicaName();
  const stubs: RouteStub[] = [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `${projectPath}/approvals`, body: { approvals: [] } },
    { path: `${projectPath}/runs`, body: { runs: [] } },
    { path: `${projectPath}/conversations`, body: { items: [] } },
    { path: `${projectPath}/assignments`, body: { assignments: [] } },
  ];
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const openThread = () => undefined;
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${projectId}`]}>
        <Routes>
          <Route
            path="/p/:projectId"
            element={<ProjectHeader project={project} active="overview" onNewThread={openThread} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("the project header's actions (finding 09)", () => {
  it("puts + Repository and Settings beside the two verbs, not behind a hover menu", async () => {
    mount();

    const header = await screen.findByTestId("project-header");
    const add = within(header).getByTestId("project-add-repository");
    const settings = within(header).getByTestId("project-settings-link");
    // Nothing in the band is hidden until you hover it.
    for (const action of [add, settings]) {
      expect(action.className).not.toMatch(/(^|[\s:"])opacity-0([\s:"']|$)/);
    }
    expect(add.textContent).toBe("+ Repository");
    expect(settings.getAttribute("href")).toBe(`/p/${projectId}/settings`);
  });

  it("opens the add-repository dialog on the spot and posts to the project", async () => {
    const { requests } = mount(projectFixture, [
      {
        path: `${projectPath}/repos`,
        method: "POST",
        status: 201,
        body: {
          id: "01987a80-0000-7000-8000-abcdef012345",
          project_id: projectId,
          name: "backend",
          git_url: "https://github.com/example/backend.git",
          default_branch: "main",
          created_at: "2026-11-08T10:00:00Z",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("project-add-repository"));
    // The finding's complaint was that this item navigated instead of opening
    // the form: the dialog is on the same page the button stands on.
    const dialog = await screen.findByTestId("add-repository-dialog");
    fireEvent.change(within(dialog).getByTestId("repo-name"), { target: { value: "backend" } });
    fireEvent.change(within(dialog).getByTestId("repo-git-url"), {
      target: { value: "https://github.com/example/backend.git" },
    });
    fireEvent.click(within(dialog).getByTestId("repo-submit"));

    await waitFor(() =>
      expect(requestsTo(requests, `${projectPath}/repos`, "POST")).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByTestId("add-repository-dialog")).toBeNull());
  });

  it("keeps Settings for a viewer, who gets no verb and no repository form", async () => {
    mount({ ...projectFixture, my_role: "viewer" });

    const header = await screen.findByTestId("project-header");
    expect(within(header).queryByTestId("project-new-conversation")).toBeNull();
    expect(within(header).queryByTestId("project-start-run")).toBeNull();
    expect(within(header).queryByTestId("project-add-repository")).toBeNull();
    expect(within(header).getByTestId("project-settings-link").getAttribute("href")).toBe(
      `/p/${projectId}/settings`,
    );
    // The honest line about why the verbs are gone stays.
    expect(within(header).getByTestId("project-role-hint").textContent).toContain("read-only");
  });

  it("hides + Repository from a contributor, whose add the server would refuse", async () => {
    mount({ ...projectFixture, my_role: "contributor" });

    const header = await screen.findByTestId("project-header");
    expect(within(header).getByTestId("project-new-conversation")).toBeTruthy();
    expect(within(header).queryByTestId("project-add-repository")).toBeNull();
  });
});
