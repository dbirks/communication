/**
 * The dev-only preview must be provably *fixture*-driven: a block that silently
 * fell back to a live endpoint would screenshot like a real run.
 */
import { afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import M4Preview from "./M4Preview";
import { mockFetch } from "../test/fakes";
import { renderApp } from "../test/render";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

/**
 * Await the route's real async boundary instead of polling for it.
 *
 * `App` mounts the preview through `lazy()`, so the first paint sits behind a
 * dynamic import plus React's pass over ~twenty panels. `findBy*` waits 1000 ms
 * by default, which measures the machine rather than the code: on an idle box
 * this mount takes ~320 ms, and 1.6 s was observed with the CPU oversubscribed
 * ~2x — i.e. the default loses the race in CI. Resolving the same module the
 * `lazy()` wrapper imports and then draining React's queue settles the paint
 * before the assertion runs, so no timeout is part of the proof.
 */
async function flushLazyChunk(): Promise<void> {
  await act(async () => {
    await import("./M4Preview");
    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/**
 * Wall-clock ceiling for a test whose only work is painting this page. The
 * await above is deterministic, but vitest's 5000 ms watchdog still kills a
 * runner that is legitimately still rendering: these two mounts paint in ~325 ms
 * and ~302 ms idle, and measured 2.4-4.0 s with the CPU oversubscribed ~3x (22
 * cores, 44 spinners) — already inside a whisker of the watchdog, which is why
 * this file's two synchronous mounts flake. A ceiling, never a wait.
 */
const PAINT_TEST_TIMEOUT = 20_000;

describe("M4Preview", () => {
  it(
    "renders every building block without contacting the API",
    () => {
      const { fetchMock, requests } = mockFetch([]);
      render(<M4Preview />);

      expect(screen.getByTestId("m4-preview-notice").textContent).toMatch(/fixtures, not a run/i);
      // Several blocks appear twice on purpose: the looping run and the fan-out
      // run are different shapes, and the preview must show both without hiding
      // either behind a tab.
      expect(screen.getAllByTestId("pipeline-library")).toHaveLength(1);
      expect(screen.getAllByTestId("yaml-view")).toHaveLength(2);
      expect(screen.getAllByTestId("definition-graph")).toHaveLength(2);
      expect(screen.getAllByTestId("run-stage-strip")).toHaveLength(2);
      expect(screen.getAllByTestId("run-tree")).toHaveLength(2);
      expect(screen.getByTestId("attempt-outputs")).toBeTruthy();
      expect(screen.getByTestId("attempt-checkpoint")).toBeTruthy();
      expect(screen.getByTestId("approval-approve")).toBeTruthy();

      expect(requests).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
    // Same synchronous mount as the test below: a watchdog ceiling, measured at
    // 3.8 s (vs ~325 ms idle) under ~3x oversubscription.
    PAINT_TEST_TIMEOUT,
  );

  it(
    "wires the graph's selection to the YAML highlight and the tree's toggle",
    () => {
      mockFetch([]);
      // This mount is synchronous — there is no boundary to await, only the
      // runner's clock to survive. It paints in ~302 ms idle, measured 4.9 s at
      // ~3x oversubscription and killed by the 5 s watchdog at 6.3 s with a
      // second full suite running alongside — that kill is how this test flaked.
      // `PAINT_TEST_TIMEOUT` is the same ceiling as the mount test above: a
      // watchdog raise, never a wait.
      render(<M4Preview />);
      fireEvent.click(screen.getByTestId("definition-graph-list-verdict"));
      expect(screen.getByTestId("definition-graph-inspector-id").textContent).toBe("verdict");

      // The fan-out scope starts expanded on the preview, so one click collapses it
      // and the next one brings its places back — 25 places, ten to a page.
      fireEvent.click(screen.getByTestId("run-tree-toggle-/verify_each"));
      expect(screen.queryAllByTestId("run-tree-row-/verify_each[1]")).toHaveLength(0);
      fireEvent.click(screen.getByTestId("run-tree-toggle-/verify_each"));
      expect(screen.getAllByTestId(/^run-tree-row-\/verify_each\[\d+\]$/)).toHaveLength(10);
      // The page says what it is hiding rather than leaving a short list unexplained.
      expect(screen.getByTestId("run-tree-row-more:/verify_each").textContent).toContain("15 more");
    },
    PAINT_TEST_TIMEOUT,
  );

  it(
    "is reachable through the app at its dev path, with no session check",
    async () => {
      // Shell asks the API who the user is; the preview renders outside it, so
      // mounting the whole app at this path must still touch the network zero
      // times. That is the guard against a fixture page quietly gaining a
      // `/session` call and screenshotting like a live screen.
      const { requests } = renderApp({ path: "/__m4-preview" });
      // Lazy, so it arrives a tick late; the assertion is that it arrives at all —
      // awaited, not raced.
      await flushLazyChunk();
      expect(screen.getByTestId("m4-preview")).toBeTruthy();
      expect(requests).toHaveLength(0);
    },
    PAINT_TEST_TIMEOUT,
  );
});
