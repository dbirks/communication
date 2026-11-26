/**
 * Home, all projects (redesign R2): the greeting, the prompt box that
 * creates a conversation in the chosen project and lands on its chat, the
 * since-you-left rows with the routine fold, the needs-you and running
 * blocks, and the factory-health sentence. The two finding-12 guarantees
 * survive the rewrite: the server-version note says the same words when the
 * approvals read 404s, and nothing links to a retired address.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import Home, { greetingLine } from "./Home";
import {
  claudeProfile,
  conversationFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { CatchUpBrief, CatchUpListItem } from "../api/catchup";
import type { CrossProjectRunSummary } from "../api/home";
import type { Approval } from "../api/types";

const NOT_FOUND = {
  type: "https://communication.dev/errors/not-found",
  title: "Not found",
  status: 404,
  detail: "no such route on this build",
};

function Probe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname}</div>;
}

function renderHome(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        {children}
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(<Home />, { wrapper });
  return { requests };
}

/** Collapse the JSX's line-wrapping to the one-line sentence a reader sees. */
function oneLine(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

const itemFixture = (
  overrides: Partial<CatchUpListItem> & Pick<CatchUpListItem, "id" | "importance">,
): CatchUpListItem => ({
  project: { id: projectFixture.id, name: "Project One", color: "#6a4bc4" },
  shape: "pr",
  title: `Story ${overrides.id}`,
  summary: "One line about the work.",
  resolution: "merged",
  refs: {},
  updated: false,
  unseen_stops: 2,
  total_stops: 2,
  updated_at: "2026-10-14T16:00:00Z",
  created_at: "2026-10-14T15:00:00Z",
  ...overrides,
});

const briefFixture = (overrides: Partial<CatchUpBrief> = {}): CatchUpBrief => ({
  window: { key: "unseen", since: "2026-10-13T18:00:00Z", until: "2026-10-14T18:00:00Z" },
  headline: { state: "ready", text: "" },
  needs_you: [],
  running_now: [],
  shipped: [],
  broke: [],
  heads_up: [],
  changes: [],
  numbers: {
    runs: { succeeded: 0, failed: 0, cancelled: 0, running: 0 },
    approvals: { decided: 0, pending: 0 },
    threads_active: 0,
    prs: 0,
    commits: 0,
  },
  by_project: [],
  omitted: {},
  ...overrides,
});

const runFixture = (overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary => ({
  id: "01987a9a-4444-7000-8000-dddddddddddd",
  project_id: projectFixture.id,
  pipeline_id: "01987a9a-5555-7000-8000-eeeeeeeeeeee",
  pipeline_revision_id: "01987a9a-6666-7000-8000-ffffffffffff",
  revision_digest: "rev-digest",
  plan_digest: "plan-digest",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: "2026-10-14T17:42:00Z",
  project_name: "Project One",
  pipeline_slug: "wf-1",
  pipeline_display_name: "Workflow One",
  steps: [{ node_id: "implement", kind: "agent.acp", state: "running" }],
  ...overrides,
});

const approvalFixture: Approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  run_id: "01987a90-2222-7000-8000-bbbbbbbbbbbb",
  node_execution_id: "01987a90-3333-7000-8000-cccccccccccc",
  kind: "pipeline_gate",
  summary: "Approve the migration.",
  artifact_refs: [],
  approver_roles: ["maintainer"],
  approver_user_ids: ["01987a70-9999-7000-8000-000000000001"],
  deadline_at: "2026-10-15T18:00:00Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  version: 1,
  created_at: "2026-10-14T16:00:00Z",
};

const approvalRun = runFixture({
  id: approvalFixture.run_id,
  status: "waiting_human",
});

/** The reads the settled page needs, empty by default. */
const calmRoutes = (): RouteStub[] => [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: [projectFixture] } },
  { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
  { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
  { path: "/api/v1/runs", body: { runs: [] } },
  { path: "/api/v1/approvals", body: { approvals: [] } },
  {
    path: "/api/v1/catch-up/items",
    body: { items: [], total_unseen: 0, oldest_unseen_at: null },
  },
  { path: "/api/v1/catch-up/brief", body: briefFixture() },
  { path: "/api/v1/catch-up/visits", method: "POST", status: 204 },
];

/** The calm stubs with `extra` answering FIRST (the mock matches the first
 * stub whose path hits), so a test overrides a read instead of shadowing it. */
function homeRoutes(extra: RouteStub[] = []): RouteStub[] {
  const overridden = new Set(extra.map((stub) => `${stub.method ?? ""} ${stub.path}`));
  const base = calmRoutes().filter(
    (stub) =>
      !overridden.has(`${stub.method ?? ""} ${stub.path}`) && !overridden.has(` ${stub.path}`),
  );
  return [...extra, ...base];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("greetingLine", () => {
  it("greets the first name, and drops to the bare time word without one", () => {
    expect(greetingLine(new Date("2026-10-14T09:00:00"), "Ada Lovelace")).toBe(
      "Good morning, Ada. What are we working on?",
    );
    expect(greetingLine(new Date("2026-10-14T09:00:00"), null)).toBe(
      "Morning. What are we working on?",
    );
    expect(greetingLine(new Date("2026-10-14T14:00:00"), "")).toBe(
      "Afternoon. What are we working on?",
    );
    expect(greetingLine(new Date("2026-10-14T21:00:00"), undefined)).toBe(
      "Evening. What are we working on?",
    );
  });
});

describe("Home, all projects", () => {
  it("greets the reader and lays out the four blocks", async () => {
    renderHome(homeRoutes());
    expect(await screen.findByTestId("home-all")).toBeTruthy();
    const heading = screen.getByTestId("home-greeting");
    await waitFor(() => expect(heading.textContent).toContain("Ada. What are we working on?"));
    expect(await screen.findByTestId("home-prompt")).toBeTruthy();
    expect(await screen.findByTestId("since-you-left")).toBeTruthy();
    expect(screen.getByTestId("needs-you-empty").textContent).toBe("Nothing is waiting on you.");
    expect(screen.getByTestId("running-list-empty").textContent).toBe("Nothing is running.");
    expect(screen.getByTestId("factory-health-sentence").textContent).toBe("All quiet.");
  });

  it("leaves 48px above the greeting and 18px between it and the prompt box", async () => {
    renderHome(homeRoutes());
    const heading = await screen.findByTestId("home-greeting");
    // The page's own top padding is the space above the greeting, and the
    // prompt wrapper carries the gap below it (handoff README §2).
    expect(heading.parentElement?.parentElement?.className).toContain("pt-[48px]");
    const space = screen.getByTestId("home-prompt-space");
    expect(space.className).toContain("mt-[18px]");
    expect(space.querySelector("[data-testid='home-prompt']")).toBeTruthy();
    // The all-projects box asks for the new chat with the one sentence.
    expect(screen.getByTestId("home-prompt-input").getAttribute("placeholder")).toBe(
      "Ask, plan, or hand off a task…",
    );
  });

  it("prompt submit creates the conversation in the chosen project and navigates to its chat", async () => {
    const { requests } = renderHome(
      homeRoutes([
        {
          path: `/api/v1/projects/${projectFixture.id}/conversations`,
          method: "POST",
          body: conversationFixture,
        },
      ]),
    );
    fireEvent.change(await screen.findByTestId("home-prompt-input"), {
      target: { value: "Fix the flaky test" },
    });
    fireEvent.click(screen.getByTestId("home-prompt-agent"));
    fireEvent.click(await screen.findByTestId(`agent-option-${claudeProfile.id}`));
    fireEvent.click(screen.getByTestId("home-prompt-send"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/conversations`, "POST").length,
      ).toBe(1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe(
        `/p/${projectFixture.id}/chats/${conversationFixture.id}`,
      ),
    );
  });

  it("since-you-left rows link to their pages and '+ N routine updates' expands in place", async () => {
    renderHome(
      homeRoutes([
        {
          path: "/api/v1/catch-up/items",
          body: {
            items: [
              itemFixture({ id: "w-1", importance: "must_know", title: "Ship the rate limiter" }),
              itemFixture({ id: "w-2", importance: "routine" }),
            ],
            total_unseen: 2,
            oldest_unseen_at: null,
          },
        },
      ]),
    );
    const row = await screen.findByTestId("since-row-w-1");
    expect(row.getAttribute("href")).toBe("/catch-up/w-1");
    expect(oneLine(row)).toContain("Ship the rate limiter");
    expect(screen.queryByTestId("since-row-w-2")).toBeNull();
    fireEvent.click(screen.getByTestId("since-you-left-routine"));
    expect(await screen.findByTestId("since-row-w-2")).toBeTruthy();
  });

  it("needs-you shows one pale card per waiting gate", async () => {
    renderHome(
      homeRoutes([
        { path: "/api/v1/approvals", body: { approvals: [approvalFixture] } },
        { path: "/api/v1/runs", body: { runs: [approvalRun] } },
      ]),
    );
    const card = await screen.findByTestId(`needs-you-card-${approvalFixture.id}`);
    expect(card.getAttribute("href")).toBe(`/approvals/${approvalFixture.id}`);
    expect(oneLine(card)).toContain("! Approve the migration.");
    expect(oneLine(card)).toContain("Project One");
  });

  it("running lists the rows actually in flight", async () => {
    renderHome(homeRoutes([{ path: "/api/v1/runs", body: { runs: [runFixture()] } }]));
    const row = await screen.findByTestId("running-row-01987a9a-4444-7000-8000-dddddddddddd");
    expect(row.getAttribute("href")).toBe("/runs/01987a9a-4444-7000-8000-dddddddddddd");
    expect(oneLine(row)).toContain("● Workflow One");
    expect(oneLine(row)).toContain("implement");
  });

  it("factory health prints the brief's arithmetic as one sentence", async () => {
    renderHome(
      homeRoutes([
        {
          path: "/api/v1/catch-up/brief",
          body: briefFixture({
            numbers: {
              runs: { succeeded: 4, failed: 0, cancelled: 0, running: 2 },
              approvals: { decided: 1, pending: 1 },
              threads_active: 0,
              prs: 0,
              commits: 0,
            },
          }),
        },
      ]),
    );
    const sentence = await screen.findByTestId("factory-health-sentence");
    await waitFor(() =>
      expect(sentence.textContent).toBe(
        "2 running, 1 waiting on a person, 0 failed in the last day.",
      ),
    );
  });

  it("says the finding-12 note, word for word, when the approvals read 404s", async () => {
    renderHome(homeRoutes([{ path: "/api/v1/approvals", status: 404, body: NOT_FOUND }]));
    const note = await screen.findByTestId("home-not-available");
    expect(oneLine(note)).toBe(
      "Approvals from other projects can't load on this server version. The rest of Today is up to date. Ask an admin to update",
    );
    expect(oneLine(note)).not.toMatch(/cross-project|scaffold|404|endpoint|build|API/i);
    // Nothing links to a retired address.
    for (const retired of ["/inbox", "/board"]) {
      expect(
        Array.from(document.querySelectorAll("a")).some(
          (link) => link.getAttribute("href") === retired,
        ),
      ).toBe(false);
    }
  });
});
