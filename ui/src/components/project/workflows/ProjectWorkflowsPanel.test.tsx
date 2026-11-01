/**
 * `WORKFLOWS IN THIS PROJECT` — the project Workflows tab's one panel —
 * against the fake fetch. The tests that matter: the 2e row shape (chevron,
 * name, `✓ rN` chip, trigger summary, step chain, repo scope), the SAME
 * `STARTS WHEN` rows the repository page uses (shared `RepoScheduleRow` /
 * `RepoIssueRow`, so their `repo-workflow-trigger-*` ids and their PATCHes
 * are asserted by `RepoWorkflows.test.tsx` too — here the project-tab angle
 * is that a workflow's triggers from EVERY repository of the project list on
 * one row), the repo-anchored 2c dialog's context from a whole-project row,
 * the honest states (loading, refused, unavailable), and the words the rows
 * are allowed to speak (no digests, no uuids).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectWorkflowsPanel } from "./ProjectWorkflowsPanel";
import type { IssueTrigger } from "../../../api/useIssueTriggers";
import type { Schedule } from "../../../api/pipelines";
import type { Assignment, Project, Repository } from "../../../api/types";
import {
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../../test/fakes";
import { testidOf } from "../../../lib/format";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wireRevision,
} from "../../../test/fixtures/m4/wire";

const wireProjectId = projectFixture.id;
const PINNED_DIGEST = wireAssignmentList.assignments[0].pinned_revision_digest;
const rowKey = testidOf(WIRE_ASSIGNMENT_ID);

const appRepo: Repository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: wireProjectId,
  name: "app",
  git_url: "https://github.com/widgets/app.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
};
const apiRepo: Repository = {
  ...appRepo,
  id: "01987b22-0003-7000-8000-abcdef012345",
  name: "api",
  git_url: "https://github.com/widgets/api.git",
};

/** The whole-project pin (no `repository_id`) — ADR-0060's any-repo use. */
const projectWideAssignment: Assignment = wireAssignmentList.assignments[0];

/** The same workflow pinned to ONE repository. */
const repoAssignment: Assignment = {
  ...projectWideAssignment,
  id: "01987b22-0009-7000-8000-abcdef012345",
  repository_id: appRepo.id,
  repository_name: appRepo.name,
};

const SCHEDULE_ID = "01987b24-0001-7000-8000-abcdef012345";
const ISSUE_APP_ID = "01987b24-0002-7000-8000-abcdef012345";
const ISSUE_API_ID = "01987b24-0003-7000-8000-abcdef012345";

function wireSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    project_id: wireProjectId,
    assignment_id: projectWideAssignment.id,
    cron_expr: "0 6 * * 1",
    inputs: { goal: "Plan this week's upgrades" },
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

function wireIssueTrigger(id: string, repositoryId: string, overrides = {}): IssueTrigger {
  return {
    id,
    project_id: wireProjectId,
    assignment_id: projectWideAssignment.id,
    repository_id: repositoryId,
    event: "labeled",
    labels: ["plan"],
    inputs: { goal: "{{issue.title}}\n\n{{issue.body}}" },
    enabled: true,
    cursor_at: null,
    last_polled_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    last_error: "",
    version: 3,
    created_by: meFixture.id,
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-20T09:00:00Z",
    my_role: "maintainer",
    ...overrides,
  };
}

function routes(repos: Repository[], overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    {
      path: `/api/v1/projects/${wireProjectId}/assignments`,
      method: "GET",
      body: { assignments: [projectWideAssignment] },
    },
    { path: `/api/v1/projects/${wireProjectId}/schedules`, method: "GET", body: { schedules: [] } },
    {
      path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
      method: "GET",
      body: { issue_triggers: [] },
    },
    { path: `/api/v1/projects/${wireProjectId}/repos`, method: "GET", body: { items: repos } },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, method: "GET", body: wirePipeline },
    { path: `/api/v1/revisions/${PINNED_DIGEST}`, method: "GET", body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, method: "GET", body: wireRevision },
  ];
  return [...overrides, ...base];
}

function mount(
  overrides: RouteStub[] = [],
  project: Project = projectFixture,
  repos: Repository[] = [appRepo, apiRepo],
) {
  const { requests } = mockFetch(routes(repos, overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectWorkflowsPanel projectId={wireProjectId} project={project} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

/** Collapse the open-by-default row (2e item 7) to reach the collapsed shape. */
async function collapseRow() {
  const toggle = await screen.findByTestId(`project-workflow-toggle-${rowKey}`);
  // Issue #68: the 14px chevron stays painted as is; the shared `.icon-hit`
  // utility gives it a ≥28×28 hit area at desktop.
  expect(toggle.className.split(/\s+/)).toContain("icon-hit");
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByTestId(`project-workflow-starts-${rowKey}`)).toBeNull());
}

afterEach(cleanup);

describe("ProjectWorkflowsPanel — the row (2e shape, project scope)", () => {
  it("counts the workflows in the panel title", async () => {
    mount();
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    expect(
      screen.getByRole("heading", { name: /WORKFLOWS IN THIS PROJECT/ }).textContent,
    ).toContain("WORKFLOWS IN THIS PROJECT · 1");
  });

  it("names the workflow, its pinned revision chip, the hand summary and the step chain", async () => {
    mount();
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    await waitFor(() =>
      expect(screen.getByTestId(`project-workflow-name-${rowKey}`).textContent).toBe(
        "Feature development",
      ),
    );
    // The name is the way to the workflow's own page — where its YAML and
    // graph now live. No `Edit` button duplicates it (2e item 8).
    expect(screen.getByTestId(`project-workflow-name-${rowKey}`).getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}`,
    );
    expect(screen.getByTestId(`project-workflow-revision-${rowKey}`).textContent).toBe("r7");
    expect(screen.getByTestId(`project-workflow-summary-${rowKey}`).textContent).toContain(
      "started by hand",
    );
    const chain = screen.getByTestId(`project-workflow-chain-${rowKey}`);
    expect(chain.textContent).toContain("plan");
    expect(chain.textContent).toContain("approve");
    expect(chain.textContent).toContain("loop:");
    // A whole-project pin reads `all repos`, not `whole project` prose or a
    // repository uuid.
    expect(screen.getByTestId(`project-workflow-scope-${rowKey}`).textContent).toBe("all repos");
    // No `Run` on this tab — starting a run is the Runs tab's verb.
    expect(screen.queryByTestId(`project-workflow-run-${rowKey}`)).toBeNull();
  });

  it("shows a repository-pinned use with its repository name as the scope", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [repoAssignment] },
      },
    ]);
    const key = testidOf(repoAssignment.id);
    await screen.findByTestId(`project-workflow-row-${key}`);
    expect(screen.getByTestId(`project-workflow-scope-${key}`).textContent).toBe("app");
  });

  it("draws the STARTS WHEN box open with ONE + Add trigger, like the repo page", async () => {
    mount();
    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    expect(box.textContent).toContain("STARTS WHEN");
    expect(box.textContent).toContain("Never triggered");
    expect(box.textContent).toContain("Or start it by hand from the project's Runs tab.");
    expect(screen.getAllByTestId(`project-workflow-add-${rowKey}`)).toHaveLength(1);
    expect(box.querySelector(`[data-testid="project-workflow-add-${rowKey}"]`)).toBeTruthy();
  });

  it("collapses on the chevron and moves its ONE + Add trigger into the row", async () => {
    mount();
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    await collapseRow();
    expect(screen.getAllByTestId(`project-workflow-add-${rowKey}`)).toHaveLength(1);
    expect(screen.getByTestId(`project-workflow-add-${rowKey}`).textContent).toBe("+ Add trigger");
  });

  it("says paused on a disabled assignment without a raw state word", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [{ ...projectWideAssignment, enabled: false }] },
      },
    ]);
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    await waitFor(() =>
      expect(screen.getByTestId(`project-workflow-enabled-${rowKey}`).textContent).toBe("paused"),
    );
    expect(document.body.textContent).not.toMatch(/DISABLED|PAUSED/);
  });

  it("refuses to claim hand-started when a trigger read failed", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        status: 500,
        body: { type: "x", title: "boom", status: 500 },
      },
    ]);
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    await waitFor(() =>
      expect(screen.getByTestId(`project-workflow-summary-${rowKey}`).textContent).toContain(
        "triggers unavailable",
      ),
    );
  });

  it("keeps the library opener inside the bar's line box (390)", async () => {
    // Below 560px the shell's phone floor (tokens.css `APP-SHELL-PHONE`) makes
    // every `main button` 44px tall; the header holds one line by clipping that
    // growth (the Repositories `+ add` / YamlView treatment) instead of growing
    // to 53px while every other panel's header stays 23px. The button keeps its
    // own 44px box — the clip is the bar's, not the control's — and at 560px and
    // above the wrapper stops clipping.
    mount();
    const button = await screen.findByTestId("project-workflow-library");
    const wrap = button.parentElement as HTMLElement;
    expect(wrap.tagName).toBe("SPAN");
    expect(wrap.className).toContain("h-[14px]");
    expect(wrap.className).toContain("overflow-hidden");
    expect(wrap.className).toContain("min-[560px]:h-auto");
    expect(wrap.className).toContain("min-[560px]:overflow-visible");
    // Still a real button that opens the library, with its label intact.
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toContain("use a library workflow");
  });

  it("hides the writing affordances from a viewer", async () => {
    mount([], { ...projectFixture, my_role: "viewer" as const });
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    expect(screen.queryByTestId("project-workflow-library")).toBeNull();
    expect(screen.queryByTestId(`project-workflow-add-${rowKey}`)).toBeNull();
  });

  it("says the honest empty line when nothing is used", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [] },
      },
    ]);
    expect(await screen.findByTestId("project-workflows-empty")).toBeTruthy();
    expect(screen.getByTestId("project-workflows-empty").textContent).toContain(
      "No workflows are used in this project yet",
    );
  });

  it("collapses to the one sentence when the assignments read is refused", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        status: 403,
        body: { type: "about:blank", title: "Forbidden", status: 403, detail: "Nope." },
      },
    ]);
    expect(await screen.findByTestId("project-pipelines-not-found")).toBeTruthy();
    expect(screen.queryAllByTestId(/project-workflow-row-/)).toHaveLength(0);
  });
});

describe("ProjectWorkflowsPanel — the STARTS WHEN box across the project's repos", () => {
  it("lists a schedule on the shared 2e row with its switch", async () => {
    const paused = wireSchedule({ enabled: false, version: 4 });
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
      { path: `/api/v1/schedules/${SCHEDULE_ID}`, method: "PATCH", body: paused },
    ]);

    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    // The collapsed summary now speaks the cadence, not "started by hand".
    await waitFor(() =>
      expect(screen.getByTestId(`project-workflow-summary-${rowKey}`).textContent).toContain(
        "weekly Monday 06:00 UTC",
      ),
    );
    // The row IS the repository page's row — shared component, shared ids.
    const scheduleRow = within(box).getByTestId(`repo-workflow-trigger-${testidOf(SCHEDULE_ID)}`);
    expect(scheduleRow.textContent).toContain("0 6 * * 1");
    expect(scheduleRow.textContent).toContain("next");

    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}`),
    );
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/schedules/${SCHEDULE_ID}`, "PATCH")).toHaveLength(1),
    );
    expect(
      JSON.parse(requestsTo(requests, `/api/v1/schedules/${SCHEDULE_ID}`, "PATCH")[0].body ?? "{}"),
    ).toEqual({ version: 3, enabled: false });
  });

  it("lists the workflow's issue triggers from EVERY repository of the project", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "GET",
        body: {
          issue_triggers: [
            wireIssueTrigger(ISSUE_APP_ID, appRepo.id),
            wireIssueTrigger(ISSUE_API_ID, apiRepo.id),
          ],
        },
      },
    ]);

    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    const appRow = within(box).getByTestId(`repo-workflow-trigger-${testidOf(ISSUE_APP_ID)}`);
    const apiRow = within(box).getByTestId(`repo-workflow-trigger-${testidOf(ISSUE_API_ID)}`);
    expect(appRow.textContent).toContain("widgets/app · checked every minute");
    expect(apiRow.textContent).toContain("widgets/api · checked every minute");
  });

  it("adds a trigger to a repository-pinned use through the 2c dialog, in its own repo", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [repoAssignment] },
      },
      { path: `/api/v1/projects/${wireProjectId}/schedules`, method: "POST", body: wireSchedule() },
    ]);

    const key = testidOf(repoAssignment.id);
    fireEvent.click(await screen.findByTestId(`project-workflow-add-${key}`));
    await screen.findByTestId("trigger-dialog");
    // The dialog fixes its repository to the row's own — the same dialog the
    // repository page opens, no selects.
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / app",
    );
    fireEvent.click(screen.getByTestId("trigger-dialog-mode-schedule"));
    fireEvent.change(screen.getByTestId("trigger-dialog-cron"), { target: { value: "0 6 * * 1" } });
    fireEvent.change(screen.getByTestId("new-run-input-goal"), {
      target: { value: "Weekly upgrades" },
    });
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/schedules`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${wireProjectId}/schedules`, "POST")[0].body ?? "{}",
    );
    expect(body).toEqual({
      assignment_id: repoAssignment.id,
      cron_expr: "0 6 * * 1",
      inputs: {
        goal: "Weekly upgrades",
        repository: "app",
        acceptance_criteria: "Tests pass, the plan is followed, and the reviewer approves.",
      },
      enabled: true,
    });
  });

  it("asks WHICH repository for a whole-project row of a multi-repo project, and obeys it", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "POST",
        body: wireIssueTrigger(ISSUE_API_ID, apiRepo.id),
      },
    ]);

    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    const choice = await within(box).findByTestId(`project-workflow-repo-choice-${rowKey}`);
    // The dialog is repo-anchored by design, so the row asks first — and the
    // default is the project's first repository, named in the dialog line.
    fireEvent.click(screen.getByTestId(`project-workflow-add-${rowKey}`));
    await screen.findByTestId("trigger-dialog");
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / app",
    );
    fireEvent.click(screen.getByTestId("trigger-dialog-cancel"));

    // Pick the other repository; the dialog now speaks for it.
    fireEvent.change(choice, { target: { value: apiRepo.id } });
    fireEvent.click(screen.getByTestId(`project-workflow-add-${rowKey}`));
    await screen.findByTestId("trigger-dialog");
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / api",
    );
    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "plan" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    // Bind the goal to the fired issue (the same gesture the repo page's test
    // makes) — a required input left empty keeps the submit blocked.
    fireEvent.click(screen.getByTestId("trigger-dialog-quickfill-goal"));
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST")[0].body ??
        "{}",
    );
    expect(body.repository_id).toBe(apiRepo.id);
  });

  it("says the one-repo project needs no asking", async () => {
    mount([], projectFixture, [appRepo]);
    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    expect(within(box).queryByTestId(`project-workflow-repo-choice-${rowKey}`)).toBeNull();
    fireEvent.click(await screen.findByTestId(`project-workflow-add-${rowKey}`));
    await screen.findByTestId("trigger-dialog");
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / app",
    );
  });

  it("says a project without repositories first needs a repository", async () => {
    mount([], projectFixture, []);
    const box = await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    expect(screen.queryByTestId(`project-workflow-add-${rowKey}`)).toBeNull();
    expect(
      within(box).getByTestId(`project-workflow-add-needs-repo-${rowKey}`).textContent,
    ).toContain("add one to this project first");
  });

  it("edits a schedule on the shared row and reopens the 2c dialog with its values", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
    ]);
    await screen.findByTestId(`project-workflow-starts-${rowKey}`);
    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-edit-${testidOf(SCHEDULE_ID)}`),
    );
    expect(await screen.findByTestId("trigger-dialog")).toBeTruthy();
    expect((screen.getByTestId("trigger-dialog-cron") as HTMLInputElement).value).toBe("0 6 * * 1");
    expect(screen.getByTestId("trigger-dialog-submit").textContent).toBe("Save trigger");
  });
});
