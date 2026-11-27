import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DragGhost, snapToGrid20 } from "./DragGhost";

afterEach(cleanup);

describe("snapToGrid20", () => {
  it("rounds to the nearest 20px and never goes above the origin", () => {
    expect(snapToGrid20(29)).toBe(20);
    expect(snapToGrid20(31)).toBe(40);
    expect(snapToGrid20(-15)).toBe(0);
    expect(snapToGrid20(0)).toBe(0);
    expect(snapToGrid20(160)).toBe(160);
  });
});

describe("DragGhost", () => {
  it("draws the snap target on the grid and the hatch 6px down-right", () => {
    render(<DragGhost x={213} y={137} width={168} height={56} />);
    const target = screen.getByTestId("drag-snap-target");
    const hatch = screen.getByTestId("drag-hatch");
    expect(target.style.left).toBe("220px");
    expect(target.style.top).toBe("140px");
    expect(hatch.style.left).toBe("219px");
    expect(hatch.style.top).toBe("143px");
    for (const el of [target, hatch]) {
      expect(el.style.width).toBe("168px");
      expect(el.style.height).toBe("56px");
      expect(el.style.pointerEvents).toBe("none");
      expect(el.getAttribute("aria-hidden")).toBe("true");
    }
    // jsdom normalises the hex to rgb() when it round-trips the shorthand.
    expect(target.style.border).toMatch(/^1\.5px dashed (#b3ada2|rgb\(179, 173, 162\))$/);
    expect(target.style.borderRadius).toBe("10px");
    expect(target.style.boxSizing).toBe("border-box");
    expect(hatch.style.background).toMatch(
      /repeating-linear-gradient\(135deg, (#b3ada2|rgb\(179, 173, 162\)) 0 1px, transparent 1px 4px\)/,
    );
    expect(hatch.style.borderRadius).toBe("10px");
  });

  it("keeps the hatch behind the node lane", () => {
    render(<DragGhost x={0} y={0} width={200} height={80} />);
    // Steps sit at z-index 2 and notes at 1: the ghost is under both.
    expect(screen.getByTestId("drag-hatch").style.zIndex).toBe("0");
    expect(screen.getByTestId("drag-snap-target").style.zIndex).toBe("0");
  });
});
