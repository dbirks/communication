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
 *   - an edge fade paints only while that side still has tabs off-strip — and
 *     it PAINTS: pass 3 found the cue present in the DOM and invisible, a solid
 *     cap in the band's own white over a white band, so the tests below ask for
 *     the ink (a gradient toward the clipped edge and a chevron), not a box.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { ProjectTabs } from "./ProjectTabs";

afterEach(cleanup);

const projectId = "01987b22-0000-7000-8000-abcdef012345";

function mount(
  active: Parameters<typeof ProjectTabs>[0]["active"],
  flags: Parameters<typeof ProjectTabs>[0]["flags"] = {},
) {
  return render(
    <MemoryRouter>
      <ProjectTabs projectId={projectId} active={active} flags={flags} />
    </MemoryRouter>,
  );
}

/** One tab change with new counts on it — the live re-read that re-measures the
 * strip, which `mount` alone cannot show because jsdom lays nothing out. */
function remount(
  active: Parameters<typeof ProjectTabs>[0]["active"],
  flags: Parameters<typeof ProjectTabs>[0]["flags"],
) {
  return (
    <MemoryRouter>
      <ProjectTabs projectId={projectId} active={active} flags={flags} />
    </MemoryRouter>
  );
}

/**
 * The strip as the phone really lays it out at 390 — measured on the dev server
 * at `project-1b-workflows-390`: a 346px viewport over 519px of tabs, the six
 * labels with their counts between them. jsdom lays nothing out, so a test that
 * asks where the strip PARKS has to hand it the geometry it would read.
 */
const TAB_BOXES: Record<string, [number, number]> = {
  overview: [0, 80.5],
  runs: [84.5, 79.4],
  threads: [167.9, 85.1],
  workflows: [257, 103],
  artifacts: [364, 76.1],
  settings: [444.1, 74.8],
};

function fakePhoneLayout(): HTMLElement {
  const nav = screen.getByTestId("project-tabs");
  let scrollLeft = 0;
  Object.defineProperty(nav, "clientWidth", { configurable: true, value: 346 });
  Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 519 });
  Object.defineProperty(nav, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  for (const [key, [left, width]] of Object.entries(TAB_BOXES)) {
    const tab = screen.getByTestId(`project-tab-${key}`);
    Object.defineProperty(tab, "offsetLeft", { configurable: true, value: left });
    Object.defineProperty(tab, "offsetWidth", { configurable: true, value: width });
  }
  return nav;
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
    // far sideways as it must — a deep link to a tab the strip cannot see at all
    // opens showing it. With nothing laid out (every box 0×0) that is the one
    // case where the component defers to the browser's own scroll.
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(screen.getByTestId("project-tab-workflows").getAttribute("aria-current")).toBe("page");
  });

  it("keeps the ACTIVE tab whole and clear of the right cue — Workflows at 390 moves off 0", () => {
    // The pass-2 acceptance review DEFECT: the old rule counted an active tab as
    // “seen” if any part of it was on the strip, so Workflows at 390 stayed at
    // `scrollLeft 0` with its last letters and its count `3` under the right
    // arrow. The strip now moves to the nearest tab edge that puts the whole
    // active tab — label and count — clear of the cue lane.
    const { rerender } = mount("workflows");
    const nav = fakePhoneLayout();
    // A count landing re-reads the geometry, exactly as the live read does.
    rerender(remount("workflows", { workflows: 3 }));
    // The strip moved — but only to `Runs`' left edge, the shortest move that
    // keeps `Overview` wholly off-strip rather than cut by the left cue.
    expect(nav.scrollLeft).toBeCloseTo(84.5, 1);
    const workflows = screen.getByTestId("project-tab-workflows");
    // Whole, and clear of the right cue (which shows at this position: the
    // strip has not reached its end).
    expect(screen.getByTestId("project-tabs-fade-right")).toBeTruthy();
    expect(workflows.offsetLeft).toBeGreaterThanOrEqual(nav.scrollLeft);
    expect(workflows.offsetLeft + workflows.offsetWidth).toBeLessThanOrEqual(
      nav.scrollLeft + nav.clientWidth - 34 + 0.5,
    );
    // Nothing is cut by the left cue's edge either: every tab is whole in the
    // clear box or wholly behind it.
    const cutAtLeftEdge = ([left, width]: [number, number]) =>
      left < nav.scrollLeft - 1 && left + width > nav.scrollLeft + 1;
    expect(Object.values(TAB_BOXES).some(cutAtLeftEdge)).toBe(false);
    // The left cue stands in its own in-flow lane — it cannot cover a label.
    const left = screen.getByTestId("project-tabs-fade-left");
    expect(left.className.split(/\s+/)).toContain("shrink-0");
    expect(left.className).not.toContain("absolute");
  });

  it("stays at scrollLeft 0 when the active tab is already whole and clear of the right cue", () => {
    // Overview, Runs and Threads fit inside the strip minus the 34px right cue
    // at `scrollLeft 0`, so the shortest move is no move: no cue at the strip's
    // start (not in the DOM at all), `Overview` whole, the tail clipped only
    // under the RIGHT fade — where it is not the tab the reader is on.
    for (const tab of ["overview", "runs", "threads"] as const) {
      const { rerender, unmount } = mount(tab);
      const nav = fakePhoneLayout();
      rerender(remount(tab, { threads: 2, workflows: 3 }));
      expect(nav.scrollLeft).toBe(0);
      expect(screen.queryByTestId("project-tabs-fade-left")).toBeNull();
      const active = screen.getByTestId(`project-tab-${tab}`);
      expect(active.offsetLeft).toBeGreaterThanOrEqual(0);
      expect(active.offsetLeft + active.offsetWidth).toBeLessThanOrEqual(
        nav.clientWidth - 34 + 0.5,
      );
      // `Overview` still begins the strip, whole.
      const overview = screen.getByTestId("project-tab-overview");
      expect(overview.offsetLeft + overview.offsetWidth).toBeLessThanOrEqual(
        nav.scrollLeft + nav.clientWidth,
      );
      expect(screen.getByTestId("project-tabs-fade-right")).toBeTruthy();
      unmount();
    }
  });

  it("parks a scrolled strip on a boundary where the cue's own edge cuts no label", () => {
    // The cue lane is 34px wide and sits to the LEFT of the strip, so a strip
    // that stops mid-label leaves a label the reader cannot finish right beside
    // it. Every rest position is therefore a tab edge, and of the clean ones the
    // nearest wins. (Starting mid-`Runs` at 118 the active Workflows tab is
    // already whole and clear, so only the left-cut rule moves the strip.)
    const { rerender } = mount("workflows");
    const nav = fakePhoneLayout();
    nav.scrollLeft = 118; // mid `Runs`: 84.5 + 79.4 = 163.9, so 118 cuts it
    rerender(remount("workflows", { workflows: 3 }));
    expect(nav.scrollLeft).toBeCloseTo(84.5, 1);
    // Nothing straddles the cue's edge any more: every tab is whole in the strip
    // or wholly behind the cue lane.
    const cutAtCueEdge = ([left, width]: [number, number]) =>
      left < nav.scrollLeft - 1 && left + width > nav.scrollLeft + 1;
    expect(Object.values(TAB_BOXES).some(cutAtCueEdge)).toBe(false);
    // And the cue stands where it should: the strip is away from its start.
    expect(screen.getByTestId("project-tabs-fade-left")).toBeTruthy();
  });

  it("still pulls a tab the strip cannot see at all whole into view (deep link to Settings)", () => {
    const { rerender } = mount("settings");
    const nav = fakePhoneLayout();
    rerender(remount("settings", { threads: 2 }));
    // Settings runs to the end of the strip, so the strip goes to its furthest
    // stop and shows the tab it was opened on entire.
    expect(nav.scrollLeft).toBeCloseTo(172.9, 0);
    const settings = screen.getByTestId("project-tab-settings");
    expect(settings.offsetLeft).toBeGreaterThanOrEqual(nav.scrollLeft);
    expect(settings.offsetLeft + settings.offsetWidth).toBeLessThanOrEqual(
      nav.scrollLeft + nav.clientWidth + 0.5,
    );
    // Now the strip IS away from its start, and the left cue appears — in its
    // own lane, which is why it still cannot print over a tab.
    const left = screen.getByTestId("project-tabs-fade-left");
    expect(left.className.split(/\s+/)).toContain("shrink-0");
    expect(left.className).not.toContain("absolute");
  });

  it("shows the right-hand fade while tabs are off-strip, and no left fade yet", () => {
    mount("overview");
    fakeScrollableStrip(0);
    expect(screen.getByTestId("project-tabs-fade-right")).toBeTruthy();
    expect(screen.queryByTestId("project-tabs-fade-left")).toBeNull();
  });

  it("inks the fade — a shadow to the clipped edge and a chevron — over the band's own colour", () => {
    mount("overview");
    fakeScrollableStrip(0);
    const fade = screen.getByTestId<HTMLSpanElement>("project-tabs-fade-right");
    // The pass-2 cue was `background: var(--color-surface)`: white over the
    // white band, so the phone showed `Workflov` with nothing saying the strip
    // scrolled. A fade that cannot be seen is not an affordance.
    expect(fade.style.background).toContain("linear-gradient");
    expect(fade.style.background).not.toContain("var(--color-surface)");
    // The direction cue is an SVG: a printed glyph under the cap would print on
    // top of the clipped tab's own ink.
    expect(fade.querySelector("svg")).toBeTruthy();
    // It stays a decoration: the tab under it keeps its click.
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    expect(fade.className.split(/\s+/)).toContain("pointer-events-none");
  });

  it("shows both fades mid-strip", () => {
    mount("settings");
    fakeScrollableStrip(120); // 120 + 320 < 600 — the tail is still off-strip.
    const left = screen.getByTestId<HTMLSpanElement>("project-tabs-fade-left");
    const right = screen.getByTestId("project-tabs-fade-right");
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    // Both cues darken toward THEIR adjacent edge and carry their chevron. The
    // LEFT cue is an in-flow lane beside the strip (pass-1 review: the old
    // absolute left arrow printed “‹verview” over the tab at the edge), so its
    // shadow darkens toward the strip on its right — and it must never be an
    // overlay again.
    expect(left.style.background).toContain("linear-gradient(to right");
    expect(right.style.background).toContain("linear-gradient(to right");
    expect(left.className.split(/\s+/)).toContain("shrink-0");
    expect(left.className).not.toContain("absolute");
    expect(left.querySelector("svg")).toBeTruthy();
    expect(right.querySelector("svg")).toBeTruthy();
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
