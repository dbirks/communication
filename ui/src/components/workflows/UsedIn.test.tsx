/**
 * The `USED IN` panel's header (design 2a). Three states, and only two of them
 * are allowed a number: a read that answered counts (`USED IN 1 REPO`, one repo
 * is one repo), a read that broke and a read still in flight say the section's
 * name and nothing else — the pass-7 review's defect was `USED IN ? REPOS` /
 * the tab's `Used in ?`, a question mark sitting in a number's seat while the
 * FAILED banner next to it already told the truth in words.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Assignment, Project } from "../../api/types";
import { UsedInPanel, usedInPanelTitle, type UsedInRevision } from "./UsedIn";
import type { UsedInGroup } from "../../pages/workflow/useUsedIn";

afterEach(cleanup);

const REVIEWS: UsedInRevision[] = [
  {
    id: "rev-2",
    revision_number: 2,
    revision_digest: "sha256:bbbb",
    version_label: "r2",
    status: "published",
  },
];

function group(id: string, repo: string): UsedInGroup {
  return {
    project: { id: `proj-${id}`, name: `Project ${id}` } as Project,
    assignment: {
      id,
      project_id: `proj-${id}`,
      pipeline_id: "pipe-1",
      pinned_revision_id: "rev-2",
      pinned_revision_digest: "sha256:bbbb",
      pinned_version_label: "r2",
      repository_id: `repo-${id}`,
      repository_name: repo,
      max_concurrent_runs: 1,
      budget_overrides: {},
      effective_budgets: {},
      enabled: true,
      version: 1,
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    } as Assignment,
    repositories: [
      {
        id: `repo-${id}`,
        project_id: `proj-${id}`,
        name: repo,
        git_url: "git@example.test:acme/app.git",
        default_branch: "main",
        created_at: "2026-10-01T10:00:00Z",
      },
    ],
    schedules: [],
    issueTriggers: [],
    runs: [],
    triggersArrived: true,
    triggersError: false,
  };
}

function mount(props: {
  groups: UsedInGroup[];
  loading: boolean;
  error: boolean;
  newestPublished?: UsedInRevision | null;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UsedInPanel
          pipelineId="pipe-1"
          groups={props.groups}
          loading={props.loading}
          error={props.error}
          revisions={REVIEWS}
          newestPublished={props.newestPublished ?? REVIEWS[0]}
          newestPublishedId={props.newestPublished === null ? null : "rev-2"}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 2 });
}

describe("usedInPanelTitle", () => {
  it("counts one repo as one repo, and two as two", () => {
    expect(usedInPanelTitle(1, false, false)).toBe("USED IN 1 REPO");
    expect(usedInPanelTitle(2, false, false)).toBe("USED IN 2 REPOS");
    expect(usedInPanelTitle(0, false, false)).toBe("USED IN 0 REPOS");
  });

  it("never counts a broken read or a read still in flight", () => {
    expect(usedInPanelTitle(0, false, true)).toBe("USED IN");
    // A fan that broke halfway is not countable either: the arrived rows are
    // facts, their total is not, and a number here reads as the whole truth.
    expect(usedInPanelTitle(2, false, true)).toBe("USED IN");
    expect(usedInPanelTitle(0, true, false)).toBe("USED IN");
    // Rows that already arrived keep counting while the rest of the fan reads.
    expect(usedInPanelTitle(2, true, false)).toBe("USED IN 2 REPOS");
  });
});

describe("the USED IN panel header", () => {
  it("says the count it read, in the singular when there is one use", async () => {
    mount({ groups: [group("a", "app")], loading: false, error: false });
    expect(await screen.findByTestId("used-in")).toBeTruthy();
    expect(heading().textContent).toBe("USED IN 1 REPO");
  });

  it("drops the number entirely over a failed read, and keeps the FAILED banner", async () => {
    mount({ groups: [], loading: false, error: true });
    const panel = await screen.findByTestId("used-in");
    expect(heading().textContent).toBe("USED IN");
    expect(heading().textContent).not.toContain("?");
    expect(panel.querySelector("[data-testid='used-in-error']")).toBeTruthy();
    // The honest absence never speaks over a failed read.
    expect(screen.queryByTestId("used-in-empty")).toBeNull();
  });

  it("says nothing countable while the fan is still reading", async () => {
    mount({ groups: [], loading: true, error: false });
    await screen.findByTestId("used-in-loading");
    expect(heading().textContent).toBe("USED IN");
  });
});

// The panel's own two sentences (2026-10-30 copy review, 2a item 7): the empty
// line is ordinary text — quoting the button in inline mono inside a UI-font
// sentence came out with uneven word-spacing and read as a piece of the
// interface — and the `Open ›` footnote belongs under a list that HAS rows.
describe("the USED IN panel's sentences", () => {
  it("writes the empty line in one voice, with no inline mono fragment", async () => {
    mount({ groups: [], loading: false, error: false });
    const empty = await screen.findByTestId("used-in-empty");
    expect(empty.textContent).toContain("Not used in any repo yet");
    expect(empty.textContent).toContain("Use in a repo…");
    expect(empty.querySelector("code, span.font-mono")).toBeNull();
  });

  it("keeps the `Open ›` footnote under a list of rows", async () => {
    mount({ groups: [group("a", "app")], loading: false, error: false });
    expect(await screen.findByTestId("used-in-footnote")).toBeTruthy();
  });

  it("hides the `Open ›` footnote when there are no rows to open", async () => {
    mount({ groups: [], loading: false, error: false });
    await screen.findByTestId("used-in-empty");
    expect(screen.queryByTestId("used-in-footnote")).toBeNull();
  });
});
