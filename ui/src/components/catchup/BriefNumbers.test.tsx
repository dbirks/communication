/**
 * The NUMBERS strip (ADR-0081 § numbers): one mono line, zero terms omitted,
 * and no strip at all when every number is zero — the quiet line owns that
 * sentence, and a strip of zeroes says nothing while pushing the terms that did
 * happen off the line.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BriefNumbers, numberTerms } from "./BriefNumbers";
import { emptyNumbers, fullBrief } from "./briefFixtures";

afterEach(cleanup);

describe("numberTerms", () => {
  it("reads the whole brief's arithmetic in one line", () => {
    expect(numberTerms(fullBrief.numbers)).toEqual([
      "12 succeeded",
      "3 failed",
      "1 cancelled",
      "2 running",
      "4 PRs",
      "1 commit",
      "2 approvals decided",
      "2 approvals waiting",
    ]);
  });

  it("omits a zero term and says one of a thing in the singular", () => {
    expect(
      numberTerms({
        runs: { succeeded: 1, failed: 0, cancelled: 0, running: 0 },
        approvals: { decided: 0, pending: 1 },
        threads_active: 3,
        prs: 1,
        commits: 0,
      }),
    ).toEqual(["1 succeeded", "1 PR", "1 approval waiting", "3 threads"]);
  });

  it("is empty when nothing moved", () => {
    expect(numberTerms(emptyNumbers)).toEqual([]);
  });
});

describe("BriefNumbers", () => {
  it("draws one mono line joined by middots", () => {
    render(<BriefNumbers numbers={fullBrief.numbers} />);
    const line = screen.getByTestId("catchup-brief-numbers");
    expect(line.textContent).toBe(
      "12 succeeded · 3 failed · 1 cancelled · 2 running · 4 PRs · 1 commit · 2 approvals decided · 2 approvals waiting",
    );
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-[11.5px]");
    expect(line.className).toContain("text-muted");
  });

  it("renders nothing when every number is zero", () => {
    const { container } = render(<BriefNumbers numbers={emptyNumbers} />);
    expect(container.innerHTML).toBe("");
  });
});
