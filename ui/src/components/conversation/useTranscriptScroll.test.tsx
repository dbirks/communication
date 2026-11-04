/**
 * The transcript pin's decision logic (rcn-review10), pinned on plain data:
 * the near-bottom threshold, the scroller search, the pin itself, and the
 * hook's behaviour — first load starts at the newest row; while pinned,
 * every new row follows; a reader who scrolled up keeps their place; a
 * viewport resize re-pins if pinned, and leaves a reading place alone.
 *
 * jsdom lays out nothing, so the scroll geometry is the test's own numbers
 * (mocked on the element) and the `ResizeObserver` is a stub the test fires —
 * what the tests pin is the hook's decisions, not a browser layout.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEAR_BOTTOM_PX,
  findScrollableAncestor,
  isNearBottom,
  pinToBottom,
  useStickyTranscript,
} from "./useTranscriptScroll";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The ResizeObserver the content is observed with, so the test can fire a
 * content-grows event the way the browser would. */
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

/** Fire the observers the content is watched by — the moment a new row
 * lands in the transcript. */
function fireContentGrow() {
  act(() => {
    ResizeObserverStub.instances.forEach((observer) =>
      observer.observed.forEach(() => observer.cb([], observer)),
    );
  });
}

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}

/** A scrollable pane with the test's own geometry (jsdom reads all zeros). */
function mountScroller(geometry: Geometry): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  document.body.appendChild(scroller);
  setGeometry(scroller, geometry);
  return scroller;
}

function setGeometry(scroller: HTMLElement, geometry: Geometry) {
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: geometry.clientHeight,
  });
  // The reader's place is the browser's own state: a content grow never
  // moves scrollTop, so the mock only rewrites it when the test says so.
  if (geometry.scrollTop !== undefined) {
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: geometry.scrollTop,
    });
  }
}

/** The hook wired to a content div inside a test-controlled scroller. */
function renderStickyContent(scroller: HTMLElement) {
  function Harness() {
    const contentRef = useStickyTranscript();
    return <div ref={contentRef} data-testid="sticky-content" />;
  }
  const content = document.createElement("div");
  scroller.appendChild(content);
  // Rendering into the scroller's subtree puts the hook's content ref under
  // the scroller in the tree it walks.
  return render(<Harness />, { container: content });
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

describe("pinToBottom", () => {
  it("lands the scroller at its bottom", () => {
    const scroller = { scrollTop: 0, scrollHeight: 1234, clientHeight: 300 };
    pinToBottom(scroller);
    expect(scroller.scrollTop).toBe(934);
  });

  it("never scrolls above zero", () => {
    const scroller = { scrollTop: 0, scrollHeight: 100, clientHeight: 300 };
    pinToBottom(scroller);
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("useStickyTranscript", () => {
  it("starts at the newest row on first load", () => {
    const scroller = mountScroller({ scrollHeight: 1000, clientHeight: 300 });
    renderStickyContent(scroller);
    // The browser's first observer callback reports the laid-out size; the
    // test plays that moment with the pane's real geometry in place.
    setGeometry(scroller, { scrollHeight: 1400, clientHeight: 300 });
    fireContentGrow();
    expect(scroller.scrollTop).toBe(1100);
  });

  it("keeps the view pinned through every new row while the reader is at the bottom", () => {
    const scroller = mountScroller({ scrollHeight: 1000, clientHeight: 300 });
    renderStickyContent(scroller);
    setGeometry(scroller, { scrollHeight: 1200, clientHeight: 300 });
    fireContentGrow();
    expect(scroller.scrollTop).toBe(900);
    // Another chunk, another reply, another divider: each growth follows.
    setGeometry(scroller, { scrollHeight: 1600, clientHeight: 300 });
    fireContentGrow();
    expect(scroller.scrollTop).toBe(1300);
  });

  it("does not move a reader who has scrolled up to read", () => {
    const scroller = mountScroller({ scrollHeight: 1200, clientHeight: 300 });
    renderStickyContent(scroller);
    setGeometry(scroller, { scrollHeight: 1200, clientHeight: 300 });
    fireContentGrow();
    // The reader climbs to an old reply: 200px above the bottom, far out of
    // the pin band.
    act(() => {
      scroller.scrollTop = 100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    setGeometry(scroller, { scrollHeight: 1600, clientHeight: 300 });
    fireContentGrow();
    expect(scroller.scrollTop).toBe(100);
    // …and so does a viewport resize.
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scroller.scrollTop).toBe(100);
  });

  it("re-pins when the reader returns within the pin band of the bottom", () => {
    const scroller = mountScroller({ scrollHeight: 1200, clientHeight: 300 });
    renderStickyContent(scroller);
    setGeometry(scroller, { scrollHeight: 1200, clientHeight: 300 });
    fireContentGrow();
    act(() => {
      scroller.scrollTop = 1200 - 300 - 40;
      scroller.dispatchEvent(new Event("scroll"));
    });
    setGeometry(scroller, { scrollHeight: 1500, clientHeight: 300 });
    fireContentGrow();
    expect(scroller.scrollTop).toBe(1200);
  });

  it("re-pins after a viewport resize (1280 ↔ 390) when the view was pinned", () => {
    const scroller = mountScroller({ scrollHeight: 1200, clientHeight: 300 });
    renderStickyContent(scroller);
    setGeometry(scroller, { scrollHeight: 1200, clientHeight: 300 });
    fireContentGrow();
    // The narrow view: the pane grows taller, the pinned view follows.
    setGeometry(scroller, { scrollHeight: 1200, clientHeight: 500 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(scroller.scrollTop).toBe(700);
  });

  it("is a no-op where the content has no scrollable ancestor", () => {
    function Bare() {
      const contentRef = useStickyTranscript();
      return <div ref={contentRef} />;
    }
    render(<Bare />);
    // Nothing is observed, and firing would only touch other tests' stubs.
    expect(ResizeObserverStub.instances).toHaveLength(0);
  });
});
