/**
 * `/p/:projectId/:repo` — the repository page (design 1e): header, the two
 * columns (WORKFLOWS ON THIS REPO + OPEN ISSUES left; WORK IN THIS REPO +
 * RECENT RUNS right), the inline `Start a run…` expansion, and the populated
 * / empty / error states of every panel — against the fake fetch.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import type { GitHubIssue } from "../api/issues";
import type {
  Assignment,
  Repository,
  Run,
  RunSummary,
  Workspace,
  WorkspaceRepoStatus,
} from "../api/types";
import {
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
  wireRevision,
} from "../test/fixtures/m4/wire";

const repositoryId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0";
const workspaceId = "01987a75-6666-7000-8000-abcdef012345";

const repository: Repository = {
  id: repositoryId,
  project_id: projectFixture.id,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
  credential: "none",
};

/** What the lab actually seeds: a local remote the issues route could only
 * answer `422 not_a_github_repository` for — the page must not ask. */
const localRepositoryId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f1";
const localRepository: Repository = {
  ...repository,
  id: localRepositoryId,
  name: "lab",
  git_url: "file:///srv/git/lab.git",
};

const issue: GitHubIssue = {
  number: 512,
  title: "The build is red",
  body: "CI is failing on main.",
  labels: ["bug"],
  html_url: "https://github.com/example/communication/issues/512",
  state: "open",
  updated_at: "2026-10-14T17:00:00Z",
  body_truncated: false,
};

/** The assignment this repository uses (ADR-0060): it arms the 2e workflow
 * row, makes the inline issue start possible, and is what RECENT RUNS
 * attributes a run to this repository through. */
const repoAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repositoryId,
  repository_name: repository.name,
};

const workspace: Workspace = {
  id: workspaceId,
  project_id: projectFixture.id,
  scope_kind: "run",
  worker_id: "01987a74-5555-7000-8000-abcdef012345",
  volume_id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  workspace_mode: "worktree",
  state: "ready",
  created_at: "2026-10-14T18:00:00Z",
  ready_at: "2026-10-14T18:05:00Z",
  repos: [
    {
      repository_id: repositoryId,
      name: "communication",
      run_ref: "run-9c1e04f2/communication",
      base_commit: "4f2a1c8d111111111111111111111111111111111111111111111111111111111",
      workspace_mode: "worktree",
    },
  ],
};

const workspaceStatus: WorkspaceRepoStatus = {
  workspace_id: workspaceId,
  repository_id: repositoryId,
  run_ref: "run-9c1e04f2/communication",
  base_commit: "4f2a1c8d111111111111111111111111111111111111111111111111111111111",
  head_commit: "9b3d7e1f111111111111111111111111111111111111111111111111111111111",
  dirty: true,
  modified_paths: ["src/app.ts"],
  recorded_at: "2026-10-14T18:07:00Z",
};

const run: RunSummary = {
  id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
  project_id: projectFixture.id,
  pipeline_id: WIRE_PIPELINE_ID,
  pipeline_revision_id: WIRE_REVISION_ID,
  assignment_id: repoAssignment.id,
  revision_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  plan_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-07-31T10:02:11Z",
};

/** The full run view the WORK IN THIS REPO row reads for its status word. */
const runView: Run = {
  ...(run as unknown as Run),
  pipeline_revision_id: WIRE_REVISION_ID,
  status: "running",
  plan: { nodes: [] },
} as unknown as Run;

/** The workflow reads the 2e panel and the issue-run select fan: the pipeline
 * names the row and the option, the pinned revision carries the number, the
 * step chain and — for the issue start — the declared `spec.inputs`. */
function workflowRoutes(): RouteStub[] {
  return [
    {
      path: `/api/v1/projects/${projectFixture.id}/assignments`,
      body: { assignments: [repoAssignment] },
    },
    { path: `/api/v1/projects/${projectFixture.id}/schedules`, body: { schedules: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
    { path: `/api/v1/revisions/${repoAssignment.pinned_revision_digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    { path: `/api/v1/runs/${run.id}`, body: runView },
  ];
}

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const projectPath = `/api/v1/projects/${projectFixture.id}`;
  const issuesPath = `${projectPath}/repos/${repositoryId}/issues`;
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: projectPath, body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: [repository] } },
    { path: `${projectPath}/secrets`, body: { secrets: [] } },
    { path: `${projectPath}/workspaces`, body: { workspaces: [workspace] } },
    {
      path: `/api/v1/workspaces/${workspaceId}/repos/${repositoryId}/status`,
      body: workspaceStatus,
    },
    { path: `${projectPath}/runs`, body: { runs: [run] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    {
      path: issuesPath,
      body: { repository: "example/communication", state: "open", items: [issue] },
    },
    ...workflowRoutes(),
  ];
  // Overrides first: the fake fetch answers the first stub that matches, so
  // a test's own stub replaces the base one for its path.
  return [...overrides, ...base];
}

describe("/p/:projectId/:repo", () => {
  it("renders the repository header and its 1e sections from the mocked API", async () => {
    const { requests } = renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes(),
    });

    expect(await screen.findByTestId("repo-page")).toBeTruthy();
    expect(screen.getByTestId("repo-name").textContent).toBe("communication");
    expect(screen.getByTestId("repo-default-branch").textContent).toBe("main");
    expect(screen.getByTestId("repo-git-url").getAttribute("href")).toBe(repository.git_url);
    expect(screen.getByTestId("repo-breadcrumb-repo").textContent).toBe("communication");

    // The 1e header carries the two ways in; neither is a dead button.
    expect(screen.getByTestId("repo-new-thread").textContent).toBe("New thread here");
    expect(screen.getByTestId("repo-start-run").textContent).toBe("Start run");

    // WORKFLOWS ON THIS REPO (2e) sits in the left column and names the
    // repository's pin, with 1e's `Edit` + `Run` buttons.
    expect(await screen.findByTestId("repo-workflows")).toBeTruthy();
    const rowKey = repoAssignment.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
    expect(await screen.findByTestId(`repo-workflow-row-${rowKey}`)).toBeTruthy();
    expect(screen.getByTestId(`repo-workflow-edit-${rowKey}`).getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}`,
    );
    expect(screen.getByTestId(`repo-workflow-run-${rowKey}`).textContent).toBe("Run");

    expect(await screen.findByTestId("repo-workspaces")).toBeTruthy();
    expect(await screen.findByTestId(`repo-workspace-${workspaceId}`)).toBeTruthy();
    // WORK IN THIS REPO speaks in words: the worker's last view is
    // “n files changed”, not a bare `dirty` flag.
    expect(screen.getByTestId(`repo-workspace-state-${workspaceId}`).textContent).toContain(
      "1 file changed",
    );

    expect(await screen.findByTestId("repo-issues")).toBeTruthy();
    // A GitHub-hosted remote does make the issues request — gating on
    // git_url must not silence the working half.
    expect(
      requestsTo(
        requests,
        `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`,
        "GET",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId(`repo-issue-${issue.number}`)).toBeTruthy();
    expect(screen.getByTestId(`repo-issue-title-${issue.number}`).getAttribute("href")).toBe(
      issue.html_url,
    );
    expect(screen.getByTestId(`repo-issue-run-${issue.number}`).textContent).toBe("Start a run…");

    // RECENT RUNS attributes the run through its assignment → this repository.
    expect(await screen.findByTestId("repo-runs")).toBeTruthy();
    expect(screen.getByTestId(`repo-run-${run.id.replace(/-/g, "").slice(0, 13)}`)).toBeTruthy();
    expect(screen.queryByTestId("repo-runs-project-note")).toBeNull();
  });

  it("shows the not-found empty state for an unknown repository", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/nope`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
        { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
      ],
    });

    expect(await screen.findByTestId("repo-not-found")).toBeTruthy();
  });

  it("shows the honest reason for a non-GitHub remote and never asks the issues route", async () => {
    // No stub on the issues path at all: the page decides from `git_url` that
    // there is nothing to read, so the request the emulator logged as a
    // failed 422 must simply not happen.
    const { requests } = renderApp({
      path: `/p/${projectFixture.id}/lab`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
        { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [localRepository] } },
      ],
    });

    expect(await screen.findByTestId("repo-page")).toBeTruthy();
    const line = await screen.findByTestId("repo-issues-not-github");
    expect(line.textContent).toContain("Issue triggers need a GitHub repository");
    expect(screen.queryByTestId("repo-issues-list")).toBeNull();
    expect(screen.queryByText("Reading GitHub")).toBeNull();
    expect(
      requestsTo(
        requests,
        `/api/v1/projects/${projectFixture.id}/repos/${localRepositoryId}/issues`,
        "GET",
      ),
    ).toHaveLength(0);
  });

  it("shows the honest rate-limited state when GitHub refuses the anonymous read", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
        { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [repository] } },
        {
          path: `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`,
          status: 502,
          body: {
            type: "https://communication.dev/errors/github_rate_limited",
            title: "GitHub rate limited",
            status: 502,
            detail: "anonymous budget spent",
          },
        },
      ],
    });

    expect(await screen.findByTestId("repo-issues-rate-limited")).toBeTruthy();
    expect(screen.getByTestId("repo-issues-rate-limited").textContent).toContain(
      "rate-limiting anonymous requests",
    );
    expect(screen.queryByTestId("repo-issues-list")).toBeNull();
  });

  // ADR-0061 § 6 second half: GitHub hides a private repo from the anonymous
  // read as a 404 — with no credential on the row the panel says so in the
  // ADR's words and one click opens the GitHub-access picker. With a
  // credential (or for a reader who cannot manage it) it does not claim
  // privacy it cannot prove.
  const notFoundRoutes = (): RouteStub[] => [
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [repository] } },
    { path: `/api/v1/projects/${projectFixture.id}/secrets`, body: { secrets: [] } },
    {
      path: `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`,
      status: 502,
      body: {
        type: "https://communication.dev/errors/github_repository_not_found",
        title: "GitHub repository not found",
        status: 502,
        code: "github_repository_not_found",
        detail: "GitHub answered 404 for example/communication",
      },
    },
  ];

  it("names the private-repo case on a not-found with no credential, and opens the access picker", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: notFoundRoutes() });
    const line = await screen.findByTestId("repo-issues-private");
    expect(line.textContent).toBe("private repo? add GitHub access");
    // The generic not-found banner is NOT what the reader gets.
    expect(screen.queryByTestId("repo-issues-private-maintainer")).toBeNull();
    fireEvent.click(screen.getByTestId("repo-issues-add-github-access"));
    expect(await screen.findByTestId("github-access-dialog")).toBeTruthy();
  });

  it("points a reader who cannot manage credentials at a maintainer instead of the picker", async () => {
    const viewer = { ...projectFixture, my_role: "viewer" as const };
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        { path: `/api/v1/projects/${projectFixture.id}`, body: viewer },
        ...notFoundRoutes().filter((r) => r.path !== `/api/v1/projects/${projectFixture.id}`),
      ],
    });
    const line = await screen.findByTestId("repo-issues-private");
    expect(line.textContent).toContain("a project maintainer can add GitHub access");
    expect(screen.queryByTestId("repo-issues-add-github-access")).toBeNull();
  });

  it("keeps the server's own words when a credential WAS sent and the read still 404s", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        {
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: {
            items: [
              {
                ...repository,
                credential: "configured" as const,
                credential_secret_id: "01987a77-7777-7000-8000-abcdef012345",
              },
            ],
          },
        },
        ...notFoundRoutes().filter((r) => r.path !== `/api/v1/projects/${projectFixture.id}/repos`),
      ],
    });
    // With a credential in play the 404 is not the private-repo hint — the
    // upstream's own problem answer stays on screen.
    expect(await screen.findByText(/GitHub repository not found/)).toBeTruthy();
    expect(screen.queryByTestId("repo-issues-private")).toBeNull();
  });

  it("says what the workspace is doing in words, never a worker or volume id", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    const row = await screen.findByTestId(`repo-workspace-${workspaceId}`);
    await waitFor(() => expect(row.textContent).toContain("1 file changed"));
    expect(row.textContent).toContain(workspace.repos[0].run_ref);
    expect(row.textContent).not.toContain(workspace.worker_id);
    expect(row.textContent).not.toContain(workspace.volume_id);
    // The bare workspace id stays a `title` attribute, never row text.
    expect(row.textContent).not.toContain(workspace.id);
  });

  it("names the workspace's owning run and its state instead of showing a raw id", async () => {
    const runWorkspace: Workspace = {
      ...workspace,
      id: "01987a76-7777-7000-8000-abcdef012345",
      run_id: run.id,
    };
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        {
          path: `/api/v1/projects/${projectFixture.id}/workspaces`,
          body: { workspaces: [runWorkspace] },
        },
        {
          path: `/api/v1/workspaces/${runWorkspace.id}/repos/${repositoryId}/status`,
          body: { ...workspaceStatus, workspace_id: runWorkspace.id },
        },
      ]),
    });

    const row = await screen.findByTestId(`repo-workspace-${runWorkspace.id}`);
    const runLink = await screen.findByTestId(`repo-workspace-run-${runWorkspace.id}`);
    expect(runLink.getAttribute("href")).toBe(`/runs/${run.id}`);
    // The row speaks: the workflow the run executes, named once the reads land.
    await waitFor(() => expect(row.textContent).toContain("Feature development"));
    // The bare id stays a title attribute, never a label in the row text.
    expect(row.textContent).not.toContain(runWorkspace.id);
  });

  it("opens the existing new-thread flow from the header's New thread here", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    fireEvent.click(await screen.findByTestId("repo-new-thread"));
    expect(await screen.findByTestId("new-conversation-dialog")).toBeTruthy();
    // The thread is opened *here*: the project is fixed, not a picker.
    expect(screen.getByTestId("new-conversation-dialog-project").textContent).toBe(
      projectFixture.name,
    );
  });

  it("opens the existing new-run flow from the header's Start run", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    fireEvent.click(await screen.findByTestId("repo-start-run"));
    expect(await screen.findByTestId("new-run-form")).toBeTruthy();
    // The repository's own pin is offered as the assignment to start.
    expect(screen.getByTestId("new-run-assignment")).toBeTruthy();
  });

  it("says how the repository reads GitHub, under the git URL (ADR-0061)", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    const line = await screen.findByTestId("repo-github-access-state");
    expect(line.textContent).toBe("public · no credential");
    // The fixture's project has this caller as maintainer — the route's gate.
    expect(screen.getByTestId("repo-github-access-change").textContent).toBe("change");
    expect(screen.getByTestId("repo-github-access").className).toContain("font-mono");
  });

  it("shows honest empty states when nothing has happened in the repository", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        { path: `/api/v1/projects/${projectFixture.id}/workspaces`, body: { workspaces: [] } },
        { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
        {
          path: `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`,
          body: { repository: "example/communication", state: "open", items: [] },
        },
        { path: `/api/v1/projects/${projectFixture.id}/assignments`, body: { assignments: [] } },
      ]),
    });

    expect(await screen.findByTestId("repo-workflows-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-issues-empty").textContent).toContain("no open issues");
    expect(screen.getByTestId("repo-workspaces-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-runs-empty").textContent).toContain(
      "No runs through this repository's workflows yet.",
    );
  });

  it("falls back to the project's runs — and says so — when the assignments read fails", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        {
          path: `/api/v1/projects/${projectFixture.id}/assignments`,
          status: 500,
          body: {
            type: "https://communication.dev/errors/internal",
            title: "Internal error",
            status: 500,
            detail: "assignments unavailable",
          },
        },
      ]),
    });

    // The run row still shows (it is a project run), under the honest note.
    expect(
      await screen.findByTestId(`repo-run-${run.id.replace(/-/g, "").slice(0, 13)}`),
    ).toBeTruthy();
    const note = await screen.findByTestId("repo-runs-project-note");
    expect(note.textContent).toContain("these are the project's runs");
  });

  it("expands an issue row inline and posts the run with the issue as its goal", async () => {
    const { requests } = renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        ...routes(),
        {
          method: "POST",
          path: `/api/v1/projects/${projectFixture.id}/runs`,
          status: 201,
          body: { run_id: "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d", status: "queued" },
        },
      ],
    });

    fireEvent.click(await screen.findByTestId(`repo-issue-run-${issue.number}`));
    expect(await screen.findByTestId(`repo-issue-expand-${issue.number}`)).toBeTruthy();

    // The workflow select names the repository's pinned workflow; the mapping
    // line is read from that revision's own `spec.inputs` — `goal` is filled
    // by the issue, `repository` is not, and the line says both.
    const select = screen.getByTestId(`repo-issue-workflow-${issue.number}`) as HTMLSelectElement;
    expect(select.options[select.selectedIndex]?.textContent).toContain("Feature development");
    const mapping = screen.getByTestId(`repo-issue-mapping-${issue.number}`);
    // The mapping is read from the pinned revision — it lands with that read.
    await waitFor(() => expect(mapping.textContent).toContain("goal = issue title + body"));
    expect(mapping.textContent).toContain("repository not filled from the issue");

    fireEvent.click(screen.getByTestId(`repo-issue-start-${issue.number}`));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/runs`, "POST").length,
      ).toBeGreaterThan(0),
    );
    const post = requestsTo(requests, `/api/v1/projects/${projectFixture.id}/runs`, "POST")[0];
    const body = JSON.parse(post.body ?? "{}") as {
      assignment_id: string;
      inputs: Record<string, unknown>;
    };
    expect(body.assignment_id).toBe(repoAssignment.id);
    expect(String(body.inputs.goal)).toContain("#512 The build is red");
    expect(String(body.inputs.goal)).toContain("CI is failing on main.");
    // One idempotency key per expansion (ADR-0023 § 12).
    expect(post.headers.get("idempotency-key")).toMatch(/^issuerrun-/);
  });

  it("cancels the inline expansion back to the row", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    fireEvent.click(await screen.findByTestId(`repo-issue-run-${issue.number}`));
    await screen.findByTestId(`repo-issue-expand-${issue.number}`);
    fireEvent.click(screen.getByTestId(`repo-issue-cancel-${issue.number}`));
    await waitFor(() =>
      expect(screen.queryByTestId(`repo-issue-expand-${issue.number}`)).toBeNull(),
    );
    expect(screen.getByTestId(`repo-issue-run-${issue.number}`)).toBeTruthy();
  });

  it("shows the trigger-run link instead of the button for an issue with a run in progress", async () => {
    const issueRun: RunSummary = {
      ...run,
      id: "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e",
      status: "waiting_human",
      trigger: { kind: "issue", ref: "example/communication#512" },
    };
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [issueRun, run] } },
      ]),
    });

    const link = await screen.findByTestId(`repo-issue-active-run-${issue.number}`);
    expect(link.getAttribute("href")).toBe(`/runs/${issueRun.id}`);
    // The design's `● run #a7f3 in progress`, spelled with the run's own word.
    expect(link.textContent).toContain("run #");
    expect(link.textContent).toContain("need you");
    expect(screen.queryByTestId(`repo-issue-run-${issue.number}`)).toBeNull();
  });

  it("refuses to claim an in-progress run for a terminal issue start", async () => {
    const finishedIssueRun: RunSummary = {
      ...run,
      id: "01987b14-5e8e-7b7f-9c53-6a7b8c9d0e1f",
      status: "completed",
      trigger: { kind: "issue", ref: "example/communication#512" },
    };
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        {
          path: `/api/v1/projects/${projectFixture.id}/runs`,
          body: { runs: [finishedIssueRun, run] },
        },
      ]),
    });

    // A completed issue run is history: the row offers the start again.
    expect(await screen.findByTestId(`repo-issue-run-${issue.number}`)).toBeTruthy();
    expect(screen.queryByTestId(`repo-issue-active-run-${issue.number}`)).toBeNull();
  });

  it("shows the error state when the run list fails", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: routes([
        {
          path: `/api/v1/projects/${projectFixture.id}/runs`,
          status: 500,
          body: {
            type: "https://communication.dev/errors/internal",
            title: "Internal error",
            status: 500,
            detail: "runs unavailable",
          },
        },
      ]),
    });

    expect(await screen.findByTestId("repo-runs")).toBeTruthy();
    expect(await screen.findByText(/runs unavailable/i)).toBeTruthy();
  });
});
