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
import { BoolField } from "./fields";

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
