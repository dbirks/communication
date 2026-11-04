/**
 * The transcript's pin (rcn-review10, rcn-review11, rcn-review12): the pane's
 * scroller — the transcript's nearest scrollable ancestor, a page-level
 * sibling — stays with the newest row. The composer is a sibling BELOW the
 * scroller, never overlapping it, so the pin's target is the transcript's own
 * bottom edge: no reserved padding, nothing scrolled while the content fits.
 * jsdom lays out nothing, so the geometry is the test's own numbers (the
 * scroller's scroll facts and the transcript's rect) and the ResizeObserver is
 * a stub the test fires when a row lands.
 */
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { ConversationTranscript, useComposerHeight } from "./ConversationTranscript";
import { projectTranscript } from "../../api/transcript";
import { conversationEvent } from "../../test/fakes";
import type { EventEnvelope } from "../../api/types";
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

describe("useComposerHeight", () => {
  it("measures the thread's pinned composer when it is on the page", () => {
    const composer = composerStub(183);
    const { result, unmount } = renderHook(() => useComposerHeight());
    expect(result.current).toBe(183);
    unmount();
    composer.remove();
  });

  it("answers zero on a surface with no composer", () => {
    const { result } = renderHook(() => useComposerHeight());
    expect(result.current).toBe(0);
  });
});

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

/**
 * The pin (rcn-review10, rcn-review11, rcn-review12): the pane's scroller — the
 * transcript's nearest scrollable ancestor, a page-level sibling — stays
 * with the newest row. jsdom lays out nothing, so the geometry is the
 * test's own numbers (the scroller's scroll facts and the transcript's
 * rect) and the ResizeObserver is a stub the test fires when a row lands.
 */
describe("the agent row's writing… indicator (the terminal-turn fix)", () => {
  /** A surface session whose transcript is the fold of the given frames —
   * the same shape the page's session holds, so the surface reads the rows
   * the journal actually committed. */
  function sessionFor(events: EventEnvelope[]): ConversationSession {
    const { items, turns } = projectTranscript(events);
    return {
      data: undefined,
      transcript: { items, turns, throughSeq: 0 },
      events,
      isController: true,
      nameOf: (id: string) => id,
      onDecide: () => {},
      decidingRequestId: null,
      decide: { error: null, isError: false, variables: undefined },
    } as unknown as ConversationSession;
  }

  function renderSession(events: EventEnvelope[]) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationTranscript session={sessionFor(events)} />
      </QueryClientProvider>,
    );
  }

  it("shows writing… while the turn runs, and drops it when the terminal line lands", () => {
    const streaming = [
      conversationEvent("conversation.turn.started", { session_origin: "new" }, { global_seq: 1 }),
      conversationEvent(
        "conversation.message.agent",
        { text: "Half of the answer" },
        {
          global_seq: 2,
        },
      ),
    ];
    const running = renderSession(streaming);
    expect(
      screen.getByText("writing…"),
      "the row is mid-stream, so the reader sees writing…",
    ).toBeTruthy();
    running.unmount();

    // The turn ends and no frame ever carries the final-chunk flag — the
    // exact stream that left the indicator up over "Turn completed".
    const settled = [
      ...streaming,
      conversationEvent(
        "conversation.turn.completed",
        { stop_reason: "end_turn" },
        {
          global_seq: 3,
        },
      ),
    ];
    const { container } = renderSession(settled);
    expect(container.textContent).not.toContain("writing…");
    expect(screen.getByText(/Turn completed/), "the terminal line is on screen").toBeTruthy();
  });
});

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

  /** The transcript's own bottom (the newest row's edge),
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
    // the pin lands the transcript's own bottom, which is what keeps the
    // last row clear of the composer that sits below the scroller.
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
