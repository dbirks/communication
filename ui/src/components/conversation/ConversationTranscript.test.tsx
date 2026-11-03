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
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationTranscript, useComposerHeight } from "./ConversationTranscript";
import type { ConversationSession } from "./useConversationSession";

afterEach(cleanup);

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
