/**
 * The redesigned project home (`/p/:projectId`, redesign R2): what the page is
 * allowed to say about this project, and where its links go.
 *
 * The two blocks the Home brief shares with the other half of the job
 * (`HomePrompt`, `SinceYouLeft`) are mocked here — the page's contract with
 * them is the props it passes, which this suite pins, and their own behaviour is
 * tested beside them rather than through this page.
 *
 * Everything else mounts for real against the fake wire, because the point of
 * the page is honesty: a card shows the run's own step, a repository row says
 * nothing when the issue read cannot answer, and a workflow's trigger line is
 * the Factory's own sentence for the assignment's real schedules.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  repositoryId,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { CrossProjectRunSummary } from "../api/home";
import type { Assignment, Repository } from "../api/types";
import { shortId } from "../lib/format";

// The sibling half of the Home job owns those two components; this page only
// hands them props, so the mocks render the props back for the assertions.
vi.mock("../components/home/HomePrompt", () => ({
  HomePrompt: ({
    projectId,
    placeholder,
    extraChips,
  }: {
    projectId?: string;
    placeholder?: string;
    extraChips?: React.ReactNode;
  }) => (
    <div data-testid="home-prompt" data-project-id={projectId ?? ""} data-placeholder={placeholder}>
      {extraChips}
    </div>
  ),
}));
vi.mock("../components/home/SinceYouLeft", () => ({
  SinceYouLeft: ({ projectId }: { projectId?: string }) => (
    <div data-testid="since-you-left" data-project-id={projectId ?? ""} />
  ),
}));

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const pipelineId = "01987b20-0000-7000-8000-abcdef012345";
const scheduleId = "01987b50-0000-7000-8000-0000000000s1";

const repository: Repository = {
  id: repositoryId,
  project_id: projectId,
  name: "app",
  git_url: "https://github.com/example/app.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
};

function run(overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary {
  return {
    id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
    project_id: projectId,
    pipeline_id: pipelineId,
    pipeline_revision_id: "01987b10-0000-7000-8000-000000000001",
    revision_digest: "sha256:1",
    plan_digest: "sha256:2",
    status: "running",
    depth: 0,
    priority: 0,
    created_at: "2026-11-20T10:00:00Z",
    project_name: projectFixture.name,
    pipeline_slug: "wf-1",
    pipeline_display_name: "Workflow One",
    steps: [
      { node_id: "plan", kind: "agent.acp", state: "succeeded" },
      { node_id: "implement", kind: "agent.acp", state: "running" },
    ],
    ...overrides,
  };
}

const assignment: Assignment = {
  id: "01987b55-0000-7000-8000-0000000000a1",
  project_id: projectId,
  pipeline_id: pipelineId,
  pinned_revision_id: "01987b10-0000-7000-8000-000000000001",
  pinned_revision_digest: "sha256:1",
  max_concurrent_runs: 1,
  budget_overrides: {},
  effective_budgets: {},
  enabled: true,
  version: 1,
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
};

/** The whole page's reads, in the state the assertions below describe. */
function routesFor(overrides: Partial<Record<string, RouteStub>> = {}): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: [repository] } },
    {
      path: `${projectPath}/conversations`,
      body: {
        items: [
          {
            ...conversationSummaryFixture,
            id: "01987b30-0000-7000-8000-0000000000a1",
            title: "Thread One",
            updated_at: "2026-11-20T10:05:00Z",
          },
        ],
      },
    },
    { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
    { path: `${projectPath}/assignments`, body: { assignments: [assignment] } },
    {
      path: "/api/v1/pipelines",
      body: {
        pipelines: [
          {
            id: pipelineId,
            slug: "wf-1",
            display_name: "Workflow One",
            latest_revision_number: 1,
            revision_count: 1,
            archived: false,
          },
        ],
      },
    },
    { path: `${projectPath}/schedules`, body: { schedules: [] } },
    { path: `${projectPath}/issue-triggers`, body: { issue_triggers: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    {
      path: "/api/v1/catch-up/items",
      body: { items: [], total_unseen: 0, oldest_unseen_at: null },
    },
    { path: "/api/v1/catch-up/brief", body: { headline: { state: "ready", text: "" } } },
  ];
  return base.map((stub) => overrides[stub.path] ?? stub);
}

describe("/p/:projectId — the project home", () => {
  it("hands the prompt box this project and names it in the placeholder", async () => {
    renderApp({ path: `/p/${projectId}`, routes: routesFor() });

    const prompt = await screen.findByTestId("home-prompt");
    expect(prompt.getAttribute("data-project-id")).toBe(projectId);
    expect(prompt.getAttribute("data-placeholder")).toBe(
      `What should we do in ${projectFixture.name}?`,
    );
    // The project home also hands the box its one extra chip, and the chip
    // opens the run form that already exists.
    expect(screen.getByTestId("home-prompt-run").textContent).toContain("or run a workflow");
    fireEvent.click(screen.getByTestId("home-prompt-run"));
    expect(await screen.findByTestId("home-start-run-dialog")).toBeTruthy();
  });

  it("scopes the since-you-left block to this project", async () => {
    renderApp({ path: `/p/${projectId}`, routes: routesFor() });
    const block = await screen.findByTestId("since-you-left");
    expect(block.getAttribute("data-project-id")).toBe(projectId);
  });

  it("offers the starter pills the project really has, and links each one", async () => {
    renderApp({ path: `/p/${projectId}`, routes: routesFor() });

    const resume = await screen.findByTestId(
      `starter-pill-resume-${shortId("01987b30-0000-7000-8000-0000000000a1")}`,
    );
    expect(resume.textContent).toContain("Thread One");
    expect(resume.getAttribute("href")).toBe(
      `/p/${projectId}/chats/01987b30-0000-7000-8000-0000000000a1`,
    );

    const runPill = await screen.findByTestId(`starter-pill-run-${shortId(pipelineId)}`);
    expect(runPill.textContent).toBe("Run Workflow One");
    expect(runPill.getAttribute("href")).toBe(`/p/${projectId}/factory/${pipelineId}`);

    expect(screen.getByTestId("starter-pill-chat").getAttribute("href")).toBe(
      `/p/${projectId}/chats/new`,
    );
  });

  it("shows the live run as a happening-now card with the run's own step", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: routesFor({
        "/api/v1/runs": { path: "/api/v1/runs", body: { runs: [run()], next_cursor: null } },
      }),
    });

    const card = await screen.findByTestId(
      `happening-run-${shortId("01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c")}`,
    );
    expect(card.getAttribute("href")).toBe("/runs/01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c");
    expect(card.textContent).toContain("Workflow One");
    expect(card.textContent).toContain("on implement");
    expect(screen.queryByTestId("happening-now-empty")).toBeNull();
  });

  it("says so when nothing is happening", async () => {
    renderApp({ path: `/p/${projectId}`, routes: routesFor() });
    await screen.findByText("Nothing is happening right now.");
  });

  it("lists the repositories with their names as links", async () => {
    renderApp({ path: `/p/${projectId}`, routes: routesFor() });
    const row = await screen.findByTestId("repo-row-app");
    expect(row.querySelector("a")?.getAttribute("href")).toBe(`/p/${projectId}/app`);
    expect(screen.getByTestId("repo-list-add").getAttribute("href")).toBe(
      `/manage/repositories?project=${projectId}`,
    );
  });

  it("words an assigned workflow's trigger in the Factory's plain English", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: routesFor({
        [`${projectPath}/schedules`]: {
          path: `${projectPath}/schedules`,
          body: {
            schedules: [
              {
                id: scheduleId,
                project_id: projectId,
                assignment_id: assignment.id,
                cron_expr: "0 9 * * 1-5",
                inputs: {},
                enabled: true,
                next_run_at: "2026-11-23T09:00:00Z",
                version: 1,
                created_by: meFixture.id,
                created_at: "2026-11-20T10:00:00Z",
                updated_at: "2026-11-20T10:00:00Z",
              },
            ],
          },
        },
      }),
    });

    const row = await screen.findByTestId(`workflow-here-${shortId(pipelineId)}`);
    expect(row.textContent).toContain("Workflow One");
    expect(row.querySelector("em")?.textContent).toBe("every weekday at 09:00 UTC");
  });

  it("keeps today's refusal: a project the caller cannot open is one sentence, not a half page", async () => {
    const { requests } = renderApp({
      path: `/p/${projectId}`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/projects", body: { items: [] } },
        { path: projectPath, method: "GET", status: 404, body: {} },
      ],
    });
    expect(await screen.findByTestId("project-not-found")).toBeTruthy();
    expect(screen.queryByTestId("project-home")).toBeNull();
    // The refusal does not go asking for the sub-resources of a project the
    // caller may not open.
    expect(requestsTo(requests, `${projectPath}/repos`).length).toBe(0);
  });

  it("quotes the server when the project read breaks", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/projects", body: { items: [] } },
        { path: projectPath, method: "GET", status: 500, body: {} },
      ],
    });
    await screen.findByTestId("project-home-error");
    expect(await screen.findByTestId("project-home-retry")).toBeTruthy();
  });

  it("prints the project's default agent under the workflows that live here", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: routesFor({
        [projectPath]: {
          path: projectPath,
          method: "GET",
          body: {
            ...projectFixture,
            default_agent_profile_id: claudeProfile.id,
            default_agent_profile_name: claudeProfile.name,
          },
        },
        "/api/v1/agent-profiles": {
          path: "/api/v1/agent-profiles",
          body: { items: [claudeProfile] },
        },
      }),
    });

    const line = await screen.findByTestId("project-default-agent");
    // A maintainer moves the default, so the name rides the picker chip.
    await waitFor(() =>
      expect(screen.getByTestId("project-default-agent-change").textContent).toContain(
        claudeProfile.name,
      ),
    );
    // CONTRACT "Agents & models" 3: the line sits under "Workflows here".
    const workflows = screen.getByTestId("workflows-here");
    expect(line.compareDocumentPosition(workflows) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("says 'none yet' for a project with no default agent", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: routesFor({
        [projectPath]: {
          path: projectPath,
          method: "GET",
          body: { ...projectFixture, my_role: "viewer" },
        },
      }),
    });

    const line = await screen.findByTestId("project-default-agent");
    expect(line.textContent).toContain("none yet");
    expect(screen.queryByTestId("project-default-agent-change")).toBeNull();
  });
});
