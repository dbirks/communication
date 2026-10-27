/**
 * `/p/:projectId` — the project overview (Projects Review design 1b): the
 * header band with its route tabs, the callouts that ask something of a person,
 * the running-now list, and the two inventory panels.
 *
 * The states each block can be in are asserted deliberately: populated from a
 * stubbed wire, honestly empty, refused (`404`) and broken (`5xx`). What the
 * design shows that no API serves — a run title, a repository on a run, an
 * issue count per repository — is asserted as *said*, never drawn as a number.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  codexProfile,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  repositoryId,
  requestsTo,
  workspaceFixture,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_APPROVAL_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  WIRE_RUN_ID,
  wireApproval,
  wirePipelineList,
  wireRevision,
  wireRun,
} from "../test/fixtures/m4/wire";
import type { CrossProjectRun } from "../components/board/columns";
import type { Assignment, Member, Project, Repository, RunSummary } from "../api/types";
import { shortId, testidOf } from "../lib/format";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const reposPath = `${projectPath}/repos`;
const membersPath = `${projectPath}/members`;
const approvalsPath = `${projectPath}/approvals`;
const runsPath = `${projectPath}/runs`;
const crossRunsPath = "/api/v1/runs";
const conversationsPath = `${projectPath}/conversations`;
const assignmentsPath = `${projectPath}/assignments`;
const schedulesPath = `${projectPath}/schedules`;
const issueTriggersPath = `${projectPath}/issue-triggers`;
const workspacesPath = `${projectPath}/workspaces`;
const revisionPath = `/api/v1/revisions/${wireRevision.revision_digest}`;

const repository: Repository = {
  id: repositoryId,
  project_id: projectId,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "configured",
};

const member: Member = { user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" };
const directoryUser = {
  id: "01987a61-2345-7000-8000-abcdef012399",
  display_name: "Grace Hopper",
  email: null,
};

/** The project pins this workflow, in this repository. */
function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "01987b22-0000-7000-8000-abcdef012345",
    project_id: projectId,
    pipeline_id: WIRE_PIPELINE_ID,
    pinned_revision_id: WIRE_REVISION_ID,
    pinned_revision_digest: wireRevision.revision_digest,
    pinned_version_label: "7.0.0",
    repository_id: repository.id,
    repository_name: repository.name,
    max_concurrent_runs: 1,
    budget_overrides: {},
    effective_budgets: {},
    enabled: true,
    version: 1,
    created_at: "2026-07-30T09:00:00Z",
    updated_at: "2026-07-30T09:00:00Z",
    ...overrides,
  };
}

/** A cross-project run row (`GET /api/v1/runs`): the run list the board and
 * Home share, which is the only run read that embeds steps. */
function crossRun(overrides: Partial<CrossProjectRun> = {}): CrossProjectRun {
  const now = new Date().toISOString();
  return {
    id: WIRE_RUN_ID,
    project_id: projectId,
    pipeline_id: WIRE_PIPELINE_ID,
    pipeline_revision_id: WIRE_REVISION_ID,
    assignment_id: null,
    revision_digest: wireRevision.revision_digest,
    plan_digest: `sha256:${"0d0c".repeat(32)}`,
    status: "running",
    failed_cause: null,
    depth: 0,
    parent_run_id: null,
    triggered_by: meFixture.id,
    priority: 0,
    created_at: new Date(Date.now() - 14 * 60_000).toISOString(),
    started_at: new Date(Date.now() - 13 * 60_000).toISOString(),
    finished_at: null,
    project_name: projectFixture.name,
    pipeline_slug: "feature-development",
    pipeline_display_name: "Feature development",
    steps: [],
    ...overrides,
    // `finished_at` is non-null exactly when the run is terminal; a fixture
    // that says `completed` without one would be an illegal row.
    ...(overrides.finished_at === undefined &&
    overrides.status !== undefined &&
    ["completed", "failed", "cancelled", "interrupted"].includes(String(overrides.status))
      ? { finished_at: now }
      : {}),
  } as CrossProjectRun;
}

/** Every read the overview touches, answering with something. A route a test
 * overrides goes in `extra` (searched first, so a stub shadows these). */
function projectRoutes(project: Project, extra: RouteStub[] = []): RouteStub[] {
  return [
    me,
    ...extra,
    { path: projectPath, method: "GET", body: project },
    { path: reposPath, method: "GET", body: { items: [repository] } },
    { path: membersPath, method: "GET", body: { items: [member] } },
    { path: "/api/v1/users", method: "GET", body: { items: [directoryUser] } },
    {
      path: "/api/v1/agent-profiles",
      method: "GET",
      body: { items: [claudeProfile, codexProfile] },
    },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
    // The attention read is approvals + the project's runs + its conversations.
    // Unstubbed they would 404, and the panels would honestly report that rather
    // than show the state the test is about.
    { path: approvalsPath, method: "GET", body: { approvals: [] } },
    { path: runsPath, method: "GET", body: { runs: [] } },
    { path: crossRunsPath, method: "GET", body: { runs: [], next_cursor: null } },
    { path: conversationsPath, method: "GET", body: { items: [conversationSummaryFixture] } },
    { path: assignmentsPath, method: "GET", body: { assignments: [] } },
    { path: schedulesPath, method: "GET", body: { schedules: [] } },
    { path: issueTriggersPath, method: "GET", body: { issue_triggers: [] } },
    { path: workspacesPath, method: "GET", body: { workspaces: [workspaceFixture] } },
    { path: revisionPath, method: "GET", body: wireRevision },
  ];
}

const mounted = (extra: RouteStub[] = [], project: Project = projectFixture) =>
  renderApp({ path: `/p/${projectId}`, routes: projectRoutes(project, extra) });

describe("/p/:projectId — the header band and its tabs", () => {
  it("shows the project's own name and description, and the two verbs", async () => {
    mounted();
    expect((await screen.findByTestId("project-name")).textContent).toBe("Widgets");
    expect(screen.getByText("Widget incubator")).toBeTruthy();
    // "Conversations" is out of this page's vocabulary: the verb is a thread.
    expect(screen.queryByText(/New conversation/i)).toBeNull();
    expect(screen.getByTestId("project-new-conversation").textContent).toBe("New thread");
    expect(screen.getByTestId("project-start-run").getAttribute("href")).toBe(
      `/p/${projectId}/runs`,
    );
  });

  it("mounts the six section tabs as routes, with Overview current", async () => {
    mounted();
    await screen.findByTestId("project-name");

    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const items = within(nav).getAllByRole("link");
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
      "project-tab-overview",
      "project-tab-runs",
      "project-tab-threads",
      "project-tab-workflows",
      "project-tab-artifacts",
      "project-tab-settings",
    ]);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      `/p/${projectId}`,
      `/p/${projectId}/runs`,
      `/p/${projectId}/conversations`,
      `/p/${projectId}/pipelines`,
      `/p/${projectId}/artifacts`,
      `/p/${projectId}/settings`,
    ]);
    expect(within(nav).getByTestId("project-tab-overview").getAttribute("aria-current")).toBe(
      "page",
    );
    // The rail is gone: no second "Project sections" navigation on the page, and
    // no legacy `/projects/<id>` href left on it.
    expect(screen.getAllByRole("navigation", { name: "Project sections" })).toHaveLength(1);
    expect(document.querySelectorAll(`a[href^="/projects/${projectId}"]`)).toHaveLength(0);
  });

  it("flags the Runs tab with what needs you, and counts threads and workflows", async () => {
    mounted([
      { path: approvalsPath, method: "GET", body: { approvals: [wireApproval] } },
      { path: runsPath, method: "GET", body: { runs: [{ ...wireRun } as RunSummary] } },
      {
        path: conversationsPath,
        method: "GET",
        body: {
          items: [
            conversationSummaryFixture,
            { ...conversationSummaryFixture, id: "01987a70-2222-7000-8000-abcdef012345" },
          ],
        },
      },
      { path: assignmentsPath, method: "GET", body: { assignments: [assignment()] } },
    ]);

    await screen.findByTestId("project-name");
    const tabs = screen.getByRole("navigation", { name: "Project sections" });
    // One open gate, and the `waiting_human` run it belongs to is the same fact
    // once — the count is the attention read's, not a sum of both lists.
    await waitFor(() =>
      expect(within(tabs).getByTestId("project-tab-runs").textContent).toContain("! 1"),
    );
    expect(within(tabs).getByTestId("project-tab-runs").textContent).toContain("need you");
    expect(within(tabs).getByTestId("project-tab-threads").textContent).toContain("2");
    expect(within(tabs).getByTestId("project-tab-workflows").textContent).toContain("1");
  });

  it("reads each tab count from the request the section below already makes", async () => {
    const { requests } = mounted([
      { path: assignmentsPath, method: "GET", body: { assignments: [assignment()] } },
    ]);
    await screen.findByTestId("project-name");
    await waitFor(() => expect(screen.getByTestId("project-workflows-assign")).toBeTruthy());
    // The header's counts and the panels share one cache entry each: the tab row
    // must not fan a second conversations/assignments read (the read-storm class
    // of bug `ProjectRefetch.test.tsx` guards on the live lab).
    expect(requestsTo(requests, conversationsPath, "GET")).toHaveLength(1);
    expect(requestsTo(requests, assignmentsPath, "GET")).toHaveLength(1);
    expect(requestsTo(requests, workspacesPath, "GET")).toHaveLength(1);
  });

  it("hides the verbs from a viewer, who cannot start either", async () => {
    mounted([], { ...projectFixture, my_role: "viewer" });
    await screen.findByTestId("project-name");
    expect(screen.queryByTestId("project-new-conversation")).toBeNull();
    expect(screen.queryByTestId("project-start-run")).toBeNull();
    expect(screen.getByTestId("project-role-hint").textContent).toContain("read-only");
    expect(screen.queryByTestId("repo-add-toggle")).toBeNull();
    expect(screen.queryByTestId("project-workflows-assign")).toBeNull();
  });
});

describe("/p/:projectId — what needs you", () => {
  it("says nothing needs attention when the project has no open work", async () => {
    mounted();
    expect((await screen.findByTestId("project-attention-empty")).textContent).toContain(
      "Nothing needs attention in this project.",
    );
  });

  it("turns an open gate into a callout with Read plan and Approve", async () => {
    const { requests } = mounted([
      { path: approvalsPath, method: "GET", body: { approvals: [wireApproval] } },
    ]);

    const key = testidOf(WIRE_APPROVAL_ID);
    const callout = await screen.findByTestId(`project-attention-decision-${key}`);
    // The gate's own text, never an invented subject line.
    expect(callout.textContent).toContain("The plan is ready");
    expect(within(callout).getByTestId(`project-read-plan-${key}`).getAttribute("href")).toBe(
      `/approvals/${WIRE_APPROVAL_ID}`,
    );
    expect(within(callout).getByTestId(`project-approve-${key}`).textContent).toBe("Approve");

    // Approve asks first: a gate is a business outcome, not a click.
    fireEvent.click(within(callout).getByTestId(`project-approve-${key}`));
    expect(within(callout).getByRole("status").textContent).toContain("approve this gate?");
    fireEvent.click(within(callout).getByTestId(`project-approve-confirm-${key}`));
    await waitFor(() => {
      const [request] = requestsTo(
        requests,
        `/api/v1/approvals/${WIRE_APPROVAL_ID}/decide`,
        "POST",
      );
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      // The row's own `version` is the CAS token.
      expect(JSON.parse(request.body ?? "{}")).toEqual({ decision: "approved", version: 1 });
    });
  });

  it("names a step failure by the step, and retries that step", async () => {
    const failed = {
      ...wireRun,
      status: "failed",
      failed_cause: "node_execution_failed:/implement",
      finished_at: "2026-07-31T10:20:00Z",
    } as unknown as RunSummary;
    const { requests } = mounted([{ path: runsPath, method: "GET", body: { runs: [failed] } }]);

    const key = testidOf(WIRE_RUN_ID);
    const callout = await screen.findByTestId(`project-attention-run-${key}`);
    expect(within(callout).getByTestId(`project-attention-run-status-${key}`).textContent).toBe(
      "failed",
    );
    // Named by the pipeline slug and the short id the wire serves — never an
    // invented title, and never the raw `node_execution_failed:/implement`.
    expect(callout.textContent).toContain("A step failed: implement");
    expect(callout.textContent).toContain("feature-development");
    expect(callout.textContent).toContain(`run #${shortId(WIRE_RUN_ID)}`);
    expect(callout.textContent).not.toContain("node_execution_failed");
    expect(within(callout).getByTestId(`project-open-run-${key}`).getAttribute("href")).toBe(
      `/runs/${WIRE_RUN_ID}`,
    );
    expect(within(callout).getByTestId(`project-retry-${key}`).textContent).toBe(
      "Retry from implement",
    );

    fireEvent.click(within(callout).getByTestId(`project-retry-${key}`));
    await waitFor(() => {
      const [request] = requestsTo(requests, `/api/v1/runs/${WIRE_RUN_ID}/retry`, "POST");
      expect(JSON.parse(request.body ?? "{}")).toEqual({ node_instance_keys: ["/implement"] });
    });
  });

  it("quotes the server's own cause when it is not a step failure", async () => {
    const failed = {
      ...wireRun,
      status: "failed",
      failed_cause: "run_duration_exceeded",
    } as unknown as RunSummary;
    mounted([{ path: runsPath, method: "GET", body: { runs: [failed] } }]);

    const key = testidOf(WIRE_RUN_ID);
    const callout = await screen.findByTestId(`project-attention-run-${key}`);
    expect(callout.textContent).toContain("The run passed its total duration budget.");
    // With no step to name, the verb is the plain one and no target is sent.
    expect(within(callout).getByTestId(`project-retry-${key}`).textContent).toBe("Retry");
  });

  it("offers Resume, not Retry, to a paused run", async () => {
    const paused = { ...wireRun, status: "paused", failed_cause: null } as unknown as RunSummary;
    const { requests } = mounted([{ path: runsPath, method: "GET", body: { runs: [paused] } }]);

    const key = testidOf(WIRE_RUN_ID);
    const callout = await screen.findByTestId(`project-attention-run-${key}`);
    expect(within(callout).queryByTestId(`project-retry-${key}`)).toBeNull();
    fireEvent.click(within(callout).getByTestId(`project-resume-${key}`));
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/runs/${WIRE_RUN_ID}/resume`, "POST")).toHaveLength(1),
    );
  });

  it("lists a waiting run with no open gate once, as a stalled run", async () => {
    mounted([
      {
        path: approvalsPath,
        method: "GET",
        body: { approvals: [{ ...wireApproval, state: "decided" }] },
      },
      {
        path: runsPath,
        method: "GET",
        body: { runs: [{ ...wireRun, status: "waiting_human" } as RunSummary] },
      },
    ]);
    const callout = await screen.findByTestId(`project-attention-run-${testidOf(WIRE_RUN_ID)}`);
    expect(screen.queryAllByTestId(/^project-attention-decision-/)).toHaveLength(0);
    expect(callout.textContent).toContain("need you");
  });
});

describe("/p/:projectId — running now", () => {
  it("lists the active runs with their step segments and what finished today", async () => {
    const running = crossRun({
      steps: [
        { node_id: "plan", kind: "agent.acp", state: "succeeded" },
        { node_id: "approve", kind: "pipeline_gate", state: "succeeded" },
        { node_id: "implement", kind: "agent.acp", state: "running" },
        { node_id: "test", kind: "process.exec", state: "pending" },
      ],
    });
    const completed = crossRun({
      id: "01987b11-0000-7000-8000-abcdef000001",
      status: "completed",
    });
    const cancelled = crossRun({
      id: "01987b11-0000-7000-8000-abcdef000002",
      status: "cancelled",
    });
    mounted([
      {
        path: crossRunsPath,
        method: "GET",
        body: { runs: [running, completed, cancelled], next_cursor: null },
      },
    ]);

    const key = testidOf(WIRE_RUN_ID);
    const row = await screen.findByTestId(`recent-run-${key}`);
    expect(within(row).getByTestId(`recent-run-status-${key}`).textContent).toBe("running");
    // The workflow's display name and slug the wire serves, the run's short id,
    // and the step it is on. There is no run title on this API, so none is
    // printed — the design's invented subject line is not drawn.
    expect(row.textContent).toContain("Feature development");
    expect(row.textContent).toContain("feature-development");
    expect(row.textContent).toContain("on implement");
    // The bar is one segment per step, with its counts spelled out (rule 06).
    const bar = within(row).getByTestId(`running-now-progress-${key}`);
    expect(bar.children).toHaveLength(4);
    expect(bar.getAttribute("aria-label")).toBe("2 of 4 steps done, 1 running");

    // A completed and a cancelled run are not "running now", but they are the
    // footer's arithmetic.
    const list = screen.getByTestId("running-now-list");
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(screen.getByTestId("running-now-finished-today").textContent).toBe(
      "1 finished today · 1 cancelled",
    );
    expect(screen.getByTestId("recent-runs-all").getAttribute("href")).toBe(`/p/${projectId}/runs`);
  });

  it("keeps child runs out of the list — they belong to their parent's tree", async () => {
    const child = crossRun({ id: WIRE_RUN_ID, depth: 1 });
    mounted([{ path: crossRunsPath, method: "GET", body: { runs: [child], next_cursor: null } }]);
    expect((await screen.findByTestId("running-now-empty")).textContent).toContain(
      "Nothing is queued or running.",
    );
    expect(screen.queryByTestId(`recent-run-${testidOf(WIRE_RUN_ID)}`)).toBeNull();
  });

  it("says a project that has never run has never run", async () => {
    mounted();
    expect((await screen.findByTestId("recent-runs-empty")).textContent).toContain("No runs yet");
    expect(screen.queryByTestId("running-now-empty")).toBeNull();
    expect(screen.queryByTestId("running-now-finished-today")).toBeNull();
  });

  it("says nothing is running when today's runs have all finished", async () => {
    mounted([
      {
        path: crossRunsPath,
        method: "GET",
        body: {
          runs: [crossRun({ id: WIRE_RUN_ID, status: "completed" })],
          next_cursor: null,
        },
      },
    ]);
    expect((await screen.findByTestId("running-now-empty")).textContent).toContain(
      "Nothing is queued or running.",
    );
    // …and the day's arithmetic is still on the page.
    expect(screen.getByTestId("running-now-finished-today").textContent).toBe(
      "1 finished today · 0 cancelled",
    );
  });

  it("says step progress is unavailable when the server predates the run read", async () => {
    mounted([
      {
        path: crossRunsPath,
        method: "GET",
        status: 404,
        body: {
          type: "https://communication.dev/errors/not-found",
          title: "Not found",
          status: 404,
          detail: "No such route.",
        },
      },
    ]);
    expect((await screen.findByTestId("running-now-unavailable")).textContent).toContain(
      "not available",
    );
    expect(screen.queryByTestId("running-now-empty")).toBeNull();
  });

  it("reports a failed run read rather than an empty panel", async () => {
    mounted([
      {
        path: crossRunsPath,
        method: "GET",
        status: 500,
        body: {
          type: "https://communication.dev/errors/internal",
          title: "Internal error",
          status: 500,
          detail: "The run list is unavailable.",
        },
      },
    ]);
    expect(await screen.findByText(/The run list is unavailable\./)).toBeTruthy();
    expect(screen.queryByTestId("running-now-empty")).toBeNull();
  });
});

describe("/p/:projectId — the inventory column", () => {
  it("lists a repository with its remote, branch, live work and workflow count", async () => {
    mounted([{ path: assignmentsPath, method: "GET", body: { assignments: [assignment()] } }]);

    const repoRow = await screen.findByTestId("repo-row-communication");
    // The compact line shortens the remote for a 300px column, but the whole URL
    // is still on the row (a screen reader gets it, and so does an operator).
    expect(repoRow.textContent).toContain("github.com/example/communication · main");
    expect(repoRow.textContent).toContain("https://github.com/example/communication.git");
    expect(repoRow.textContent).toContain("1 workflow");
    // `workspaceFixture` is a ready workspace of THIS repository: one live.
    expect(within(repoRow).getByTestId("repo-live-communication").textContent).toContain("1");
    // The design's `3 open issues`: no endpoint serves a count, and the row says
    // so rather than inventing one or fanning a live GitHub proxy per repository.
    expect(within(repoRow).getByTestId("repo-issues-communication").textContent).toContain(
      "open issues not counted here",
    );
    expect(within(repoRow).getByRole("link").getAttribute("href")).toBe(
      `/p/${projectId}/communication`,
    );
  });

  it("opens the existing add-repository form in a dialog and posts it", async () => {
    const { requests } = mounted([
      { path: reposPath, method: "POST", status: 201, body: { ...repository, name: "web" } },
    ]);

    fireEvent.click(await screen.findByTestId("repo-add-toggle"));
    const dialog = await screen.findByTestId("add-repository-dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.change(within(dialog).getByTestId("repo-name"), { target: { value: "web" } });
    fireEvent.change(within(dialog).getByTestId("repo-git-url"), {
      target: { value: "https://github.com/example/web.git" },
    });
    expect(within(dialog).getByTestId("repo-default-branch").getAttribute("placeholder")).toBe(
      "main",
    );
    fireEvent.click(within(dialog).getByTestId("repo-submit"));

    await waitFor(() => {
      const [request] = requestsTo(requests, reposPath, "POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({
        name: "web",
        git_url: "https://github.com/example/web.git",
        default_branch: "main",
      });
    });
    // A create closes the dialog and refetches the list it changed.
    await waitFor(() => expect(screen.queryByTestId("add-repository-dialog")).toBeNull());
    await waitFor(() => expect(requestsTo(requests, reposPath, "GET").length).toBeGreaterThan(1));
  });

  it("keeps a duplicate-name refusal in the server's words, with the dialog open", async () => {
    mounted([
      {
        path: reposPath,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "A repository named web already exists in this project.",
        },
      },
    ]);

    fireEvent.click(await screen.findByTestId("repo-add-toggle"));
    const dialog = await screen.findByTestId("add-repository-dialog");
    fireEvent.change(within(dialog).getByTestId("repo-name"), { target: { value: "web" } });
    fireEvent.change(within(dialog).getByTestId("repo-git-url"), {
      target: { value: "https://github.com/example/web.git" },
    });
    fireEvent.click(within(dialog).getByTestId("repo-submit"));

    expect(await screen.findByTestId("repo-add-conflict")).toBeTruthy();
    expect((await screen.findByTestId("form-error")).textContent).toContain(
      "already exists in this project",
    );
    expect(screen.getByTestId("add-repository-dialog")).toBeTruthy();
  });

  it("lists the workflows this project uses with their pin, trigger and repository", async () => {
    mounted([{ path: assignmentsPath, method: "GET", body: { assignments: [assignment()] } }]);

    const key = testidOf(assignment().id);
    const row = await screen.findByTestId(`project-workflow-row-${key}`);
    // The revision number is read, not the assignment's version label.
    await waitFor(() =>
      expect(within(row).getByTestId(`project-workflow-meta-${key}`).textContent).toContain("r7"),
    );
    // Neither trigger list answered anything for this assignment.
    expect(row.textContent).toContain("started by hand");
    expect(row.textContent).toContain(repository.name);
    expect(within(row).getByTestId(`project-workflow-edit-${key}`).getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}`,
    );
    // Assigning is the Workflows tab's form, not a second copy of it here.
    expect(screen.getByTestId("project-workflows-assign").getAttribute("href")).toBe(
      `/p/${projectId}/pipelines`,
    );
  });

  it("says what starts a workflow when it is scheduled", async () => {
    const pin = assignment();
    mounted([
      { path: assignmentsPath, method: "GET", body: { assignments: [pin] } },
      {
        path: schedulesPath,
        method: "GET",
        body: {
          schedules: [
            {
              id: "sch-1",
              project_id: projectId,
              assignment_id: pin.id,
              cron_expr: "0 6 * * 1",
              inputs: {},
              enabled: true,
              next_run_at: "2026-10-19T06:00:00Z",
              version: 1,
              created_by: meFixture.id,
              created_at: "2026-10-01T09:00:00Z",
              updated_at: "2026-10-01T09:00:00Z",
            },
          ],
        },
      },
    ]);
    const key = testidOf(pin.id);
    const row = await screen.findByTestId(`project-workflow-row-${key}`);
    expect(await within(row).findByText(/weekly Monday 06:00 UTC/)).toBeTruthy();
  });

  it("refuses to claim a workflow is hand-started when its trigger read failed", async () => {
    const pin = assignment();
    mounted([
      { path: assignmentsPath, method: "GET", body: { assignments: [pin] } },
      {
        path: schedulesPath,
        method: "GET",
        status: 500,
        body: {
          type: "https://communication.dev/errors/internal",
          title: "Internal error",
          status: 500,
        },
      },
    ]);
    const key = testidOf(pin.id);
    const broken = await screen.findByTestId(`project-workflow-row-${key}`);
    // A trigger read that failed is not "started by hand".
    expect(await within(broken).findByText(/triggers unavailable/)).toBeTruthy();
    expect(broken.textContent).not.toContain("started by hand");
  });

  it("shows a project-wide pin as the whole project, not a missing repository", async () => {
    const pin = assignment({ repository_id: null, repository_name: null });
    mounted([{ path: assignmentsPath, method: "GET", body: { assignments: [pin] } }]);
    const row = await screen.findByTestId(`project-workflow-row-${testidOf(pin.id)}`);
    expect(row.textContent).toContain("whole project");
  });

  it("shows the honest empty states when the project holds nothing", async () => {
    mounted([
      { path: reposPath, method: "GET", body: { items: [] } },
      { path: conversationsPath, method: "GET", body: { items: [] } },
      { path: workspacesPath, method: "GET", body: { workspaces: [] } },
    ]);

    expect((await screen.findByTestId("repo-list-empty")).textContent).toContain(
      "No repositories yet",
    );
    expect(screen.getByTestId("project-threads-empty").textContent).toContain(
      "No threads in this project yet.",
    );
    expect(screen.getByTestId("project-workflows-empty").textContent).toContain(
      "No workflows are used in this project yet.",
    );
    expect(screen.getByTestId("recent-runs-empty")).toBeTruthy();
    expect(screen.getByTestId("project-attention-empty")).toBeTruthy();
    // Zero is printed as zero — the reads answered, so the count is a fact.
    expect(screen.getByTestId("project-tab-workflows").textContent).toContain("Workflows");
    expect(screen.getByTestId("project-tab-workflows").textContent).toContain("0");
  });

  it("names the agent profile, and the repository a workspace says the thread is in", async () => {
    mounted();
    const row = await screen.findByTestId(
      `project-thread-${testidOf(conversationSummaryFixture.id)}`,
    );
    // `workspaceFixture` is this conversation's workspace, holding `backend`.
    expect(row.textContent).toContain(conversationSummaryFixture.title);
    expect(row.textContent).toContain("backend");
    expect(row.textContent).toContain(claudeProfile.name);
    expect(screen.getByTestId("project-all-threads").getAttribute("href")).toBe(
      `/p/${projectId}/conversations`,
    );
  });

  it("says the agent is unread rather than printing a profile id", async () => {
    mounted([{ path: "/api/v1/agent-profiles", method: "GET", body: { items: [] } }]);
    const row = await screen.findByTestId(
      `project-thread-${testidOf(conversationSummaryFixture.id)}`,
    );
    expect(row.textContent).toContain("agent unread");
    expect(row.textContent).not.toContain(claudeProfile.id);
  });

  it("points the panels that left the overview at where they went", async () => {
    mounted();
    const note = await screen.findByTestId("project-moved-off-note");
    expect(
      within(note)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([`/p/${projectId}/members`, `/p/${projectId}/settings`]);
    // They are off this page: members, the event feed and workspaces are gone
    // from the overview, and nothing else silently took their requests either.
    expect(screen.queryByTestId("member-list")).toBeNull();
    expect(screen.queryByTestId("activity-list")).toBeNull();
    expect(screen.queryByTestId("workspace-list")).toBeNull();
  });

  it("tells a maintainer there is nothing to add without hiding the form", async () => {
    mounted([
      { path: reposPath, method: "GET", body: { items: [] } },
      { path: workspacesPath, method: "GET", body: { workspaces: [] } },
    ]);
    fireEvent.click(await screen.findByTestId("repo-add-empty"));
    expect(screen.getByTestId("add-repository-dialog")).toBeTruthy();
  });
});

describe("/p/:projectId — the project itself cannot be read", () => {
  it("says the project was not found when the API returns 404", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: [
        me,
        {
          path: projectPath,
          status: 404,
          body: {
            type: "https://communication.dev/errors/not-found",
            title: "Not found",
            status: 404,
            detail: "No such project.",
          },
        },
      ],
    });

    await screen.findByTestId("project-not-found");
    expect(screen.getByTestId("project-not-found").textContent).toBe(
      "Project not found or you do not have access",
    );
    // The refusal is one sentence: no shell around a project the reader cannot
    // open, and no tab row promising sections they cannot reach.
    expect(screen.queryByTestId("project-tabs")).toBeNull();
    expect(screen.queryByTestId("repo-list")).toBeNull();
  });

  it("quotes the server when the read fails for another reason", async () => {
    renderApp({
      path: `/p/${projectId}`,
      routes: [
        me,
        {
          path: projectPath,
          status: 503,
          body: {
            type: "https://communication.dev/errors/unavailable",
            title: "Service unavailable",
            status: 503,
            detail: "The control plane is still migrating.",
          },
        },
      ],
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Service unavailable");
    expect(alert.textContent).toContain("still migrating");
  });
});
