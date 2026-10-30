/**
 * The project page's tab strip (design 1b) at phone width.
 *
 * The pass-2 review found `/p/:id` at 390 with Artifacts and Settings cut off
 * and nothing saying the strip continued — the row neither scrolled the active
 * tab into view nor hinted there was more. These tests pin the two fixes:
 *   - the strip is its own horizontal scroller (`overflow-x-auto` +
 *     `overscroll-x-contain`, so dragging it never takes the page sideways),
 *     every tab keeps its place in the strip (nothing is hidden behind a
 *     `display:none`), and the active tab is scrolled into view on arrival;
 *   - an edge fade paints only while that side still has tabs off-strip.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { ProjectTabs } from "./ProjectTabs";

afterEach(cleanup);

const projectId = "01987b22-0000-7000-8000-abcdef012345";

function mount(active: Parameters<typeof ProjectTabs>[0]["active"]) {
  return render(
    <MemoryRouter>
      <ProjectTabs projectId={projectId} active={active} />
    </MemoryRouter>,
  );
}

/** jsdom has no layout: every box measures 0×0, so a scroll container always
 *  looks un-overflowed and no fade would ever paint. This gives the strip a
 *  scrollable box — a 320px viewport over 600px of tabs parked at `scrollLeft`
 *  — then scrolls it so the component re-measures for real. */
function fakeScrollableStrip(scrollLeft: number) {
  const nav = screen.getByTestId("project-tabs");
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: 320 });
  Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 600 });
  Object.defineProperty(nav, "scrollLeft", { configurable: true, value: scrollLeft });
  fireEvent.scroll(nav);
  return nav;
}

describe("the project tab strip at phone width", () => {
  afterEach(() => {
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("is its own horizontal scroller, never the page's", () => {
    mount("overview");
    const cls = screen.getByTestId("project-tabs").className.split(/\s+/);
    expect(cls).toContain("overflow-x-auto");
    // Chaining a strip flick to the document is what made the page itself
    // scroll sideways at 390.
    expect(cls).toContain("overscroll-x-contain");
    expect(cls).toContain("min-w-0");
  });

  it("keeps all six tabs in the strip at every width (nothing display:none)", () => {
    mount("overview");
    // Every tab is a real link the strip can be scrolled to — the fix is a
    // scroller, not hidden overflow.
    expect(screen.getAllByTestId(/^project-tab-/)).toHaveLength(6);
    expect(screen.getByTestId("project-tab-settings").className.split(/\s+/)).toContain("shrink-0");
  });

  it("pulls the ACTIVE tab into view on arrival", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    mount("workflows");
    // The browser stays put vertically (`block: "nearest"`) and moves only as
    // far sideways as it must — a deep link to Workflows opens showing it.
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(screen.getByTestId("project-tab-workflows").getAttribute("aria-current")).toBe("page");
  });

  it("shows the right-hand fade while tabs are off-strip, and no left fade yet", () => {
    mount("overview");
    fakeScrollableStrip(0);
    expect(screen.getByTestId("project-tabs-fade-right")).toBeTruthy();
    expect(screen.queryByTestId("project-tabs-fade-left")).toBeNull();
  });

  it("shows both fades mid-strip", () => {
    mount("settings");
    fakeScrollableStrip(120); // 120 + 320 < 600 — the tail is still off-strip.
    expect(screen.getByTestId("project-tabs-fade-left")).toBeTruthy();
    expect(screen.getByTestId("project-tabs-fade-right")).toBeTruthy();
  });

  it("drops the right fade once the strip is at its end", () => {
    mount("settings");
    fakeScrollableStrip(280); // 280 + 320 = 600 — the last tab is fully in view.
    expect(screen.getByTestId("project-tabs-fade-left")).toBeTruthy();
    expect(screen.queryByTestId("project-tabs-fade-right")).toBeNull();
  });

  it("draws no fade when the strip has nothing to scroll (1280)", () => {
    mount("overview");
    // The default jsdom box is 0×0: the strip is not overflowing, so a desktop
    // reader gets no cue for content that is all already visible.
    expect(screen.queryByTestId("project-tabs-fade-left")).toBeNull();
    expect(screen.queryByTestId("project-tabs-fade-right")).toBeNull();
  });

  it("does not throw where Element.prototype.scrollIntoView is undefined", () => {
    // jsdom never defines it; the call is optional-chained, so the strip still
    // renders all six tabs instead of erroring on first paint.
    expect(Element.prototype.scrollIntoView).toBeUndefined();
    expect(() => mount("artifacts")).not.toThrow();
    expect(screen.getByTestId("project-tab-artifacts")).toBeTruthy();
  });
});
