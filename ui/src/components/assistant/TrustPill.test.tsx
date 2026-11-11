import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrustPill } from "./TrustPill";

/**
 * The trust pill and its menu (handoff §4; mock L357–366 + L441–455). The copy
 * is the handoff's, verbatim — and nothing in the menu promises that a change
 * can be undone.
 */

afterEach(() => {
  cleanup();
});

const openMenu = () => {
  fireEvent.click(screen.getByTestId("assistant-pill"));
  return screen.getByTestId("assistant-pill-menu");
};

describe("TrustPill", () => {
  it("shows the current level in lowercase with the Tabler chevron (no ▾ glyph)", () => {
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const pill = screen.getByTestId("assistant-pill");
    expect(pill.textContent).toContain("Ask when risky");
    expect(pill.textContent).not.toContain("▾");
    expect(pill.querySelector("svg")).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(pill.className).toContain("h-[26px]");
    // §1: the design's pill label is mono 10.5px (prototype `font-size:10.5px`).
    expect(pill.className).toContain("text-[10.5px]");
  });

  it("stays WHITE on a line border while its menu is open — no pressed fill", () => {
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const pill = screen.getByTestId("assistant-pill");
    // Closed: the grey wash is a HOVER state only.
    expect(pill.className).toContain("bg-surface");
    expect(pill.className).toContain("border-line");
    expect(pill.className).toContain("hover:bg-fill");
    openMenu();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(pill.className).toContain("bg-surface");
    expect(pill.className).toContain("border-line");
    // §1: nothing paints the open pill grey — not a pressed style, not the
    // hover wash held under the cursor while the menu is up.
    expect(pill.className).not.toContain("bg-fill");
    expect(pill.className).not.toContain("bg-line");
  });

  it("sits 12px LEFT of the pill with its arrow on the chevron", () => {
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const pill = screen.getByTestId("assistant-pill");
    // The design's geometry (prototype: pill at base+34, trustBox at base+22,
    // arrow at base+90), measured from a pill 100px wide at x=240.
    pill.getBoundingClientRect = () =>
      ({
        left: 240,
        right: 340,
        top: 600,
        bottom: 626,
        width: 100,
        height: 26,
        x: 240,
        y: 600,
        toJSON: () => ({}),
      }) as DOMRect;
    fireEvent.click(pill);
    const menu = screen.getByTestId("assistant-pill-menu") as HTMLElement;
    expect(menu.style.left).toBe("228px");
    const arrow = menu.querySelector('[data-testid="menu-arrow"]') as HTMLElement;
    // The chevron's centre (right edge − 7px padding − half the 11px glyph),
    // in the box's own coordinates: (340 − 12.5) − 228.
    expect(arrow.style.left).toBe("99.5px");
  });

  it("labels every level the handoff way", () => {
    render(<TrustPill value="ask_all" onChange={() => {}} />);
    expect(screen.getByTestId("assistant-pill").textContent).toContain("Ask every change");
    render(<TrustPill value="no_ask" onChange={() => {}} />);
    expect(screen.getAllByTestId("assistant-pill")[1].textContent).toContain("Don't ask");
  });

  it("opens a menu with the three levels and radio semantics", () => {
    render(<TrustPill value="ask_all" onChange={() => {}} />);
    openMenu();
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
    // ask_risky is the default, and it says so.
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain("default");
  });

  it("carries the handoff's exact copy — and never promises an undo", () => {
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const menu = openMenu();
    expect(screen.getByTestId("assistant-pill-option-ask_all").textContent).toContain(
      "Ask before every change",
    );
    expect(screen.getByTestId("assistant-pill-option-ask_all").textContent).toContain(
      "You confirm every change.",
    );
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain(
      "Ask when it looks risky",
    );
    expect(screen.getByTestId("assistant-pill-option-ask_risky").textContent).toContain(
      "A decision model checks each call. Flagged ones wait for you.",
    );
    expect(screen.getByTestId("assistant-pill-option-no_ask").textContent).toContain("Don't ask");
    expect(screen.getByTestId("assistant-pill-option-no_ask").textContent).toContain(
      "Everything runs. Each action is listed in the thread.",
    );
    // §4: only draft edits are reversible, so the menu says nothing about undo.
    expect(menu.textContent?.toLowerCase()).not.toContain("undon");
    expect(menu.textContent?.toLowerCase()).not.toContain("can be undone");
    // One line per option, no stacked footer under the three rows.
    expect(menu.textContent).not.toContain("never reads secret values");
  });

  it("renders the menu OUTSIDE the trigger's wrapper, above it, with the arrow", () => {
    render(
      <div data-testid="panel">
        <TrustPill value="ask_risky" onChange={() => {}} />
      </div>,
    );
    const pill = screen.getByTestId("assistant-pill");
    const menu = openMenu();
    // A sibling of the panel, not a descendant of the pill (handoff §1).
    expect(screen.getByTestId("panel").contains(menu)).toBe(false);
    expect(pill.parentElement?.contains(menu)).toBe(false);
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain("border-ink");
    expect(menu.className).toContain("shadow-raised");
    expect(menu.style.width).toBe("290px");
    const arrow = screen.getByTestId("menu-arrow") as HTMLElement;
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
    expect(arrow.style.width).toBe("9px");
    expect(arrow.style.transform).toContain("rotate(45deg)");
    // The arrow is the box's own, on the edge facing the trigger.
    expect(menu.contains(arrow)).toBe(true);
  });

  it("selecting a level calls onChange with its value and closes the menu", () => {
    const onChange = vi.fn();
    render(<TrustPill value="ask_risky" onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByTestId("assistant-pill-option-no_ask"));
    expect(onChange).toHaveBeenCalledWith("no_ask");
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
  });

  it("navigates the options with arrow keys and selects with Enter", () => {
    const onChange = vi.fn();
    render(<TrustPill value="ask_risky" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("assistant-pill"));
    const menu = screen.getByRole("menu");
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
    render(<TrustPill value="ask_risky" onChange={() => {}} />);
    const pill = screen.getByTestId("assistant-pill");
    openMenu();
    fireEvent.keyDown(screen.getByTestId("assistant-pill-option-ask_risky"), { key: "Escape" });
    expect(screen.queryByTestId("assistant-pill-menu")).toBeNull();
    expect(document.activeElement).toBe(pill);
    expect(onClose).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onKey);
  });
});
