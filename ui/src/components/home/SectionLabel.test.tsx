/**
 * SectionLabel / ColumnHeading: the mono label's colour rules (muted by
 * default, a status tone when the block is a live one, a decorative glyph that
 * still reads as glyph + word), and the column heading's 16/700 sentence-case
 * `<h3>` with its optional mono aside and its rule underneath.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ColumnHeading, SECTION_LABEL_CLASS, SectionLabel } from "./SectionLabel";

afterEach(cleanup);

describe("SectionLabel", () => {
  it("is an uppercase mono `<h3>` in muted by default", () => {
    render(<SectionLabel testid="lbl">Needs you</SectionLabel>);
    const label = screen.getByTestId("lbl");
    expect(label.tagName).toBe("H3");
    expect(label.textContent).toBe("Needs you");
    expect(label.className).toContain("font-mono");
    expect(label.className).toContain("uppercase");
    expect(label.className).toContain("text-muted");
    expect(SECTION_LABEL_CLASS).toContain("text-muted");
  });

  it("carries a glyph and the waiting colour, and hides the glyph from readers", () => {
    render(
      <SectionLabel testid="lbl" glyph="!" tone="waiting">
        Needs you
      </SectionLabel>,
    );
    const label = screen.getByTestId("lbl");
    expect(label.textContent).toBe("! Needs you");
    expect(label.className).toContain("text-st-waiting-tag-fg");
    expect(label.className).not.toContain("text-muted");
    expect(label.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("carries the running colour for a live label", () => {
    render(
      <SectionLabel testid="lbl" glyph="●" tone="running">
        Running
      </SectionLabel>,
    );
    const label = screen.getByTestId("lbl");
    expect(label.textContent).toBe("● Running");
    expect(label.className).toContain("text-st-running-tag-fg");
    expect(label.className).not.toContain("text-muted");
  });
});

describe("ColumnHeading", () => {
  it("is a 16/700 ink sentence-case `<h3>` with a rule under it", () => {
    render(<ColumnHeading testid="head">Since you left</ColumnHeading>);
    const head = screen.getByTestId("head");
    expect(head.tagName).toBe("H3");
    expect(head.textContent).toBe("Since you left");
    expect(head.className).toContain("text-[16px]");
    expect(head.className).toContain("font-bold");
    expect(head.className).toContain("text-ink");
    expect(head.className).toContain("border-b");
    expect(head.className).toContain("border-line-soft");
    expect(head.className).toContain("pb-[8px]");
    expect(head.className).toContain("mb-[10px]");
    expect(head.className).not.toContain("uppercase");
    expect(head.querySelector("[data-testid]")).toBeNull();
  });

  it("prints optional mono muted meta beside the title", () => {
    render(
      <ColumnHeading testid="head" metaTestid="head-meta" meta="3">
        Repos
      </ColumnHeading>,
    );
    const head = screen.getByTestId("head");
    expect(head.textContent).toBe("Repos3");
    const meta = screen.getByTestId("head-meta");
    expect(meta.className).toContain("font-mono");
    expect(meta.className).toContain("text-[11px]");
    expect(meta.className).toContain("text-muted");
  });
});
