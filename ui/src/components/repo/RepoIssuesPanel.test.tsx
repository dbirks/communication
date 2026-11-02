/**
 * The side panel's OPEN ISSUES list (design 3a): the bar counts everything
 * GitHub answers with, the panel itself lists at most eight, and `all ›` —
 * the design's meta link — walks to GitHub's own issue list for the rest.
 * A busy tracker (the lab's `server` repository: eighteen open) must not
 * turn the repo page into an endless scroll.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { GitHubIssueList, useRepoIssues } from "../../api/issues";
import type { Repository } from "../../api/types";
import { projectFixture } from "../../test/fakes";
import { RepoIssuesPanel } from "./RepoIssuesPanel";

afterEach(cleanup);

const repository: Repository = {
  id: "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0",
  project_id: projectFixture.id,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none",
};

const list: GitHubIssueList = {
  repository: "example/communication",
  state: "open",
  items: Array.from({ length: 10 }, (_, i) => ({
    number: 500 + i,
    title: `Issue ${500 + i}`,
    body: "Body.",
    labels: [],
    html_url: `https://github.com/example/communication/issues/${500 + i}`,
    state: "open",
    updated_at: "2026-10-14T17:00:00Z",
    body_truncated: false,
  })),
};

function renderPanel(): void {
  // The panel speaks the query hook's result shape; the read itself belongs
  // to the page, so the fake carries only what the panel reads off it.
  const issues = {
    data: list,
    error: null,
    isError: false,
    isPending: false,
  } as unknown as ReturnType<typeof useRepoIssues>;
  render(
    <MemoryRouter>
      <RepoIssuesPanel
        repository={repository}
        projectId={projectFixture.id}
        issues={issues}
        githubHosted
        assignments={[]}
        names={new Map()}
        activeRunsByIssue={new Map()}
        expandedIssue={null}
        onExpand={() => {}}
        canManageGitHub={false}
        onAddGitHubAccess={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("the OPEN ISSUES panel cap", () => {
  it("lists at most eight issues", () => {
    renderPanel();
    expect(screen.getByTestId("repo-issues-list").children).toHaveLength(8);
    expect(screen.getByTestId("repo-issue-500")).toBeTruthy();
    expect(screen.getByTestId("repo-issue-507")).toBeTruthy();
    expect(screen.queryByTestId("repo-issue-508")).toBeNull();
    expect(screen.queryByTestId("repo-issue-509")).toBeNull();
  });
  it("still counts them all in the bar, and sends the rest to GitHub", () => {
    renderPanel();
    expect(document.getElementById("repo-issues-heading")?.textContent).toContain("10");
    const all = screen.getByTestId("repo-issues-all");
    expect(all.getAttribute("href")).toBe("https://github.com/example/communication/issues");
  });
});
