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

function renderPanel(items: GitHubIssueList["items"] = list.items): void {
  // The panel speaks the query hook's result shape; the read itself belongs
  // to the page, so the fake carries only what the panel reads off it.
  const issues = {
    data: { ...list, items },
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

/**
 * The rcn-3b overlap defect in List form: a snake_case title
 * (`assign_copilot_to_issue`) has no break opportunity, so at the panel's
 * width it overflowed the title's own box and drew under the row's `Hand off`
 * button. jsdom lays nothing out, so this asserts the structure the layout
 * rests on — the title breaks anywhere and may shrink, the button cannot.
 */
describe("the OPEN ISSUES row holds a long unbreakable title", () => {
  it("wraps the title inside its column and keeps the Hand off button whole", () => {
    renderPanel([
      {
        ...list.items[0],
        number: 11666,
        title: "Test issue for assign_copilot_to_issue",
      },
    ]);
    const row = screen.getByTestId("repo-issue-11666");
    const title = screen.getByTestId("repo-issue-title-11666");
    const handOff = screen.getByTestId("repo-issue-run-11666");

    expect(title.textContent).toContain("assign_copilot_to_issue");
    // `wrap-anywhere` = Tailwind v4's `overflow-wrap: anywhere`.
    expect(title.className, "the title breaks an unbreakable word").toContain("wrap-anywhere");
    // The column the title lives in is the shrinkable one (min-width:0).
    const column = title.parentElement as HTMLElement;
    expect(column.className, "the title column may shrink").toContain("min-w-0");
    expect(column.className).toContain("flex-1");
    // `flex: none` — the button never shrinks, and it is a sibling of the
    // column rather than something the title can overflow onto from within.
    expect(handOff.className, "the Hand off button never shrinks").toContain("flex-none");
    expect(column.contains(handOff)).toBe(false);
    expect(row.contains(column)).toBe(true);
    expect(row.contains(handOff)).toBe(true);
  });
});
