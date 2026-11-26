/**
 * RepoList: one mono row per repository with the honest short status, the
 * empty sentence, and the Add repository link carrying this project.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { RepoList, addRepositoryHref, repoStatusText } from "./RepoList";
import { mockFetch, projectFixture, repositoryId, type RouteStub } from "../../test/fakes";
import type { GitHubIssueList } from "../../api/issues";
import type { RepositoryList } from "../../api/types";

const projectId = projectFixture.id;

function repo(overrides: Partial<RepositoryList["items"][number]> = {}) {
  return {
    id: repositoryId,
    project_id: projectId,
    name: "app",
    git_url: "https://github.com/example/app.git",
    default_branch: "main",
    created_at: "2026-10-14T18:00:00Z",
    ...overrides,
  };
}

function harness(routes: RouteStub[]) {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { wrapper };
}

function issues(count: number): GitHubIssueList {
  return {
    repository: "app",
    state: "open",
    items: Array.from({ length: count }, (_unused, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      body: "",
      state: "open" as const,
      html_url: `https://github.com/example/app/issues/${index + 1}`,
      labels: [],
      updated_at: "2026-11-20T10:00:00Z",
      body_truncated: false,
    })),
  };
}

afterEach(cleanup);

describe("RepoList", () => {
  it("heads the block with a column heading that survives an empty list", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/repos`, body: { items: [] } },
    ]);
    render(<RepoList projectId={projectId} />, { wrapper });

    const head = await screen.findByTestId("repo-list-label");
    expect(head.tagName).toBe("H3");
    expect(head.textContent).toBe("Repos");
    expect(head.className).toContain("text-[16px]");
    expect(head.className).not.toContain("font-mono");
  });

  it("divides its rows and words its add link in the UI font", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/repos`, body: { items: [repo()] } },
      {
        path: `/api/v1/projects/${projectId}/repos/${repositoryId}/issues`,
        body: issues(3),
      },
    ]);
    render(<RepoList projectId={projectId} />, { wrapper });

    const row = await screen.findByTestId("repo-row-app");
    expect(row.className).toContain("border-b");
    expect(row.className).toContain("border-line-soft");

    const add = screen.getByTestId("repo-list-add");
    expect((add.textContent ?? "").trim()).toBe("Add repository");
    expect(add.className).not.toContain("font-mono");
    expect(add.className).toContain("text-[13px]");
    expect(add.className).toContain("text-accent-text");
    expect(add.className).toContain("hover:underline");
  });

  it("says the empty sentence and still offers the repository form", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/repos`, body: { items: [] } },
    ]);
    render(<RepoList projectId={projectId} />, { wrapper });

    const empty = await screen.findByText(/No repositories here yet/);
    expect(empty.getAttribute("data-testid")).toBe("repo-list-empty");
    expect(screen.getByTestId("repo-list-add").getAttribute("href")).toBe(
      addRepositoryHref(projectId),
    );
    expect(addRepositoryHref(projectId)).toBe(`/manage/repositories?project=${projectId}`);
  });

  it("prints a mono row per repository with its open-issue status", async () => {
    const { wrapper } = harness([
      { path: `/api/v1/projects/${projectId}/repos`, body: { items: [repo()] } },
      {
        path: `/api/v1/projects/${projectId}/repos/${repositoryId}/issues`,
        body: issues(3),
      },
    ]);
    render(<RepoList projectId={projectId} />, { wrapper });

    const row = await screen.findByTestId("repo-row-app");
    expect(row.querySelector("a")?.getAttribute("href")).toBe(`/p/${projectId}/app`);
    expect((await screen.findByTestId("repo-status-app")).textContent).toBe("3 open issues");
  });

  it("prints nothing for a status the read cannot serve, and `✓ clean` for an empty one", async () => {
    const { wrapper } = harness([
      {
        path: `/api/v1/projects/${projectId}/repos`,
        body: {
          items: [
            repo(),
            repo({
              id: "01987b40-0000-7000-8000-000000000002",
              name: "service",
              git_url: "https://git.example.org/team/service.git",
            }),
          ],
        },
      },
      {
        path: `/api/v1/projects/${projectId}/repos/${repositoryId}/issues`,
        body: issues(0),
      },
    ]);
    render(<RepoList projectId={projectId} />, { wrapper });

    expect((await screen.findByTestId("repo-status-app")).textContent).toBe("✓ clean");
    // The non-GitHub remote's row exists and says nothing about issues: the
    // route could not answer for it, so any word would be a claim.
    await screen.findByTestId("repo-row-service");
    expect(screen.queryByTestId("repo-status-service")).toBeNull();
    expect(repoStatusText(false, 4)).toBeNull();
    expect(repoStatusText(true, null)).toBeNull();
  });
});
