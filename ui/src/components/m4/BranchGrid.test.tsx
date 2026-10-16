/**
 * The branch grid as a person meets it: a header that counts, one square per
 * branch, one selected at a time, and the selected branch's history under it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BranchGrid } from "./BranchGrid";
import { fanOutNodes } from "../../test/fixtures/m4/runs";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";

/** The smallest row the grid reads: a declared 4-item scope, nothing started. */
function row(overrides: Partial<NodeExecutionSummary>): NodeExecutionSummary {
  return {
    id: `nx_${overrides.node_instance_key ?? "x"}`.replace(/\W/g, ""),
    run_id: "run_branches",
    node_id: "each",
    node_instance_key: "/each",
    scope_key: "/",
    kind: "for_each",
    execution_location: "control_plane",
    status: "running",
    outcome: null,
    error_class: null,
    failed_cause: null,
    attempt_count: 0,
    attempt_limit: 1,
    in_flight: 0,
    waiting_reason: null,
    artifact_refs: [],
    ready_at: null,
    finished_at: null,
    ...overrides,
  };
}

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

function renderGrid({
  selectedBranch = null,
  onSelectBranch = vi.fn(),
}: { selectedBranch?: number | null; onSelectBranch?: (index: number) => void } = {}) {
  render(
    <BranchGrid
      scope="/verify_each"
      nodes={fanOutNodes}
      selectedBranch={selectedBranch}
      onSelectBranch={onSelectBranch}
      definitionOrder={["invoke"]}
    />,
  );
  return onSelectBranch;
}

const cells = () =>
  [...screen.getByTestId("branch-grid").querySelectorAll("button")].map(
    (button) => button.getAttribute("data-testid") ?? "",
  );

describe("BranchGrid", () => {
  it("draws the counts header and one numbered cell per branch", () => {
    renderGrid();
    expect(screen.getByTestId("branch-counts").textContent).toContain("25 branches");
    // Counts accompany colour (rule 06): every state the cells carry is counted,
    // in words as well as glyphs.
    const header = screen.getByTestId("branch-counts").textContent ?? "";
    expect(header).toContain("18 done");
    expect(header).toContain("3 running");
    expect(header).toContain("1 failed");
    expect(header).toContain("3 queued");
    expect(cells()).toHaveLength(25);
    expect(screen.getByTestId("branch-cell-1").textContent).toContain("1");
    expect(screen.getByTestId("branch-cell-25").getAttribute("data-branch-state")).toBe("queued");
    // The fixture's 22nd module is the failed one (03's fan-out stays honest).
    expect(screen.getByTestId("branch-cell-22").getAttribute("data-branch-state")).toBe("failed");
  });

  it("orders stuck first by default, and by number on request", () => {
    renderGrid();
    // Branch 22 failed: it leads the grid until the person asks for plain order.
    expect(cells()[0]).toBe("branch-cell-22");
    fireEvent.click(screen.getByRole("button", { name: "by number" }));
    expect(cells()[0]).toBe("branch-cell-1");
    expect(screen.getByRole("button", { name: "stuck first" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "by number" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("marks the selected cell and reports a click", () => {
    const onSelectBranch = renderGrid({ selectedBranch: 14 });
    expect(screen.getByTestId("branch-cell-14").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("branch-cell-13").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("branch-cell-15"));
    expect(onSelectBranch).toHaveBeenCalledWith(15);
  });

  it("shows the selected branch's history, with its failure reason", () => {
    renderGrid({ selectedBranch: 22 });
    const history = screen.getByTestId("branch-history");
    expect(history.textContent).toContain("task 22");
    const chip = screen.getByTestId("branch-step-/verify_each[22]/invoke");
    expect(chip.textContent).toContain("invoke");
    expect(chip.textContent).toContain("node_execution_failed");
    expect(chip.getAttribute("data-branch-step-state")).toBe("failed");
  });

  it("says so when a branch has run nothing, and when none is picked", () => {
    // The scope declared four items and the run has started none of them: the
    // cells exist (that is the point of the grid) and say `queued`.
    render(
      <BranchGrid
        scope="/each"
        nodes={[row({ items: 4 })]}
        selectedBranch={3}
        onSelectBranch={() => {}}
      />,
    );
    expect(screen.getByTestId("branch-history-none").textContent).toBe("queued");
    cleanup();
    renderGrid();
    expect(screen.getByTestId("branch-history-empty")).toBeDefined();
  });

  it("moves focus with the arrow keys and selects with Enter", () => {
    const onSelectBranch = renderGrid({ selectedBranch: 14 });
    const first = screen.getByTestId("branch-cell-14");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("branch-cell-15"));
    fireEvent.keyDown(screen.getByTestId("branch-cell-15"), { key: "Home" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("branch-cell-22");
    // A roving tabindex: the grid is one tab stop, not twenty-five.
    expect(
      [...screen.getByTestId("branch-grid").querySelectorAll("button")].filter(
        (button) => button.tabIndex === 0,
      ).length,
    ).toBe(1);
    // Enter is the button's own activation, which jsdom does not synthesise from
    // a keydown — a click on the focused cell is what the browser does with it.
    fireEvent.click(screen.getByTestId("branch-cell-22"));
    expect(onSelectBranch).toHaveBeenCalledWith(22);
  });
});
