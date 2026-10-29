/**
 * graphFit.ts — the pure geometry behind the read-only Overview canvas's
 * fit-to-width (design 1e, the 390px reflow rule): everything the 1280 view
 * shows must be reachable and readable at 390 without hunting.
 *
 * The canvas draws at its natural size and the pane scrolls. When the pane
 * is narrower than the graph, the graph is scaled DOWN to the pane width —
 * but never below `MIN_FIT_SCALE`, because a smaller scale is decoration,
 * not a graph. When even the floor cannot fit the graph, the drawing stays
 * left-aligned at its LEFT edge (`justify-start`, `scrollLeft` 0): with the
 * old `justify-center` the overflow split to both sides and the browser
 * cannot scroll into the inline-start dead zone, so the graph's left column
 * was unreachable — the bug this file exists to kill. The pan affordance
 * (`pansHorizontally` → the hint line) then says out loud that there is
 * more to the right.
 */

/** The card title is the one label the reader came for; it renders at
 * `CARD_TITLE_PX` inside the scaled canvas. At the floor it is still
 * ≈9.5px, which is the line the m4 graph draws ("8px is decoration, not a
 * graph"). Keep `CARD_TITLE_PX` in step with the 13.5px title line in
 * `GraphCanvas.tsx`. */
export const CARD_TITLE_PX = 13.5;
/** The smallest on-screen title the fit may produce (px). */
export const MIN_TITLE_PX = 9;
/** The floor the width fit may not go under: 9 / 13.5 ≈ 0.67, rounded up to
 * 0.7 so a 13.5px title lands at 9.45px. If the graph is still wider than
 * the pane here, it pans from its left edge instead of shrinking further. */
export const MIN_FIT_SCALE = Math.ceil((MIN_TITLE_PX / CARD_TITLE_PX) * 10) / 10;

/**
 * The scale that fits `graphWidth` into `paneWidth`: 1 at 1280 (the design's
 * own width — the fit NEVER enlarges, so the 1280 look is untouched), the
 * exact ratio in between, and the readable floor when the pane is too narrow
 * to fit even at the floor. An unmeasured pane (0 — first paint, or jsdom,
 * which does no layout) draws at natural scale, never at 0.
 */
export function fitScale(opts: {
  paneWidth: number;
  graphWidth: number;
  minScale?: number;
}): number {
  const { paneWidth, graphWidth } = opts;
  const minScale = opts.minScale ?? MIN_FIT_SCALE;
  if (!(paneWidth > 0) || !(graphWidth > 0)) return 1;
  return Math.max(minScale, Math.min(1, paneWidth / graphWidth));
}

/** True when the scaled graph is wider than the pane — the canvas must then
 * left-align (so the graph's left edge is at `scrollLeft` 0, reachable) and
 * say it pans. The 1px slack keeps a rounding-level overflow from claiming
 * a pan that no scrollbar will offer. */
export function pansHorizontally(opts: {
  paneWidth: number;
  graphWidth: number;
  scale: number;
}): boolean {
  const { paneWidth, graphWidth, scale } = opts;
  return paneWidth > 0 && graphWidth * scale > paneWidth + 1;
}
