/**
 * The 3a side panel's trigger surface: the ONE trigger line lists EVERY
 * trigger of the assignment (paused ones named and marked, e.g. `GitHub ·
 * issue labeled plan · paused`), the row's `⋯` menu carries `Add trigger…`
 * plus one `Edit <trigger>` item per existing trigger, and each of those
 * opens today's TriggerDialog — the add dialog with no pause switch, the
 * edit dialog with one. (A trigger read that failed says `triggers
 * unavailable`, never `By hand` — the honesty rule the rows were born with.)
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoWorkflowPanel } from "./RepoWorkflowPanel";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type { Schedule } from "../../api/pipelines";
import type { Assignment, Repository } from "../../api/types";
import { meFixture, mockFetch, projectFixture, type RouteStub } from "../../test/fakes";
import { testidOf } from "../../lib/format";
import {
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipelineList,
  wireRevision,
} from "../../test/fixtures/m4/wire";

const repository: Repository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  name: "storefront",
  git_url: "https://github.com/northwind/storefront.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
  credential: "none",
};

const assignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repository.id,
  repository_name: repository.name,
};
const assignmentKey = testidOf(assignment.id);

const SCHEDULE_ID = "01987b24-0001-7000-8000-abcdef012345";
const ISSUE_TRIGGER_ID = "01987b24-0009-7000-8000-abcdef012345";

function wireSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    project_id: projectFixture.id,
    assignment_id: assignment.id,
    cron_expr: "0 9 * * *",
    inputs: { goal: "Nightly sweep" },
    enabled: true,
    next_run_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    last_run_at: null,
    last_run_id: null,
    version: 3,
    created_by: meFixture.id,
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-20T09:00:00Z",
    ...overrides,
  };
}

function wireIssueTrigger(overrides: Partial<IssueTrigger> = {}): IssueTrigger {
  return {
    id: ISSUE_TRIGGER_ID,
    project_id: projectFixture.id,
    assignment_id: assignment.id,
    repository_id: repository.id,
    event: "labeled",
    labels: ["plan"],
    inputs: { goal: "{{issue.title}}\n\n{{issue.body}}" },
    enabled: true,
    cursor_at: null,
    last_polled_at: null,
    last_error: "",
    version: 5,
    created_by: meFixture.id,
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-20T09:00:00Z",
    my_role: "maintainer",
    ...overrides,
  };
}

function mount(overrides: RouteStub[] = []) {
  const base: RouteStub[] = [
    {
      path: `/api/v1/projects/${projectFixture.id}/assignments`,
      method: "GET",
      body: { assignments: [assignment] },
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/schedules`,
      method: "GET",
      body: { schedules: [] },
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
      method: "GET",
      body: { issue_triggers: [] },
    },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
    {
      path: `/api/v1/revisions/${WIRE_REVISION_ID}`,
      method: "GET",
      body: wireRevision,
    },
  ];
  mockFetch([...overrides, ...base]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RepoWorkflowPanel
          projectId={projectFixture.id}
          project={projectFixture}
          repository={repository}
          runs={[]}
          runsPending={false}
          runsError={null}
          onRun={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return assignmentKey;
}

/** Open the row's `⋯` menu and wait for it to land. */
async function openRowMenu(key: string) {
  fireEvent.click(await screen.findByTestId(`repo-workflow-menu-${key}`));
  await screen.findByTestId("repo-workflow-row-menu");
}

afterEach(cleanup);

describe("RepoWorkflowPanel — the trigger line (3a)", () => {
  it("says By hand when both reads answer and no trigger exists", async () => {
    const key = mount();
    const line = await screen.findByTestId(`repo-workflow-triggers-${key}`);
    expect(line.textContent).toBe("By hand");
  });

  it("lists EVERY trigger of the assignment and marks the paused one", async () => {
    const key = mount([
      {
        path: `/api/v1/projects/${projectFixture.id}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule({ enabled: false })] },
      },
      {
        path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger()] },
      },
    ]);
    const line = await screen.findByTestId(`repo-workflow-triggers-${key}`);
    // The brief's shape: `GitHub · issue labeled factory · paused` — the
    // paused words stay readable (a pause is not a deletion) and the state
    // rides at the end, the same word the dialog's switch shows.
    expect(line.textContent).toBe(
      "GitHub · issue labeled plan · Schedule · daily 09:00 UTC · paused",
    );
  });

  it("says triggers unavailable when a trigger read failed — never By hand", async () => {
    const key = mount([
      {
        path: `/api/v1/projects/${projectFixture.id}/schedules`,
        method: "GET",
        status: 500,
        body: { type: "about:blank", title: "Internal Server Error", status: 500 },
      },
    ]);
    const line = await screen.findByTestId(`repo-workflow-triggers-${key}`);
    expect(line.textContent).toBe("triggers unavailable");
  });
});

describe("RepoWorkflowPanel — the ⋯ menu reaches every trigger (3a)", () => {
  it("offers Add trigger… plus one Edit item per existing trigger", async () => {
    const key = mount([
      {
        path: `/api/v1/projects/${projectFixture.id}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
      {
        path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger()] },
      },
    ]);
    await screen.findByTestId(`repo-workflow-triggers-${key}`);
    await openRowMenu(key);
    expect(screen.getByTestId(`repo-workflow-menu-add-${key}`).textContent).toBe("Add trigger…");
    expect(
      screen.getByTestId(`repo-workflow-menu-issue-${testidOf(ISSUE_TRIGGER_ID)}`).textContent,
    ).toBe("Edit issue labeled plan");
    expect(
      screen.getByTestId(`repo-workflow-menu-schedule-${testidOf(SCHEDULE_ID)}`).textContent,
    ).toBe("Edit daily 09:00 UTC");
  });

  it("Add trigger… opens the dialog with no pause switch (a new trigger is born active)", async () => {
    const key = mount();
    await openRowMenu(key);
    fireEvent.click(screen.getByTestId(`repo-workflow-menu-add-${key}`));
    await screen.findByTestId("trigger-dialog");
    expect(screen.getByRole("heading", { name: "Add a trigger" })).toBeTruthy();
    expect(screen.queryByTestId("trigger-dialog-enabled")).toBeNull();
    // The menu closed with the selection — one door, not two.
    expect(screen.queryByTestId("repo-workflow-row-menu")).toBeNull();
  });

  it("Edit <trigger> opens the dialog on that trigger, carrying its pause switch", async () => {
    const key = mount([
      {
        path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger({ enabled: false })] },
      },
    ]);
    await openRowMenu(key);
    fireEvent.click(screen.getByTestId(`repo-workflow-menu-issue-${testidOf(ISSUE_TRIGGER_ID)}`));
    await screen.findByTestId("trigger-dialog");
    expect(screen.getByRole("heading", { name: "Edit trigger" })).toBeTruthy();
    // The paused trigger opens as Paused, and its line already said so (the
    // trigger reads landed long before the dialog opened — no race).
    const sw = await screen.findByRole("switch", { name: "turn this trigger on" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId(`repo-workflow-triggers-${key}`).textContent).toContain(
      "GitHub · issue labeled plan · paused",
    );
    expect(screen.getByTestId("trigger-dialog-enabled-state").textContent).toBe("Paused");
    // The arm it edits is the one selected — the cron segment is not pressed.
    await waitFor(
      () =>
        expect(screen.getByTestId("trigger-dialog-mode-issue").getAttribute("aria-pressed")).toBe(
          "true",
        ),
      { timeout: 5_000 },
    );
  });
});
