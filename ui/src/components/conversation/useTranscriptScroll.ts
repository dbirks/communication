/**
 * The chat transcript's pin (rcn-review10, rcn-review11): the view stays with
 * the newest row the way every chat does —
 *
 * - opening a chat starts at the newest row;
 * - while the reader is at (or within ~80px of) the newest row, every new row
 *   — an agent chunk, a reply, a switch divider, a scope-change line, a mail
 *   card — keeps the view pinned to the newest row;
 * - if the reader has scrolled up to read, new rows do NOT move the view —
 *   they keep their place until the reader returns to the newest row;
 * - a viewport resize (1280 ↔ 390) re-pins if the view was pinned.
 *
 * Where the pin lands is the NEWEST ROW, not the scroller's raw bottom
 * (rcn-review11): the thread's scroller holds more than the transcript —
 * below it sit the thread-details disclosure and, at phone width, the whole
 * side-panel stack. Pinning the scroller's max left that trailing content in
 * the visible bottom and the newest row ABOVE it, out of view. The hook
 * instead lands the transcript's own bottom (the content element, including
 * its reserved composer-height padding) exactly at the scroller's visible
 * bottom, so the newest row ends fully clear of the composer at every width.
 *
 * The pin re-runs on every movement of the view's bottom edge: new rows grow
 * the content (ResizeObserver on it), and a composer or header reflow
 * resizes the scroller's box (ResizeObserver on it — the 1280 WORKS-IN move
 * changed the meta line and the composer chip and moved the bottom edge with
 * no content growth at all). A scroll event that leaves the reader inside the
 * pin band re-sticks on the spot; one that climbs out of it keeps the
 * reader's place.
 *
 * The hook returns a ref for the content container. A surface that renders
 * its transcript later than its first paint (the panel's loading state, then
 * the transcript) is handled: the ref callback re-arms the pin when the
 * content lands, and disarms it when the content unmounts.
 *
 * The scroller the pin drives is re-resolved on EVERY pin run — the nearest
 * ancestor with a computed `overflow-y` that scrolls, walked up from the
 * content at the moment the pin lands (rcn-review12, the 1280 thread pane):
 * the element that stands above the transcript can differ from the one the
 * first paint saw. The pane's column settles in as its side panel mounts or
 * unmounts, a 1280 ↔ 390 resize reflows the ancestor chain, and an embedded
 * reuse can wrap the transcript in a scroller that exists only after its
 * own mount. When the resolved scroller is not the one the observers and
 * the pin last drove, the observation moves to the new one on that same
 * run — a row landing over SSE, a composer reflow, or a viewport resize is
 * what re-runs the pin, so the newest row follows the pane's scroller even
 * though the pane's scroller is not the transcript component's own element.
 */
import { useCallback, useEffect, useState } from "react";

/** How far from the newest row still counts as "at the newest row" (the
 * review's ~80px: a reply that lands while the last line sits 80px up still
 * pins). */
export const NEAR_BOTTOM_PX = 80;

/** The scroll facts the pin needs — the smallest slice of `HTMLElement`, so
 * the helpers run on a test's own mock geometry. */
export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The view is pinned while the last row sits within `NEAR_BOTTOM_PX` of the
 * bottom of the scroller. */
export function isNearBottom(view: ScrollState): boolean {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * Is the reader at the newest row: the transcript's own bottom (`content`'s
 * bottom in the scroller's content coordinates) sits within `NEAR_BOTTOM_PX`
 * of the visible bottom — on either side, so a reader who has scrolled just
 * PAST the row into the trailing thread-details/side-panel content is still
 * at the newest row, while one reading old history is not.
 */
export function isNearContentBottom(
  contentBottom: number,
  view: Pick<ScrollState, "scrollTop" | "clientHeight">,
): boolean {
  return Math.abs(contentBottom - view.scrollTop - view.clientHeight) <= NEAR_BOTTOM_PX;
}

/**
 * The scroll position that lands `content`'s bottom — the transcript's end,
 * including its reserved composer-height padding — exactly on the scroller's
 * visible bottom edge. Content that trails the transcript (the thread-details
 * disclosure, the phone's side-panel stack) stays below the pinned view.
 */
export function pinPosition(
  contentBottom: number,
  scroller: Pick<ScrollState, "clientHeight">,
): number {
  return Math.max(0, Math.round(contentBottom - scroller.clientHeight));
}

/**
 * The bottom of `content` in the scroller's content coordinates. The
 * getBoundingClientRect pair is scroll-invariant: scrolling the scroller
 * moves both boxes by the same amount, so the difference (plus the current
 * offset) is the content position the pin lands on.
 */
export function contentBottomInScroller(content: HTMLElement, scroller: HTMLElement): number {
  const contentBox = content.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  return contentBox.bottom - scrollerBox.top + scroller.scrollTop;
}

/**
 * The nearest ancestor of `el` that scrolls vertically. `getComputedStyle`
 * includes the element's own inline styles, so the read is the one the
 * browser actually applies — and in a unit test, inline styles are the whole
 * of it. Walking stops at the body: a page that scrolls through the body is
 * not this surface's scroller.
 */
export function findScrollableAncestor(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node !== null && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Pin the scroller that owns the transcript to its newest row.
 *
 * The hook returns a ref for the content container. A surface that renders
 * its transcript later than its first paint (the panel's loading state, then
 * the transcript) is handled: the ref callback re-arms the pin when the
 * content lands, and disarms it when the content unmounts. Where the content
 * has no scrollable ancestor at first paint the pin stays ARMED — the content
 * is watched and every pin input re-resolves the scroller — so a scroller
 * that stands above the transcript only after its layout settles (the 1280
 * thread pane, an embedded reuse) is picked up by the next row, reflow or
 * resize instead of waiting for the content to remount.
 */
export function useStickyTranscript(): (el: HTMLElement | null) => void {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const setRef = useCallback((el: HTMLElement | null) => {
    setContent((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    if (content === null) return;

    // Pinned from first sight: opening a chat starts at the newest row.
    let pinned = true;
    let observedScroller: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;

    /** The scroller that owns the transcript, re-walked on every pin run —
     * the computed overflow-y read is the one the browser actually applies
     * at THAT moment, so a layout change that reflows the ancestor chain is
     * answered on the next pin input, not on the content's next remount. */
    const scrollerNow = () => findScrollableAncestor(content);

    const stick = () => {
      const scroller = scrollerNow();
      if (scroller === null) return;
      if (pinned) {
        scroller.scrollTop = pinPosition(contentBottomInScroller(content, scroller), scroller);
      }
      // The owning scroller can change under the pin (the pane's column
      // reflows, its side panel mounts or unmounts, an embed wraps the
      // transcript in a scroller after its own mount): the observation
      // moves to the scroller that now owns the transcript, on this run.
      if (ro !== null && observedScroller !== scroller) {
        if (observedScroller !== null) ro.unobserve(observedScroller);
        observedScroller = scroller;
        ro.observe(scroller);
      }
    };

    /** The reader moved in the scroller that owns the transcript. A
     * capture-phase listener on the document reaches the scroller whether
     * it was found at mount or re-resolved later — no listener can go stale
     * on a re-bound element — and every other scrollable element (the
     * thread list, a nested code block, the side panel) is ignored by the
     * target test. At (or just past) the newest row the view re-pins on the
     * spot; anywhere else the reader keeps their place until they return
     * within NEAR_BOTTOM_PX. A stick() of our own lands exactly at the row,
     * so its scroll event re-computes pinned as true and re-sticks to the
     * same position — the loop is fixed-point, not spin. */
    const onScroll = (event: Event) => {
      const scroller = scrollerNow();
      if (scroller === null || event.target !== scroller) return;
      pinned = isNearContentBottom(contentBottomInScroller(content, scroller), scroller);
      if (pinned) stick();
    };

    // 1280 ↔ 390: the view keeps its pin (or its place) across the resize —
    // stick() re-resolves the scroller in case the resize reflowed the
    // ancestor chain.
    const onResize = () => stick();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    // Two bottoms to watch (rcn-review11): every new row — an agent chunk, a
    // reply, a switch divider, a scope-change line, a mail card — grows the
    // content; and a composer or header reflow (the agent chip's text, a
    // wrapped meta line) resizes the scroller's box and moves the visible
    // bottom with no content growth at all. Both re-run the pin, and each
    // run re-resolves the scroller it drives. (jsdom has no ResizeObserver;
    // the guard also covers an embedded reuse whose host stripped the
    // global — without it the document scroll and resize inputs still keep
    // the pin armed, and the scroller is found the moment it exists.)
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => stick());
      ro.observe(content);
    }
    stick();

    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [content]);

  return setRef;
}
