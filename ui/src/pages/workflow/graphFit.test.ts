/**
 * graphFit (design 1e, 390px reflow rule): the read-only Overview canvas
 * scales its drawing down to the pane width, never up (the 1280 look is the
 * design's own), never under the readable floor, and when even the floor
 * leaves it wider than the pane it must PAN FROM ITS LEFT EDGE — the fit
 * numbers below are the seed `feature-development` graph, 714×841px, which
 * fits the 1280 pane and does not fit a 350px phone pane at any scale that
 * keeps the 13.5px card title readable.
 */
import { describe, expect, it } from "vitest";
import { CARD_TITLE_PX, fitScale, MIN_FIT_SCALE, MIN_TITLE_PX, pansHorizontally } from "./graphFit";

/** The seed graph as `GraphCanvas` measures it (see the geometry test). */
const SEED_WIDTH = 714;

describe("graphFit", () => {
  it("never zooms past 1 — the 1280 pane fits the seed graph and draws it unchanged", () => {
    // The 1280 Overview canvas: 1280 − sidebar (~220) − the 285px rail.
    expect(fitScale({ paneWidth: 775, graphWidth: SEED_WIDTH })).toBe(1);
    expect(fitScale({ paneWidth: 4000, graphWidth: SEED_WIDTH })).toBe(1);
    expect(fitScale({ paneWidth: SEED_WIDTH, graphWidth: SEED_WIDTH })).toBe(1);
  });

  it("scales to the pane width exactly between 1 and the floor", () => {
    const fitted = fitScale({ paneWidth: 600, graphWidth: SEED_WIDTH });
    expect(fitted).toBeCloseTo(600 / SEED_WIDTH, 6);
    expect(fitted).toBeLessThan(1);
    expect(fitted).toBeGreaterThan(MIN_FIT_SCALE);
    // And it does fit — no pan claimed at this width.
    expect(pansHorizontally({ paneWidth: 600, graphWidth: SEED_WIDTH, scale: fitted })).toBe(false);
  });

  it("holds the readable floor when the pane cannot fit the graph: 390px pans, it does not shrink to nothing", () => {
    // A 390 phone: the 350px content pane would need ~49%, which puts the
    // 13.5px card title under 7px — decoration, not a graph.
    const fitted = fitScale({ paneWidth: 350, graphWidth: SEED_WIDTH });
    expect(fitted).toBe(MIN_FIT_SCALE);
    expect(fitted * SEED_WIDTH).toBeGreaterThan(350);
    // The floor is stated in the reader's units, not in scale numbers.
    expect(CARD_TITLE_PX * fitted).toBeGreaterThanOrEqual(MIN_TITLE_PX);
    // So the canvas pans — and the pan is only honest because the drawing
    // left-aligns (the component side of this contract is in GraphCanvas).
    expect(pansHorizontally({ paneWidth: 350, graphWidth: SEED_WIDTH, scale: fitted })).toBe(true);
  });

  it("draws at natural scale before the pane is measured (and in a no-layout environment)", () => {
    // First paint and jsdom report no width: scaling by 0/graphWidth would
    // vanish the graph.
    expect(fitScale({ paneWidth: 0, graphWidth: SEED_WIDTH })).toBe(1);
    expect(fitScale({ paneWidth: Number.NaN, graphWidth: SEED_WIDTH })).toBe(1);
    expect(fitScale({ paneWidth: 350, graphWidth: 0 })).toBe(1);
    expect(pansHorizontally({ paneWidth: 0, graphWidth: SEED_WIDTH, scale: 1 })).toBe(false);
  });

  it("a rounding-level overflow is not a pan", () => {
    expect(pansHorizontally({ paneWidth: 600, graphWidth: 600.5, scale: 1 })).toBe(false);
    expect(pansHorizontally({ paneWidth: 600, graphWidth: 602, scale: 1 })).toBe(true);
  });

  it("a caller-supplied floor replaces the default", () => {
    expect(fitScale({ paneWidth: 100, graphWidth: SEED_WIDTH, minScale: 0.5 })).toBe(0.5);
  });
});
