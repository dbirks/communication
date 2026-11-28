import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AddBar } from "./ToolIsland";

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof AddBar>[0]> = {}) {
  const props = {
    onAddStep: vi.fn(),
    onAddNote: vi.fn(),
    onMoreSteps: vi.fn(),
    disabled: false,
    dragType: "application/x-communication-step",
    onDragKind: vi.fn(),
    ...overrides,
  };
  render(<AddBar {...props} />);
  return props;
}

it("renders the six items in order with their labels", () => {
  renderBar();
  const bar = screen.getByTestId("add-bar");
  expect(bar.getAttribute("role")).toBe("toolbar");
  expect(bar.getAttribute("aria-label")).toBe("Add to canvas");
  // Floating bottom-centre, 22px from the bottom (README 1b).
  expect(bar.className).toContain("absolute");
  expect(bar.className).toContain("bottom-[22px]");
  expect(bar.className).toContain("left-1/2");
  expect(bar.className).toContain("-translate-x-1/2");
  const labels = Array.from(bar.querySelectorAll("button > span:first-of-type")).map(
    (span) => span.textContent,
  );
  expect(labels).toEqual(["Agent", "Command", "Approval", "Judge", "Note", "More"]);
  // The Note item shows its key hint after the label.
  const note = screen.getByTestId("add-bar-note");
  const hint = note.querySelector("span:nth-of-type(2)");
  expect(hint?.textContent).toBe("N");
  expect(hint?.className).toContain("font-mono");
  expect(hint?.className).toContain("text-[10.5px]");
  expect(hint?.className).toContain("text-muted");
});

it("clicking a step calls onAddStep with its kind", () => {
  const { onAddStep } = renderBar();
  const addStep = onAddStep as ReturnType<typeof vi.fn>;
  fireEvent.click(screen.getByTestId("add-bar-agent.acp"));
  fireEvent.click(screen.getByTestId("add-bar-process.exec"));
  fireEvent.click(screen.getByTestId("add-bar-human.approval"));
  fireEvent.click(screen.getByTestId("add-bar-model.chat"));
  expect(addStep.mock.calls.map((call: unknown[]) => call[0])).toEqual([
    "agent.acp",
    "process.exec",
    "human.approval",
    "model.chat",
  ]);
});

it("Note calls onAddNote and More calls onMoreSteps", () => {
  const { onAddNote, onMoreSteps } = renderBar();
  fireEvent.click(screen.getByTestId("add-bar-note"));
  fireEvent.click(screen.getByTestId("add-bar-more"));
  expect(onAddNote).toHaveBeenCalledOnce();
  expect(onMoreSteps).toHaveBeenCalledOnce();
});

it("disabled disables every button", () => {
  renderBar({ disabled: true });
  const buttons = screen.getAllByRole("button");
  expect(buttons.length).toBe(6);
  for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
});

it("step items drag their kind onto the canvas", () => {
  const { onDragKind } = renderBar();
  const agent = screen.getByTestId("add-bar-agent.acp");
  const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(agent, { dataTransfer });
  expect(dataTransfer.setData).toHaveBeenCalledWith(
    "application/x-communication-step",
    "agent.acp",
  );
  expect(dataTransfer.effectAllowed).toBe("copy");
  expect(onDragKind).toHaveBeenCalledWith("agent.acp");
  fireEvent.dragEnd(agent);
  expect(onDragKind).toHaveBeenLastCalledWith(null);
});

it("Note and More are not draggable", () => {
  renderBar();
  for (const testId of ["add-bar-note", "add-bar-more"]) {
    const el = screen.getByTestId(testId);
    expect(el.getAttribute("draggable")).not.toBe("true");
  }
  for (const testId of [
    "add-bar-agent.acp",
    "add-bar-process.exec",
    "add-bar-human.approval",
    "add-bar-model.chat",
  ]) {
    expect(screen.getByTestId(testId).getAttribute("draggable")).toBe("true");
  }
});

it("on the phone band the bar scrolls sideways with 44px items", () => {
  renderBar({ narrow: true });
  const bar = screen.getByTestId("add-bar");
  expect(bar.className).toContain("max-w-[calc(100%-24px)]");
  expect(bar.className).toContain("overflow-x-auto");
  for (const button of screen.getAllByRole("button")) {
    expect(button.className).toContain("min-h-[44px]");
  }
});
