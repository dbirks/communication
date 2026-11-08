/**
 * `ds/Popover` unit tests — the rail's click-surface primitive (redesign 3a):
 * the ~196px white box with the ink border, the `2px 2px 0` offset shadow,
 * the 10px rotated-square arrow on the edge facing the trigger; opening parks
 * the keyboard on the first item, ↑/↓ rove with wrap, Enter activates, Esc
 * closes and returns focus to the trigger, and a pointerdown outside closes.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { Popover } from "./Popover";

// `src/test/render.tsx` carries the app-wide `afterEach(cleanup)`; this file
// renders its own harness, so it owns its own teardown.
afterEach(cleanup);

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const set = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <MemoryRouter>
      <button ref={triggerRef} type="button" data-testid="trigger" onClick={() => set(!open)}>
        Projects
      </button>
      <div className="relative">
        <Popover
          open={open}
          onClose={() => set(false)}
          triggerRef={triggerRef}
          ariaLabel="Projects"
          panelId="pop-panel"
          data-testid="popover"
        >
          <span>PROJECTS</span>
          <a href="/a" data-testid="item-a">
            Alpha
          </a>
          <a href="/b" data-testid="item-b">
            Beta
          </a>
        </Popover>
      </div>
    </MemoryRouter>
  );
}

describe("ds Popover", () => {
  it("is absent until opened, then draws the 3a box with its arrow", () => {
    render(<Harness />);
    expect(screen.queryByTestId("popover")).toBeNull();
    fireEvent.click(screen.getByTestId("trigger"));
    const panel = screen.getByTestId("popover");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-label")).toBe("Projects");
    // ~196px wide, and the arrow is its own element on the trigger-facing edge.
    expect(panel.style.width).toBe("196px");
    const arrow = panel.querySelector('[data-testid="menu-arrow"]') as HTMLElement;
    expect(arrow).toBeTruthy();
    expect(arrow.style.width).toBe("10px");
    expect(arrow.style.transform).toBe("rotate(45deg)");
    expect(panel.getAttribute("data-side")).toBe("right");
  });

  it("opens with the keyboard on the first item; ↑/↓ rove with wrap", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));
    fireEvent.keyDown(document, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.keyDown(document, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));
  });

  it("Enter activates the focused item", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trigger"));
    const itemB = screen.getByTestId("item-b");
    itemB.focus();
    let activated = 0;
    itemB.addEventListener("click", () => {
      activated += 1;
    });
    fireEvent.keyDown(itemB, { key: "Enter" });
    expect(activated).toBe(1);
  });

  it("Esc closes and returns focus to the trigger", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("trigger"));
  });

  it("a pointerdown outside closes; one inside does not", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("trigger"));
    onOpenChange.mockClear();
    fireEvent.pointerDown(screen.getByTestId("item-a"));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("popover")).toBeNull();
  });

  it("a pointerdown outside returns focus to the trigger when it had been inside", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("trigger"));
  });
});
