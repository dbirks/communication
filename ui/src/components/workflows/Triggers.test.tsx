/**
 * The Triggers section's issue half (ADR-0056 part 2, backend in c5ef3d7):
 * the "Issue triggers" sub-list rows, the add dialog's POST body, the toggle's
 * PATCH, and the two inline refusals (409 version-stale, 422 not-a-GitHub).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowTriggers } from "./Triggers";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wireRevision,
} from "../../test/fixtures/m4/wire";

const wireProjectId = projectFixture.id;

/** The lab repository the pinned revision's `repository` input names. */
const appRepository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: wireProjectId,
  name: "app",
  git_url: "https://example.invalid/app.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
};

const ISSUE_TRIGGER_ID = "01987b24-0000-7000-8000-abcdef012345";
const ISSUE_TRIGGER_VERSION = 3;

function wireIssueTrigger(overrides: Partial<IssueTrigger> = {}): IssueTrigger {
  return {
    id: ISSUE_TRIGGER_ID,
    project_id: wireProjectId,
    assignment_id: WIRE_ASSIGNMENT_ID,
    repository_id: appRepository.id,
    event: "opened",
    labels: [],
    inputs: { goal: "watch this" },
    enabled: true,
    cursor_at: null,
    last_polled_at: "2026-10-20T09:00:00Z",
    last_error: "",
    version: ISSUE_TRIGGER_VERSION,
    created_by: meFixture.id,
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-20T09:00:00Z",
    my_role: "maintainer",
    ...overrides,
  };
}

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
    { path: `/api/v1/projects/${wireProjectId}/schedules`, body: { schedules: [] } },
    { path: `/api/v1/projects/${wireProjectId}/repos`, body: { items: [appRepository] } },
    { path: `/api/v1/projects/${wireProjectId}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
  ];
  return [...overrides, ...base];
}

function mount(overrides: RouteStub[] = []) {
  const { requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkflowTriggers pipelineId={WIRE_PIPELINE_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

afterEach(cleanup);

describe("WorkflowTriggers — the issue half", () => {
  it("renders the honest empty state under the issue sub-list", async () => {
    mount();
    const section = await screen.findByTestId("workflow-issue-triggers");
    expect(section).toBeTruthy();
    expect(await screen.findByTestId("trigger-issue-placeholder")).toBeTruthy();
    expect(screen.getByTestId("trigger-add-issue")).toBeTruthy();
    expect(screen.getByTestId("trigger-issue-note").textContent).toContain(
      "Checked every minute · public GitHub repositories only",
    );
  });

  it("lists one issue trigger: repo, event, any-label chip, polled, toggle", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        body: { issue_triggers: [wireIssueTrigger()] },
      },
    ]);
    const section = await screen.findByTestId("workflow-issue-triggers");
    expect(
      await within(section).findByTestId(`trigger-issue-row-${ISSUE_TRIGGER_ID}`),
    ).toBeTruthy();
    expect(
      within(section).getByTestId(`trigger-issue-repo-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("example.invalid/app");
    expect(
      within(section).getByTestId(`trigger-issue-event-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("when an issue is opened");
    expect(
      within(section).getByTestId(`trigger-issue-labels-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("any label");
    expect(
      within(section).getByTestId(`trigger-issue-polled-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("polled");
    expect(
      (within(section).getByTestId(`trigger-issue-enabled-${ISSUE_TRIGGER_ID}`) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      within(section).getByTestId(`trigger-issue-state-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("on");
  });

  it("shows the label chips and the last-error line when the trigger carries them", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        body: {
          issue_triggers: [
            wireIssueTrigger({
              labels: ["bug", "triage"],
              last_error: "GitHub rate limit exceeded",
            }),
          ],
        },
      },
    ]);
    const section = await screen.findByTestId("workflow-issue-triggers");
    expect(
      await within(section).findByTestId(`trigger-issue-labels-${ISSUE_TRIGGER_ID}`),
    ).toBeTruthy();
    expect(
      within(section).getByTestId(`trigger-issue-labels-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("bug");
    expect(
      await within(section).findByTestId(`trigger-issue-last-error-${ISSUE_TRIGGER_ID}`),
    ).toBeTruthy();
    expect(
      within(section).getByTestId(`trigger-issue-last-error-${ISSUE_TRIGGER_ID}`).textContent,
    ).toContain("GitHub rate limit exceeded");
  });

  it("adds an issue trigger through the dialog and posts the typed labels and inputs", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "POST",
        status: 201,
        body: wireIssueTrigger(),
      },
      { path: `/api/v1/projects/${wireProjectId}/repos`, body: { items: [appRepository] } },
    ]);
    fireEvent.click(await screen.findByTestId("trigger-add-issue"));
    const dialog = await screen.findByTestId("trigger-add-issue-dialog");
    expect(dialog).toBeTruthy();
    fireEvent.change(await screen.findByTestId("trigger-add-issue-repository"), {
      target: { value: appRepository.id },
    });
    fireEvent.change(await screen.findByTestId("trigger-add-issue-input-goal"), {
      target: { value: "Fix the flaky checkout" },
    });
    fireEvent.change(await screen.findByTestId("trigger-add-issue-labels"), {
      target: { value: "bug" },
    });
    fireEvent.keyDown(await screen.findByTestId("trigger-add-issue-labels"), { key: "Enter" });
    const confirm = await screen.findByTestId("trigger-add-issue-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${wireProjectId}/issue-triggers`, "POST")[0].body ??
        "{}",
    );
    expect(body.assignment_id).toBe(WIRE_ASSIGNMENT_ID);
    expect(body.repository_id).toBe(appRepository.id);
    expect(body.event).toBe("opened");
    expect(body.enabled).toBe(true);
    expect(body.labels).toEqual(["bug"]);
    expect(body.inputs.goal).toBe("Fix the flaky checkout");
  });

  it("toggles an issue trigger through PATCH with the row's version", async () => {
    const { requests } = mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        body: { issue_triggers: [wireIssueTrigger()] },
      },
      {
        path: `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`,
        method: "PATCH",
        status: 200,
        body: wireIssueTrigger({ enabled: false, version: 4 }),
      },
    ]);
    const toggle = await screen.findByTestId(`trigger-issue-enabled-${ISSUE_TRIGGER_ID}`);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH")[0].body ?? "{}",
    );
    expect(body).toEqual({ version: ISSUE_TRIGGER_VERSION, enabled: false });
  });

  it("says changed elsewhere, reload when the toggle's PATCH loses its version race", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        body: { issue_triggers: [wireIssueTrigger()] },
      },
      {
        path: `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`,
        method: "PATCH",
        status: 409,
        body: {
          type: "https://communication.dev/errors/issue_trigger_version_stale",
          title: "Issue Trigger Version Stale",
          status: 409,
          detail:
            "The issue trigger changed since you read it; re-read and replay your edit against the current version.",
        },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`trigger-issue-enabled-${ISSUE_TRIGGER_ID}`));
    const alert = await screen.findByTestId(`trigger-issue-error-${ISSUE_TRIGGER_ID}`);
    expect(alert.textContent).toContain("changed elsewhere, reload");
  });

  it("shows the server's not_a_github_repository 422 inline and keeps the dialog open", async () => {
    mount([
      {
        path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
        method: "POST",
        status: 422,
        body: {
          type: "https://communication.dev/errors/not_a_github_repository",
          title: "Not A GitHub Repository",
          status: 422,
          detail:
            "The repository behind this issue trigger is not a GitHub repository, so it has no issues to watch.",
        },
      },
      { path: `/api/v1/projects/${wireProjectId}/repos`, body: { items: [appRepository] } },
    ]);
    fireEvent.click(await screen.findByTestId("trigger-add-issue"));
    fireEvent.change(await screen.findByTestId("trigger-add-issue-repository"), {
      target: { value: appRepository.id },
    });
    fireEvent.change(await screen.findByTestId("trigger-add-issue-input-goal"), {
      target: { value: "sweep" },
    });
    const confirm = await screen.findByTestId("trigger-add-issue-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    const alert = await screen.findByTestId("trigger-add-issue-error");
    expect(alert.textContent).toContain("Not A GitHub Repository");
    expect(screen.getByTestId("trigger-add-issue-form")).toBeTruthy();
  });
});
