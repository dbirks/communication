import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GoalFrame } from "./GoalFrame";

afterEach(cleanup);

const RECT = { x: 100, y: 60, width: 240, height: 320 };

describe("GoalFrame", () => {
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
});
