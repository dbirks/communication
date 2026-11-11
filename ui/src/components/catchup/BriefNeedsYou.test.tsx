/**
 * NEEDS YOU (ADR-0081 § needs_you): the panel's rows come out in the SERVER's
 * order — oldest first, because the item that has waited longest is the one
 * somebody else is blocked on — and each row is the link to where the reader
 * actually answers it. The age is the row's own argument, so it is asserted
 * against a fixed clock.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BriefNeedsYou } from "./BriefNeedsYou";
import { BRIEF_NOW, fullBrief, quietBrief } from "./briefFixtures";

afterEach(cleanup);

function mount(needs: typeof fullBrief.needs_you) {
  render(
    <MemoryRouter>
      <BriefNeedsYou needs={needs} now={BRIEF_NOW} />
    </MemoryRouter>,
  );
  return screen.queryByTestId("catchup-brief-needs-you");
}

describe("BriefNeedsYou", () => {
  it("is absent when nothing waits on the reader", () => {
    expect(mount(quietBrief.needs_you)).toBeNull();
  });

  it("counts itself and keeps the API's oldest-first order", () => {
    const panel = mount(fullBrief.needs_you);
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("needs you · 3");
    const rows = screen.getAllByTestId(/^catchup-brief-need-/);
    expect(rows).toHaveLength(3);
    // The fixture is deliberately NOT sorted by kind: the page must not re-sort
    // it, so the first row is the 2h-old question, not the approval.
    expect(rows[0]?.textContent).toContain("Alert routing: one tree or two?");
    expect(rows[1]?.textContent).toContain("Stabilise the invoice export test");
    expect(rows[2]?.textContent).toContain("Rotate the payments webhook secret");
  });

  it("draws each kind's glyph, its project and its age in the one unit it reads at", () => {
    mount(fullBrief.needs_you);
    const [question, failedRun, approval] = screen.getAllByTestId(/^catchup-brief-need-/);
    // 2h, 3m and 15m against BRIEF_NOW.
    expect(question?.textContent).toContain("2h");
    expect(failedRun?.textContent).toContain("3m");
    expect(approval?.textContent).toContain("15m");
    expect(question?.textContent).toContain("infra");
    expect(approval?.textContent).toContain("billing-service");
    // The failed run's glyph is the warning triangle in the failure red; the
    // other two kinds have their own shapes, so kind is never colour alone.
    expect(screen.getByTestId("catchup-brief-failed-glyph")).toBeDefined();
    expect(question?.querySelectorAll("svg")).toHaveLength(1);
  });

  it("links a row to the page that answers it and carries the ask as its title", () => {
    mount(fullBrief.needs_you);
    const approval = screen.getByTestId("catchup-brief-need-2");
    expect(approval.getAttribute("href")).toBe("/approvals/01987a90-0000-7000-8000-666666666666");
    expect(approval.getAttribute("title")).toBe("Approve plan: rotate webhook secret");
    // The row is 40px and the title truncates: a long ask never grows the panel.
    expect(approval.className).toContain("h-[40px]");
    expect(approval.className).toContain("items-center");
  });
});
