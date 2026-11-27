import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalFrame } from "./GoalFrame";
import type { GoalKind } from "./wrapModel";

afterEach(cleanup);

const RECT = { x: 100, y: 60, width: 240, height: 320 };

/** The header glyph's classes (Tabler names the icon in `tabler-icon-<name>`). */
function iconClass(): string {
  return screen.getByTestId("goal-frame-icon").getAttribute("class") ?? "";
}

describe("GoalFrame", () => {
  // Review-1 finding 39: the header icon follows the goal kind, so the frame
  // says what it is judged by at a glance, as the wrap panel's choices do.
  it("draws the header glyph of the goal kind", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    expect(iconClass()).toContain("tabler-icon-gavel");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "command", text: "pnpm test", maxRounds: 3 }} />);
    expect(iconClass()).toContain("tabler-icon-terminal-2");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "contains", text: "LGTM", maxRounds: 3 }} />);
    expect(iconClass()).toContain("tabler-icon-text-scan-2");
  });

  it("keeps the repeat glyph for a goal kind this build does not know", () => {
    render(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "parallel" as GoalKind, text: "Ready", maxRounds: 3 }}
      />,
    );
    expect(iconClass()).toContain("tabler-icon-repeat");
  });

  it("renders sentence, typographic quotes, and font per kind", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "All tests pass", maxRounds: 3 }} />,
    );
    expect(screen.getByText("Repeat until a judge says:")).toBeTruthy();
    expect(screen.getByTestId("goal-frame-text").textContent).toBe("“All tests pass”");
    expect(screen.getByTestId("goal-frame-text").className).toContain("font-ui");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "command", text: "pnpm test", maxRounds: 3 }} />);
    expect(screen.getByText("Repeat until this command passes:")).toBeTruthy();
    expect(screen.getByTestId("goal-frame-text").textContent).toBe("“pnpm test”");
    expect(screen.getByTestId("goal-frame-text").className).toContain("font-mono");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "contains", text: "LGTM", maxRounds: 3 }} />);
    expect(screen.getByText("Repeat until the output contains:")).toBeTruthy();
    expect(screen.getByTestId("goal-frame-text").textContent).toBe("“LGTM”");
    expect(screen.getByTestId("goal-frame-text").className).toContain("font-mono");
  });

  it("renders default and custom giveUpText in the footer", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    expect(screen.getByTestId("goal-frame-footer").textContent).toBe("up to 3 rounds · then stop");

    rerender(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 1 }}
        giveUpText="then ask Ada"
      />,
    );
    expect(screen.getByTestId("goal-frame-footer").textContent).toBe(
      "up to 1 round · then ask Ada",
    );
  });

  it("swaps the static border for MarchingAnts when running is true", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    expect(screen.queryByTestId("goal-frame-ants")).toBeNull();
    expect(screen.getByTestId("goal-frame").style.border).toContain("1.5px solid");

    rerender(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} running />,
    );
    expect(screen.getByTestId("goal-frame-ants")).toBeTruthy();
    expect(screen.getByTestId("goal-frame").style.border).toContain("transparent");
  });

  it("carries the loop's own run state as glyph + word in the header", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    // While editing there is no run state to print, and none appears.
    expect(screen.queryByTestId("goal-frame-status")).toBeNull();

    rerender(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 3 }}
        running
        status={{ text: "● iteration 2 of 3", className: "text-st-running-pale-fg" }}
      />,
    );
    const status = screen.getByTestId("goal-frame-status");
    expect(status.textContent).toBe("● iteration 2 of 3");
    expect(status.getAttribute("title")).toBe("● iteration 2 of 3");
    expect(status.className).toContain("text-st-running-pale-fg");
  });

  it("renders a clickable header button when onHeaderClick is passed", () => {
    const onHeaderClick = vi.fn();
    render(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 3 }}
        onHeaderClick={onHeaderClick}
      />,
    );
    fireEvent.click(screen.getByTestId("goal-frame-header"));
    expect(onHeaderClick).toHaveBeenCalledTimes(1);
  });
});
