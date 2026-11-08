/**
 * `/p/:projectId/:repo` — the repository page: the List view (design 3a —
 * the chat box, the mixed runs+chats activity feed, the side panel) and the
 * Lanes view (design 3b — the workflow chip row, four lanes, drag-an-issue-
 * into-Running), plus the honest GitHub refusals both share.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { PAGE_BAND_PAD } from "../components/ds/Page";
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
import type { Approval, Assignment, PipelineRevision, Repository, RunSummary } from "../api/types";
import type { IssueTrigger } from "../api/useIssueTriggers";
import type { Schedule } from "../api/pipelines";
import { buildLanes, issueChatSeed, type LaneEntry } from "../components/repo/RepoLanes";
import {
  WIRE_CHILD_PIPELINE_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
  wireRevision,
} from "../test/fixtures/m4/wire";

/**
 * The instant every clock-dependent test pretends it is running at: after the
 * newest fixture activity (2026-11-02T09:45Z) and before the future schedule
 * fire (2026-11-03T02:00Z), while every `finished_at`/`updated_at` the seven
 * day window is measured against is still inside that window.
 */
const LANES_NOW = "2026-11-02T12:00:00Z";

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
  // ADR-0070: the project run list row carries the bounded step progress —
  // the List row's strip and the Lanes card's strip both read this.
  progress: {
    steps: [
      { node_id: "plan", state: "done" },
      { node_id: "implement", state: "done" },
      { node_id: "review", state: "running" },
      { node_id: "pr", state: "open" },
      { node_id: "merge", state: "open" },
    ],
    more: 0,
  },
} as RunSummary;

/** A terminal row for the FINISHED lane (and the failed pale edge). */
const failedRun: RunSummary = {
  ...waitingRun,
  id: "01987c11-0003-7000-8000-abcdef012345",
  title: "Order notes field",
  status: "failed",
  failed_cause: "node_execution_failed:/review",
  assignment_id: projectAssignment.id,
  created_at: "2026-10-31T11:00:00Z",
  started_at: "2026-10-31T11:01:00Z",
  finished_at: "2026-11-01T07:00:00Z",
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

/** A chat whose session dropped with a turn open — the NEEDS YOU arm. */
const stalledChat: ConversationSummary = {
  ...repoChat,
  id: "01987c33-0001-7000-8000-abcdef012345",
  title: "Session dropped mid-review",
  status: "disconnected",
  updated_at: "2026-11-01T09:30:00Z",
};

/** An archived chat — the FINISHED arm. */
const endedChat: ConversationSummary = {
  ...repoChat,
  id: "01987c33-0002-7000-8000-abcdef012345",
  title: "Why is CI flaky?",
  status: "archived",
  updated_at: "2026-11-01T06:00:00Z",
};

/**
 * An `idle` chat — history, no session attached (09). rcn-3b review item 1:
 * this row used to file under FINISHED · 7 DAYS while the List row beside it
 * said `pending` and the thread pane said LIVE. It is an open chat, so it is
 * a RUNNING card.
 */
const parkedChat: ConversationSummary = {
  ...repoChat,
  id: "01987c33-0003-7000-8000-abcdef012345",
  title: "Cursor pagination question",
  status: "idle",
  updated_at: "2026-11-01T09:45:00Z",
};

/** The pending gate of the waiting run — the lanes' `Approve` is a link
 * onto this observed gate's route, never an invented one. */
const pendingGate: Approval = {
  id: "01987c44-0000-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  run_id: waitingRun.id,
  node_execution_id: "01987c44-0001-7000-8000-abcdef012345",
  node_instance_key: "plan",
  kind: "pipeline_gate",
  summary: "Approve plan",
  artifact_refs: [],
  approver_roles: ["maintainer"],
  approver_user_ids: [],
  deadline_at: "2026-11-02T18:00:00Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  version: 1,
  created_at: "2026-11-01T09:01:00Z",
};

/** The repo pin's revision, ADR-0066: a required `github_issue` input and
 * an optional branch with a default — a drag can start it directly. */
const issueAcceptingRevision: PipelineRevision = {
  ...wireRevision,
  input_specs: [
    { name: "base", type: "branch", required: false, default: "main" },
    { name: "issue", type: "github_issue", required: true },
  ],
};

/** Same, but a SECOND required input with no default — the drop must hand
 * over to the run-by-hand form, not post a doomed run.
 */
const needsFormRevision: PipelineRevision = {
  ...issueAcceptingRevision,
  input_specs: [
    ...issueAcceptingRevision.input_specs!,
    { name: "goal", type: "text", required: true },
  ],
};

/** The whole-project pin rides its OWN pinned revision — the one that
 * declares no inputs, so the start menu must not list it. */
const plainAssignment: Assignment = {
  ...projectAssignment,
  pinned_revision_id: "01987b21-7777-7000-8000-abcdef012345",
  pinned_revision_digest: `sha256:${"9d9d".repeat(32)}`,
};

function dataTransferStub(): {
  data: Record<string, string>;
  effectAllowed: string;
  dropEffect: string;
  setData: (kind: string, value: string) => void;
  getData: (kind: string) => string;
} {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: "none",
    dropEffect: "none",
    setData: (kind, value) => {
      data[kind] = value;
    },
    getData: (kind) => data[kind] ?? "",
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

/** The same page with the Lanes fixtures: a pending gate for the waiting
 * run, the repo pin's revision declaring a `github_issue` input (ADR-0066),
 * a second pin whose revision declares none, the stalled and ended chats,
 * and the two POSTs the drop can make. `overrides` win over all of it. */
function lanesRoutes(overrides: RouteStub[] = []): RouteStub[] {
  const projectPath = `/api/v1/projects/${projectFixture.id}`;
  return feedRoutes([
    ...overrides,
    {
      path: `${projectPath}/assignments`,
      body: { assignments: [repoAssignment, plainAssignment] },
    },
    { path: `${projectPath}/approvals`, body: { approvals: [pendingGate] } },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: issueAcceptingRevision },
    { path: `/api/v1/revisions/${plainAssignment.pinned_revision_id}`, body: wireRevision },
    {
      method: "GET",
      path: `${projectPath}/conversations`,
      body: { items: [repoChat, parkedChat, stalledChat, endedChat] },
    },
    {
      method: "POST",
      path: `${projectPath}/conversations`,
      status: 201,
      body: createdConversation(),
    },
    {
      method: "POST",
      path: `${projectPath}/runs`,
      status: 201,
      body: { run_id: "01987c99-0000-7000-8000-abcdef012345", status: "queued" },
    },
    { path: `${projectPath}/runs`, body: { runs: [waitingRun, runningRun, doneRun, failedRun] } },
  ]);
}

function renderLanes(overrides: RouteStub[] = []) {
  return renderApp({
    path: `/p/${projectFixture.id}/communication`,
    routes: lanesRoutes(overrides),
  });
}

/** Open the Lanes view (the choice is a session pref; the toggle stands). */
async function openLanes(): Promise<HTMLElement> {
  await screen.findByTestId("repo-page");
  fireEvent.click(screen.getByTestId("repo-view-lanes"));
  return screen.findByTestId("repo-lanes");
}

const laneIds = (entries: LaneEntry[]): string[] =>
  entries.map((entry) => (entry.kind === "run" ? entry.run.id : entry.conversation.id));

function testid(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

describe("/p/:projectId/:repo — 3a header", () => {
  it("stands its own band at the shared page inset (no edge-to-edge header)", async () => {
    renderFeed();
    const root = await screen.findByTestId("repo-page");
    expect(root.getAttribute("data-page-layout")).toBe("wide");
    // Finding 07 converted this page to `ds/Page` with no `title` (it draws its
    // own band), and acceptance 42452527578 caught the loss: the shell stopped
    // padding the column, so the breadcrumb, the H1 and both lists sat flush on
    // the sidebar edge (x=220 at 1280) and the top edge (y=0) while every other
    // page's title sits at 248. The inset is the shared constant.
    const body = (screen.getByTestId("repo-page-body").parentElement ??
      new HTMLElement()) as HTMLElement;
    for (const cls of [...PAGE_BAND_PAD.split(/\s+/), "pb-[28px]"]) {
      expect(body.className).toContain(cls);
    }
    // The band (breadcrumb + H1 + composer row) lives inside that padded column,
    // so its title's left edge IS the band inset.
    expect(body.contains(screen.getByTestId("repo-header"))).toBe(true);
  });

  it("renders the breadcrumb, the H1 and the List | Lanes control (both arms built)", async () => {
    renderFeed();
    expect(await screen.findByTestId("repo-page")).toBeTruthy();
    expect(screen.getByTestId("repo-name").textContent).toBe("communication");
    expect(screen.getByTestId("repo-breadcrumb-repo").textContent).toBe("communication");
    const list = screen.getByTestId("repo-view-list");
    const lanes = screen.getByTestId("repo-view-lanes") as HTMLButtonElement;
    expect(list.getAttribute("aria-pressed")).toBe("true");
    // Lanes is built (3b): the segment is enabled and switches the page.
    expect(lanes.disabled).toBe(false);
    fireEvent.click(lanes);
    expect(await screen.findByTestId("repo-lanes")).toBeTruthy();
    expect(screen.getByTestId("repo-view-lanes").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("repo-activity")).toBeNull();
    // …and back to List.
    fireEvent.click(screen.getByTestId("repo-view-list"));
    expect(await screen.findByTestId("repo-activity")).toBeTruthy();
    expect(screen.queryByTestId("repo-lanes")).toBeNull();
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
    // Finding 07: the failed read is still a `<Page>` — the page root
    // declares the layout and the SHARED band owns the one H1, so the band
    // inset is not lost on the failure screen.
    expect(screen.getByTestId("repo-error-page").getAttribute("data-page-layout")).toBe("wide");
    const band = screen.getByTestId("page-band");
    expect(band.querySelector("h1")?.textContent).toBe("Repository");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // Issue #24's rule survives the frame change: the breadcrumb still names
    // the project the failed repository belongs to.
    expect(screen.getByTestId("repo-breadcrumb").textContent).toBe(projectFixture.name);
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
    // Finding 07: the refusal stands inside the page frame — the band's H1
    // names what was missing (the emulator asserts the same heading), the
    // root declares its layout, and the page never carries two H1s.
    expect(screen.getByTestId("repo-page").getAttribute("data-page-layout")).toBe("wide");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Repository not found");
    expect(screen.getByTestId("page-band").contains(heading)).toBe(true);
    // The way back is still the project's own name, as button and trail.
    expect(screen.getByTestId("repo-back-to-project").textContent).toMatch(/^← /);
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
    // The kinds are spelled: RUN for runs, THREAD for threads; the fourth cell
    // names the workflow (runs) or the agent profile (chats).
    expect(chat.textContent).toContain("THREAD");
    expect(chat.textContent).toContain("Search revamp spike");
    expect(chat.textContent).toContain(claudeProfile.name);
    expect(waiting.textContent).toContain("Feature development");
    // ADR-0070: the project run list row carries `progress`, so the running
    // row draws the strip from the served steps — and only from those (the
    // rows whose data carries none, like the waiting one, carry no strip).
    const strip = running.querySelector("[role='img']");
    expect(strip).toBeTruthy();
    expect(strip?.getAttribute("aria-label")).toBe("2 done, 1 running, 2 open");
    expect(waiting.querySelector("[role='img']")).toBeNull();
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

  it("shows the empty state pointing at the thread box", async () => {
    renderFeed([
      { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        body: { items: [] },
      },
    ]);
    const empty = await screen.findByTestId("repo-activity-empty");
    expect(empty.textContent).toContain("No runs or threads in communication yet");
    expect(empty.textContent).toContain("thread box");
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

  it("shows the ASSISTANT NOTICED heading with its honest empty state when no notes source is served", async () => {
    renderFeed();
    await screen.findByTestId("repo-page");
    // rcn-review13 item 3: the section never vanishes — the heading stands
    // with one muted line, never a placeholder note.
    expect(screen.getByTestId("repo-assistant-notes-empty").textContent).toContain(
      "Nothing noticed yet",
    );
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

  /** 1k acceptance review: a row's `Run` opens ONE modal (no outer `Start a
   * run` shell around the typed form) that CARRIES THE REPOSITORY — the
   * subtitle names this repo, never "whole project", and a declared
   * repository input arrives prefilled and read-only. */
  it("the row's Run opens ONE typed form that carries this repository (1k)", async () => {
    renderFeed([
      {
        path: `/api/v1/revisions/${WIRE_REVISION_ID}`,
        body: {
          ...wireRevision,
          revision_number: 1,
          input_specs: [
            { name: "goal", type: "text", required: true },
            { name: "repository", type: "text", required: true },
          ],
        },
      },
    ]);
    await screen.findByTestId(`repo-workflow-row-${testid(repoAssignment.id)}`);
    fireEvent.click(screen.getByTestId(`repo-workflow-run-${testid(repoAssignment.id)}`));
    expect(await screen.findByTestId("run-form-dialog")).toBeTruthy();
    expect(screen.queryByTestId("repo-run-form")).toBeNull();
    // One esc, one chrome: the dialog's own. The title is the workflow's.
    expect(screen.queryAllByText("Start a run")).toHaveLength(0);
    // The repo pin's name, not "whole project".
    expect(screen.getByTestId("run-form-subtitle").textContent).toBe("communication · pinned r1");
    // The repository field arrives filled and locked; the person does not
    // retype what the row already knows.
    const repoField = screen.getByTestId("new-run-input-repository") as HTMLInputElement;
    expect(repoField.value).toBe("communication");
    expect(repoField.readOnly).toBe(true);
  });

  /** A WHOLE-PROJECT pin row still carries the repository the page is about
   * (the 1k review: opened from the web repo, the form says so). */
  it("the whole-project row's Run still carries this repository (1k)", async () => {
    renderFeed([
      {
        path: `/api/v1/revisions/${WIRE_REVISION_ID}`,
        body: {
          ...wireRevision,
          revision_number: 1,
          input_specs: [
            { name: "goal", type: "text", required: true },
            { name: "repository", type: "text", required: true },
          ],
        },
      },
    ]);
    await screen.findByTestId(`repo-workflow-row-${testid(projectAssignment.id)}`);
    fireEvent.click(screen.getByTestId(`repo-workflow-run-${testid(projectAssignment.id)}`));
    expect(await screen.findByTestId("run-form-dialog")).toBeTruthy();
    expect(screen.getByTestId("run-form-subtitle").textContent).toBe("communication · pinned r1");
    const repoField = screen.getByTestId("new-run-input-repository") as HTMLInputElement;
    expect(repoField.value).toBe("communication");
    expect(repoField.readOnly).toBe(true);
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

describe("/p/:projectId/:repo — 3b Lanes", () => {
  // The FINISHED lane is "the last 7 days" counted against the clock the page
  // reads (`buildLanes(…, now = Date.now())`), and every fixture above is a
  // fixed calendar date — so the clock is pinned here (the same instant the
  // pure `buildLanes` test below uses) instead of being a time bomb that
  // drops `Nightly deps` out of the window as real days pass. Only `Date` is
  // faked: react-query, promises and `findBy*` keep the real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(LANES_NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets the runs and chats into the four lanes", async () => {
    renderLanes();
    await openLanes();

    // The WORKFLOWS chip row: name · trigger, the same words the panel uses.
    const chips = screen.getByTestId("repo-lane-workflows");
    expect(chips.textContent).toContain("Feature development");
    expect(chips.textContent).toContain("Module check");
    expect(
      screen.getByTestId(`repo-lane-workflow-trigger-${testid(repoAssignment.id)}`).textContent,
    ).toBe("GitHub · issue labeled factory");

    // ISSUES: the draggable cards, `#num` + title, with the keyboard path.
    const issuesLane = screen.getByTestId("repo-lane-issues");
    expect(issuesLane.textContent).toContain("#512");
    expect(issuesLane.textContent).toContain("The build is red");
    expect(screen.getByTestId(`repo-lane-issue-start-${issue.number}`)).toBeTruthy();

    // NEEDS YOU: the waiting run with its observed gate — Approve is the
    // gate route, Open the run — and the disconnected chat.
    const needsYou = screen.getByTestId("repo-lane-needs-you");
    expect(needsYou.textContent).toContain("Checkout rounds tax wrong");
    expect(needsYou.textContent).toContain("Approve plan");
    const approve = screen.getByTestId(`repo-lane-approve-${testid(waitingRun.id)}`);
    expect(approve.getAttribute("href")).toBe(`/approvals/${pendingGate.id}`);
    expect(
      screen.getByTestId(`repo-lane-runbutton-${testid(waitingRun.id)}`).getAttribute("href"),
    ).toBe(`/runs/${waitingRun.id}`);
    expect(needsYou.textContent).toContain("Session dropped mid-review");
    expect(screen.getByTestId(`repo-lane-run-${testid(waitingRun.id)}`).className).toContain(
      "border-st-waiting-pale-edge",
    );

    // RUNNING: the running run with its ADR-0070 strip, plus the live chat.
    const running = screen.getByTestId("repo-lane-running");
    const runningCard = screen.getByTestId(`repo-lane-run-${testid(runningRun.id)}`);
    expect(runningCard.textContent).toContain("Add Apple Pay");
    expect(runningCard.querySelector("[role='img']")).toBeTruthy();
    expect(running.textContent).toContain("Search revamp spike");
    expect(screen.getByTestId(`repo-lane-chat-${testid(repoChat.id)}`)).toBeTruthy();

    // rcn-6 review 1: an `idle` chat (open, no turn queued) reads as `idle`,
    // never `pending` — it lives in RUNNING, and it is not counted among the
    // finished week.
    const parkedCard = screen.getByTestId(`repo-lane-chat-${testid(parkedChat.id)}`);
    expect(running.contains(parkedCard)).toBe(true);
    expect(parkedCard.textContent).toContain("Cursor pagination question");
    expect(parkedCard.textContent).toContain("idle");
    expect(parkedCard.textContent).not.toContain("pending");

    // Glyph AND word on every card (states.ts, handoff rule 06) — the glyph
    // alone is colour-only signalling, and the FINISHED header carries no
    // glyph at all without one.
    expect(screen.getByTestId(`repo-lane-chat-${testid(repoChat.id)}`).textContent).toContain(
      "running",
    );
    expect(screen.getByTestId(`repo-lane-chat-${testid(stalledChat.id)}`).textContent).toContain(
      "stopped",
    );
    expect(screen.getByTestId(`repo-lane-chat-${testid(endedChat.id)}`).textContent).toContain(
      "noted",
    );
    expect(screen.getByTestId("repo-lane-finished").textContent).toContain("✓");
    expect(runningCard.textContent).toContain("running");
    expect(screen.getByTestId(`repo-lane-run-${testid(waitingRun.id)}`).textContent).toContain(
      "need you",
    );

    // FINISHED · 7 DAYS: the done run, the failed run on the failed pale
    // edge, and the ended chat.
    const finished = screen.getByTestId("repo-lane-finished");
    expect(finished.textContent).toContain("Nightly deps");
    expect(finished.textContent).toContain("Why is CI flaky?");
    // The `idle` chat is not part of the finished week (rcn-3b review 1).
    expect(
      finished.querySelector(`[data-testid='repo-lane-chat-${testid(parkedChat.id)}']`),
    ).toBeNull();
    expect(screen.getByTestId(`repo-lane-run-${testid(failedRun.id)}`).className).toContain(
      "border-st-failed-pale-edge",
    );
    // The waiting run is nowhere else, the live chat nowhere else either.
    expect(running.querySelector(`[data-testid='repo-lane-run-${testid(waitingRun.id)}']`));
    expect(
      screen
        .getByTestId("repo-lane-needs-you")
        .querySelector(`[data-testid='repo-lane-run-${testid(runningRun.id)}']`),
    ).toBeNull();
  });

  it("drags an issue into Running: the lane lights, the drop opens the start menu", async () => {
    renderLanes();
    await openLanes();

    const card = await screen.findByTestId(`repo-lane-issue-${issue.number}`);
    fireEvent.dragStart(card, { dataTransfer: dataTransferStub() });
    const lane = screen.getByTestId("repo-lane-running");
    fireEvent.dragOver(lane);
    // Dashed accent border over an accent-tint fill, and the caught preview.
    expect(lane.className).toContain("outline-dashed");
    expect(lane.className).toContain("outline-accent");
    expect(lane.className).toContain("bg-accent-tint");
    const preview = screen.getByTestId("repo-lane-drop-preview");
    expect(preview.textContent).toContain("#512 · dragging");
    expect(preview.textContent).toContain("The build is red");

    fireEvent.drop(lane);
    const menu = await screen.findByTestId("repo-start-issue-menu");
    // The caption rides ds/Menu's mono caps (CSS uppercase on the DOM text).
    expect(menu.textContent?.toUpperCase()).toContain("START #512 WITH");
    // Only the workflow whose pinned revision declares a github_issue input
    // is offered; the input-less pin stays out of the menu.
    const startable = await screen.findByTestId(
      `repo-start-issue-workflow-${testid(repoAssignment.id)}`,
    );
    expect(startable.textContent).toContain("Feature development");
    expect(menu.textContent).not.toContain("Module check");
    expect(screen.getByTestId("repo-start-issue-chat").textContent).toContain(
      "Ask in a thread instead",
    );
    // The caught card is the menu's anchor (3b's dropped card).
    expect(screen.getByTestId("repo-lane-drop-card").textContent).toContain("#512");

    // Esc closes the menu and the drop card with it.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("repo-start-issue-menu")).toBeNull());
    expect(screen.queryByTestId("repo-lane-drop-card")).toBeNull();
  });

  it("starting from the menu posts the run with the ADR-0066 issue object", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    const { requests } = renderLanes();
    await openLanes();
    fireEvent.dragStart(screen.getByTestId(`repo-lane-issue-${issue.number}`), {
      dataTransfer: dataTransferStub(),
    });
    fireEvent.drop(screen.getByTestId("repo-lane-running"));
    const item = await screen.findByTestId(
      `repo-start-issue-workflow-${testid(repoAssignment.id)}`,
    );
    fireEvent.click(item);

    const posted = await waitFor(() => {
      const hits = requestsTo(requests, `${projectPath}/runs`, "POST");
      expect(hits.length).toBeGreaterThan(0);
      return hits[0];
    });
    const body = JSON.parse(posted.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      assignment_id: repoAssignment.id,
      inputs: {
        issue: {
          number: 512,
          title: "The build is red",
          body: "CI is failing on main.",
          url: "https://github.com/example/communication/issues/512",
          repo: "example/communication",
        },
      },
      title: "The build is red",
      issue: { number: 512 },
      idempotency: expect.stringMatching(/^lanedrop-/),
    });
    // The same key rides the header (ADR-023 § 12: a replay is one run).
    expect(posted.headers.get("Idempotency-Key")).toBe(body.idempotency);
    // …and the page lands on the new run.
    await waitFor(() => expect(screen.queryByTestId("repo-lane-running")).toBeNull());
  });

  it("a workflow with other required inputs opens the run-by-hand form instead", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    const { requests } = renderLanes([
      { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: needsFormRevision },
    ]);
    await openLanes();
    fireEvent.dragStart(screen.getByTestId(`repo-lane-issue-${issue.number}`), {
      dataTransfer: dataTransferStub(),
    });
    fireEvent.drop(screen.getByTestId("repo-lane-running"));
    fireEvent.click(
      await screen.findByTestId(`repo-start-issue-workflow-${testid(repoAssignment.id)}`),
    );
    // `goal` is required and no default covers it: 1k takes over — opened
    // with the issue prefilled — and no run is posted here. ONE modal (1k
    // review): the typed form's own dialog, not the outer `Start a run`
    // shell wrapping it, and it carries the repository it was opened from.
    expect(await screen.findByTestId("run-form-dialog")).toBeTruthy();
    expect(screen.queryByTestId("repo-run-form")).toBeNull();
    expect(screen.getByTestId("run-form-subtitle").textContent).toContain(repository.name);
    expect(
      requestsTo(requests, `${projectPath}/runs`, "POST").filter((request) =>
        (request.body ?? "").includes('"issue"'),
      ),
    ).toHaveLength(0);
  });

  it("the keyboard `Start…` opens the same menu, and `Ask in a thread instead` seeds a repo chat", async () => {
    const projectPath = `/api/v1/projects/${projectFixture.id}`;
    const { requests } = renderLanes();
    await openLanes();

    fireEvent.click(screen.getByTestId(`repo-lane-issue-start-${issue.number}`));
    const menu = await screen.findByTestId("repo-start-issue-menu");
    expect(menu.textContent?.toUpperCase()).toContain("START #512 WITH");
    await screen.findByTestId(`repo-start-issue-workflow-${testid(repoAssignment.id)}`);

    fireEvent.click(screen.getByTestId("repo-start-issue-chat"));
    const posted = await waitFor(() => {
      const hits = requestsTo(requests, `${projectPath}/conversations`, "POST");
      expect(hits.length).toBeGreaterThan(0);
      return hits[0];
    });
    // Born bound to the repository (ADR-0067), seeded with the issue's own
    // words — the heading line and the body, never a paraphrase.
    expect(JSON.parse(posted.body ?? "{}")).toEqual({
      title: "#512 The build is red",
      agent_profile_id: claudeProfile.id,
      prompt: "#512 The build is red\n\nCI is failing on main.",
      repository: repository.name,
    });
    await waitFor(() => expect(screen.queryByTestId("repo-lane-running")).toBeNull());
  });

  it("New thread opens today's thread box in a modal", async () => {
    renderLanes();
    await openLanes();
    fireEvent.click(screen.getByTestId("repo-new-chat"));
    expect(await screen.findByTestId("repo-new-chat-dialog")).toBeTruthy();
    expect(screen.getByTestId("repo-chat-input")).toBeTruthy();
    fireEvent.click(screen.getByTestId("repo-new-chat-close"));
    expect(screen.queryByTestId("repo-new-chat-dialog")).toBeNull();
  });

  it("says so when a lane has nothing", async () => {
    renderLanes([
      { path: `/api/v1/projects/${projectFixture.id}/runs`, body: { runs: [] } },
      {
        method: "GET",
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        body: { items: [] },
      },
      {
        path: `/api/v1/projects/${projectFixture.id}/repos/${repositoryId}/issues`,
        body: { repository: "example/communication", state: "open", items: [] },
      },
    ]);
    await openLanes();
    expect(screen.getByTestId("repo-lane-issues-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-lane-needs-you-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-lane-running-empty")).toBeTruthy();
    expect(screen.getByTestId("repo-lane-finished-empty")).toBeTruthy();
  });

  it("keeps bucketing the chats when the runs read fails, and offers retry", async () => {
    renderLanes([
      {
        path: `/api/v1/projects/${projectFixture.id}/runs`,
        status: 500,
        body: { type: "x", title: "Runs are down", status: 500, detail: "" },
      },
    ]);
    await openLanes();
    expect(await screen.findByTestId("repo-lanes-runs-retry")).toBeTruthy();
    // The chats the read still answers are bucketed despite the failed runs.
    expect(screen.getByTestId(`repo-lane-chat-${testid(repoChat.id)}`)).toBeTruthy();
  });
});

describe("buildLanes (3b bucketing, fixed clock)", () => {
  it("puts each status in its lane and keeps the seven-day window honest", () => {
    const now = Date.parse(LANES_NOW);
    const stale = {
      ...doneRun,
      id: "01987c11-0004-7000-8000-abcdef012345",
      finished_at: "2026-10-01T10:00:00Z",
    };
    const lanes = buildLanes(
      [waitingRun, runningRun, doneRun, failedRun, stale],
      [repoChat, parkedChat, stalledChat, endedChat],
      now,
    );
    // Newest activity first inside each lane: the parked chat (09:45) and the
    // stalled chat (09:30) beat the waiting run (09:01); the failed run
    // (Nov 1, 07:00) leads FINISHED, then the ended chat (06:00), then last
    // night's done run.
    expect(laneIds(lanes.needsYou)).toEqual([stalledChat.id, waitingRun.id]);
    // `idle` is an OPEN chat, not a finished one (rcn-3b review item 1): the
    // live-chat lane carries both the attached (`active`) and the unattached
    // (`idle`) row, and FINISHED keeps only what the wire calls archived.
    expect(laneIds(lanes.running)).toEqual([parkedChat.id, runningRun.id, repoChat.id]);
    // The run finished 2026-10-01 is outside the FINISHED · 7 DAYS window
    // the header names — it lives on the project's run list, not here.
    expect(laneIds(lanes.finished)).toEqual([failedRun.id, endedChat.id, doneRun.id]);
  });

  it("seeds the chat with the issue's own heading and body", () => {
    expect(issueChatSeed(issue)).toBe("#512 The build is red\n\nCI is failing on main.");
    expect(issueChatSeed({ ...issue, body: "  " })).toBe("#512 The build is red");
  });
});
