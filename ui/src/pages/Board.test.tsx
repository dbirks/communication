/**
 * The board ↔ drawer wiring (artboard 3c): a card click puts `?run=<id>` on
 * the board URL and the 440px run drawer renders over the board; the drawer
 * closes (and unmounts) when `?run` is removed. The drawer's own reads are
 * mocked — its behaviour is covered by RunDrawer.test.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Board from "./Board";
import type { CrossProjectRun } from "../components/board/columns";

const { useBoardRunsMock } = vi.hoisted(() => ({ useBoardRunsMock: vi.fn() }));

vi.mock("../api/board", () => ({
  useBoardRuns: (filter: unknown) => useBoardRunsMock(filter),
  useBoardLiveUpdates: () => undefined,
}));
vi.mock("../api/queries", () => ({
  useProjects: () => ({
    data: { items: [{ id: "p1", name: "acme-api" }] },
    isPending: false,
    error: null,
  }),
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

beforeEach(() => {
  useBoardRunsMock.mockReturnValue({ data: { runs: [ROW] }, isPending: false, error: null });
});

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

describe("Board header bands — contrast (never dilute a token fg with opacity)", () => {
  it("every column header band and count badge keeps its full token fg", () => {
    renderBoard();
    for (const column of ["queued", "running", "needs-you", "failed", "done"]) {
      const band = screen.getByTestId(`board-col-${column}`).querySelector("button") as Element;
      const badge = screen.getByTestId(`board-col-count-${column}`);
      expect(band.className).not.toMatch(/opacity/);
      expect(badge.className).not.toMatch(/opacity/);
    }
  });
});

describe("Board — the from issues / scheduled trigger filters (ADR-0056 part 1)", () => {
  it("the from issues and scheduled chips are enabled and idle by default", () => {
    renderBoard();
    const issue = screen.getByTestId("board-filter-issue") as HTMLButtonElement;
    const scheduled = screen.getByTestId("board-filter-scheduled") as HTMLButtonElement;
    expect(issue.disabled).toBe(false);
    expect(scheduled.disabled).toBe(false);
    expect(issue.getAttribute("aria-pressed")).toBe("false");
    expect(scheduled.getAttribute("aria-pressed")).toBe("false");
  });

  it("pressing a trigger chip sends that trigger to the run list and toggles aria-pressed", () => {
    renderBoard();
    const scheduled = screen.getByTestId("board-filter-scheduled") as HTMLButtonElement;
    fireEvent.click(scheduled);
    expect(scheduled.getAttribute("aria-pressed")).toBe("true");
    expect(useBoardRunsMock).toHaveBeenLastCalledWith({
      projectId: undefined,
      mine: false,
      trigger: "schedule",
    });
    fireEvent.click(scheduled);
    expect(scheduled.getAttribute("aria-pressed")).toBe("false");
    expect(useBoardRunsMock).toHaveBeenLastCalledWith({
      projectId: undefined,
      mine: false,
      trigger: null,
    });
  });

  it("a trigger chip combines with the project select and the mine filter", () => {
    renderBoard();
    fireEvent.change(screen.getByTestId("board-project-select"), { target: { value: "p1" } });
    fireEvent.click(screen.getByTestId("board-filter-mine"));
    fireEvent.click(screen.getByTestId("board-filter-issue"));
    expect(useBoardRunsMock).toHaveBeenLastCalledWith({
      projectId: "p1",
      mine: true,
      trigger: "issue",
    });
  });
});

describe("Board — honest empty states for a trigger filter", () => {
  it("an empty scheduled filter shows the honest empty state", () => {
    useBoardRunsMock.mockReturnValue({ data: { runs: [] }, isPending: false, error: null });
    renderBoard();
    fireEvent.click(screen.getByTestId("board-filter-scheduled"));
    const empty = screen.getByTestId("board-empty-schedule");
    expect(empty).toBeTruthy();
    expect(empty.textContent).toBe("No scheduled runs");
  });

  it("an empty from-issues filter shows the honest empty state", () => {
    useBoardRunsMock.mockReturnValue({ data: { runs: [] }, isPending: false, error: null });
    renderBoard();
    fireEvent.click(screen.getByTestId("board-filter-issue"));
    const empty = screen.getByTestId("board-empty-issue");
    expect(empty).toBeTruthy();
    expect(empty.textContent).toBe("No runs started from issues");
  });

  it("no filter and no runs keeps the generic empty state", () => {
    useBoardRunsMock.mockReturnValue({ data: { runs: [] }, isPending: false, error: null });
    renderBoard();
    expect(screen.getByTestId("board-empty")).toBeTruthy();
  });
});
