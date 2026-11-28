import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BesideCard, placeBesideCard } from "./BesideCard";

afterEach(cleanup);

describe("placeBesideCard", () => {
  it("places the card to the right with the caret centred on the selection", () => {
    const p = placeBesideCard(
      { x: 100, y: 100, width: 180, height: 70 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
    );
    expect(p).toEqual({ side: "right", left: 298, top: 35, caret: 100 });
  });

  it("honours a custom gap", () => {
    const p = placeBesideCard(
      { x: 100, y: 100, width: 180, height: 70 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
      30,
    );
    expect(p.left).toBe(310);
  });

  it("flips to the left when the card overflows on the right", () => {
    const p = placeBesideCard(
      { x: 900, y: 100, width: 180, height: 70 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
    );
    expect(p.side).toBe("left");
    expect(p.left).toBe(542); // 900 - 18 - 340
    expect(p.top).toBe(35);
    expect(p.caret).toBe(100);
  });

  it("goes below when neither side fits", () => {
    const p = placeBesideCard(
      { x: 200, y: 100, width: 900, height: 60 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
    );
    expect(p.side).toBe("below");
    expect(p.top).toBe(178); // 100 + 60 + 18
    expect(p.left).toBe(480); // centred on the selection
    expect(p.caret).toBe(170); // centred on the card's left edge
  });

  it("clamps the caret to 16px from the card's top edge", () => {
    const p = placeBesideCard(
      { x: 100, y: 0, width: 180, height: 40 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
    );
    expect(p.side).toBe("right");
    expect(p.top).toBe(8);
    expect(p.caret).toBe(16); // raw caret would be 12
  });

  it("clamps the caret away from the card's bottom edge", () => {
    const p = placeBesideCard(
      { x: 100, y: 760, width: 180, height: 60 },
      { w: 340, h: 200 },
      { w: 1200, h: 800 },
    );
    expect(p.top).toBe(592);
    expect(p.caret).toBe(184); // card.h - 16
  });

  it("clamps the caret on the below axis when the card is pinned to the pane edge", () => {
    const p = placeBesideCard(
      { x: 0, y: 100, width: 20, height: 40 },
      { w: 340, h: 200 },
      { w: 300, h: 800 },
    );
    expect(p.side).toBe("below");
    expect(p.left).toBe(8);
    expect(p.caret).toBe(16);
  });

  it("keeps the raw right position while the pane is unmeasured", () => {
    const p = placeBesideCard(
      { x: 900, y: 600, width: 180, height: 70 },
      { w: 340, h: 200 },
      { w: 0, h: 0 },
    );
    expect(p).toEqual({ side: "right", left: 1098, top: 535, caret: 100 });
  });
});

describe("BesideCard", () => {
  it("renders the title, subtitle and body", () => {
    render(
      <BesideCard title="INSERT STEP" subtitle="after “implement”" testid="insert-card">
        <p>body</p>
      </BesideCard>,
    );
    const card = screen.getByTestId("insert-card");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("INSERT STEP");
    expect(screen.getByText("INSERT STEP").textContent).toBe("INSERT STEP");
    expect(screen.getByText("after “implement”").textContent).toBe("after “implement”");
    expect(screen.getByText("body").textContent).toBe("body");
  });

  it("shows the × button only with onClose and calls it on click", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <BesideCard title="NOTE" onClose={onClose}>
        <p>note</p>
      </BesideCard>,
    );
    fireEvent.click(screen.getByTestId("beside-card-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <BesideCard title="NOTE">
        <p>note</p>
      </BesideCard>,
    );
    expect(screen.queryByTestId("beside-card-close")).toBeNull();
  });

  it("calls onClose on Escape inside the card", () => {
    const onClose = vi.fn();
    render(
      <BesideCard title="AGENT STEP" onClose={onClose}>
        <input data-testid="inner" />
      </BesideCard>,
    );
    fireEvent.keyDown(screen.getByTestId("inner"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the caret on the phone sheet", () => {
    render(
      <BesideCard title="AGENT STEP" sheet side="right" caret={100} onClose={() => {}}>
        <p>body</p>
      </BesideCard>,
    );
    expect(screen.queryByTestId("beside-card-caret")).toBeNull();
    expect(screen.getByTestId("beside-card").className).toContain("rounded-t-[14px]");
  });

  it("renders no caret without a side", () => {
    render(
      <BesideCard title="NOTE" caret={100}>
        <p>body</p>
      </BesideCard>,
    );
    expect(screen.queryByTestId("beside-card-caret")).toBeNull();
  });

  it("falls back to a corner caret when only a side is given", () => {
    render(
      <BesideCard title="NOTE" side="right">
        <p>body</p>
      </BesideCard>,
    );
    expect(screen.getByTestId("beside-card-caret").style.top).toBe("-6px");
  });

  it.each([
    ["right", "left-[-7px]", "border-b", "border-l", { top: "94px" }],
    ["left", "right-[-7px]", "border-t", "border-r", { top: "94px" }],
    ["below", "top-[-7px]", "border-t", "border-l", { left: "94px" }],
  ] as const)("points the caret out of the %s edge", (side, offset, b1, b2, expected) => {
    render(
      <BesideCard title="NOTE" side={side} caret={100}>
        <p>body</p>
      </BesideCard>,
    );
    const caret = screen.getByTestId("beside-card-caret");
    expect(caret.className).toContain(offset);
    expect(caret.className).toContain(b1);
    expect(caret.className).toContain(b2);
    expect(caret.className).toContain("rotate-45");
    Object.entries(expected).forEach(([cssProp, value]) => {
      expect((caret.style as unknown as Record<string, string>)[cssProp]).toBe(value);
    });
  });

  it("defaults to a 340px card and accepts a width override", () => {
    const { unmount } = render(
      <BesideCard title="AGENT STEP">
        <p>body</p>
      </BesideCard>,
    );
    expect(screen.getByTestId("beside-card").style.width).toBe("340px");
    unmount();

    render(
      <BesideCard title="INSERT STEP" width={260}>
        <p>body</p>
      </BesideCard>,
    );
    expect(screen.getByTestId("beside-card").style.width).toBe("260px");
  });
});
