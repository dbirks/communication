import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolIsland } from "./ToolIsland";

afterEach(cleanup);
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
