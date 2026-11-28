import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GESTURE_HINT_KEY,
  GestureHint,
  dismissGestureHint,
  gestureHintDismissed,
} from "./GestureHint";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
});

function boldKeys(): string[] {
  return Array.from(screen.getByTestId("gesture-hint").querySelectorAll(".font-semibold")).map(
    (el) => el.textContent ?? "",
  );
}

describe("GestureHint", () => {
  it("renders the desktop wording with keys bold", () => {
    render(<GestureHint onDismiss={() => {}} />);
    const hint = screen.getByTestId("gesture-hint");
    expect(hint.getAttribute("role")).toBe("note");
    expect(boldKeys()).toEqual(["drag empty space", "space + drag", "drag a dot", "N"]);
    expect(hint.textContent).toContain("select");
    expect(hint.textContent).toContain("move");
    expect(hint.textContent).toContain("connect");
    expect(hint.textContent).toContain("note");
    expect(hint.textContent).toContain("·");
  });

  it("renders the touch wording with keys bold", () => {
    render(<GestureHint touch onDismiss={() => {}} />);
    const hint = screen.getByTestId("gesture-hint");
    expect(boldKeys()).toEqual(["long-press", "drag", "tap a step"]);
    expect(hint.textContent).toContain("select");
    expect(hint.textContent).toContain("move");
    expect(hint.textContent).toContain("open");
  });

  it("dismiss persists the flag and calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<GestureHint onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("gesture-hint-close"));
    expect(window.localStorage.getItem(GESTURE_HINT_KEY)).toBe("1");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("gestureHintDismissed reflects the flag", () => {
    expect(gestureHintDismissed()).toBe(false);
    dismissGestureHint();
    expect(gestureHintDismissed()).toBe(true);
  });

  it("does not crash when localStorage.getItem throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(gestureHintDismissed()).toBe(false);
    expect(() => render(<GestureHint onDismiss={() => {}} />)).not.toThrow();
  });
});
