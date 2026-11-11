/**
 * The brief's section frame and its five row shapes (ADR-0081 § the sections).
 *
 * What the tests hold: a section that received no rows is NO section at all;
 * the head counts the rows the cap cut as well as the ones it shows, and names
 * them on the right; a PR row says "opened" and never "merged" (the ref is
 * labelled data from the run's own outputs, not reconciled GitHub state); a run
 * with no executing step reads "queued" rather than a guessed step; and a broke
 * row says WHICH sentence it is — still failing, or fixed at a moment.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  BriefBrokeRow,
  BriefChangeRow,
  BriefHeadsUpRow,
  BriefRunningRow,
  BriefSection,
  BriefShippedRow,
  shippedRefLabel,
} from "./BriefSection";
import { BRIEF_NOW, fullBrief } from "./briefFixtures";

afterEach(cleanup);

describe("BriefSection", () => {
  it("is no box at all when the section is empty", () => {
    const { container } = render(
      <BriefSection testid="catchup-brief-shipped" title="SHIPPED" count={0} omitted={0}>
        <div>row</div>
      </BriefSection>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("counts its rows in the head and names the cut rows on the right", () => {
    render(
      <BriefSection testid="catchup-brief-shipped" title="SHIPPED" count={7} omitted={4}>
        <div>row</div>
      </BriefSection>,
    );
    const head = screen.getByTestId("catchup-brief-shipped").querySelector("h2");
    expect(head?.textContent).toContain("SHIPPED · 7");
    expect(head?.textContent).toContain("and 4 more");
  });

  it("says nothing about more rows when the cap cut none", () => {
    render(
      <BriefSection testid="catchup-brief-shipped" title="SHIPPED" count={2} omitted={0}>
        <div>row</div>
      </BriefSection>,
    );
    expect(screen.getByTestId("catchup-brief-shipped").textContent).not.toContain("more");
  });
});

function row(ui: React.ReactElement) {
  render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("section rows", () => {
  it("running: step and age, and 'queued' when nothing is executing", () => {
    row(<BriefRunningRow row={fullBrief.running_now[0]!} now={BRIEF_NOW} />);
    const running = screen.getByTestId(/^catchup-brief-running-/);
    expect(running.textContent).toContain("Add idempotency keys to refunds");
    expect(running.textContent).toContain("billing-service");
    expect(running.textContent).toContain("step implement · 6m");
    cleanup();
    row(<BriefRunningRow row={fullBrief.running_now[1]!} now={BRIEF_NOW} />);
    const queued = screen.getByTestId(/^catchup-brief-running-/);
    expect(queued.textContent).toContain("queued · 20m");
    // The step the UI did not have is never invented.
    expect(queued.textContent).not.toContain("step ");
  });

  it("shipped: the ref chip labels the row, and a PR says opened — never merged", () => {
    const [pr, commit, revision] = fullBrief.shipped;
    expect(shippedRefLabel(pr!)).toBe("PR #412");
    expect(shippedRefLabel(commit!)).toBe("commit 27fb429");
    expect(shippedRefLabel(revision!)).toBe("workflow");
    row(<BriefShippedRow row={pr!} now={BRIEF_NOW} />);
    const line = screen.getByTestId(/^catchup-brief-shipped-/);
    expect(line.textContent).toContain("opened by ravi · 9m");
    expect(line.textContent).not.toContain("merged");
    cleanup();
    row(<BriefShippedRow row={revision!} now={BRIEF_NOW} />);
    const rev = screen.getByTestId(/^catchup-brief-shipped-/);
    expect(rev.textContent).toContain("by a teammate · 16h");
    expect(rev.textContent).not.toContain("opened");
  });

  it("shipped: a run with no human names no actor", () => {
    row(<BriefShippedRow row={{ ...fullBrief.shipped[1]!, by: "" }} now={BRIEF_NOW} />);
    const line = screen.getByTestId(/^catchup-brief-shipped-/);
    expect(line.textContent).toContain("commit 27fb429");
    expect(line.textContent).toContain("web-app");
    expect(line.textContent).toContain("8h");
    // No `by`, so no bare "by" either — the row says nothing about an actor.
    expect(line.textContent).not.toContain("by ");
  });

  it("broke: the dot and the words agree on still failing versus fixed", () => {
    const [failing, fixed] = fullBrief.broke;
    row(<BriefBrokeRow row={failing!} now={BRIEF_NOW} />);
    const red = screen.getByTestId(/^catchup-brief-broke-/);
    expect(red.textContent).toContain("3 failures · test · still failing");
    expect(red.querySelector("span")?.className).toContain("bg-seg-failed");
    cleanup();
    row(<BriefBrokeRow row={fixed!} now={BRIEF_NOW} />);
    const done = screen.getByTestId(/^catchup-brief-broke-/);
    expect(done.textContent).toContain("1 failure · infra · fixed 18h ago");
    expect(done.querySelector("span")?.className).toContain("bg-st-done-strong");
    expect(done.textContent).not.toContain("still failing");
  });

  it("broke: no error class is no separator either", () => {
    row(<BriefBrokeRow row={{ ...fullBrief.broke[0]!, error_class: "" }} now={BRIEF_NOW} />);
    expect(screen.getByTestId(/^catchup-brief-broke-/).textContent).toContain(
      "3 failures · still failing",
    );
  });

  it("heads-up: the signal is the uppercase word the reader scans for", () => {
    row(<BriefHeadsUpRow row={fullBrief.heads_up[0]!} />);
    const line = screen.getByTestId(/^catchup-brief-heads-up-/);
    expect(line.textContent).toContain("PUSH TO MAIN");
    expect(line.textContent).toContain("Pin the shared lint config on main");
    expect(line.querySelector("span")?.className).toContain("border-line");
    expect(line.querySelector("span")?.className).toContain("rounded-[3px]");
  });

  it("changes: the verb, the quoted title, the actor and the age", () => {
    row(<BriefChangeRow row={fullBrief.changes[0]!} now={BRIEF_NOW} />);
    const published = screen.getByTestId(/^catchup-brief-change-/);
    expect(published.textContent).toContain("Published");
    expect(published.textContent).toContain('"Issue to draft PR v3"');
    expect(published.textContent).toContain("ravi · 25m");
    cleanup();
    row(<BriefChangeRow row={fullBrief.changes[1]!} now={BRIEF_NOW} />);
    const member = screen.getByTestId(/^catchup-brief-change-/);
    // `memberships` stores no inviter: no actor is drawn, and none is guessed.
    expect(member.textContent).toContain("Added");
    expect(member.textContent).toContain("2d");
    expect(member.textContent).not.toContain("· ·");
  });
});
