import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictStack } from "./VerdictStack";

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
});
