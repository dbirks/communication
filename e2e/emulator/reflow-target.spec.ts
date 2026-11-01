// reflow.ts's `findSmallTargets` measures the HIT AREA, not the painted box
// (acceptance-36 defect loop): six passes in a row reported
// `touch targets under 44px: Edit:26px, ⋯:26px` on 1b index / 1b folders / 1c
// new-workflow at 390, while `ui/src/components/workflows/WorkflowRow.tsx`
// (`PHONE_HIT`, `PHONE_HIT_MENU_TRIGGER`) draws those 26px buttons on purpose
// and extends the tappable area with an invisible absolutely positioned
// `::after` — `after:inset-x-0 after:-top-[10px] after:-bottom-[10px]` since
// a29d3ed ("24 + 10 + 10 = 44": the pseudo lays out against the bordered 26px
// button's PADDING box, so ±10px is what reaches 44; it used to be ±9px, and
// case (a2) below is the measurement that moved it). `getBoundingClientRect()` alone could never see that
// area — and reading the CSS on faith would be gullible, since a sibling parked
// over the extension makes it unreachable. So the checker takes the union of
// the rect and the element's OWN absolutely positioned pseudos (the element must
// host them, i.e. not be `position:static`; the abspos containing block is the
// element's PADDING box) and then PROVES the extension answers to a touch with
// `document.elementFromPoint` at the extension's top and bottom. A failed probe
// is retried once with the element centred in everything that scrolls it (then
// every scroll restored) — see the `fold` cases below, which are the lab's own
// 390×844 shape.
//
// This spec is the checker's own unit test: no lab, no server, no app build —
// `page.setContent` fixtures, run by the config's `reflow` project (no `setup`
// dependency).
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts --project=reflow
import { expect, test } from "@playwright/test";
import { findSmallTargets, type TargetHit } from "./reflow.js";

/**
 * A document whose MAIN holds `body`. The 26px box is the design's compact
 * button height (`docs/design/handoff-app-shell/README.md`: "Heights 26 / 30 /
 * 36; mobile 44–48") and `.hit` reproduces WorkflowRow's FORMER treatment,
 * the ±9px invisible `::after` — kept at ±9px on purpose so (a) shows it
 * clearing 44px on a borderless 26px box and (a2) shows it failing to on the
 * app's bordered one (the app now draws ±10px, which fixes that). Fixture
 * controls are named by `aria-label` because that is the label the checker
 * reports.
 */
function doc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 14px/20px ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { padding: 8px; }
    /* A 26px box with no border; .bordered adds the 1px border the app's
       .ds-btn draws, which shrinks the padding box to 24px. */
    button { height: 26px; padding: 0 8px; border: 0; background: #eee; }
    .bordered { border: 1px solid #888; }
    .hit { position: relative; }
    .hit::after { content: ''; position: absolute; left: 0; right: 0; top: -9px; bottom: -9px; }
    .hit5 { position: relative; }
    .hit5::after { content: ''; position: absolute; left: 0; right: 0; top: -5px; bottom: -5px; }
    /* .bordered .hit10 is WorkflowRow's CURRENT phone treatment exactly: the
       bordered 26px compact button with the ±10px invisible ::after that
       clears 44px off the padding box (24 + 10 + 10). */
    .hit10 { position: relative; }
    .hit10::after { content: ''; position: absolute; left: 0; right: 0; top: -10px; bottom: -10px; }
    .stat::after { content: ''; position: absolute; left: 0; right: 0; top: -9px; bottom: -9px; }
  </style></head><body><main>${body}</main></body></html>`;
}

/** The one hit named `testid`, or undefined when that control passed. */
function hitFor(testid: string, hits: TargetHit[]): TargetHit | undefined {
  return hits.find((hit) => hit.name === testid);
}

/** The painted box layout gave `testid` — the assertions only mean something if
 * the fixture really is the shape it claims to be. */
function painted(testid: string): { top: number; bottom: number } {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (el === null) return { top: -1, bottom: -1 };
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
}

/** What `elementFromPoint` says owns a point 390px-wide at the element's centre
 * (the fixture's own proof that the band is contested). */
function ownerAbove(pair: [testid: string, offset: number]): string {
  const [testid, offset] = pair;
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (el === null) return "missing";
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + offset);
  if (hit === null) return "null";
  return hit.getAttribute("data-testid") ?? hit.tagName.toLowerCase();
}

test.describe("findSmallTargets and the real hit area", () => {
  test("(a) a 26px button whose ::after really reaches 44px is not reported", async ({ page }) => {
    await page.setContent(
      doc(
        [
          '<div style="padding-top:60px">',
          '<button data-testid="edit-a" class="hit" aria-label="edit-a"></button> ',
          '<button data-testid="menu-a" class="hit" aria-label="⋯"></button>',
          "</div>",
        ].join(""),
      ),
    );
    const box = await page.evaluate(painted, "edit-a");
    // The painted box really is the short one, clear of the viewport edge.
    expect(box.bottom - box.top).toBe(26);
    expect(box.top).toBeGreaterThan(9);
    // …and the band above it answers to a touch: the ::after is 9px of nothing
    // but hit area, and it wins the hit test where it is laid out.
    expect(await page.evaluate(ownerAbove, ["edit-a", -8])).toBe("edit-a");
    expect(await page.evaluate(findSmallTargets)).toEqual([]);
  });

  test("(a2) a 26px BORDER-box button with the old ±9px gets 42px, not 44", async ({ page }) => {
    // The abspos containing block is the PADDING box: `.ds-btn` is 26px
    // border-box with a 1px border, so its padding box is 24px and Chrome lays
    // the ±9px `::after` out 8px past the visible box on each side (42px, the
    // lab's own measured answer) — under the 44px phone floor. This is the
    // measurement a29d3ed moved the app to ±10px over (`24 + 10 + 10 = 44`);
    // the fixture stays at ±9px because short-of-44 is what this case proves.
    await page.setContent(
      doc(
        '<div style="padding-top:60px"><button data-testid="edit-a2" class="bordered hit" aria-label="edit-a2"></button></div>',
      ),
    );
    expect(await page.evaluate(ownerAbove, ["edit-a2", -8])).toBe("edit-a2");
    expect(await page.evaluate(ownerAbove, ["edit-a2", -9])).not.toBe("edit-a2");
    const hits = await page.evaluate(findSmallTargets);
    expect(hitFor("edit-a2", hits)).toEqual({ name: "edit-a2", height: 42 });
  });

  test("(b) a plain 26px button is reported at 26", async ({ page }) => {
    await page.setContent(
      doc(
        '<div style="padding-top:60px"><button data-testid="plain-b" class="bordered" aria-label="plain-b"></button></div>',
      ),
    );
    const hits = await page.evaluate(findSmallTargets);
    expect(hits).toHaveLength(1);
    expect(hitFor("plain-b", hits)).toEqual({ name: "plain-b", height: 26 });
  });

  test("(c) a sibling covering the extension means it is still reported at 26", async ({
    page,
  }) => {
    // The button's box starts 68px down (main padding 8 + padding-top 60), so
    // its ±9px extension is the band 59–68 above it. The sibling is parked over
    // exactly that band, positioned and later in DOM order, so it wins the hit
    // test: the extension is unreachable and the target is 26px again.
    await page.setContent(
      doc(
        [
          '<div style="position:relative;padding-top:60px">',
          '<button data-testid="covered-c" class="hit" aria-label="covered-c"></button>',
          '<div data-testid="overlay-c" style="position:absolute;left:0;right:0;top:51px;height:9px;background:#ccc"></div>',
          "</div>",
        ].join(""),
      ),
    );
    // The overlay (offsets come off the container's padding box, which starts at
    // y=8) really does own the extension band.
    expect(await page.evaluate(ownerAbove, ["covered-c", -7])).toBe("overlay-c");
    const hits = await page.evaluate(findSmallTargets);
    expect(hitFor("covered-c", hits)).toEqual({ name: "covered-c", height: 26 });
  });

  test("(d) a ::after on a position:static button does not count", async ({ page }) => {
    // `static` → the button is not the pseudo's containing block, so the 44px
    // box that `::after` paints belongs to an ancestor, not to this target.
    await page.setContent(
      doc(
        [
          '<div style="padding-top:60px">',
          '<button data-testid="static-d" class="stat" aria-label="static-d" style="position:static"></button>',
          "</div>",
        ].join(""),
      ),
    );
    const hits = await page.evaluate(findSmallTargets);
    expect(hitFor("static-d", hits)).toEqual({ name: "static-d", height: 26 });
  });

  test("an extension that only reaches 36px is reported at 36, not 26", async ({ page }) => {
    // The defect line carries the REAL hit area, so a partial extension is
    // reported honestly instead of at the painted height.
    await page.setContent(
      doc(
        '<div style="padding-top:60px"><button data-testid="short-e" class="hit5" aria-label="short-e"></button></div>',
      ),
    );
    const hits = await page.evaluate(findSmallTargets);
    expect(hitFor("short-e", hits)).toEqual({ name: "short-e", height: 36 });
  });

  test("an extension off the top of the viewport does not count", async ({ page }) => {
    // The band above the box is off screen while the button itself is on it: as
    // displayed, a finger cannot get all 44px.
    await page.setContent(
      doc(
        '<button data-testid="edge-f" class="hit" aria-label="edge-f" style="margin-top:-6px"></button>',
      ),
    );
    expect(await page.evaluate(painted, "edge-f")).toEqual({ top: 2, bottom: 28 });
    const hits = await page.evaluate(findSmallTargets);
    expect(hitFor("edge-f", hits)).toEqual({ name: "edge-f", height: 26 });
  });

  // row-hit-390: on the REAL page the app's extension was genuine (a centred
  // `Edit` probes SELF top and bottom at 44px) yet every 390 pass still
  // reported `Edit:26px, ⋯:26px`, because the journeys measure from the top
  // and the first workflow row parks its 26px box at y≈831..857 of the
  // 390×844 viewport — the bottom probe fell below the fold and the checker
  // read the page's SCROLL as the control's height. These two cases pin both
  // halves of the fix: (g) the checker follows the scroll a finger can make
  // and clears a clipped-but-real extension, (h) a control that really is
  // 26px is still reported at the fold — no scroll excuse for a short box.
  test.describe("at the fold of the lab's own 390×844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    /** main's 8px pad + an 828px spacer puts the button at 836..862: on
     * screen at the top scroll, its ±10px band below the 844px fold, with a
     * long tail of page making the scroll possible (the /workflows shape). */
    const atTheFold = (testid: string, cls: string): string =>
      `<div style="height:828px"></div><button data-testid="${testid}" class="${cls}" aria-label="${testid}"></button><div style="height:900px"></div>`;

    test("(g) the app's ±10px extension clipped at the viewport bottom counts at 44", async ({
      page,
    }) => {
      await page.setContent(doc(atTheFold("fold-g", "bordered hit10")));
      const before = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="fold-g"]')!.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
        };
      });
      // The defect's exact shape: the box on screen, its bottom band not.
      expect(before).toEqual({ top: 836, bottom: 862, innerHeight: 844, scrollY: 0 });
      expect(await page.evaluate(findSmallTargets)).toEqual([]);
      // …and the checker leaves no trace: the page is back where it was.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    test("(h) a plain 26px button at the same fold is still reported at 26", async ({ page }) => {
      await page.setContent(doc(atTheFold("fold-h", "bordered")));
      const hits = await page.evaluate(findSmallTargets);
      expect(hitFor("fold-h", hits)).toEqual({ name: "fold-h", height: 26 });
    });
  });
});
