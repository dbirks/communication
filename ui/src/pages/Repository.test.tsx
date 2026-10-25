/**
 * `/p/:projectId/:repo` — the repository page: header, STATUS, ISSUES and
 * RECENT RUNS sections, against the fake fetch.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, type RouteStub } from "../test/fakes";
import type { GitHubIssue } from "../api/issues";
import type { Repository, RunSummary, Workspace, WorkspaceRepoStatus } from "../api/types";
import { wirePipelineList } from "../test/fixtures/m4/wire";

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
      run_ref: "run-01987a75-6666-7000-8000-abcdef012345/communication",
      base_commit: "4f2a1c8d111111111111111111111111111111111111111111111111111111111",
      workspace_mode: "worktree",
    },
  ],
};

const workspaceStatus: WorkspaceRepoStatus = {
  workspace_id: workspaceId,
  repository_id: repositoryId,
  run_ref: "run-01987a75-6666-7000-8000-abcdef012345/communication",
  base_commit: "4f2a1c8d111111111111111111111111111111111111111111111111111111111",
  head_commit: "9b3d7e1f111111111111111111111111111111111111111111111111111111111",
  dirty: true,
  modified_paths: ["src/app.ts"],
  recorded_at: "2026-10-14T18:07:00Z",
};

const run: RunSummary = {
  id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
  project_id: projectFixture.id,
  pipeline_id: "01987b20-0000-7000-8000-abcdef012345",
  pipeline_revision_id: "01987b21-0000-7000-8000-abcdef012345",
  revision_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  plan_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-07-31T10:02:11Z",
};

function routes(): RouteStub[] {
  const projectPath = `/api/v1/projects/${projectFixture.id}`;
  const issuesPath = `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`;
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: projectPath, body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: [repository] } },
    { path: `${projectPath}/assignments`, body: { assignments: [] } },
    { path: `${projectPath}/schedules`, body: { schedules: [] } },
    { path: `${projectPath}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `${projectPath}/secrets`, body: { secrets: [] } },
    { path: `${projectPath}/workspaces`, body: { workspaces: [workspace] } },
    {
      path: `/api/v1/workspaces/${workspaceId}/repos/${repositoryId}/status`,
      body: workspaceStatus,
    },
    { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [run] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    {
      path: issuesPath,
      body: { repository: "example/communication", state: "open", items: [issue] },
    },
  ];
}

describe("/p/:projectId/:repo", () => {
  it("renders the repository header and its sections from the mocked API", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    expect(await screen.findByTestId("repo-page")).toBeTruthy();
    expect(screen.getByTestId("repo-name").textContent).toBe("communication");
    expect(screen.getByTestId("repo-default-branch").textContent).toBe("main");
    expect(screen.getByTestId("repo-git-url").getAttribute("href")).toBe(repository.git_url);
    expect(screen.getByTestId("repo-breadcrumb-repo").textContent).toBe("communication");

    // The 1e header carries the two ways in; neither is a dead button.
    expect(screen.getByTestId("repo-new-thread").textContent).toBe("New thread here");
    expect(screen.getByTestId("repo-start-run").textContent).toBe("Start run");

    // WORKFLOWS ON THIS REPO (2e) sits in the left column, above STATUS.
    expect(await screen.findByTestId("repo-workflows")).toBeTruthy();
    expect(screen.getByTestId("repo-workflows-empty").textContent).toContain(
      "uses no workflow yet",
    );

    expect(await screen.findByTestId("repo-workspaces")).toBeTruthy();
    expect(await screen.findByTestId(`repo-workspace-${workspaceId}`)).toBeTruthy();
    expect(screen.getByTestId("repo-workspaces").textContent).toContain("dirty");

    expect(await screen.findByTestId("repo-issues")).toBeTruthy();
    expect(screen.getByTestId(`repo-issue-${issue.number}`)).toBeTruthy();
    expect(screen.getByTestId(`repo-issue-title-${issue.number}`).getAttribute("href")).toBe(
      issue.html_url,
    );

    expect(await screen.findByTestId("repo-runs")).toBeTruthy();
    expect(screen.getByTestId(`repo-run-${run.id.replace(/-/g, "").slice(0, 13)}`)).toBeTruthy();
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

  it("shows the workspace status row with branch and dirty state", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    const row = await screen.findByTestId(`repo-workspace-${workspaceId}`);
    await waitFor(() => expect(row.textContent).toContain("dirty"), { timeout: 8000 });
  });

  it("names the workspace's owning run instead of showing a raw id", async () => {
    const runWorkspace: Workspace = {
      ...workspace,
      id: "01987a76-7777-7000-8000-abcdef012345",
      run_id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
    };
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
        { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [repository] } },
        {
          path: `/api/v1/projects/${projectFixture.id}/workspaces`,
          body: { workspaces: [runWorkspace] },
        },
        {
          path: `/api/v1/workspaces/${runWorkspace.id}/repos/${repositoryId}/status`,
          body: workspaceStatus,
        },
        { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [run] } },
        { path: "/api/v1/pipelines", body: wirePipelineList },
      ],
    });

    const row = await screen.findByTestId(`repo-workspace-${runWorkspace.id}`);
    const runLink = await screen.findByTestId(`repo-workspace-run-${runWorkspace.id}`);
    expect(runLink.getAttribute("href")).toBe("/runs/01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c");
    expect(runLink.textContent).toContain("run #");
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
    // No workflow is used yet, so the form says that instead of offering an
    // empty assignment select.
    expect(screen.getByTestId("new-run-no-assignments")).toBeTruthy();
  });

  it("says how the repository reads GitHub, under the git URL (ADR-0061)", async () => {
    renderApp({ path: `/p/${projectFixture.id}/communication`, routes: routes() });

    const line = await screen.findByTestId("repo-github-access-state");
    expect(line.textContent).toBe("public · no credential");
    // The fixture's project has this caller as maintainer — the route's gate.
    expect(screen.getByTestId("repo-github-access-change").textContent).toBe("change");
    expect(screen.getByTestId("repo-github-access").className).toContain("font-mono");
  });
});
