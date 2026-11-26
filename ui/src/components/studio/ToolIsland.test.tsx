import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolIsland } from "./ToolIsland";

afterEach(cleanup);

/**
 * Review-1 09-1280-2 + 10-390-1: the island's top edge sits 40px below the
 * top bar (README “(16, 100)” is viewport px: 60px bar + 40px), and on a
 * touch device it never widens past 48px — the hover/focus widening is
 * gated to a fine pointer, and a tap no longer toggles it open (a tap
 * sticks :hover and focuses the pressed button on touch).
 */
it("sits 40px below the top bar and stays 48px on touch", () => {
  render(
    <ToolIsland
      tool="select"
      onTool={vi.fn()}
      onAddStep={vi.fn()}
      onMoreSteps={vi.fn()}
      disabled={false}
    />,
  );
  const island = screen.getByTestId("tool-island");
  expect(island.className).toContain("top-[40px]");
  expect(island.className).toContain("left-4");
  expect(island.className).toContain("w-[48px]");
  // Only pointer-fine variants widen it — a plain hover:/focus-within:
  // would catch the stuck touch hover.
  expect(island.className).toContain("pointer-fine:hover:w-[176px]");
  expect(island.className).toContain("pointer-fine:focus-within:w-[176px]");
  expect(island.className).not.toMatch(/(^|\s)hover:w-\[176px\]/);
  expect(island.className).not.toMatch(/(^|\s)focus-within:w-\[176px\]/);
  // A touch pointerdown anywhere on the island keeps it at 48px.
  fireEvent.pointerDown(island, { pointerType: "touch" });
  expect(screen.getByTestId("tool-island").className).toContain("w-[48px]");

  // In the app-shell phone band the widening classes are dropped entirely
  // (CONTRACT: “the tool island stays 48px”).
  render(
    <ToolIsland
      tool="select"
      narrow
      onTool={vi.fn()}
      onAddStep={vi.fn()}
      onMoreSteps={vi.fn()}
      disabled={false}
    />,
  );
  const phoneIsland = screen.getAllByTestId("tool-island").at(-1) as HTMLElement;
  expect(phoneIsland.className).not.toContain("w-[176px]");
  expect(phoneIsland.className).toContain("top-[40px]");
});

/** Review-1 10-1280-1: keys are one style; only the label bolds. */
it("renders every tool key in one muted normal-weight style", () => {
  render(
    <ToolIsland
      tool="select"
      onTool={vi.fn()}
      onAddStep={vi.fn()}
      onMoreSteps={vi.fn()}
      disabled={false}
    />,
  );
  const island = screen.getByTestId("tool-island");
  const keys = Array.from(island.querySelectorAll("span")).filter((span) =>
    /^(V|H|B|C)$/.test(span.textContent ?? ""),
  );
  expect(keys.length).toBe(4);
  for (const key of keys) {
    expect(key.className).toContain("font-mono");
    expect(key.className).toContain("font-normal");
    expect(key.className).toContain("text-muted");
  }
});

it("exposes the tools, active state, additions and disabled state", () => {
  const onTool = vi.fn();
  const onAddStep = vi.fn();
  const onMoreSteps = vi.fn();
  const props = { tool: "select" as const, onTool, onAddStep, onMoreSteps, disabled: false };
  const { rerender } = render(<ToolIsland {...props} />);
  const toolbar = screen.getByRole("toolbar", { name: "Canvas tools" });
  expect(
    within(toolbar).getByRole("button", { name: "Select (V)" }).getAttribute("aria-pressed"),
  ).toBe("true");
  for (const name of ["Move around (H)", "Box select (B)", "Connect (C)"])
    expect(within(toolbar).getByRole("button", { name }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  fireEvent.click(within(toolbar).getByRole("button", { name: "Move around (H)" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "Agent" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "More steps…" }));
  expect(onTool).toHaveBeenCalledWith("move");
  expect(onAddStep).toHaveBeenCalledWith("agent.acp");
  expect(onMoreSteps).toHaveBeenCalledOnce();
  rerender(<ToolIsland {...props} disabled />);
  expect(
    within(toolbar)
      .getAllByRole("button")
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
});
