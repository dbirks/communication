/**
 * `WORKFLOWS ON THIS REPO` (design 1e + 2e) against the fake fetch: the
 * collapsed row (name, pinned revision chip, trigger summary, step chain), the
 * expanded `STARTS WHEN` box (one row per trigger, switch, edit), the 2c
 * dialog's two writes (issue trigger, schedule — with the server's `422
 * invalid_cron` kept inline), the ADR-0060 attachment rule (this repo's pins
 * plus the whole-project ones, never another repo's), the empty state, and the
 * library picker's repo-scoped assignment pinned to the latest revision.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RepoWorkflows } from "./RepoWorkflows";
import { GithubIcon } from "./TriggerDialog";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type { Schedule } from "../../api/pipelines";
import type { Assignment, Repository } from "../../api/types";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import { testidOf } from "../../lib/format";
import {
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
  wireRevision,
} from "../../test/fixtures/m4/wire";

const wireProjectId = projectFixture.id;

const repository: Repository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: wireProjectId,
  name: "storefront",
  git_url: "https://github.com/northwind/storefront.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
  credential: "none",
};

/** A second repository of the same project: its pins must NOT appear here. */
const otherRepository: Repository = {
  ...repository,
  id: "01987b22-0003-7000-8000-abcdef012345",
  name: "docs-site",
  git_url: "https://github.com/northwind/docs-site.git",
};

/** The assignment the panel rows are built from: this repo, per ADR-0060. */
const repoAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repository.id,
  repository_name: repository.name,
};

/** The same pin with `repository_id` null: whole-project, so it also shows. */
const projectWideAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  id: "01987b22-0004-7000-8000-abcdef012345",
  repository_id: null,
  repository_name: null,
};

const pinnedDigest = repoAssignment.pinned_revision_digest;
const assignmentKey = testidOf(repoAssignment.id);

const SCHEDULE_ID = "01987b24-0001-7000-8000-abcdef012345";
const ISSUE_TRIGGER_ID = "01987b24-0002-7000-8000-abcdef012345";

function wireSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    project_id: wireProjectId,
    assignment_id: repoAssignment.id,
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

function wireIssueTrigger(overrides: Partial<IssueTrigger> = {}): IssueTrigger {
  return {
    id: ISSUE_TRIGGER_ID,
    project_id: wireProjectId,
    assignment_id: repoAssignment.id,
    repository_id: repository.id,
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

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    {
      path: `/api/v1/projects/${wireProjectId}/assignments`,
      method: "GET",
      body: { assignments: [repoAssignment] },
    },
    {
      path: `/api/v1/projects/${wireProjectId}/schedules`,
      method: "GET",
      body: { schedules: [] },
    },
    {
      path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
      method: "GET",
      body: { issue_triggers: [] },
    },
    {
      path: `/api/v1/projects/${wireProjectId}/repos`,
      method: "GET",
      body: { items: [repository, otherRepository] },
    },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, method: "GET", body: wirePipeline },
    { path: `/api/v1/revisions/${pinnedDigest}`, method: "GET", body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, method: "GET", body: wireRevision },
  ];
  return [...overrides, ...base];
}

function mount(overrides: RouteStub[] = [], project = projectFixture) {
  const { requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RepoWorkflows projectId={wireProjectId} project={project} repository={repository} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

/** Open the 2c dialog from the row's own `+ Add trigger`. */
async function openDialogFromRow() {
  fireEvent.click(await screen.findByTestId(`repo-workflow-add-${assignmentKey}`));
  await screen.findByTestId("trigger-dialog");
}

afterEach(cleanup);

describe("RepoWorkflows — the collapsed row (2e)", () => {
  it("names the workflow, its pinned revision, the hand-started summary and the step chain", async () => {
    mount();

    const row = await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    expect(row).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId(`repo-workflow-name-${assignmentKey}`).textContent).toBe(
        "Feature development",
      ),
    );
    // The chip is the PINNED revision's own number, not the library's latest.
    expect(screen.getByTestId(`repo-workflow-revision-${assignmentKey}`).textContent).toBe("r7");
    expect(screen.getByTestId(`repo-workflow-summary-${assignmentKey}`).textContent).toContain(
      "started by hand",
    );

    const chain = screen.getByTestId(`repo-workflow-chain-${assignmentKey}`);
    expect(chain.textContent).toContain("plan");
    expect(chain.textContent).toContain("approve");
    // A scope node folds to one shaded `loop:` cell — the document's own ids.
    expect(chain.textContent).toContain("loop:");

    // Collapsed: the STARTS WHEN box only exists once the row is opened.
    expect(screen.queryByTestId(`repo-workflow-starts-${assignmentKey}`)).toBeNull();
  });

  it("counts the workflows in the panel title and offers the library link to a maintainer", async () => {
    mount();
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    expect(screen.getByRole("heading", { name: /WORKFLOWS ON THIS REPO/ }).textContent).toContain(
      "WORKFLOWS ON THIS REPO · 1",
    );
    expect(screen.getByTestId("repo-workflow-library").textContent).toBe(
      "+ use a library workflow",
    );
  });

  it("keeps another repository's pin off this page and shows the whole-project one", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: {
          assignments: [
            { ...repoAssignment, repository_id: otherRepository.id, repository_name: "docs-site" },
            projectWideAssignment,
          ],
        },
      },
    ]);

    // The project-wide pin (repository_id null) covers every repo, so it is
    // here; the docs-site pin belongs to the other repository page.
    const projectWideKey = testidOf(projectWideAssignment.id);
    const row = await screen.findByTestId(`repo-workflow-row-${projectWideKey}`);
    expect(row).toBeTruthy();
    expect(screen.getByTestId("repo-workflows").textContent).not.toContain("docs-site");
    expect(screen.getAllByTestId(/repo-workflow-row-/)).toHaveLength(1);
  });

  it("says the repository uses no workflow when nothing is attached to it", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: {
          assignments: [
            { ...repoAssignment, repository_id: otherRepository.id, repository_name: "docs-site" },
          ],
        },
      },
    ]);

    expect(await screen.findByTestId("repo-workflows-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-workflows-empty").textContent).toContain(
      "uses no workflow yet",
    );
    expect(screen.queryByTestId(`repo-workflow-row-${assignmentKey}`)).toBeNull();
  });

  it("refuses to claim hand-started when the trigger read failed", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        status: 500,
        body: { type: "x", title: "boom", status: 500 },
      },
    ]);
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    await waitFor(() =>
      expect(screen.getByTestId(`repo-workflow-summary-${assignmentKey}`).textContent).toContain(
        "triggers unavailable",
      ),
    );
    expect(screen.getByTestId(`repo-workflow-summary-${assignmentKey}`).textContent).not.toContain(
      "started by hand",
    );
  });

  it("hides the writing affordances from a viewer", async () => {
    mount([], { ...projectFixture, my_role: "viewer" as const });
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    expect(screen.queryByTestId("repo-workflow-library")).toBeNull();
    expect(screen.queryByTestId(`repo-workflow-add-${assignmentKey}`)).toBeNull();
    // Run stays: starting a run is the contributor route, not a maintainer one.
    expect(screen.getByTestId(`repo-workflow-run-${assignmentKey}`)).toBeTruthy();
  });
});

describe("RepoWorkflows — the expanded STARTS WHEN box (2e)", () => {
  it("shows one grid row per trigger with its sentence, detail line, bookkeeping and Edit", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger()] },
      },
    ]);

    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    expect(box.textContent).toContain("STARTS WHEN");

    // The collapsed summary now speaks the triggers, not "started by hand".
    expect(screen.getByTestId(`repo-workflow-summary-${assignmentKey}`).textContent).toContain(
      "weekly Monday 06:00 UTC",
    );

    const issueRow = within(box).getByTestId(`repo-workflow-trigger-${testidOf(ISSUE_TRIGGER_ID)}`);
    expect(issueRow.textContent).toContain("An issue is labeled");
    expect(issueRow.textContent).toContain("plan");
    expect(issueRow.textContent).toContain("northwind/storefront · checked every minute");
    expect(issueRow.textContent).toContain("polled");
    expect(
      within(issueRow)
        .getByTestId(`repo-workflow-trigger-enabled-${testidOf(ISSUE_TRIGGER_ID)}`)
        .getAttribute("aria-checked"),
    ).toBe("true");

    const scheduleRow = within(box).getByTestId(`repo-workflow-trigger-${testidOf(SCHEDULE_ID)}`);
    expect(scheduleRow.textContent).toContain("weekly Monday 06:00 UTC");
    expect(scheduleRow.textContent).toContain("0 6 * * 1");
    // The fixed inputs ride the mono detail line (a long value is trimmed).
    expect(scheduleRow.textContent).toContain("goal: “Plan this week");
    expect(scheduleRow.textContent).toContain("next");

    expect(box.textContent).toContain("Or start it by hand with Run, or from an issue below.");
  });

  it("says never triggered when the workflow carries no trigger at all", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    expect(box.textContent).toContain("Never triggered");
    expect(box.textContent).toContain("started by a person");
  });

  it("pauses a schedule through the switch's PATCH (version + enabled)", async () => {
    const paused = wireSchedule({ enabled: false, version: 4 });
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
      { path: `/api/v1/schedules/${SCHEDULE_ID}`, method: "PATCH", body: paused },
    ]);

    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    const toggle = await screen.findByTestId(
      `repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}`,
    );
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/schedules/${SCHEDULE_ID}`, "PATCH")).toHaveLength(1),
    );
    expect(
      JSON.parse(requestsTo(requests, `/api/v1/schedules/${SCHEDULE_ID}`, "PATCH")[0].body!),
    ).toEqual({ version: 3, enabled: false });
  });

  it("surfaces a stale-version 409 on the row instead of pretending it saved", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
      {
        path: `/api/v1/schedules/${SCHEDULE_ID}`,
        method: "PATCH",
        status: 409,
        body: {
          type: "https://communication.dev/errors/schedule_version_stale",
          title: "Schedule version stale",
          status: 409,
          detail: "the schedule moved elsewhere",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}`),
    );

    const error = await screen.findByTestId(`repo-workflow-trigger-error-${testidOf(SCHEDULE_ID)}`);
    expect(error.textContent).toContain("changed elsewhere, reload");
    expect(requestsTo(requests, `/api/v1/schedules/${SCHEDULE_ID}`, "PATCH")).toHaveLength(1);
  });

  it("pauses an issue trigger through its own PATCH", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger()] },
      },
      {
        path: `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`,
        method: "PATCH",
        body: wireIssueTrigger({ enabled: false, version: 4 }),
      },
    ]);

    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-enabled-${testidOf(ISSUE_TRIGGER_ID)}`),
    );

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH")[0].body!,
      ),
    ).toEqual({ version: 3, enabled: false });
  });

  it("edits a trigger by reopening the 2c dialog with its own values", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
    ]);

    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-edit-${testidOf(SCHEDULE_ID)}`),
    );

    expect(await screen.findByTestId("trigger-dialog")).toBeTruthy();
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / storefront",
    );
    expect((screen.getByTestId("trigger-dialog-cron") as HTMLInputElement).value).toBe("0 6 * * 1");
    // Edit mode is the schedule segment pressed, and the save verb matches.
    expect(screen.getByTestId("trigger-dialog-mode-schedule").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("trigger-dialog-submit").textContent).toBe("Save schedule");
  });
});

describe("RepoWorkflows — adding a trigger through the 2c dialog", () => {
  it("posts an issue trigger for this repo and this assignment", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "POST",
        body: wireIssueTrigger({ event: "opened", labels: ["plan"] }),
      },
    ]);

    await openDialogFromRow();
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / storefront",
    );
    // The project and the repository come from where it was opened: no selects.
    expect(screen.queryByTestId("trigger-add-issue-assignment")).toBeNull();
    expect(screen.queryByTestId("trigger-add-issue-repository")).toBeNull();

    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "plan" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    expect(screen.getByTestId("trigger-dialog-label-chip-0").textContent).toContain("plan");
    fireEvent.click(screen.getByTestId("trigger-dialog-quickfill-goal"));
    // THE RUN GETS reads the mapping in words, not as token soup.
    expect(screen.getByTestId("trigger-dialog-run-gets-goal").textContent).toBe(
      "goal = the issue title and the issue body",
    );
    expect(screen.getByTestId("trigger-dialog-note").textContent).toBe("Checked every minute");
    // ADR-0061 gives repositories a GitHub credential: never claim public-only.
    expect(screen.getByTestId("trigger-dialog").textContent).not.toContain(
      "public GitHub repositories only",
    );

    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST")[0].body!,
      ),
    ).toEqual({
      assignment_id: repoAssignment.id,
      repository_id: repository.id,
      event: "opened",
      labels: ["plan"],
      inputs: {
        goal: "{{issue.title}}\n\n{{issue.body}}",
        repository: "storefront",
        acceptance_criteria: "Tests pass, the plan is followed, and the reviewer approves.",
      },
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByTestId("trigger-dialog")).toBeNull());
  });

  it("keeps the server's 422 invalid_cron inline and the dialog open", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "POST",
        status: 422,
        body: {
          type: "https://communication.dev/errors/invalid_cron",
          title: "Invalid cron",
          status: 422,
          detail: "invalid_cron: expected five UTC fields",
        },
      },
    ]);

    await openDialogFromRow();
    fireEvent.click(screen.getByTestId("trigger-dialog-mode-schedule"));
    fireEvent.change(screen.getByTestId("trigger-dialog-cron"), { target: { value: "nonsense" } });
    fireEvent.change(screen.getByTestId("new-run-input-goal"), {
      target: { value: "Retry the payment plan" },
    });
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    const error = await screen.findByTestId("trigger-dialog-error");
    expect(error.textContent).toContain("invalid_cron");
    expect(screen.getByTestId("trigger-dialog")).toBeTruthy();
    expect((screen.getByTestId("trigger-dialog-cron") as HTMLInputElement).value).toBe("nonsense");
    expect(
      requestsTo(requests, `/api/v1/projects/${wireProjectId}/schedules`, "POST"),
    ).toHaveLength(1);
  });

  it("posts a schedule with its cron and fixed inputs", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "POST",
        body: wireSchedule({ cron_expr: "0 6 * * 1", inputs: { goal: "Weekly upgrades" } }),
      },
    ]);

    await openDialogFromRow();
    fireEvent.click(screen.getByTestId("trigger-dialog-mode-schedule"));
    // The English reading travels with the field as it is typed.
    fireEvent.change(screen.getByTestId("trigger-dialog-cron"), { target: { value: "0 6 * * 1" } });
    expect(screen.getByTestId("trigger-dialog-cron-words").textContent).toBe(
      "weekly Monday 06:00 UTC",
    );
    fireEvent.change(screen.getByTestId("new-run-input-goal"), {
      target: { value: "Weekly upgrades" },
    });
    expect(screen.getByTestId("trigger-dialog-run-gets-goal").textContent).toBe(
      "goal = “Weekly upgrades”",
    );

    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/schedules`, "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/schedules`, "POST")[0].body!,
      ),
    ).toEqual({
      assignment_id: repoAssignment.id,
      cron_expr: "0 6 * * 1",
      inputs: {
        goal: "Weekly upgrades",
        repository: "storefront",
        acceptance_criteria: "Tests pass, the plan is followed, and the reviewer approves.",
      },
      enabled: true,
    });
  });

  it("creates a repo-scoped assignment pinned to the workflow's latest revision", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [] },
      },
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "POST",
        body: { ...repoAssignment },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-workflow-library"));
    expect(await screen.findByTestId("repo-library-dialog")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("repo-library-use-feature-development"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/assignments`, "POST"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/assignments`, "POST")[0].body!,
      ),
    ).toEqual({
      pipeline_id: WIRE_PIPELINE_ID,
      pinned_revision_id: WIRE_REVISION_ID,
      max_concurrent_runs: 1,
      repository_id: repository.id,
    });
  });

  it("shows the server's 409 on the picker instead of a fake success", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "GET",
        body: { assignments: [] },
      },
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/assignment-already-exists",
          title: "Assignment already exists",
          status: 409,
          detail: "this workflow is already used by this repository",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-workflow-library"));
    fireEvent.click(await screen.findByTestId("repo-library-use-feature-development"));

    const error = await screen.findByTestId("repo-library-error");
    expect(error.textContent).toContain("Assignment already exists");
    expect(screen.getByTestId("repo-library-dialog")).toBeTruthy();
  });
});

describe("RepoWorkflows — the trigger glyphs", () => {
  it("renders the Lucide github mark, never a # or a ◷ glyph", async () => {
    const { container } = render(
      <MemoryRouter>
        <GithubIcon size={14} strokeWidth={2} />
      </MemoryRouter>,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);

    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger()] },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`));
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    expect(box.textContent).not.toContain("#");
    expect(box.textContent).not.toContain("◷");
    expect(box.textContent).not.toContain("⏱");
    expect(box.querySelectorAll("svg").length).toBeGreaterThan(1);
  });
});
