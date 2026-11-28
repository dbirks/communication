import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalFrame } from "./GoalFrame";
import type { GoalKind } from "./wrapModel";

afterEach(cleanup);

const RECT = { x: 100, y: 60, width: 240, height: 320 };

/** The tab glyph's classes (Tabler names the icon in `tabler-icon-<name>`). */
function iconClass(): string {
  return screen.getByTestId("goal-frame-icon").getAttribute("class") ?? "";
}

describe("GoalFrame", () => {
  // Design 1g: the frame stopped being blue. The tab on the border names the
  // loop kind; every Repeat-until goal reads "REPEAT UNTIL" with the repeat
  // glyph, side-by-side wraps read "SIDE BY SIDE".
  it("shows the REPEAT UNTIL tab with the repeat glyph", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    expect(screen.getByTestId("goal-frame-tab").textContent).toBe("REPEAT UNTIL");
    expect(iconClass()).toContain("tabler-icon-repeat");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "command", text: "pnpm test", maxRounds: 3 }} />);
    expect(screen.getByTestId("goal-frame-tab").textContent).toBe("REPEAT UNTIL");
    expect(iconClass()).toContain("tabler-icon-repeat");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "contains", text: "LGTM", maxRounds: 3 }} />);
    expect(screen.getByTestId("goal-frame-tab").textContent).toBe("REPEAT UNTIL");
    expect(iconClass()).toContain("tabler-icon-repeat");
  });

  it("shows the SIDE BY SIDE tab for variant=side", () => {
    render(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 3 }}
        variant="side"
      />,
    );
    expect(screen.getByTestId("goal-frame-tab").textContent).toBe("SIDE BY SIDE");
    expect(iconClass()).toContain("tabler-icon-columns");
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

  it("names the checker per goal kind under the quoted goal", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "All tests pass", maxRounds: 3 }} />,
    );
    expect(screen.getByTestId("goal-frame-checker").textContent).toBe("a judge decides");
    expect(screen.getByTestId("goal-frame-text").textContent).toBe("“All tests pass”");
    expect(screen.getByTestId("goal-frame-text").className).toContain("font-ui");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "command", text: "pnpm test", maxRounds: 3 }} />);
    expect(screen.getByTestId("goal-frame-checker").textContent).toBe("a command passes");
    expect(screen.getByTestId("goal-frame-text").textContent).toBe("“pnpm test”");
    expect(screen.getByTestId("goal-frame-text").className).toContain("font-mono");

    rerender(<GoalFrame rect={RECT} goal={{ kind: "contains", text: "LGTM", maxRounds: 3 }} />);
    expect(screen.getByTestId("goal-frame-checker").textContent).toBe("the output contains …");
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

  // Design 1g: the box is 1px #cfc9bd on a #faf9f6 fill; selection is ink, not
  // blue. No inline blue border or blue fill survives anywhere.
  it("draws the ink frame with no blue style when not running", () => {
    render(<GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />);
    const frame = screen.getByTestId("goal-frame");
    expect(frame.getAttribute("style") ?? "").not.toContain("#2f4bd6");
    expect(frame.style.border).toBe("");
    expect(frame.className).toContain("border-fill-edge");
    expect(frame.className).toContain("bg-rail");
    expect(frame.className).not.toContain("shadow-(--shadow-node-selected)");
  });

  it("adds the ink border and ink shadow when selected", () => {
    render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} selected />,
    );
    const frame = screen.getByTestId("goal-frame");
    expect(frame.className).toContain("border-ink");
    expect(frame.className).toContain("shadow-(--shadow-node-selected)");
    expect(frame.className).not.toContain("border-fill-edge");
  });

  it("swaps the static border for MarchingAnts when running is true", () => {
    const { rerender } = render(
      <GoalFrame rect={RECT} goal={{ kind: "judge", text: "Ready", maxRounds: 3 }} />,
    );
    expect(screen.queryByTestId("goal-frame-ants")).toBeNull();

    rerender(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 3 }}
        running
        selected
      />,
    );
    expect(screen.getByTestId("goal-frame-ants")).toBeTruthy();
    expect(screen.getByTestId("goal-frame").style.border).toContain("transparent");
  });

  it("carries the loop's own run state as glyph + word in the footer", () => {
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

  // Design 1g: the TAB is the button, not the whole header.
  it("renders the tab as the clickable button when onHeaderClick is passed", () => {
    const onHeaderClick = vi.fn();
    render(
      <GoalFrame
        rect={RECT}
        goal={{ kind: "judge", text: "Ready", maxRounds: 3 }}
        onHeaderClick={onHeaderClick}
      />,
    );
    const header = screen.getByTestId("goal-frame-header");
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("type")).toBe("button");
    expect(header.getAttribute("aria-label")).toBe("Edit goal");
    expect(header.textContent).toBe("REPEAT UNTIL");
    fireEvent.click(header);
    expect(onHeaderClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("goal-frame-tab"));
    expect(onHeaderClick).toHaveBeenCalledTimes(2);
  });
});
