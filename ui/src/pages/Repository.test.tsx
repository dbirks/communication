/**
 * `/p/:projectId/:repo` — the repository page, List view (design 3a): the
 * chat box, the mixed runs+chats activity feed (order, filters, empty and
 * error states), Start creating a repo-bound conversation (ADR-0067), the
 * side panel (assistant notes absent without a source, workflow rows with
 * their trigger line and latest result, OPEN ISSUES with `Hand off`), and
 * the honest GitHub refusals carried over from design 1e.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { ConversationSummary } from "../api/types";
import type { GitHubIssue } from "../api/issues";
import type { Assignment, Repository, RunSummary } from "../api/types";
import type { IssueTrigger } from "../api/useIssueTriggers";
import type { Schedule } from "../api/pipelines";
import {
  WIRE_CHILD_PIPELINE_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
  wireRevision,
} from "../test/fixtures/m4/wire";

const repositoryId = "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0";

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

/** This repository's own pin (ADR-0060): it arms the workflow row, the issue
 * hand-off select and the run attribution. */
const repoAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repositoryId,
  repository_name: repository.name,
};

/** A whole-project pin (`repository_id` null) — it covers this repo too, and
 * its row is the `Schedule · …` one. */
const projectAssignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  id: "01987b22-1111-7000-8000-abcdef012345",
  pipeline_id: WIRE_CHILD_PIPELINE_ID,
  repository_id: null,
  repository_name: null,
};

const issueTrigger: IssueTrigger = {
  id: "01987b28-0000-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  assignment_id: repoAssignment.id,
  repository_id: repositoryId,
  event: "labeled",
  labels: ["factory"],
  inputs: {},
  enabled: true,
  version: 1,
  created_by: meFixture.id,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
};

const schedule: Schedule = {
  id: "01987b29-0000-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  assignment_id: projectAssignment.id,
  cron_expr: "0 2 * * *",
  inputs: {},
  enabled: true,
  next_run_at: "2026-11-03T02:00:00Z",
  version: 1,
  created_by: meFixture.id,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
};

/* The feed's story, in fixed activity order: the waiting run is the newest
 * (09:01), the running one is older (08:30), the chat sits before it
 * (08:00), the completed run finished the night before (21:00). */
const waitingRun: RunSummary = {
  id: "01987c11-0000-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  pipeline_id: WIRE_PIPELINE_ID,
  pipeline_revision_id: WIRE_REVISION_ID,
  assignment_id: repoAssignment.id,
  title: "Checkout rounds tax wrong",
  repository_id: repositoryId,
  repository_name: repository.name,
  revision_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  plan_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  status: "waiting_human",
  depth: 0,
  triggered_by: meFixture.id,
  priority: 0,
  created_at: "2026-11-01T09:00:00Z",
  started_at: "2026-11-01T09:01:00Z",
};

const runningRun: RunSummary = {
  ...waitingRun,
  id: "01987c11-0002-7000-8000-abcdef012345",
  title: "Add Apple Pay",
  status: "running",
  triggered_by: meFixture.id,
  created_at: "2026-10-31T10:00:00Z",
  started_at: "2026-11-01T08:30:00Z",
};

const doneRun: RunSummary = {
  ...waitingRun,
  id: "01987c11-0001-7000-8000-abcdef012345",
  title: "Nightly deps",
  status: "completed",
  assignment_id: projectAssignment.id,
  triggered_by: "01987a61-9999-7000-8000-abcdef012345",
  created_at: "2026-10-31T20:00:00Z",
  started_at: "2026-10-31T20:01:00Z",
  finished_at: "2026-10-31T21:00:00Z",
};

const repoChat: ConversationSummary = {
  id: conversationFixture.id,
  project_id: projectFixture.id,
  agent_profile_id: claudeProfile.id,
  title: "Search revamp spike",
  status: "active",
  created_by: "01987a61-9999-7000-8000-abcdef012345",
  created_at: "2026-10-30T08:00:00Z",
  updated_at: "2026-11-01T08:00:00Z",
  control: conversationFixture.control,
  origin: "manual",
  run_link: null,
  repository_id: repositoryId,
  repository_name: repository.name,
};

/** A thread created by the chat box (the POST's 201 answer). */
function createdConversation(): ConversationSummary & Partial<typeof conversationFixture> {
  return {
    ...conversationFixture,
    id: "01987c22-0000-7000-8000-abcdef012345",
    title: "fix the flaky checkout test",
    created_at: "2026-11-02T08:00:00Z",
    updated_at: "2026-11-02T08:00:00Z",
  };
}

/** The page's routes: runs newest-first as the server sends them, the
 * repo-filtered conversations (ADR-0067), the two pins with one trigger
 * each, the workflow reads and the issue list. */
function feedRoutes(overrides: RouteStub[] = []): RouteStub[] {
  const projectPath = `/api/v1/projects/${projectFixture.id}`;
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: projectPath, body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: [repository] } },
    { path: `${projectPath}/secrets`, body: { secrets: [] } },
    { path: `${projectPath}/runs`, body: { runs: [waitingRun, runningRun, doneRun] } },
    { method: "GET", path: `${projectPath}/conversations`, body: { items: [repoChat] } },
    {
      path: `${projectPath}/assignments`,
      body: { assignments: [repoAssignment, projectAssignment] },
    },
    { path: `${projectPath}/schedules`, body: { schedules: [schedule] } },
    { path: `${projectPath}/issue-triggers`, body: { issue_triggers: [issueTrigger] } },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
    { path: `/api/v1/revisions/${repoAssignment.pinned_revision_digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    {
      path: `${projectPath}/repos/${repositoryId}/issues`,
      body: { repository: "example/communication", state: "open", items: [issue] },
    },
  ];
  return [...overrides, ...base];
}

function renderFeed(overrides: RouteStub[] = []) {
  return renderApp({
    path: `/p/${projectFixture.id}/communication`,
    routes: feedRoutes(overrides),
  });
}

function testid(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

describe("/p/:projectId/:repo — 3a header", () => {
  it("renders the breadcrumb, the H1 and the List | Lanes control (Lanes disabled, unbuilt)", async () => {
    renderFeed();
    expect(await screen.findByTestId("repo-page")).toBeTruthy();
    expect(screen.getByTestId("repo-name").textContent).toBe("communication");
    expect(screen.getByTestId("repo-breadcrumb-repo").textContent).toBe("communication");
    const list = screen.getByTestId("repo-view-list");
    const lanes = screen.getByTestId("repo-view-lanes") as HTMLButtonElement;
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(lanes.disabled).toBe(true);
    expect(lanes.title).toBe("Lanes view arrives next");
  });

  it("keeps the server-error screen when the repositories read fails", async () => {
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
        {
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          status: 500,
          body: { type: "x", title: "Boom", status: 500, detail: "" },
        },
      ],
    });
    expect(await screen.findByTestId("repo-error-page")).toBeTruthy();
    expect(screen.getByTestId("repo-load-retry")).toBeTruthy();
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
});

describe("the activity feed", () => {
  it("mixes runs and chats, newest activity first", async () => {
    renderFeed();
    const waiting = await screen.findByTestId(`repo-run-${testid(waitingRun.id)}`);
    const chat = screen.getByTestId(`repo-chat-row-${testid(repoChat.id)}`);
    const done = screen.getByTestId(`repo-run-${testid(doneRun.id)}`);
    const order = Array.from(
      document.querySelectorAll("[data-testid^='repo-run-'], [data-testid^='repo-chat-row-']"),
    ).filter((element) => element.tagName === "A");
    const index = (element: Element) => order.indexOf(element);
    // The waiting run's last activity (09:01) beats the running one (08:30),
    // which beats the chat (08:00), which beats the finished run (21:00 the
    // night before).
    expect(index(waiting)).toBeGreaterThanOrEqual(0);
    const running = screen.getByTestId(`repo-run-${testid(runningRun.id)}`);
    expect(index(waiting)).toBeLessThan(index(running));
    expect(index(running)).toBeLessThan(index(chat));
    expect(index(chat)).toBeLessThan(index(done));
    // The waiting row wears the waiting pale body (handoff rule 06 pairs the
    // `!` glyph with its word for screen readers).
    expect(waiting.className).toContain("bg-st-waiting-pale-body");
    expect(screen.getByTestId(`repo-run-status-${testid(waitingRun.id)}`).textContent).toContain(
      "need you",
    );
    // The kinds are spelled: RUN for runs, CHAT for chats; the fourth cell
    // names the workflow (runs) or the agent profile (chats).
    expect(chat.textContent).toContain("CHAT");
    expect(chat.textContent).toContain("Search revamp spike");
    expect(chat.textContent).toContain(claudeProfile.name);
    expect(waiting.textContent).toContain("Feature development");
    // The project run list carries no per-step states, so no strip is drawn
    // for the running row — never invented segments.
    expect(running.querySelector("[role='img']")).toBeNull();
  });

  it("filters with the All · Runs · Chats · Mine chips", async () => {
    renderFeed();
    await screen.findByTestId(`repo-chat-row-${testid(repoChat.id)}`);
    fireEvent.click(screen.getByTestId("repo-filter-runs"));
    expect(screen.queryByTestId(`repo-chat-row-${testid(repoChat.id)}`)).toBeNull();
    expect(screen.getByTestId(`repo-run-${testid(waitingRun.id)}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId("repo-filter-chats"));
    expect(screen.queryByTestId(`repo-run-${testid(waitingRun.id)}`)).toBeNull();
    expect(screen.getByTestId(`repo-chat-row-${testid(repoChat.id)}`)).toBeTruthy();

    // Mine: only rows the caller started/created (the two live runs; the
    // chat belongs to someone else, the done run was a schedule start).
    fireEvent.click(screen.getByTestId("repo-filter-mine"));
    expect(screen.queryByTestId(`repo-chat-row-${testid(repoChat.id)}`)).toBeNull();
    expect(screen.getByTestId(`repo-run-${testid(waitingRun.id)}`)).toBeTruthy();
    expect(screen.queryByTestId(`repo-run-${testid(doneRun.id)}`)).toBeNull();
  });

  it("shows the empty state pointing at the chat box", async () => {
    renderFeed([
      { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        body: { items: [] },
      },
    ]);
    const empty = await screen.findByTestId("repo-activity-empty");
    expect(empty.textContent).toContain("No runs or chats in communication yet");
    expect(empty.textContent).toContain("chat box");
  });

  it("shows the error card with Retry when the reads fail", async () => {
    renderFeed([
      {
        path: `/api/v1/projects/${projectFixture.id}/runs`,
        status: 500,
        body: { type: "x", title: "Runs are down", status: 500, detail: "" },
      },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        status: 500,
        body: { type: "x", title: "Chats are down", status: 500, detail: "" },
      },
    ]);
    expect(await screen.findByTestId("repo-runs-retry")).toBeTruthy();
    expect(await screen.findByTestId("repo-activity-chats-retry")).toBeTruthy();
    expect(screen.queryByTestId(`repo-run-${testid(waitingRun.id)}`)).toBeNull();
  });
});

describe("the chat box", () => {
  it("disables Start while the box is empty, posts a repo-bound chat on Start and navigates", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    const { requests } = renderFeed([
      {
        method: "POST",
        path: `${projectPath}/conversations`,
        status: 201,
        body: createdConversation(),
      },
    ]);

    const input = await screen.findByTestId("repo-chat-input");
    const start = screen.getByTestId("repo-chat-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "fix the flaky checkout test" } });
    await waitFor(() => expect(start.disabled).toBe(false));
    // The chip names the default profile (the first one the wire offers).
    expect(screen.getByTestId("repo-chat-profile").textContent).toContain(claudeProfile.name);

    fireEvent.click(start);

    // The conversation is BORN BOUND to this repository (ADR-0067): the POST
    // carries `repository` (the name), the chosen profile and the typed text
    // as the first message, titled by its own first line.
    const posted = await waitFor(() => {
      const hits = requestsTo(requests, `${projectPath}/conversations`, "POST");
      expect(hits.length).toBeGreaterThan(0);
      return hits[0];
    });
    expect(JSON.parse(posted.body ?? "{}")).toEqual({
      title: "fix the flaky checkout test",
      agent_profile_id: claudeProfile.id,
      prompt: "fix the flaky checkout test",
      repository: repository.name,
    });
    // …and the page lands on the thread.
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/conversations/${createdConversation().id}`, "GET").length,
      ).toBeGreaterThan(0),
    );
  });

  it("shows the API error inline when the create is refused", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    renderFeed([
      {
        method: "POST",
        path: `${projectPath}/conversations`,
        status: 422,
        body: { type: "x", title: "Repository not found", status: 422, detail: "no such repo" },
      },
    ]);
    const input = await screen.findByTestId("repo-chat-input");
    fireEvent.change(input, { target: { value: "start something" } });
    const start = screen.getByTestId("repo-chat-start") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    const error = await screen.findByTestId("repo-chat-error");
    expect(error.textContent).toContain("Repository not found");
  });

  it("renders nothing of ASSISTANT NOTICED without a notes source", async () => {
    renderFeed();
    await screen.findByTestId("repo-page");
    expect(screen.queryByTestId("repo-assistant-notes")).toBeNull();
  });
});

describe("the side panel", () => {
  it("workflow rows show the trigger line and the latest result", async () => {
    renderFeed();
    const repoKey = testid(repoAssignment.id);
    const projectKey = testid(projectAssignment.id);
    const repoRow = await screen.findByTestId(`repo-workflow-row-${repoKey}`);
    expect(repoRow.textContent).toContain("Feature development");
    // The ADR-0056 issue trigger reads as the 3a sentence.
    expect(screen.getByTestId(`repo-workflow-triggers-${repoKey}`).textContent).toBe(
      "GitHub · issue labeled factory",
    );
    // The assignment's live runs count by state (glyph + word, never color
    // alone): waitingRun is waiting, runningRun is running.
    const repoResult = screen.getByTestId(`repo-workflow-result-${repoKey}`).textContent ?? "";
    expect(repoResult).toContain("1 running");
    expect(repoResult).toContain("1 needs you");

    const scheduleRow = await screen.findByTestId(`repo-workflow-row-${projectKey}`);
    expect(scheduleRow.textContent).toContain("Module check");
    expect(screen.getByTestId(`repo-workflow-triggers-${projectKey}`).textContent).toMatch(
      /^Schedule · /,
    );
    // No live runs on this assignment: the newest finished one reports itself.
    expect(screen.getByTestId(`repo-workflow-result-${projectKey}`).textContent).toMatch(
      /last .+ ago/,
    );
  });

  it("the Run button opens the run-start form and `+ add` the library picker", async () => {
    renderFeed();
    await screen.findByTestId(`repo-workflow-row-${testid(repoAssignment.id)}`);
    fireEvent.click(screen.getByTestId(`repo-workflow-run-${testid(repoAssignment.id)}`));
    expect(await screen.findByTestId("repo-run-form")).toBeTruthy();
    fireEvent.click(screen.getByTestId("repo-run-form-close"));
    expect(screen.queryByTestId("repo-run-form")).toBeNull();

    fireEvent.click(await screen.findByTestId("repo-workflow-library"));
    expect(await screen.findByTestId("repo-library-dialog")).toBeTruthy();
  });

  it("issues list with `Hand off` expanding today's inline run form", async () => {
    renderFeed();
    const row = await screen.findByTestId(`repo-issue-${issue.number}`);
    expect(row.textContent).toContain("#512 The build is red");
    const handOff = screen.getByTestId(`repo-issue-run-${issue.number}`);
    expect(handOff.textContent).toBe("Hand off");
    fireEvent.click(handOff);
    // The expansion is today's form (the workflow select over the repo's pins).
    expect(await screen.findByTestId(`repo-issue-runform-${issue.number}`)).toBeTruthy();
  });

  it("shows the honest reason for a non-GitHub remote and never asks the issues route", async () => {
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
    expect(line.textContent).toContain("Issue hand-offs need a GitHub repository");
    expect(screen.queryByTestId("repo-issues-list")).toBeNull();
    expect(
      requestsTo(
        requests,
        `/api/v1/projects/${projectFixture.id}/repos/${localRepositoryId}/issues`,
        "GET",
      ),
    ).toHaveLength(0);
  });

  it("names the private-repo case on a not-found with no credential, and opens the access picker", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    renderApp({
      path: `/p/${projectFixture.id}/communication`,
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: projectPath, body: projectFixture },
        { path: `${projectPath}/repos`, body: { items: [repository] } },
        { path: `${projectPath}/secrets`, body: { secrets: [] } },
        {
          path: `${projectPath}/repos/${repositoryId}/issues`,
          status: 502,
          body: {
            type: "https://communication.dev/errors/github_repository_not_found",
            title: "GitHub repository not found",
            status: 502,
            code: "github_repository_not_found",
            detail: "GitHub answered 404 for example/communication",
          },
        },
      ],
    });
    const line = await screen.findByTestId("repo-issues-private");
    expect(line.textContent).toBe("private repo? add GitHub access");
    fireEvent.click(screen.getByTestId("repo-issues-add-github-access"));
    expect(await screen.findByTestId("github-access-dialog")).toBeTruthy();
  });
});
