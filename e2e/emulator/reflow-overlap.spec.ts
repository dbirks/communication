// reflow.ts's `findOverlaps` has two jobs: say YES when two things really print
// over one another, and say NOTHING when the page is merely shaped that way. The
// acceptance-32 loop proved it could not do the second one — every pass of
// 32's run reported the same `overlap` defect on `run-gate waiting` /
// `run-gate completed` / `2e schedule-run-approved`, e.g.
//
//   span "Action: Verify all four file" × span "head matches the survey text" (351×17px)
//
// while `run-gate-completed-390.png` shows the plan's inline runs wrapped in
// clean, separate lines. The plan is rendered by `ui/src/lib/markdown.tsx` as
// adjacent INLINE `<span>`/`<code>` runs; layout gives such a run one box per
// line it breaks across, and the checker collapsed them into their union, so a
// run that ended on line 1 and its neighbour that filled the rest of line 1 each
// "covered" both lines and they intersected across the whole paragraph width.
//
// This spec is the checker's own unit test: no lab, no server, no app build —
// `page.setContent` fixtures, run by the config's `reflow` project, which (unlike
// `journeys`) has no `setup` dependency.
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts emulator/reflow-overlap.spec.ts
import { expect, test } from "@playwright/test";
import { findOverlaps } from "./reflow.js";

/** A document whose MAIN holds `body`; the mono font keeps fixture widths stable. */
function doc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 14px/20px ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { padding: 8px; }
  </style></head><body><main>${body}</main></body></html>`;
}

/** The element's own line fragments — how many boxes LAYOUT gave it. */
function lineFragments(testid: string): number {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  return el === null ? -1 : el.getClientRects().length;
}

test.describe("findOverlaps and wrapped inline text", () => {
  test("two adjacent inline runs that wrap are not a collision", async ({ page }) => {
    await page.setContent(
      doc(
        [
          '<div style="width:200px">',
          // The run-gate's plan line: prose, a code span, more prose — all
          // inline, all wrapping inside one 200px paragraph.
          '<span data-testid="run-a">Action: Verify all four files named</span> ',
          '<code data-testid="run-b" style="background:#eee">pytest tests/test_hello.py::test_plan</code> ',
          '<span data-testid="run-c">head matches the survey text and exits 0</span>',
          "</div>",
        ].join(""),
      ),
    );
    // The fixture must really be the shape that used to false-positive: each run
    // broken across several lines, so one union box per run would span them all.
    for (const testid of ["run-a", "run-b", "run-c"]) {
      expect(await page.evaluate(lineFragments, testid)).toBeGreaterThan(1);
    }
    expect(await page.evaluate(findOverlaps)).toEqual([]);
  });

  test("an absolutely positioned span printed over another is a collision", async ({ page }) => {
    // The geometry is deliberately generous (≥7px on every containment edge).
    // The first cut of this fixture parked the absolute span 2px below the
    // inline one and 0px beside it — INSIDE the checker's own 1px containment
    // slack once a font's ink box starts 2px below the line box (what every
    // Actions pass of run 41423602047 observed: 0 hits, whole suite red),
    // while this machine's ui-monospace match kept it at 0 and passed. The
    // rule under test — an abs-positioned run printed OVER its neighbour is
    // a collision — does not change with the geometry.
    await page.setContent(
      doc(
        [
          '<div style="position:relative;width:400px;height:120px">',
          '<div style="height:30px"></div>',
          '<span data-testid="over-a">short line</span>',
          '<span data-testid="over-b" style="position:absolute;left:8px;top:36px;width:260px">',
          "printed over the whole line by someone who meant it",
          "</span>",
          "</div>",
        ].join(""),
      ),
    );
    const hits = await page.evaluate(findOverlaps);
    expect(hits).toHaveLength(1);
    expect([hits[0]!.a, hits[0]!.b].sort()).toEqual(["over-a", "over-b"]);
    expect(hits[0]!.dx).toBeGreaterThan(4);
    expect(hits[0]!.dy).toBeGreaterThan(4);
  });
});
