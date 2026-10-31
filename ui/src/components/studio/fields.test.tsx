/**
 * fields.tsx tests — the load-bearing one is BoolField's touch target. The
 * 390 phone rule (e2e/emulator/reflow.ts, app-shell "mobile 44–48") measures a
 * checkbox through its LABEL box, so a bare 14px input with no wrapping label
 * is a recorded defect; BoolField must render the input inside a label the way
 * components/workflows/IssueTriggerDialog.tsx does — WITHOUT losing the
 * accessible name Field's `<label htmlFor>` already gives it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoolField, NumberField } from "./fields";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BoolField", () => {
  it("renders the checkbox INSIDE a label box (the phone touch target)", () => {
    render(
      <BoolField
        id="retry-backoff-jitter"
        label="Add jitter"
        readOnly={false}
        value={false}
        onCommit={vi.fn()}
      />,
    );
    const input = screen.getByTestId("insp-retry-backoff-jitter") as HTMLInputElement;
    const box = input.closest("label");
    expect(box, "the input is wrapped in a <label>").not.toBeNull();
    expect(screen.getByTestId("insp-retry-backoff-jitter-row")).toBe(box);
    expect(input.type).toBe("checkbox");
  });

  it("keeps Field's text label as the accessible name (no duplicate label)", () => {
    render(
      <BoolField
        id="retry-backoff-jitter"
        label="Add jitter"
        readOnly={false}
        value
        onCommit={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Add jitter") as HTMLInputElement;
    expect(input.checked).toBe(true);
    // The wrapping row label adds no text of its own.
    expect(input.closest("label")?.textContent).toBe("");
  });

  it("commits the instant the box is ticked, and never when read-only", () => {
    const onCommit = vi.fn();
    render(<BoolField id="x" label="X" readOnly onCommit={vi.fn()} value={false} />);
    expect((screen.getByTestId("insp-x") as HTMLInputElement).disabled).toBe(true);

    cleanup();
    render(<BoolField id="x" label="X" readOnly={false} value={false} onCommit={onCommit} />);
    fireEvent.click(screen.getByTestId("insp-x"));
    expect(onCommit).toHaveBeenCalledWith(true);
  });
});

// The accepted range is guidance under the field, not a suffix on its label
// (2026-10-30 copy review, 1g item 9): Field sets labels in mono caps, so
// `(allowed 0–2)` printed as `TEMPERATURE (ALLOWED 0-2)` — a schema fragment
// wearing the label's voice.
describe("NumberField range hint", () => {
  it("keeps the label clean and says the range under the field", () => {
    render(
      <NumberField
        id="retry-backoff-multiplier"
        label="Backoff multiplier"
        readOnly={false}
        value={1.5}
        min={0}
        max={2}
        onCommit={vi.fn()}
      />,
    );
    const label = screen.getByText("Backoff multiplier") as HTMLElement;
    expect(label.textContent).toBe("Backoff multiplier");
    expect(label.textContent).not.toMatch(/allowed|0–2/i);
    expect(screen.getByText("0 to 2")).toBeTruthy();
  });

  it("adds the hint the caller passed rather than replacing it", () => {
    render(
      <NumberField
        id="timeout"
        label="Timeout"
        hint="seconds the step may run"
        readOnly={false}
        value={30}
        min={1}
        max={600}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText("seconds the step may run · 1 to 600")).toBeTruthy();
  });

  it("still refuses an out-of-range value in plain words", () => {
    const onCommit = vi.fn();
    render(
      <NumberField
        id="attempts"
        label="Max attempts"
        readOnly={false}
        value={1}
        min={1}
        max={10}
        integerOnly
        onCommit={onCommit}
      />,
    );
    const input = screen.getByTestId("insp-attempts") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(/Max attempts: 40 is out of range/)).toBeTruthy();
  });
});
