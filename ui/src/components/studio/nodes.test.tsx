/**
 * StepNode — the canvas step card. README section 8 (4h): live run state rides
 * the card's top-right corner as a small mono status TAG; the card itself keeps
 * its fixed 56px box so an overlay never reflows the graph.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { Position, ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepNode, type StepNodeRender } from "./nodes";

afterEach(cleanup);

function renderStep(overrides: Partial<StepNodeRender> = {}, selected = false) {
  const data: StepNodeRender = {
    id: "implement",
    kind: "process.exec",
    label: "Command",
    kindWord: "command",
    deferred: null,
    when: null,
    terminal: false,
    readOnly: false,
    stale: false,
    highlight: false,
    status: null,
    onSelect: vi.fn(),
    onMenu: null,
    onAddAfter: null,
    ...overrides,
  };
  const props = {
    id: data.id,
    type: "step",
    data,
    selected,
    isConnectable: false,
    dragging: false,
    zIndex: 1,
    width: 168,
    height: 56,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  } as unknown as NodeProps<Node<StepNodeRender>>;
  render(
    <ReactFlowProvider>
      <StepNode {...props} />
    </ReactFlowProvider>,
  );
  return data;
}

const card = () => screen.getByTestId("canvas-step-implement").querySelector("[role='button']")!;
const tag = () => screen.queryByTestId("step-status-implement");

describe("StepNode live state tag (README 8 / 4h)", () => {
  it("draws a running status as a corner tag, not a third text line", () => {
    renderStep({ status: { state: "running", label: "running" } });
    const el = tag();
    expect(el).toBeTruthy();
    // The DOM text keeps the lower-case label (tests and e2e compare it); the
    // capitals are CSS.
    expect(el!.textContent).toBe("● running");
    expect(el!.className).toContain("uppercase");
    expect(el!.className).toContain("bg-st-running-tag");
    expect(el!.className).toContain("text-st-running-tag-fg");
    expect(el!.getAttribute("aria-label")).toBe("status: running");
    // Absolutely positioned on the card's top-right corner, clear of the card.
    expect(el!.className).toContain("absolute");
    expect(el!.style.right).toBe("-6px");
    expect(el!.style.top).toBe("-12px");
    // The card still holds exactly two lines at its fixed height.
    expect(card().className).toContain("h-[56px]");
    expect(card().className).not.toContain("min-h-");
    expect(card().querySelectorAll("[data-testid='canvas-step-fact-implement']")).toHaveLength(1);
    expect(card().textContent).toBe("implementcommand");
  });

  it("colours the tag by state category", () => {
    const cases: Array<[string, string]> = [
      ["waiting", "bg-st-waiting-tag"],
      ["failed", "bg-st-failed-tag"],
      ["succeeded", "bg-st-done-tag"],
      ["interrupted", "bg-st-interrupted-tag"],
      ["queued", "bg-fill"],
    ];
    for (const [state, cls] of cases) {
      cleanup();
      renderStep({ status: { state, label: state } });
      expect(tag()!.className).toContain(cls);
    }
  });

  it("renders no tag and the plain 56px card when the step has no status", () => {
    renderStep();
    expect(tag()).toBeNull();
    expect(card().className).toContain("h-[56px]");
  });

  it("shifts the tag left of the selected step's ⋯ button", () => {
    renderStep({ status: { state: "running", label: "running" }, onMenu: vi.fn() }, true);
    expect(screen.getByTestId("node-menu-button-implement")).toBeTruthy();
    expect(tag()!.style.right).toBe("22px");
  });
});
