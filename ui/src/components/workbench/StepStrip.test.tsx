/**
 * The full-screen workbench's step strip (design 5c): one cell per
 * top-level step, each wearing its shared state's glyph + word (never
 * colour alone), the loop's `i/N` counter on `until` steps, the selected
 * step raised with the hard `2px 2px 0` ink shadow, and a click that
 * selects that step's transcript like clicking the node on the graph.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATES } from "../ds/states";
import type { Overlay } from "../../lib/pipeline/workbench";
import { StepStrip, buildStepCells, loopCounterOf } from "./StepStrip";

const overlay = (
  state: Overlay["state"],
  label: string,
  executionId: string | null = null,
): Overlay => ({ state, label, executionId });

afterEach(cleanup);

describe("loopCounterOf", () => {
  it("compacts the overlay's iteration label to i/N and nothing else", () => {
    expect(loopCounterOf("iteration 2 of 4")).toBe("2/4");
    expect(loopCounterOf("iteration 1 of 1")).toBe("1/1");
    expect(loopCounterOf("running")).toBeNull();
    expect(loopCounterOf("not started")).toBeNull();
    expect(loopCounterOf("4 items: 1 done")).toBeNull();
  });
});

describe("buildStepCells", () => {
  it("orders the cells after the steps and gives an untouched step the honest queued overlay", () => {
    const cells = buildStepCells(
      [
        { id: "plan", kind: "agent.acp" },
        { id: "loop", kind: "until" },
        { id: "publish", kind: "artifact.publish" },
      ],
      {
        plan: overlay("done", "done", "e1"),
        loop: overlay("running", "iteration 2 of 4"),
      },
    );
    expect(cells.map((cell) => cell.id)).toEqual(["plan", "loop", "publish"]);
    expect(cells[0].overlay).toEqual(overlay("done", "done", "e1"));
    expect(cells[1].loopCounter).toBe("2/4");
    expect(cells[2].overlay.state).toBe("queued");
    expect(cells[2].overlay.label).toBe("not started");
    // Only an `until` step carries the loop counter.
    const nonLoop = buildStepCells([{ id: "loop", kind: "process.exec" }], {
      loop: overlay("running", "iteration 2 of 4"),
    });
    expect(nonLoop[0].loopCounter).toBeNull();
  });
});

describe("StepStrip", () => {
  const cells = buildStepCells(
    [
      { id: "plan", kind: "agent.acp" },
      { id: "approve", kind: "human.approval" },
      { id: "implement", kind: "until" },
      { id: "test", kind: "process.exec" },
      { id: "review", kind: "agent.acp" },
    ],
    {
      plan: overlay("done", "done", "e1"),
      approve: overlay("done", "done", "e2"),
      implement: overlay("running", "iteration 2 of 4", "e3"),
      test: overlay("failed", "failed"),
      review: overlay("queued", "not started"),
    },
  );

  it("shows one cell per step with glyph + word, the loop's i/N counter, and state colours", () => {
    const { container } = render(
      <StepStrip cells={cells} selectedId="implement" onSelect={() => {}} />,
    );
    expect(container.querySelector('[data-testid="workbench-step-strip"]')).toBeTruthy();
    const implement = screen.getByTestId("workbench-step-cell-implement");
    expect(implement.textContent).toContain("implement");
    expect(implement.textContent).toContain(STATES.running.glyph);
    expect(implement.textContent).toContain("2/4");
    expect(implement.className).toContain(STATES.running.tagBg);
    expect(screen.getByTestId("workbench-step-cell-plan").textContent).toContain(STATES.done.glyph);
    expect(screen.getByTestId("workbench-step-cell-plan").textContent).toContain(STATES.done.word);
    expect(screen.getByTestId("workbench-step-cell-test").textContent).toContain(
      STATES.failed.glyph,
    );
    const review = screen.getByTestId("workbench-step-cell-review");
    expect(review.textContent).toContain(STATES.queued.glyph);
    expect(review.textContent).toContain("pending");
  });

  it("raises only the selected step with the hard 2px 2px 0 ink shadow", () => {
    const { container } = render(
      <StepStrip cells={cells} selectedId="implement" onSelect={() => {}} />,
    );
    const buttons = Array.from(container.querySelectorAll('[data-testid^="workbench-step-cell-"]'));
    const raised = buttons.filter((button) =>
      button.className.includes("shadow-(--shadow-raised)"),
    );
    expect(raised).toHaveLength(1);
    expect(raised[0].getAttribute("data-testid")).toBe("workbench-step-cell-implement");
    expect(raised[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("selects the clicked step's transcript — the graph node click", () => {
    const onSelect = vi.fn();
    render(<StepStrip cells={cells} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("workbench-step-cell-test"));
    expect(onSelect).toHaveBeenCalledWith("test");
    fireEvent.click(screen.getByTestId("workbench-step-cell-review"));
    expect(onSelect).toHaveBeenLastCalledWith("review");
  });
});
