/**
 * StepPicker tests: search filtering, keyboard pick (arrows + Enter),
 * Escape closes, and non-runnable kinds stay pickable with their reason.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepPicker } from "./StepPicker";

afterEach(cleanup);

describe("StepPicker", () => {
  it("filters the list by search text", () => {
    render(<StepPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByTestId("step-picker-search");
    expect(screen.getByTestId("step-picker-item-agent.acp")).toBeTruthy();
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
    fireEvent.change(input, { target: { value: "run" } });
    // "Run command / tests" (process.exec) is the only match.
    expect(screen.getByTestId("step-picker-item-process.exec")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("process.exec");
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
    fireEvent.change(screen.getByTestId("step-picker-search"), { target: { value: "parallel" } });
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
