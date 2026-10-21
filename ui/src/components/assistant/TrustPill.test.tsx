import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrustPill } from "./TrustPill";

afterEach(() => {
  cleanup();
});

describe("TrustPill", () => {
  it("shows the current level in lowercase with the ▾ chevron", () => {
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const pill = screen.getByTestId("assistant-pill");
    expect(pill.textContent).toContain("ask for risky");
    expect(pill.textContent).toContain("▾");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a menu with the three levels and radio semantics", () => {
    render(<TrustPill value="ask_all" onChange={() => {}} />);
    fireEvent.click(screen.getByTestId("assistant-pill"));
    expect(screen.getByTestId("assistant-pill-menu")).toBeTruthy();
    const options = [
      screen.getByTestId("assistant-pill-option-ask_all"),
      screen.getByTestId("assistant-pill-option-ask_risky"),
      screen.getByTestId("assistant-pill-option-no_ask"),
    ];
    expect(options.map((option) => option.getAttribute("role"))).toEqual([
      "menuitemradio",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    // default is ask_risky, and the footer line is present
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain("default");
    expect(screen.getByText(/never reads secret values/)).toBeTruthy();
  });

  it("selecting a level calls onChange with its value and closes the menu", () => {
    const onChange = vi.fn();
    render(<TrustPill value="ask_risky" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("assistant-pill"));
    fireEvent.click(screen.getByTestId("assistant-pill-option-no_ask"));
    expect(onChange).toHaveBeenCalledWith("no_ask");
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
  });

  it("navigates the options with arrow keys and selects with Enter", () => {
    const onChange = vi.fn();
    render(<TrustPill value="ask_risky" onChange={onChange} />);
    const pill = screen.getByTestId("assistant-pill");
    fireEvent.click(pill);
    // move focus into the menu (the pill does it via rAF; tests do it directly)
    const menu = screen.getByTestId("assistant-pill-menu");
    const first = screen.getByTestId("assistant-pill-option-ask_all");
    first.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "assistant-pill-option-ask_risky",
    );
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "assistant-pill-option-no_ask",
    );
    // wraps around on the next down arrow
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "assistant-pill-option-ask_all",
    );
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("ask_all");
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
  });

  it("esc closes the menu, refocuses the pill and does not close the panel", () => {
    const onClose = vi.fn();
    const onKey = vi.fn((event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    });
    window.addEventListener("keydown", onKey);
    render(
      <div>
        <TrustPill value="ask_risky" onChange={() => {}} />
      </div>,
    );
    const pill = screen.getByTestId("assistant-pill");
    fireEvent.click(pill);
    const option = screen.getByTestId("assistant-pill-option-ask_risky");
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
    expect(document.activeElement).toBe(pill);
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onKey);
  });
});
