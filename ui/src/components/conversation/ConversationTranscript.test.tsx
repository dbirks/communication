/**
 * The transcript reserves ONE COMPOSER'S HEIGHT as bottom padding (round 6,
 * the 390 review): at short viewports the composer pinned to the bottom of
 * the pane leaves the scroller little room, so the transcript's last line must
 * be scrollable clear of the box instead of sitting flush under it. The
 * padding is measured from the composer itself — a page-level sibling, whose
 * height varies with width and the textarea — so it follows the composer; a
 * surface with no such composer (the legacy page, an embedded reuse) reserves
 * nothing.
 */
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { ConversationTranscript, useComposerHeight } from "./ConversationTranscript";
import type { ConversationSession } from "./useConversationSession";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The page's composer, stubbed with a measured height (jsdom lays out
 * nothing: offsetHeight is a mock, not a layout). */
function composerStub(height: number) {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "thread-composer-pin");
  Object.defineProperty(el, "offsetHeight", { configurable: true, value: height });
  document.body.appendChild(el);
  return el;
}

const emptySession = {
  data: undefined,
  transcript: { items: [], turns: [], throughSeq: 0 },
  events: [],
  isController: true,
  nameOf: (id: string) => id,
  onDecide: () => {},
  decidingRequestId: null,
  decide: { error: null, isError: false, variables: undefined },
} as unknown as ConversationSession;

function renderTranscript() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationTranscript session={emptySession} />
    </QueryClientProvider>,
  );
}

describe("useComposerHeight", () => {
  it("measures the thread's pinned composer when it is on the page", () => {
    const composer = composerStub(183);
    const { result, unmount } = renderHook(() => useComposerHeight());
    expect(result.current).toBe(183);
    unmount();
    composer.remove();
  });

  it("reserves nothing on a surface with no composer", () => {
    const { result } = renderHook(() => useComposerHeight());
    expect(result.current).toBe(0);
  });
});

describe("the transcript's composer padding (round 6, the 390 review)", () => {
  it("gives the transcript a bottom padding equal to the composer's height", async () => {
    const composer = composerStub(183);
    const { container } = renderTranscript();
    const wrapper = container.firstElementChild as HTMLElement;
    await waitFor(() => expect(wrapper.style.paddingBottom).toBe("183px"));
    composer.remove();
  });

  it("adds no padding where no composer is mounted", async () => {
    const { container } = renderTranscript();
    const wrapper = container.firstElementChild as HTMLElement;
    await waitFor(() => expect(wrapper.style.paddingBottom).toBe(""));
  });
});

/**
 * The pin (rcn-review10, rcn-review11): the pane's scroller — the
 * transcript's nearest scrollable ancestor, a page-level sibling — stays
 * with the newest row. jsdom lays out nothing, so the geometry is the
 * test's own numbers (the scroller's scroll facts and the transcript's
 * rect) and the ResizeObserver is a stub the test fires when a row lands.
 */
describe("the transcript's pin to the newest row (rcn-review10)", () => {
  const roCallbacks = new Set<() => void>();
  class ResizeObserverStub {
    cb: (entries: unknown[], observer: unknown) => void;
    fire: () => void;
    constructor(cb: (entries: unknown[], observer: unknown) => void) {
      this.cb = cb;
      this.fire = () => this.cb([], this);
      roCallbacks.add(this.fire);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      roCallbacks.delete(this.fire);
    }
  }

  function fireRowLanded() {
    act(() => {
      roCallbacks.forEach((cb) => cb());
    });
  }

  /** The transcript's own bottom (its reserved composer padding included),
   * mocked the way a laid-out browser would report it: the content is the
   * whole scroller content here, so its bottom is the scroller's scroll
   * height minus the current offset. */
  function mockContentRect(scroller: HTMLElement) {
    const content = scroller.firstElementChild;
    if (!content) throw new Error("the transcript did not land in the scroller");
    content.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: scroller.scrollHeight - scroller.scrollTop,
        left: 0,
        right: 0,
        width: 0,
        height: scroller.scrollHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }

  it("keeps the pane's scroller pinned to the newest row as rows land", () => {
    roCallbacks.clear();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    scroller.scrollTop = 0;
    document.body.appendChild(scroller);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationTranscript session={emptySession} />
      </QueryClientProvider>,
      { container: scroller },
    );
    // The browser's first observer callback reports the laid-out size; the
    // test plays that moment and first load starts at the newest row.
    mockContentRect(scroller);
    fireRowLanded();
    expect(scroller.scrollTop).toBe(700);
    // A reply lands: the content grows, and the pinned view follows it —
    // the pin lands the transcript's own bottom, so the composer padding the
    // transcript reserved keeps the last row clear of the composer.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    fireRowLanded();
    expect(scroller.scrollTop).toBe(1100);
    // A switch divider and the next turn's header land: it follows again.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1700 });
    fireRowLanded();
    expect(scroller.scrollTop).toBe(1400);
    scroller.remove();
  });

  it("leaves a reader alone who has scrolled up to read", () => {
    roCallbacks.clear();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    scroller.scrollTop = 0;
    document.body.appendChild(scroller);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationTranscript session={emptySession} />
      </QueryClientProvider>,
      { container: scroller },
    );
    mockContentRect(scroller);
    fireRowLanded();
    expect(scroller.scrollTop).toBe(1100);
    // The reader climbs up to an old line, well out of the 80px pin band.
    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1800 });
    fireRowLanded();
    expect(scroller.scrollTop).toBe(200);
    scroller.remove();
  });
});
