/**
 * The selected-step menu (design 1g): the floating two-item box right of the
 * node, and the DOCKED strip the narrow canvas falls back to when every
 * over-graph spot would cover another step (the pass-2 390px defect).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeMenu } from "./NodeMenu";

afterEach(cleanup);

function mountMenu(overrides: Partial<Parameters<typeof NodeMenu>[0]> = {}) {
  render(
    <NodeMenu
      x={303}
      y={100}
      nodeId="plan"
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
  return screen.getByTestId("studio-node-menu");
}

describe("NodeMenu", () => {
  it("floats at the coordinates the canvas derived, as 1g draws it", () => {
    const menu = mountMenu();
    expect(menu.getAttribute("data-docked")).toBe("false");
    expect(menu.style.left).toBe("303px");
    expect(menu.style.top).toBe("100px");
    expect(menu.className).toContain("absolute");
    // Duplicate over Delete, the design's order.
    expect(screen.getByTestId("studio-node-menu-duplicate").textContent).toBe("Duplicate");
    expect(screen.getByTestId("studio-node-menu-delete").textContent).toContain("Delete");
  });

  it("flows as its own strip when docked — no coordinates, nothing covered", () => {
    const menu = mountMenu({ docked: true });
    expect(menu.getAttribute("data-docked")).toBe("true");
    expect(menu.style.left).toBe("");
    expect(menu.style.top).toBe("");
    expect(menu.className).toContain("shrink-0");
    expect(menu.className).not.toContain("absolute");
    // The same two actions, so the keyboard path is identical either way.
    expect(screen.getByTestId("studio-node-menu-duplicate")).toBeTruthy();
    expect(screen.getByTestId("studio-node-menu-delete")).toBeTruthy();
  });
});
