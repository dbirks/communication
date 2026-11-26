import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictStack, verdictLabel, verdictWords } from "./VerdictStack";

afterEach(cleanup);

describe("VerdictStack", () => {
  it("renders all three verdict states with their colors and reasons", () => {
    render(
      <VerdictStack
        rounds={[
          { n: 1, verdict: "not_yet", reason: "Two unit tests failed." },
          { n: 2, verdict: "met", reason: "All checks pass." },
          { n: 3, verdict: "running", reason: "Checking build output." },
        ]}
      />,
    );
    expect(screen.getByTestId("verdict-stack")).toBeTruthy();

    const r1 = screen.getByTestId("verdict-round-1");
    expect(r1.textContent).toContain("Round 1");
    expect(r1.textContent).toContain("× not yet");
    expect(r1.textContent).toContain("Two unit tests failed.");
    expect(screen.getByText("× not yet").className).toContain("text-st-failed-tag-fg");

    const r2 = screen.getByTestId("verdict-round-2");
    expect(r2.textContent).toContain("Round 2");
    expect(r2.textContent).toContain("✓ goal met");
    expect(r2.textContent).toContain("All checks pass.");
    expect(screen.getByText("✓ goal met").className).toContain("bg-st-done-tag");
    expect(screen.getByText("✓ goal met").className).toContain("text-st-done-tag-fg");

    const r3 = screen.getByTestId("verdict-round-3");
    expect(r3.textContent).toContain("Round 3");
    expect(r3.textContent).toContain("● judging");
    expect(r3.textContent).toContain("Checking build output.");
    expect(screen.getByText("● judging").className).toContain("bg-st-running-tag");
    expect(screen.getByText("● judging").className).toContain("text-st-running-tag-fg");
  });

  // One set of words lied about two of the three goals: a loop that runs a
  // command did not "meet a goal", it checked and the check passed, and a loop
  // that looks for a string neither judged nor passed — it FOUND the thing.
  it("says each goal kind's own verdict", () => {
    const rounds = [
      { n: 1, verdict: "running" as const },
      { n: 2, verdict: "met" as const },
      { n: 3, verdict: "not_yet" as const },
    ];
    const { unmount } = render(<VerdictStack rounds={rounds} kind="command" />);
    expect(screen.getByTestId("verdict-round-1").textContent).toContain("● checking");
    expect(screen.getByTestId("verdict-round-2").textContent).toContain("✓ passed");
    expect(screen.getByTestId("verdict-round-3").textContent).toContain("× failed");
    unmount();

    render(<VerdictStack rounds={rounds} kind="contains" />);
    expect(screen.getByTestId("verdict-round-1").textContent).toContain("● checking");
    expect(screen.getByTestId("verdict-round-2").textContent).toContain("✓ found");
    expect(screen.getByTestId("verdict-round-3").textContent).toContain("× not found");
  });

  it("says a hand-written condition's verdict in generic words", () => {
    render(
      <VerdictStack
        rounds={[
          { n: 1, verdict: "not_yet", kind: "generic" },
          { n: 2, verdict: "running", kind: "generic" },
        ]}
      />,
    );
    // The kind rides on the rounds because that is the only thing the canvas
    // hands a stack (`nodes.tsx` forwards `rounds` and nothing else).
    expect(screen.getByTestId("verdict-round-1").textContent).toContain("× not yet");
    expect(screen.getByTestId("verdict-round-2").textContent).toContain("● running");
  });

  it("keeps the three goals' words and glyphs in one table", () => {
    expect(verdictWords("judge")).toEqual({
      running: "judging",
      met: "goal met",
      not_yet: "not yet",
    });
    expect(verdictLabel("command", "met")).toBe("✓ passed");
    expect(verdictLabel("contains", "not_yet")).toBe("× not found");
    expect(verdictLabel("generic", "running")).toBe("● running");
  });
});

describe("VerdictStack words", () => {
  it("glyphs match the state sets they stand for", () => {
    // ● running, ✓ done, × failed — the same glyphs ds/states.ts puts on a box.
    expect(verdictLabel("judge", "running")).toMatch(/^●/);
    expect(verdictLabel("judge", "met")).toMatch(/^✓/);
    expect(verdictLabel("judge", "not_yet")).toMatch(/^×/);
  });
});
