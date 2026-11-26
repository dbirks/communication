/**
 * Manage → Repositories and People (redesign R7): the two tables whose rows
 * are built from per-project reads. What is pinned is the honesty, not the
 * layout — a project whose read was refused is counted, never shown as empty —
 * and the shape of the merged person row.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import RepositoriesSection from "./Repositories";
import PeopleSection from "./People";
import { mockFetch, meFixture, type RouteStub } from "../../test/fakes";
import type { Project, Repository } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ONE = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const TWO = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81";

const projectOne: Project = {
  id: ONE,
  slug: "project-one",
  name: "Project One",
  description: "",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "maintainer",
};
const projectTwo: Project = { ...projectOne, id: TWO, slug: "project-two", name: "Project Two" };

function repository(
  projectId: string,
  id: string,
  name: string,
  credential: "none" | "configured",
): Repository {
  return {
    id,
    project_id: projectId,
    name,
    git_url: `https://git.example/${name}.git`,
    default_branch: "main",
    created_at: "2026-10-14T18:00:00Z",
    credential,
  };
}

function renderAt(element: ReactNode, path: string, extra: RouteStub[]) {
  mockFetch([
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectOne, projectTwo] } },
    { path: `/api/v1/projects/${ONE}`, body: projectOne },
    { path: `/api/v1/projects/${TWO}`, body: projectTwo },
    { path: `/api/v1/projects/${ONE}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${TWO}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${ONE}/members`, body: { items: [] } },
    { path: `/api/v1/projects/${TWO}/members`, body: { items: [] } },
    { path: "/api/v1/users", body: { items: [] } },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Repositories table", () => {
  it("lists every project's repositories with their branch and credential state", async () => {
    renderAt(<RepositoriesSection />, "/manage/repositories", [
      {
        path: `/api/v1/projects/${ONE}/repos`,
        body: { items: [repository(ONE, "repo-1", "first-repo", "configured")] },
      },
      {
        path: `/api/v1/projects/${TWO}/repos`,
        body: { items: [repository(TWO, "repo-2", "second-repo", "none")] },
      },
    ]);
    const table = await screen.findByTestId("manage-repositories-table", {}, { timeout: 5000 });
    expect(table.textContent).toContain("first-repo");
    expect(table.textContent).toContain("second-repo");
    expect(screen.getByTestId("repo-status-repo-1").textContent).toContain("credential");
    expect(screen.getByTestId("repo-status-repo-2").textContent).toContain("no credential");
    // The row links to the repository page, whose address is the project's.
    expect(
      screen.getByTestId("manage-repositories-table-row-repo-1-link").getAttribute("href"),
    ).toBe(`/p/${ONE}/first-repo`);
  });

  it("counts the projects it could not read instead of showing them as empty", async () => {
    renderAt(<RepositoriesSection />, "/manage/repositories", [
      { path: `/api/v1/projects/${ONE}/repos`, status: 500, body: {} },
    ]);
    const line = await screen.findByTestId("repo-unread", {}, { timeout: 5000 });
    expect(line.textContent).toContain("1 project could not be read");
    // The project that answered still contributes its (empty) result.
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it("disables the add action while All projects is the choice", async () => {
    renderAt(<RepositoriesSection />, "/manage/repositories", []);
    const button = await screen.findByTestId("manage-add-repository");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("Pick a project first");
  });
});

describe("People merged table", () => {
  it("folds one person across projects and prints the highest role", async () => {
    renderAt(<PeopleSection />, "/manage/people", [
      {
        path: `/api/v1/projects/${ONE}/members`,
        body: { items: [{ user_id: meFixture.id, display_name: "Ada Lovelace", role: "viewer" }] },
      },
      {
        path: `/api/v1/projects/${TWO}/members`,
        body: {
          items: [{ user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" }],
        },
      },
    ]);
    const table = await screen.findByTestId("manage-people-table", {}, { timeout: 5000 });
    // One row, not two.
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table.textContent).toContain("Project One, Project Two");
    expect(table.textContent).toContain("maintainer");
    // The per-project roles stay on the row, in the title.
    const role = table.querySelector("td:last-child span");
    expect(role?.getAttribute("title")).toBe("Project One: viewer · Project Two: maintainer");
  });

  it("says no members rather than nothing at all when every list is empty", async () => {
    renderAt(<PeopleSection />, "/manage/people", []);
    await waitFor(() => expect(screen.getByTestId("manage-people-table-empty")).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByTestId("manage-people-table-empty").textContent).toContain("No members yet");
  });
});
