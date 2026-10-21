/**
 * StepPicker tests (redesign "Add a step (4a)"): the five START A NEW STEP
 * cards and their copy, the MORE section with the remaining offered kinds,
 * the honest YOUR SAVED STEPS section and assistant hint, the ADR-0045
 * exclusion of Publish kinds, search filtering, keyboard pick (arrows +
 * Enter), describe-and-Enter handoff to the assistant, Escape closes, and
 * non-runnable kinds staying pickable with their reason.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepPicker } from "./StepPicker";

afterEach(cleanup);

describe("StepPicker", () => {
  it("shows the five START A NEW STEP cards with the 4a copy", () => {
    render(<StepPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const picker = screen.getByTestId("step-picker");
    expect(picker.querySelector('[data-testid="step-picker-featured"]')).toBeTruthy();
    const expected: [string, string, string][] = [
      ["agent.acp", "Agent", "an ACP agent with a profile"],
      ["process.exec", "Command", "run a program, check exit code"],
      ["human.approval", "Approval", "a person decides"],
      ["until", "Loop", "repeat until a check passes"],
      ["pipeline.invoke", "Workflow", "run another workflow inside"],
    ];
    for (const [kind, title, blurb] of expected) {
      const card = screen.getByTestId(`step-picker-item-${kind}`);
      expect(card.textContent).toContain(title);
      expect(card.textContent).toContain(blurb);
    }
  });

  it("offers the remaining kinds under MORE and never a Publish kind", () => {
    render(<StepPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const picker = screen.getByTestId("step-picker");
    expect(screen.getByTestId("step-picker-more")).toBeTruthy();
    for (const kind of ["model.chat", "condition", "for_each"]) {
      expect(screen.getByTestId(`step-picker-item-${kind}`)).toBeTruthy();
    }
    // ADR-0045: Publish kinds stay in the YAML catalogue, never in the picker.
    expect(screen.queryByTestId("step-picker-item-git.publish")).toBeNull();
    expect(screen.queryByTestId("step-picker-item-artifact.publish")).toBeNull();
    expect(picker.textContent).not.toContain("Publish");
    expect(picker.textContent).not.toContain("publish");
  });

  it("shows the honest YOUR SAVED STEPS section and the assistant hint", () => {
    render(<StepPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("step-picker-saved")).toBeTruthy();
    expect(screen.getByTestId("step-picker-saved-count").textContent).toContain("0");
    expect(screen.getByText("Saved steps arrive with the step registry.")).toBeTruthy();
    expect(screen.getByTestId("step-picker-assistant-hint").textContent).toContain(
      "the assistant drafts it",
    );
  });

  it("filters the sections by search text", () => {
    render(<StepPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByTestId("step-picker-search");
    fireEvent.change(input, { target: { value: "approval" } });
    expect(screen.getByTestId("step-picker-item-human.approval")).toBeTruthy();
    expect(screen.queryByTestId("step-picker-item-agent.acp")).toBeNull();
    fireEvent.change(input, { target: { value: "zzz-nothing" } });
    expect(screen.getByTestId("step-picker-empty")).toBeTruthy();
  });

  it("picks with the keyboard: arrows move, Enter picks", () => {
    const onPick = vi.fn();
    render(<StepPicker onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByTestId("step-picker-search");
    expect(document.activeElement).toBe(input);
    // First entry is the Agent card; one down lands on Command (process.exec).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("process.exec");
  });

  it("picks the first matching entry when a search narrows the list", () => {
    const onPick = vi.fn();
    render(<StepPicker onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByTestId("step-picker-search");
    fireEvent.change(input, { target: { value: "check exit" } });
    // "run a program, check exit code" is the Command card's blurb.
    expect(screen.getByTestId("step-picker-item-process.exec")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("process.exec");
  });

  it("hands a description to the assistant when Enter matches no kind", () => {
    const onDescribe = vi.fn();
    const onClose = vi.fn();
    render(<StepPicker onPick={vi.fn()} onClose={onClose} onDescribe={onDescribe} />);
    const input = screen.getByTestId("step-picker-search");
    fireEvent.change(input, { target: { value: "check the bundle size stays under 300 KB" } });
    expect(screen.getByTestId("step-picker-empty")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDescribe).toHaveBeenCalledWith("check the bundle size stays under 300 KB");
    expect(onClose).toHaveBeenCalled();
  });

  it("does nothing (no crash, no pick) on describe-less Enter with no match", () => {
    const onPick = vi.fn();
    render(<StepPicker onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByTestId("step-picker-search");
    fireEvent.change(input, { target: { value: "zzz-nothing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<StepPicker onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("step-picker-search"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps non-runnable kinds pickable, labelled 'not runnable yet'", () => {
    const onPick = vi.fn();
    render(<StepPicker onPick={onPick} onClose={vi.fn()} />);
    const item = screen.getByTestId("step-picker-item-parallel");
    expect(item.textContent).toContain("not runnable yet");
    fireEvent.click(item);
    expect(onPick).toHaveBeenCalledWith("parallel");
  });

  it("picks on click of a visible entry", () => {
    const onPick = vi.fn();
    render(<StepPicker onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("step-picker-item-model.chat"));
    expect(onPick).toHaveBeenCalledWith("model.chat");
  });
});
