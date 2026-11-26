/**
 * HappeningNow against the fake wire: the empty sentence, a live run card (the
 * run's own step, the Factory's blue), and an open chat card (the agent's own
 * last line, or no line at all when the wire has none).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { HAPPENING_NOW_MAX, HappeningNow, happeningRunStep } from "./HappeningNow";
import { conversationFixture, mockFetch, projectFixture, type RouteStub } from "../../test/fakes";
import type { CrossProjectRun } from "../board/columns";
import { shortId } from "../../lib/format";

const projectId = projectFixture.id;

function run(overrides: Partial<CrossProjectRun> = {}): CrossProjectRun {
  return {
    id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
    project_id: projectId,
    pipeline_id: "01987b20-0000-7000-8000-abcdef012345",
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

function harness(routes: RouteStub[]) {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { wrapper };
}

const emptyRoutes = (runs: CrossProjectRun[]): RouteStub[] => [
  { path: "/api/v1/runs", body: { runs, next_cursor: null } },
  {
    path: `/api/v1/projects/${projectId}/conversations`,
    body: {
      items: [
        {
          id: "01987b30-0000-7000-8000-0000000000a1",
          project_id: projectId,
          agent_profile_id: "01987a70-0000-7000-8000-000000000001",
          title: "Quiet thread",
          status: "idle",
          created_by: "01987a61-2345-7000-8000-abcdef012345",
          created_at: "2026-11-20T10:00:00Z",
          updated_at: "2026-11-20T10:05:00Z",
          control: conversationFixture.control,
          has_active_turn: false,
          origin: "manual",
          run_link: null,
        },
      ],
    },
  },
];

afterEach(cleanup);

describe("HappeningNow", () => {
  it("says the one true sentence when nothing is live", async () => {
    const { wrapper } = harness(emptyRoutes([]));
    render(<HappeningNow projectId={projectId} />, { wrapper });

    await screen.findByText("Nothing is happening right now.");
    expect(screen.getByTestId("happening-now-empty").textContent).toBe(
      "Nothing is happening right now.",
    );
    expect(screen.queryAllByTestId(/^happening-run-/).length).toBe(0);
  });

  it("renders a run card with the run's own current step and the link to the run", async () => {
    const live = run();
    const { wrapper } = harness(emptyRoutes([live]));
    render(<HappeningNow projectId={projectId} />, { wrapper });

    const card = await screen.findByTestId(`happening-run-${shortId(live.id)}`);
    expect(card.getAttribute("href")).toBe("/runs/01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c");
    expect(card.textContent).toContain("running");
    expect(card.textContent).toContain("Workflow One");
    expect(card.textContent).toContain("on implement");
    expect(happeningRunStep(run({ steps: [] }))).toBeNull();
  });

  it("shows an open chat only with the agent's own last line, and caps the row", async () => {
    const open = (n: number, extra: Record<string, unknown> = {}) => ({
      ...conversationFixture,
      id: `01987b30-0000-7000-8000-0000000000b${n}`,
      title: `Thread ${n}`,
      status: "active" as const,
      has_active_turn: true,
      ...extra,
    });
    const items = [
      open(1, { last_agent_line: "- adding the docstring" }),
      open(2),
      open(3),
      open(4),
    ];
    const { wrapper } = harness([
      { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
      { path: `/api/v1/projects/${projectId}/conversations`, body: { items } },
    ]);
    render(<HappeningNow projectId={projectId} />, { wrapper });

    await screen.findByTestId(`happening-chat-${shortId(items[0].id)}`);
    const cards = screen.getAllByTestId(/^happening-chat-/);
    expect(cards.length).toBe(HAPPENING_NOW_MAX);
    // The bullet markdown is stripped and the row shows the agent's own words.
    const first = screen.getByTestId(`happening-chat-${shortId(items[0].id)}`);
    expect(first.textContent).toContain("adding the docstring");
    // A chat whose wire serves no last line prints none rather than one.
    const second = screen.getByTestId(`happening-chat-${shortId(items[1].id)}`);
    expect(second.textContent).toContain("Thread 2");
    // No last line on the wire means no last line on the card — not a dash.
    expect(second.textContent).not.toContain("—");
  });
});
