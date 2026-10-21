/**
 * The board ↔ drawer wiring (artboard 3c): a card click puts `?run=<id>` on
 * the board URL and the 440px run drawer renders over the board; the drawer
 * closes (and unmounts) when `?run` is removed. The drawer's own reads are
 * mocked — its behaviour is covered by RunDrawer.test.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Board from "./Board";
import type { CrossProjectRun } from "../components/board/columns";

vi.mock("../api/board", () => ({
  useBoardRuns: () => ({ data: { runs: [ROW] }, isPending: false, error: null }),
  useBoardLiveUpdates: () => undefined,
}));
vi.mock("../api/queries", () => ({
  useProjects: () => ({ data: { items: [] }, isPending: false, error: null }),
}));
vi.mock("../api/runs", () => ({
  useRun: () => ({ data: null, isPending: false, error: null }),
  useRunNodes: () => ({ data: null, isPending: false, error: null }),
  useRetryRun: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../api/approvals", () => ({
  useProjectApprovals: () => ({ data: null, isPending: false, error: null }),
  useDecideApproval: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../api/runEvents", () => ({
  useRunEvents: () => ({ events: [], status: "reconnecting" }),
}));
vi.mock("../api/pipelines", () => ({
  useCreateDraft: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../api/assistant", () => ({
  useAssistantAsk: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  assistantNotConfigured: (error: unknown) =>
    error instanceof Error && error.message === "not configured",
}));

const RUN_ID = "9c1eaaaa-bbbb-cccc-dddd-eeeeeeee0000";

const ROW: CrossProjectRun = {
  id: RUN_ID,
  project_id: "p-1",
  pipeline_id: "pip-1",
  pipeline_revision_id: "rev-1",
  revision_digest: "d",
  plan_digest: "d",
  status: "running",
  depth: 0,
  priority: 0,
  created_at: new Date(2026, 5, 18, 12, 0, 0).toISOString(),
  started_at: new Date(2026, 5, 18, 12, 0, 0).toISOString(),
  finished_at: null,
  project_name: "acme-api",
  pipeline_slug: "process-ready-issues",
  pipeline_display_name: "process-ready-issues",
  steps: [
    { node_id: "plan", kind: "agent.acp", state: "succeeded" },
    { node_id: "implement", kind: "agent.acp", state: "running" },
    { node_id: "test", kind: "agent.acp", state: "pending" },
    { node_id: "publish", kind: "agent.acp", state: "pending" },
  ],
};

afterEach(cleanup);

function renderBoard(initial = "/board") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Board />
    </MemoryRouter>,
  );
}

describe("Board run-drawer wiring", () => {
  it("a card click opens the drawer for that run", () => {
    renderBoard();
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    fireEvent.click(screen.getByTestId(`board-card-open-${RUN_ID}`));
    expect(screen.getByTestId("run-drawer")).toBeTruthy();
    expect(screen.getByTestId("run-drawer-title").textContent).toContain("process-ready-issues");
  });

  it("`?run=<id>` in the URL opens the drawer directly (a board deep link)", () => {
    renderBoard(`/board?run=${RUN_ID}`);
    expect(screen.getByTestId("run-drawer")).toBeTruthy();
  });

  it("Esc closes the drawer and removes the param, unmounting it", () => {
    renderBoard(`/board?run=${RUN_ID}`);
    expect(screen.getByTestId("run-drawer")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("run-drawer")).toBeNull();
    // The board stays put behind the drawer.
    expect(screen.getByTestId("board-page")).toBeTruthy();
  });
});
