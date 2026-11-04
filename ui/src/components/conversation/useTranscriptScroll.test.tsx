/**
 * The transcript pin's decision logic (rcn-review10, rcn-review11), pinned on
 * plain data: the pin band, the scroller search, the pin position (the
 * transcript's own bottom on the visible bottom — NOT the scroller's raw
 * max, which at phone width lands the trailing thread-details/side-panel
 * content in view and hides the newest row), and the hook's behaviour —
 * first load starts at the newest row; while pinned, every new row follows;
 * a reader who scrolled up keeps their place; a composer/header reflow (the
 * scroller's box resizing) re-pins; a viewport resize re-pins if pinned, and
 * leaves a reading place alone.
 *
 * jsdom lays out nothing, so the geometry is the test's own little model
 * (mocked rects + scroll facts) and the `ResizeObserver` is a stub the test
 * fires — what the tests pin is the hook's decisions, not a browser layout.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEAR_BOTTOM_PX,
  contentBottomInScroller,
  findScrollableAncestor,
  isNearBottom,
  isNearContentBottom,
  pinPosition,
  useStickyTranscript,
} from "./useTranscriptScroll";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The ResizeObserver the content AND the scroller are observed with, so the
 * test fires a content-grows or a scroller-resizes event the way the browser
 * would. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly cb: (entries: unknown[], observer: unknown) => void;
  observed: Element[] = [];
  constructor(cb: (entries: unknown[], observer: unknown) => void) {
    this.cb = cb;
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    ResizeObserverStub.instances = ResizeObserverStub.instances.filter((o) => o !== this);
  }
}

beforeEach(() => {
  ResizeObserverStub.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

/** Fire the observers watching `el` — the moment its box changes size: the
 * content growing (a new row) or the scroller reflowing (a composer/header
 * resize). */
function fireResize(el: Element) {
  act(() => {
    ResizeObserverStub.instances.forEach((observer) => {
      if (observer.observed.includes(el)) observer.cb([], observer);
    });
  });
}

/**
 * The pane's geometry as a little model the mocks read from, honoring the
 * browser's own invariants: the scroller's box stays put in the viewport,
 * and scrolling it moves the content's viewport position by the same amount.
 */
interface PaneModel {
  /** The scroller's top edge in viewport coordinates (stable). */
  scrollerTop: number;
  clientHeight: number;
  /** The transcript content's bottom — the newest row's edge — in the
   * scroller's content coordinates. */
  contentBottom: number;
  /** The trailing content below the transcript (details, the phone's side
   * panel) — what the scroller's raw max would leave in view. */
  below: number;
  scrollTop: number;
}

function makeRect(top: number, bottom: number) {
  return {
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * A scrollable pane wired to the model: the scroller's scroll facts and its
 * own rect read from it, honoring the browser's invariants — the scroller's
 * box stays put in the viewport, and scrolling it moves the content's
 * viewport position by the same amount. `below` is a real trailing element
 * inside the scroller, so a pin at the scroller's raw max would leave it in
 * view.
 */
/** The scroll facts and the box, mocked on `el` from the model — the same
 * invariants a real scroller honors, on whichever element the layout makes
 * the scroller. */
function mockScrollerGeometry(scroller: HTMLElement, model: PaneModel): void {
  const scrollMax = () => Math.max(0, model.contentBottom + model.below - model.clientHeight);
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => model.scrollTop,
    set: (value: number) => {
      model.scrollTop = Math.min(Math.max(0, value), scrollMax());
    },
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => model.contentBottom + model.below,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => model.clientHeight,
  });
  scroller.getBoundingClientRect = () =>
    makeRect(model.scrollerTop, model.scrollerTop + model.clientHeight);
}

function mountPane(model: PaneModel): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  scroller.appendChild(document.createElement("div")); // the trailing details/panel content
  document.body.appendChild(scroller);
  mockScrollerGeometry(scroller, model);
  return scroller;
}

/** The harness content's rect from the model: it moves with the scroll the
 * way a real browser's would (height 100px, the model's contentBottom is its
 * bottom in the scroller's content coordinates). */
function mockContentRect(content: HTMLElement, model: PaneModel): void {
  content.getBoundingClientRect = () =>
    makeRect(
      model.scrollerTop + model.contentBottom - model.scrollTop - 100,
      model.scrollerTop + model.contentBottom - model.scrollTop,
    );
}

/** The hook wired to the transcript content inside the model's scroller.
 * The ref lands on React's own node; its rect is mocked from the model so it
 * moves with the scroll the way a real browser's would. */
function renderStickyContent(scroller: HTMLElement, model: PaneModel): HTMLDivElement {
  function Harness() {
    const contentRef = useStickyTranscript();
    return <div ref={contentRef} data-testid="sticky-content" />;
  }
  // Rendering into the scroller puts the hook's content node under the
  // scroller in the tree it walks.
  render(<Harness />, { container: scroller });
  const content = scroller.querySelector<HTMLDivElement>("[data-testid='sticky-content']");
  if (!content) throw new Error("the harness content did not land in the scroller");
  mockContentRect(content, model);
  return content;
}

describe("isNearBottom", () => {
  it("is pinned exactly at the bottom and within NEAR_BOTTOM_PX above it", () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    for (const gap of [1, 40, NEAR_BOTTOM_PX]) {
      expect(
        isNearBottom({ scrollTop: 700 - gap, scrollHeight: 1000, clientHeight: 300 }),
        `gap of ${gap}px`,
      ).toBe(true);
    }
    expect(
      isNearBottom({
        scrollTop: 700 - (NEAR_BOTTOM_PX + 1),
        scrollHeight: 1000,
        clientHeight: 300,
      }),
    ).toBe(false);
  });

  it("is pinned when the content is shorter than the view", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true);
  });
});

describe("isNearContentBottom", () => {
  it("is at the newest row at the row's own bottom and within the band on either side", () => {
    for (const delta of [0, 40, NEAR_BOTTOM_PX, -40, -NEAR_BOTTOM_PX]) {
      expect(
        isNearContentBottom(1000, { scrollTop: 700 + delta, clientHeight: 300 }),
        `delta ${delta}`,
      ).toBe(true);
    }
  });

  it("is not at the newest row beyond the band — reading old history, or deep in the trailing panel", () => {
    expect(
      isNearContentBottom(1000, { scrollTop: 700 - (NEAR_BOTTOM_PX + 1), clientHeight: 300 }),
    ).toBe(false);
    expect(
      isNearContentBottom(1000, { scrollTop: 700 + (NEAR_BOTTOM_PX + 1), clientHeight: 300 }),
    ).toBe(false);
  });
});

describe("pinPosition", () => {
  it("lands the content's bottom exactly on the visible bottom", () => {
    expect(pinPosition(900, { clientHeight: 300 })).toBe(600);
  });

  it("clamps at zero where the content is shorter than the view", () => {
    expect(pinPosition(100, { clientHeight: 300 })).toBe(0);
  });

  it("rounds to a whole pixel", () => {
    expect(pinPosition(850.4, { clientHeight: 300 })).toBe(550);
  });
});

describe("contentBottomInScroller", () => {
  it("is scroll-invariant: the same content position no matter the scroll", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    expect(contentBottomInScroller(content, scroller)).toBe(800);
    model.scrollTop = 300;
    expect(contentBottomInScroller(content, scroller)).toBe(800);
    scroller.remove();
  });
});

describe("findScrollableAncestor", () => {
  it("returns the nearest ancestor with a scrolling overflow-y", () => {
    const leaf = document.createElement("div");
    const middle = document.createElement("div");
    const outer = document.createElement("div");
    middle.style.overflowY = "hidden";
    outer.style.overflowY = "scroll";
    middle.appendChild(leaf);
    outer.appendChild(middle);
    document.body.appendChild(outer);
    expect(findScrollableAncestor(leaf)).toBe(outer);
    outer.remove();
  });

  it("prefers auto and scroll over visible and hidden", () => {
    const leaf = document.createElement("div");
    const auto = document.createElement("div");
    const visible = document.createElement("div");
    auto.style.overflowY = "auto";
    visible.style.overflowY = "visible";
    visible.appendChild(auto);
    auto.appendChild(leaf);
    document.body.appendChild(visible);
    expect(findScrollableAncestor(leaf)).toBe(auto);
    visible.remove();
  });

  it("finds nothing where no ancestor scrolls", () => {
    const leaf = document.createElement("div");
    const wrapper = document.createElement("div");
    wrapper.appendChild(leaf);
    document.body.appendChild(wrapper);
    expect(findScrollableAncestor(leaf)).toBeNull();
    expect(findScrollableAncestor(null)).toBeNull();
    wrapper.remove();
  });
});

describe("useStickyTranscript", () => {
  it("starts at the newest row on first load — the transcript's bottom on the visible bottom, not the scroller's raw max", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    // The browser's first observer callback reports the laid-out size; the
    // test plays that moment with the pane's real geometry in place.
    fireResize(content);
    expect(scroller.scrollTop).toBe(500);
    scroller.remove();
  });

  it("scrolls NOTHING while the content fits — a short transcript stays at the top with every row visible", () => {
    // rcn-review12, the 390 defect: the old pin target sat a whole composer
    // below the newest row, so a transcript that fit inside the scroller
    // still scrolled and hid its first rows. The pin's target is the
    // transcript's own bottom: shorter than the view means offset zero.
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 260, // shorter than the 300px view — it fits
      below: 200, // the trailing details/side-panel content still overflows
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    expect(scroller.scrollTop).toBe(0);
    // …and new rows keep the view at the top until the content overflows.
    model.contentBottom = 290;
    fireResize(content);
    expect(scroller.scrollTop).toBe(0);
    // Overflow begins: the pin lifts the newest row to the visible bottom,
    // and only then — never earlier — does it move the top edge.
    model.contentBottom = 420;
    fireResize(content);
    expect(scroller.scrollTop).toBe(120);
    scroller.remove();
  });

  it("keeps the newest row on the visible bottom through every new row while the reader is there", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    expect(scroller.scrollTop).toBe(500);
    // Another chunk, another reply, another divider: each growth follows.
    model.contentBottom = 1100;
    fireResize(content);
    expect(scroller.scrollTop).toBe(800);
    model.contentBottom = 1400;
    fireResize(content);
    expect(scroller.scrollTop).toBe(1100);
    scroller.remove();
  });

  it("re-pins when the scroller's box resizes — the composer or header reflow moved the visible bottom", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    expect(scroller.scrollTop).toBe(500);
    // The composer's chip changed text and the box grew: no content growth,
    // but the visible bottom moved and the pinned view follows it.
    model.clientHeight = 500;
    fireResize(scroller);
    expect(scroller.scrollTop).toBe(300);
    scroller.remove();
  });

  it("keeps the pin when the journal outpaces the pin's own scroll event — a fast replay grows the content past the band before the event is read", () => {
    // The 1280 first-load failure: the retained journal drips down the
    // stream faster than the pin's own scroll events clear. The browser
    // processes a pin write's scroll event LATER than the layout that
    // followed it, so the next batch of rows is already laid out when the
    // event is read — the view still sits where the pin put it, but the
    // content's bottom now lies past the band below the visible bottom.
    // Read naively that is a reader who climbed away; it is not, so the pin
    // holds and follows the grown bottom instead of dropping.
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    expect(scroller.scrollTop).toBe(500);
    // 600px of growth — far past the 80px band — landed before the pin's
    // own scroll event is processed, with the view unmoved.
    model.contentBottom = 1400;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(1100); // the pin followed the grown bottom
    // …and keeps following each later row.
    model.contentBottom = 1700;
    fireResize(content);
    expect(scroller.scrollTop).toBe(1400);
    scroller.remove();
  });

  it("does not move a reader who has scrolled up to read", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    expect(scroller.scrollTop).toBe(500);
    // The reader climbs to an old reply: 300px above the newest row, far out
    // of the pin band.
    act(() => {
      model.scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    model.contentBottom = 1400;
    fireResize(content);
    expect(scroller.scrollTop).toBe(100);
    // …and so does a viewport resize.
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scroller.scrollTop).toBe(100);
    scroller.remove();
  });

  it("re-pins when the reader returns within the pin band of the newest row", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    act(() => {
      model.scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    // 40px above the newest row: inside the band, the view re-sticks on the
    // spot.
    act(() => {
      model.scrollTop = 460; // 800 - 300 - 40
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(500);
    // …and the next row follows.
    model.contentBottom = 1100;
    fireResize(content);
    expect(scroller.scrollTop).toBe(800);
    scroller.remove();
  });

  it("re-sticks when the reader is just past the newest row, in the trailing panel", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    // The reader has scrolled 50px PAST the newest row into the thread-details
    // block: still at the newest row, the view re-sticks to the row itself.
    act(() => {
      model.scrollTop = 550; // 800 - 300 + 50
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(500);
    scroller.remove();
  });

  it("re-pins after a viewport resize (1280 ↔ 390) when the view was pinned", () => {
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const scroller = mountPane(model);
    const content = renderStickyContent(scroller, model);
    fireResize(content);
    // The narrow view reflows everything — the pane grows taller, the pinned
    // view follows. The scroll offset is set without an event (the browser's
    // clamp mid-reflow), so the window resize is what re-runs the pin.
    model.clientHeight = 500;
    model.scrollTop = 400;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scroller.scrollTop).toBe(300);
    scroller.remove();
  });

  it("moves the pin to the scroller that now owns the transcript when a reflow re-binds the ancestor chain", () => {
    // The content mounts with an inner box as its nearest scrollable ancestor
    // (an embedded reuse's own scrollbox); the layout then reflows — the
    // inner box stops scrolling and the OUTER pane owns the scroll. The pin
    // must follow the ownership, not keep driving the box it pinned first.
    const innerModel: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const outerModel: PaneModel = {
      scrollerTop: 60,
      clientHeight: 500,
      contentBottom: 1000,
      below: 200,
      scrollTop: 0,
    };
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    outer.appendChild(inner);
    document.body.appendChild(outer);

    function Harness() {
      const contentRef = useStickyTranscript();
      return <div ref={contentRef} data-testid="sticky-content" />;
    }
    render(<Harness />, { container: inner });
    const content = inner.querySelector<HTMLDivElement>("[data-testid='sticky-content']");
    if (!content) throw new Error("the harness content did not land in the inner box");
    mockScrollerGeometry(inner, innerModel);
    mockContentRect(content, innerModel);

    fireResize(content);
    expect(inner.scrollTop).toBe(500); // 800 - 300, on the inner box

    // The reflow: the inner box stops scrolling; the outer pane takes the
    // scroll, with its own box facts.
    inner.style.overflowY = "visible";
    outer.style.overflowY = "auto";
    mockScrollerGeometry(outer, outerModel);
    content.getBoundingClientRect = () =>
      makeRect(
        outerModel.scrollerTop + outerModel.contentBottom - outerModel.scrollTop - 100,
        outerModel.scrollerTop + outerModel.contentBottom - outerModel.scrollTop,
      );
    fireResize(content);
    expect(outer.scrollTop).toBe(500); // 1000 - 500, on the OUTER scroller
    expect(inner.scrollTop).toBe(500); // the stale box is left alone
    outer.remove();
  });

  it("stays armed where the content has no scrollable ancestor, and pins the moment one stands above it", () => {
    // The 1280 thread pane's failure shape: the transcript lands before the
    // column settles into its `overflow-y-auto` scroller. The hook must not
    // give up at mount — it stays armed, and the first pin input after the
    // layout settles resolves the pane's scroller and pins on it.
    const model: PaneModel = {
      scrollerTop: 100,
      clientHeight: 300,
      contentBottom: 800,
      below: 600,
      scrollTop: 0,
    };
    const column = document.createElement("div");
    document.body.appendChild(column);

    function Harness() {
      const contentRef = useStickyTranscript();
      return <div ref={contentRef} data-testid="sticky-content" />;
    }
    render(<Harness />, { container: column });
    const content = column.querySelector<HTMLDivElement>("[data-testid='sticky-content']");
    if (!content) throw new Error("the harness content did not land in the column");

    // No scrollable ancestor yet: the content is watched, and firing with
    // the column still non-scrolling pins nothing.
    expect(ResizeObserverStub.instances).toHaveLength(1);
    column.style.overflowY = "visible";
    column.getBoundingClientRect = () =>
      makeRect(model.scrollerTop, model.scrollerTop + model.clientHeight);
    mockContentRect(content, model);
    fireResize(content);

    // The layout settles: the column becomes the pane's scroller. The next
    // pin input (the content's own resize — a row just landed) re-resolves
    // and pins on it.
    column.style.overflowY = "auto";
    mockScrollerGeometry(column, model);
    fireResize(content);
    expect(column.scrollTop).toBe(500);
    column.remove();
  });
});
