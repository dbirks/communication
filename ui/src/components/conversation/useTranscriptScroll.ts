/**
 * The chat transcript's pin (rcn-review10): the view stays with the newest row
 * the way every chat does —
 *
 * - opening a chat starts at the newest row;
 * - while the reader is at (or within ~80px of) the bottom, every new row — an
 *   agent chunk, a reply, a switch divider, a scope-change line, a mail card —
 *   keeps the view pinned to the bottom. The pin lands the scroller's own
 *   bottom, which includes the transcript's composer-height bottom padding
 *   (round 6), so the last row sits fully clear of the pinned composer;
 * - if the reader has scrolled up to read, new rows do NOT move the view —
 *   they keep their place until the reader returns to the bottom;
 * - a viewport resize (1280 ↔ 390) re-pins if the view was pinned.
 *
 * The hook returns a ref for the content container. A surface that renders
 * its transcript later than its first paint (the panel's loading state, then
 * the transcript) is handled: the ref callback re-arms the pin when the
 * content lands, and disarms it when the content unmounts.
 */
import { useCallback, useEffect, useState } from "react";

/** How far above the bottom still counts as "at the bottom" (the review's
 * ~80px: a reply that lands while the last line sits 80px up still pins). */
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

/** Put the scroller at its bottom: the newest row (plus the reserved composer
 * padding) lands at the bottom edge, clear of the pinned composer. */
export function pinToBottom(scroller: ScrollState & { scrollTop: number }): void {
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

/**
 * Pin the scroller that owns the transcript to its newest row.
 *
 * The hook returns a ref for the content container. A surface that renders
 * its transcript later than its first paint (the panel's loading state, then
 * the transcript) is handled: the ref callback re-arms the pin when the
 * content lands, and disarms it when the content unmounts. No-op where the
 * content has no scrollable ancestor.
 */
export function useStickyTranscript(): (el: HTMLElement | null) => void {
  const [content, setContent] = useState<HTMLElement | null>(null);
  const setRef = useCallback((el: HTMLElement | null) => {
    setContent((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    if (content === null) return;
    const scroller = findScrollableAncestor(content);
    if (scroller === null) return;

    // Pinned from first sight: opening a chat starts at the newest row.
    let pinned = true;
    const stick = () => {
      if (pinned) pinToBottom(scroller);
    };
    stick();

    const onScroll = () => {
      // The reader scrolled up to read: remember it, and stop following.
      // Scrolling back within NEAR_BOTTOM_PX re-pins the same way.
      pinned = isNearBottom(scroller);
    };
    scroller.addEventListener("scroll", onScroll);

    // 1280 ↔ 390: the view keeps its pin (or its place) across the resize.
    const onResize = () => stick();
    window.addEventListener("resize", onResize);

    // Every new row — an agent chunk, a reply, a switch divider, a
    // scope-change line, a mail card — grows the content, and while the view
    // is pinned that is exactly the moment to follow it. (jsdom has no
    // ResizeObserver; the guard also covers an embedded reuse whose host
    // stripped the global.)
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => stick());
      ro.observe(content);
    }

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [content]);

  return setRef;
}
