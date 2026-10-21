/**
 * The two-step take-control confirm card (5c): the copy must say exactly
 * what a takeover does — the current attempt is interrupted and the run
 * pauses, and on hand-back the SAME step runs again as a new attempt —
 * never "pauses before its next step". Plus the accessible-modal contract:
 * focus on the primary button at open, Tab/Shift+Tab stay inside, Escape =
 * `Just watch`, and each button reports back to the parent.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { TakeControlCard } from "./TakeControlCard";

afterEach(cleanup);

function renderCard(overrides: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  render(
    <div>
      <button type="button">opener</button>
      <TakeControlCard step="implement" onConfirm={onConfirm} onCancel={onCancel} />
    </div>,
  );
  return { onConfirm, onCancel };
}

describe("TakeControlCard", () => {
  it("names the step and says exactly what a takeover does", () => {
    renderCard();
    const card = screen.getByTestId("take-control-card");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    // The heading is a mono caps strip: the class uppercases it, and the
    // accessible name says it as written.
    expect(screen.getByTestId("take-control-card-heading").textContent).toBe(
      "Take control of implement?",
    );
    expect(card.getAttribute("aria-label")).toBe("Take control of implement?");
    const body = card.querySelector("p:nth-of-type(2)");
    expect(body).toBeTruthy();
    expect(body?.textContent).toBe(
      "The current attempt of implement stops and the run pauses. You talk to this agent " +
        "directly; when you hand back, implement runs again as a new attempt with whatever " +
        "you changed.",
    );
    // The rejected 5c copy must never come back.
    expect(body?.textContent).not.toContain("pauses before");
    expect(screen.getByTestId("take-control-confirm")).toBeTruthy();
    expect(screen.getByTestId("take-control-cancel")).toBeTruthy();
  });

  it("focuses the confirm button on open, and focus leaves the card when it closes", () => {
    // The parent unmounts the card on cancel — that is the close path.
    const onCancel = vi.fn(() => cleanup());
    renderCard({ onCancel });
    expect(document.activeElement).toBe(screen.getByTestId("take-control-confirm"));
    fireEvent.click(screen.getByTestId("take-control-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("take-control-card")).toBeNull();
    expect(
      (document.activeElement as HTMLElement | null)?.closest('[data-testid="take-control-card"]'),
    ).toBeNull();
  });

  it("Esc behaves like Just watch", () => {
    const { onCancel } = renderCard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenLastCalledWith();
  });

  it("Traps Tab and Shift+Tab inside the card", () => {
    renderCard();
    const confirm = screen.getByTestId("take-control-confirm");
    const cancel = screen.getByTestId("take-control-cancel");
    // From the last element, Tab wraps to the first.
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);
    // From the first element, Shift+Tab wraps to the last.
    fireEvent.keyDown(confirm, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("reports confirm and cancel back to the parent", () => {
    const { onConfirm, onCancel } = renderCard();
    fireEvent.click(screen.getByTestId("take-control-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(0);
  });
});
