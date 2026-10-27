/**
 * Panel's title bar is ONE line at any width (the 390px design check on
 * 2e/repo-1e): the observed failure was “WORKFLOWS ON THIS REPO · 4”
 * wrapping the count alone onto a second bar row and the
 * `+ use a library workflow` link onto two lines, because the flex items
 * shrank and their TEXT wrapped. The contract that prevents it: the title
 * ellipsises instead of wrapping (`min-w-0 truncate`) and the right slot
 * never shrinks or wraps (`shrink-0 whitespace-nowrap`). jsdom lays nothing
 * out, so — as elsewhere in this suite — the assertion is on the class
 * contract the renderer writes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel } from "./Panel";

afterEach(cleanup);

describe("Panel title bar", () => {
  it("keeps the title on one line (ellipsised) and the meta slot unwrapped", () => {
    render(
      <Panel
        title="WORKFLOWS ON THIS REPO · 4"
        headingId="h"
        headingLevel={2}
        meta={<button type="button">+ use workflow</button>}
      >
        <p>body</p>
      </Panel>,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.className).toContain("min-w-0");
    expect(heading.className).toContain("truncate"); // nowrap + clip, never a second bar row
    const bar = heading.parentElement as HTMLElement;
    expect(bar.className).toContain("flex");
    expect(bar.className).not.toContain("flex-wrap");
    const meta = bar.lastElementChild as HTMLElement;
    expect(meta.className).toContain("ml-auto");
    expect(meta.className).toContain("shrink-0");
    expect(meta.className).toContain("whitespace-nowrap");
  });

  it("keeps the same one-line rule on a state panel", () => {
    render(
      <Panel title="HANDOFF" state="failed" headingId="h2" headingLevel={3} meta="all ›">
        <p>body</p>
      </Panel>,
    );
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.className).toContain("truncate");
    const meta = (heading.parentElement as HTMLElement).lastElementChild as HTMLElement;
    expect(meta.className).toContain("whitespace-nowrap");
    // A state panel's meta keeps the bar's own strong color (no text-faint).
    expect(meta.className).not.toContain("text-faint");
  });
});
