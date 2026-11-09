// The capture harness's own unit test (no lab, no server, no app build — the
// `reflow` project's idiom): `fullPage` evidence shots go from the TOP.
//
// The defect this proves away is in the EVIDENCE, not the product: a journey
// auto-scrolls a clicked row, and a `page.screenshot({fullPage:true})` taken
// while the page is still scrolled stitches the sticky phone band into the
// MIDDLE of the 390 render. Measured on the dev tree (:15173, /p/<project> at
// 390 scrolled to 400): the band's full-width bottom border — the row with 352
// dark pixels — landed at y=229 instead of y=43, its wordmark ink at y=197..220
// instead of y=11..34, and rows 0..43 came back empty, i.e. the band painted
// over the overview's own content. `scrollToTopForCapture` puts every scroll
// container back at the top and waits two animation frames before the capture.
import { expect, test } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { scrollToTopForCapture } from "../tests/helpers.js";

/** The observed real shape at 390: the WINDOW scrolls, a sticky band follows
 * it, and an inner `main` scrolls on its own (the shell's own container). */
function doc(bodyClass: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 14px/20px ui-monospace, monospace; }
    header { position: sticky; top: 0; height: 43px; background: #fff;
             border-bottom: 1px solid #555; }
    main { height: 200px; overflow-y: auto; }
    .long { height: 3000px; }
  </style></head><body>
    <header><span>BAND</span></header>
    <main class="${bodyClass}" id="scroller"><div class="long">CONTENT</div></main>
    <div class="long">TAIL</div>
  </body></html>`;
}

/** The row indices with over 300 dark pixels (the band's own full-width
 * border) and the first row with any ink, read out of a PNG buffer. */
async function bandInk(page: Page, png: Buffer): Promise<{ borders: number[]; firstInk: number }> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const borders: number[] = [];
    let firstInk = -1;
    for (let y = 0; y < c.height; y += 1) {
      const d = ctx.getImageData(0, y, c.width, 1).data;
      let dark = 0;
      for (let x = 0; x < c.width; x += 1) if (d[x * 4] < 160) dark += 1;
      if (firstInk === -1 && dark > 0) firstInk = y;
      if (dark > 300) borders.push(y);
    }
    return { borders, firstInk };
  }, png.toString("base64"));
}

test("a full-page capture taken after scrollToTopForCapture starts at the band", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(doc("a"));

  const scrolled = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("#scroller")!;
    scroller.scrollTop = 400;
    window.scrollTo(0, 400);
    return {
      windowY: window.scrollY,
      docEl: document.documentElement.scrollTop,
      main: scroller.scrollTop,
    };
  });
  expect(scrolled.windowY, "the window is scrolled").toBeGreaterThan(0);
  expect(scrolled.main, "the inner container is scrolled").toBe(400);

  await scrollToTopForCapture(page);
  const rest = await page.evaluate(() => ({
    windowY: window.scrollY,
    docEl: document.documentElement.scrollTop,
    stillScrolled: Array.from(document.querySelectorAll("*")).filter(
      (el) => el.scrollTop !== 0 || el.scrollLeft !== 0,
    ).length,
  }));
  expect(rest, "every scroll container is back at the top").toEqual({
    windowY: 0,
    docEl: 0,
    stillScrolled: 0,
  });

  const ink = await bandInk(page, await page.screenshot({ fullPage: true }));
  expect(ink.firstInk, "the image's first rows are the band, not the page behind it").toBeLessThan(
    15,
  );
  expect(
    ink.borders.slice(0, 1),
    "the band's bottom border is the row it draws at the top (y=43)",
  ).toEqual([43]);
});

test("the same page captured while scrolled does NOT start at the band", async ({ page }) => {
  // The bug, stated as an assertion: without the fix the stitched ink is NOT at
  // y=43 — which is exactly why the harness scrolls to the top first.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(doc("b"));
  await page.evaluate(() => {
    window.scrollTo(0, 400);
    document.querySelector<HTMLElement>("#scroller")!.scrollTop = 400;
  });
  const ink = await bandInk(page, await page.screenshot({ fullPage: true }));
  expect(
    ink.borders.includes(43),
    `the band was stitched away from its own row (borders at ${ink.borders.join(",")})`,
  ).toBe(false);
});
