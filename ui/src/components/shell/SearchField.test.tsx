/**
 * SearchField — the field-shaped button in the top bar (redesign R1). It owns
 * no text: its one job is to open the command palette through the SAME event
 * the sidebar's `Search ⌘K` field used (`PALETTE_OPEN_EVENT`), and to show the
 * chord the keyboard really prints.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTE_OPEN_EVENT } from "../CommandPalette";
import SearchField from "./SearchField";

function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, "platform", {
    value,
    configurable: true,
    writable: false,
  });
}

afterEach(() => {
  cleanup();
  setPlatform("Win32");
});

describe("the field", () => {
  it("says what it opens and fires the palette's own open event", () => {
    setPlatform("MacIntel");
    const opened = vi.fn();
    window.addEventListener(PALETTE_OPEN_EVENT, opened);
    try {
      render(<SearchField />);
      const field = screen.getByTestId("search-or-ask");
      expect(field.tagName).toBe("BUTTON");
      expect(field.textContent).toContain("Search or ask");
      fireEvent.click(field);
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(PALETTE_OPEN_EVENT, opened);
    }
  });

  it("spells the chord for the keyboard in use", () => {
    setPlatform("MacIntel");
    const { unmount } = render(<SearchField />);
    expect(screen.getByTestId("search-or-ask").textContent).toContain("⌘K");
    unmount();
    setPlatform("Win32");
    render(<SearchField />);
    expect(screen.getByTestId("search-or-ask").textContent).toContain("Ctrl K");
  });

  it("keeps the same handle and name when compact (phone), with no words drawn", () => {
    render(<SearchField compact />);
    const field = screen.getByTestId("search-or-ask");
    expect(field.getAttribute("aria-label")).toBe("Search or ask");
    expect(field.className).toContain("h-9");
    expect(field.className).toContain("w-9");
    expect(field.textContent).toBe("");
    const opened = vi.fn();
    window.addEventListener(PALETTE_OPEN_EVENT, opened);
    try {
      fireEvent.click(field);
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(PALETTE_OPEN_EVENT, opened);
    }
  });
});
