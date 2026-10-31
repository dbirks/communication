/**
 * `WORKFLOWS ON THIS REPO` (design 1e + 2e) against the fake fetch: the row
 * (name, pinned revision chip, trigger summary, step chain, 2e's two actions),
 * the `STARTS WHEN` box a trigger-bearing row opens with (one row per trigger,
 * switch, edit) — collapsed by default on a trigger-less row (reflow-390), the 2c
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

/** Open the 2c dialog from the row's ONE `+ Add trigger`. */
async function openDialogFromRow() {
  fireEvent.click(await screen.findByTestId(`repo-workflow-add-${assignmentKey}`));
  await screen.findByTestId("trigger-dialog");
}

/** 2e (reflow-390 review item 4): a row with NO triggers starts collapsed and
 * the chevron opens its STARTS WHEN box — the tests that care about the box
 * on a hand-started row use this. */
async function expandRow() {
  const toggle = await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`);
  fireEvent.click(toggle);
  await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
}

/** The chevron on an open row CLOSES it. */
async function collapseRow() {
  const toggle = await screen.findByTestId(`repo-workflow-toggle-${assignmentKey}`);
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(screen.queryByTestId(`repo-workflow-starts-${assignmentKey}`)).toBeNull(),
  );
}

afterEach(cleanup);

describe("RepoWorkflows — the workflow row (2e)", () => {
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

    // 2e (reflow-390 review item 4): a row with NO triggers starts COLLAPSED
    // — design 2e draws it with `+ Add trigger` and `Run` in the row, not as
    // a permanently open “Never triggered…” box.
    expect(screen.queryByTestId(`repo-workflow-starts-${assignmentKey}`)).toBeNull();
    expect(
      screen.getByTestId(`repo-workflow-toggle-${assignmentKey}`).getAttribute("aria-expanded"),
    ).toBe("false");
    // 2e item 6: still ONE `+ Add trigger` — in the row while the box is shut.
    expect(screen.getAllByTestId(`repo-workflow-add-${assignmentKey}`)).toHaveLength(1);
  });

  it("opens its STARTS WHEN box on the chevron and moves its ONE `+ Add trigger` into it", async () => {
    mount();
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    // Collapsed at first: `+ Add trigger` lives in the row's actions.
    expect(screen.getByTestId(`repo-workflow-add-${assignmentKey}`).textContent).toBe(
      "+ Add trigger",
    );
    await expandRow();
    // Open: the affordance moved into the box's header — never two of them.
    expect(screen.getAllByTestId(`repo-workflow-add-${assignmentKey}`)).toHaveLength(1);
    expect(
      screen
        .getByTestId(`repo-workflow-starts-${assignmentKey}`)
        .querySelector(`[data-testid="repo-workflow-add-${assignmentKey}"]`),
    ).toBeTruthy();
    await collapseRow();
    expect(screen.getByTestId(`repo-workflow-run-${assignmentKey}`).textContent).toBe("Run");
  });

  it("counts the workflows in the panel title and offers the library link to a maintainer", async () => {
    mount();
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    expect(screen.getByRole("heading", { name: /WORKFLOWS ON THIS REPO/ }).textContent).toContain(
      "WORKFLOWS ON THIS REPO · 1",
    );
    // One honest label at every width (reflow-390 review, 2c item 3): the
    // phone used to render a shortened `+ use workflow`; the panel's own
    // title ellipsis makes room for the full words instead.
    const libraryAction = screen.getByTestId("repo-workflow-library");
    expect(libraryAction.textContent).toContain("+ use a library workflow");
    expect(libraryAction.textContent).not.toContain("+ use workflow ");
    expect(libraryAction.textContent).toBe("+ use a library workflow");
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

  it("gives the row 2e's two actions, with the name as the way to the workflow", async () => {
    // 2e item 8 (2026-10-30 review): the design's row actions are `+ Add
    // trigger` and `Run` — no third `Edit` button linking to the page the
    // workflow's own name already links to.
    mount();
    const name = await screen.findByText("Feature development");
    expect(name.getAttribute("href")).toBe(`/workflows/${WIRE_PIPELINE_ID}`);
    expect(screen.queryByTestId(`repo-workflow-edit-${assignmentKey}`)).toBeNull();
    expect(screen.getByTestId(`repo-workflow-add-${assignmentKey}`).textContent).toBe(
      "+ Add trigger",
    );
    expect(screen.getByTestId(`repo-workflow-run-${assignmentKey}`).textContent).toBe("Run");
  });
});

describe("RepoWorkflows — the STARTS WHEN box (2e)", () => {
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

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
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

  it("lays each trigger row as two phone lines that flatten into 2e's five columns", async () => {
    // reflow-390 item 3: at 390 the five cells stacked into seven lines
    // (icon alone, title, chip, repo, “never polled”, toggle, boxed Edit);
    // they are now `icon·sentence·toggle` over `detail·bookkeeping·Edit`,
    // with `Edit` the design's text button. From 900px the same cells lay
    // out as 2e's grid.
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
    ]);
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    const row = within(box).getByTestId(`repo-workflow-trigger-${testidOf(SCHEDULE_ID)}`);
    const classes = row.className.split(/\s+/);
    expect(classes).toContain("grid");
    expect(classes).toContain("grid-cols-[18px_minmax(0,1fr)_auto]"); // two phone lines
    expect(classes).toContain("min-[900px]:grid-cols-[18px_minmax(0,1fr)_160px_80px_40px]");
    // Line 1: the switch stands at the sentence's right end; line 2: the
    // detail and the bookkeeping, then `Edit` — a text button, not a box.
    const edit = within(row).getByTestId(`repo-workflow-trigger-edit-${testidOf(SCHEDULE_ID)}`);
    expect(edit.className).toContain("text-accent-text");
    expect(edit.className).not.toContain("ds-btn");
  });

  it("says never triggered when the reader opens a trigger-less row", async () => {
    mount();
    // The row starts collapsed (reflow-390 item 4); the “Never triggered”
    // line is what the chevron reveals.
    await screen.findByTestId(`repo-workflow-row-${assignmentKey}`);
    await expandRow();
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

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
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

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
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

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
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

  it("keeps the switch a fixed 28×16 track on one line with its state word", async () => {
    // The pass-2 review caught this at 390 (2c-issue-trigger-saved,
    // 2c-schedule-trigger-saved, 2e-triggers-paused): the phone's 44px touch
    // floor (styles/tokens.css) stretched the TRACK into a tall blue oval.
    // `components/workflows/ToggleSwitch` is the shared answer — the same
    // control every trigger row now uses — and its trick is that the floor
    // grows `button`s and text inputs but EXEMPTS `input[type=checkbox]`, and
    // grows the LABEL instead: the tap target gets bigger, the pill does not.
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
    ]);

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    const track = await screen.findByTestId(
      `repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}`,
    );
    // The control IS the track: a checkbox (what the 44px rule exempts) wearing
    // the switch role, in a fixed 28×16 box.
    expect(track.tagName).toBe("INPUT");
    expect(track.getAttribute("type")).toBe("checkbox");
    expect(track.getAttribute("role")).toBe("switch");
    expect(track.getAttribute("aria-checked")).toBe("true");
    expect(track.className).toContain("h-[16px]");
    expect(track.className).toContain("w-[28px]");
    expect(track.className).toContain("shrink-0");
    expect(track.className).toContain("appearance-none");
    // One line with its label: the row wraps nothing, the LABEL is the hit
    // area (the stylesheet grows labels that hold a checkbox), and neither the
    // switch nor the word may shrink away.
    const line = track.parentElement as HTMLElement;
    expect(line.tagName).toBe("LABEL");
    expect(line.className).toContain("whitespace-nowrap");
    expect(line.className).toContain("shrink-0");
    const state = within(line).getByTestId(
      `repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}-state`,
    );
    expect(state.className).toContain("shrink-0");
    expect(state.textContent).toBe("on");
  });

  it("edits a trigger by reopening the 2c dialog with its own values", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule()] },
      },
    ]);

    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    fireEvent.click(
      await screen.findByTestId(`repo-workflow-trigger-edit-${testidOf(SCHEDULE_ID)}`),
    );

    expect(await screen.findByTestId("trigger-dialog")).toBeTruthy();
    expect(screen.getByTestId("trigger-dialog-context").textContent).toBe(
      "Feature development · Widgets / storefront",
    );
    expect((screen.getByTestId("trigger-dialog-cron") as HTMLInputElement).value).toBe("0 6 * * 1");
    // Edit mode is the schedule segment pressed, and the save verb matches
    // — one trigger kind word across both arms (pass-2 review, 2c).
    expect(screen.getByTestId("trigger-dialog-mode-schedule").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("trigger-dialog-submit").textContent).toBe("Save trigger");
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
    // 2e draws the STARTS WHEN box OPEN; nothing has to be clicked to see it.
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    expect(box.textContent).not.toContain("#");
    expect(box.textContent).not.toContain("◷");
    expect(box.textContent).not.toContain("⏱");
    expect(box.querySelectorAll("svg").length).toBeGreaterThan(1);
  });
});

// The paused trigger row (2026-10-30 copy review, 2e/2c item 5). A row that is
// switched OFF is not deleted text, and the word `paused` belongs to ONE
// element — the switch beside it already says it. The countdown of a live
// schedule reads `next in <span>`, not `next <span> left`.
describe("RepoWorkflows — a paused trigger reads as paused, not deleted", () => {
  it("mutes the collapsed summary instead of striking it through", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule({ enabled: false })] },
      },
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "GET",
        body: { issue_triggers: [wireIssueTrigger({ enabled: false })] },
      },
    ]);
    // A row WITH triggers opens to show them (2e); the collapsed summary is the
    // chevron's other state, and that is where the strike used to live.
    await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    await collapseRow();
    const summary = await screen.findByTestId(`repo-workflow-summary-${assignmentKey}`);
    expect(summary.textContent).toContain("weekly Monday 06:00 UTC");
    expect(summary.textContent).toContain("An issue is labeled");
    // No `line-through` anywhere: a paused trigger is off, not gone. The mute
    // that says so is `text-faint`.
    expect(summary.innerHTML).not.toContain("line-through");
    expect(summary.innerHTML).toContain("text-faint");
  });

  it("says `paused` once in a paused schedule row and drops the countdown", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule({ enabled: false })] },
      },
    ]);
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    const row = within(box).getByTestId(`repo-workflow-trigger-${testidOf(SCHEDULE_ID)}`);
    // ONCE: the switch's own state word is the row's only `paused`.
    expect((row.textContent?.match(/paused/g) ?? []).length).toBe(1);
    expect(
      within(row).getByTestId(`repo-workflow-trigger-enabled-${testidOf(SCHEDULE_ID)}-state`)
        .textContent,
    ).toBe("paused");
    // The bookkeeping cell has nothing to count down to, so it says what the
    // schedule did instead of repeating the state.
    expect(
      within(row).getByTestId(`repo-workflow-trigger-meta-${testidOf(SCHEDULE_ID)}`).textContent,
    ).toBe("never run");
  });

  it("names the last run of a paused schedule without the word `paused`", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule({ enabled: false, last_run_id: SCHEDULE_ID })] },
      },
    ]);
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    const meta = within(box).getByTestId(`repo-workflow-trigger-meta-${testidOf(SCHEDULE_ID)}`);
    expect(meta.textContent).toContain("last");
    expect(meta.textContent).not.toContain("paused");
  });

  it("counts a live schedule down as `next in <span>`, never `next <span> left`", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/schedules`,
        method: "GET",
        body: { schedules: [wireSchedule({ last_run_id: SCHEDULE_ID })] },
      },
    ]);
    const box = await screen.findByTestId(`repo-workflow-starts-${assignmentKey}`);
    const meta = within(box).getByTestId(`repo-workflow-trigger-meta-${testidOf(SCHEDULE_ID)}`);
    expect(meta.textContent).toContain("next in 3d");
    expect(meta.textContent).not.toContain("left");
    expect(meta.textContent).toContain("last");
  });
});
