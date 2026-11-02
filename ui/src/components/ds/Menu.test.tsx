/**
 * The ds Menu/Popover primitive (handoff 2c/3c): placement anchored to the
 * trigger, the 9px pointer arrow centered on the trigger even under viewport
 * clamping, Esc closing with focus returned to the trigger, outside-click
 * closing, and ArrowUp/Down/Home/End roving between `menuitem`s (disabled
 * items skipped, separators not stop-painted). The viewport rects are the
 * only layout jsdom can offer, so the clamp tests stub `getBoundingClientRect`
 * and `window.innerWidth` and assert the resulting inline offsets.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

// The suite runs vitest without `globals`, so testing-library cannot
// self-register its afterEach: these tests reuse testids across cases.
afterEach(cleanup);
import { Menu, MENU_ITEM_CLASS, Popover, type MenuEntry } from "./Menu";

function rect(l: number, t: number, w = 48, h = 26) {
  return {
    left: l,
    right: l + w,
    width: w,
    height: h,
    top: t,
    bottom: t + h,
    x: l,
    y: t,
  } as DOMRect;
}

function Harness({
  items,
  side = "bottom",
  align = "start",
  width = 180,
  height,
  caption,
}: {
  items: MenuEntry[];
  side?: "bottom" | "top" | "right" | "left";
  align?: "start" | "end";
  width?: number;
  height?: number;
  caption?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        open
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        data-testid="panel"
        ariaLabel="harness"
        side={side}
        align={align}
        width={width}
        height={height}
        caption={caption}
        items={items}
      />
    </div>
  );
}

const ITEMS: MenuEntry[] = [
  { id: "a", label: "Alpha", testId: "item-a", onSelect: () => {} },
  { id: "b", label: "Bravo", testId: "item-b", onSelect: () => {} },
  { separator: true },
  { id: "c", label: "Charlie", testId: "item-c", onSelect: () => {} },
];

describe("ds Menu keyboard", () => {
  it("focuses the first item on open and roves with the arrows, wrapping", () => {
    render(<Harness items={ITEMS} />);
    fireEvent.click(screen.getByTestId("trigger"));
    const a = screen.getByTestId("item-a");
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));
    // The separator is not an item; the arrows walk past it.
    fireEvent.keyDown(screen.getByTestId("item-b"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-c"));
    fireEvent.keyDown(screen.getByTestId("item-c"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("item-c"));
    fireEvent.keyDown(screen.getByTestId("item-c"), { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("item-c"));
  });

  it("skips disabled items", () => {
    const items: MenuEntry[] = [
      { id: "a", label: "Alpha", testId: "item-a", onSelect: () => {} },
      { id: "b", label: "Bravo", testId: "item-b", disabled: true, onSelect: () => {} },
      { id: "c", label: "Charlie", testId: "item-c", onSelect: () => {} },
    ];
    render(<Harness items={items} />);
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.keyDown(screen.getByTestId("item-a"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-c"));
  });

  it("Escape closes and returns focus to the trigger", () => {
    render(<Harness items={ITEMS} />);
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.keyDown(screen.getByTestId("item-a"), { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("trigger"));
  });

  it("activates on click and renders separators, captions and radio gutters", () => {
    let picked = "";
    const items: MenuEntry[] = [
      { id: "a", label: "Alpha", testId: "item-a", checked: false, onSelect: () => (picked = "a") },
      { id: "b", label: "Bravo", testId: "item-b", checked: true, onSelect: () => (picked = "b") },
    ];
    render(<Harness caption="Next turn runs on" items={items} />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByText("Next turn runs on")).toBeTruthy();
    expect(screen.getByTestId("item-b").textContent).toContain("✓");
    expect(screen.getByTestId("item-a").textContent).not.toContain("✓");
    fireEvent.click(screen.getByTestId("item-b"));
    expect(picked).toBe("b");
  });

  it("closes on a pointerdown outside, not inside", () => {
    render(<Harness items={ITEMS} />);
    fireEvent.click(screen.getByTestId("trigger"));
    fireEvent.pointerDown(screen.getByTestId("item-a"));
    expect(screen.queryByTestId("panel")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("choreographs children-drawn items exactly like declarative ones", () => {
    // The migrated menus draw their own item JSX so the e2e test ids stay
    // literal attributes (scripts/check-testids.mjs). The keyboard, the
    // first-item focus and Esc must treat those items identically.
    function ChildrenMenu() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <div className="relative">
          <button
            ref={triggerRef}
            type="button"
            data-testid="trigger"
            onClick={() => setOpen((current) => !current)}
          >
            open
          </button>
          <Menu
            open={open}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
            data-testid="panel"
            ariaLabel="children"
          >
            <button type="button" role="menuitem" data-testid="item-a" className={MENU_ITEM_CLASS}>
              Alpha
            </button>
            <div role="separator" className="my-1 h-px bg-line" />
            <button type="button" role="menuitem" data-testid="item-b" className={MENU_ITEM_CLASS}>
              Bravo
            </button>
          </Menu>
        </div>
      );
    }
    render(<ChildrenMenu />);
    fireEvent.click(screen.getByTestId("trigger"));
    expect(document.activeElement).toBe(screen.getByTestId("item-a"));
    fireEvent.keyDown(screen.getByTestId("item-a"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("item-b"));
    fireEvent.keyDown(screen.getByTestId("item-b"), { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("trigger"));
  });
});

describe("ds Menu placement and the pointer arrow", () => {
  it("renders the arrow inside the menu box", () => {
    render(<Harness items={ITEMS} />);
    fireEvent.click(screen.getByTestId("trigger"));
    const arrow = screen.getByTestId("menu-arrow");
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("panel").contains(arrow)).toBe(true);
    // 9px square, ink-bordered two sides, rotated 45°.
    expect(arrow.style.width).toBe("9px");
    expect(arrow.style.height).toBe("9px");
    expect(arrow.style.transform).toContain("rotate(45deg)");
    expect(screen.getByTestId("panel").getAttribute("role")).toBe("menu");
    // Separators carry the role and never take an item's place.
    expect(screen.getByTestId("panel").querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(screen.getByTestId("panel").querySelectorAll('[role="menuitem"]')).toHaveLength(3);
  });

  it("keeps the arrow centered on the trigger while the box is clamped to the viewport", () => {
    render(<Harness items={ITEMS} />);
    const trigger = screen.getByTestId("trigger");
    // Trigger at x 250…298 (center 274) in a 300px viewport: the 180px box
    // anchored at 250 would end at 430 — it clamps to viewport-left 112
    // (right edge exactly on the 8px margin), and the arrow must still
    // point at 274.
    trigger.getBoundingClientRect = () => rect(250, 0);
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 300 });
    fireEvent.click(trigger);
    const panel = screen.getByTestId("panel");
    const arrow = screen.getByTestId("menu-arrow");
    expect(panel.style.left).toBe("112px");
    expect(arrow.style.left).toBe("162px"); // 274 - 112: box clamped, arrow centered
    expect(112 + 180).toBe(300 - 8); // the clamp sits on the margin
  });

  it("flips above the trigger when the bottom edge has no room", () => {
    render(<Harness items={ITEMS} height={100} />);
    const trigger = screen.getByTestId("trigger");
    // Trigger's bottom is 2px from the 768px viewport floor: the 100px box
    // cannot fit below, so it lands above — top 740 - 4 - 100 = 636.
    trigger.getBoundingClientRect = () => rect(10, 740);
    fireEvent.click(trigger);
    const panel = screen.getByTestId("panel");
    expect(panel.getAttribute("data-side")).toBe("top");
    expect(panel.style.top).toBe("636px");
    expect(screen.getByTestId("menu-arrow").className).toContain("border-b");
  });

  it("places side flyouts to the right of the trigger", () => {
    render(<Harness items={ITEMS} side="right" />);
    const trigger = screen.getByTestId("trigger");
    trigger.getBoundingClientRect = () => rect(10, 300);
    fireEvent.click(trigger);
    const panel = screen.getByTestId("panel");
    expect(panel.getAttribute("data-side")).toBe("right");
    expect(panel.style.left).toBe("62px"); // 10 + 48 + 4 gap
    // Arrow rides the trigger's vertical center (313): 313 - panel top 300.
    expect(screen.getByTestId("menu-arrow").style.top).toBe("13px");
    expect(screen.getByTestId("menu-arrow").className).toContain("border-t");
  });
});

describe("ds Popover", () => {
  it("holds free content, shows the arrow, and Esc closes with focus returned", () => {
    function Flyout() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <div className="relative">
          <button ref={triggerRef} type="button" data-testid="tile" onClick={() => setOpen(true)}>
            NW
          </button>
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
            data-testid="flyout"
            ariaLabel="Northwind"
            side="right"
            width={220}
          >
            <p>storefront</p>
          </Popover>
        </div>
      );
    }
    render(<Flyout />);
    fireEvent.click(screen.getByTestId("tile"));
    expect(screen.getByTestId("flyout").textContent).toContain("storefront");
    expect(screen.getByTestId("menu-arrow")).toBeTruthy();
    expect(screen.getByTestId("flyout").style.width).toBe("220px");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("flyout")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("tile"));
  });
});
