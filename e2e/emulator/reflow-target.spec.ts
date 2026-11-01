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
// pass-1 (`out/pass-1-20261101102509`, screen 1c new-workflow at 390) added the
// other half of “the real hit area”: what a finger can REACH. That screen is
// the /workflows index with the New workflow dialog open over it, so the rows'
// 26px `Edit` / `⋯` were reported as defects even though the dialog's backdrop
// takes every touch and the page behind is inert — a target nobody can tap is
// not a short target. The `modal` cases below pin both halves: a 26px control
// behind an open modal is not reported, and a 26px control INSIDE it still is.
//
// This spec is the checker's own unit test: no lab, no server, no app build —
// `page.setContent` fixtures, run by the config's `reflow` project (no `setup`
// dependency).
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts --project=reflow
//
// The middle describe block is the THIRD pass-1 checker fix: `out/pass-1-
// 20261101113830` recorded 20 defects and 19 of them were the same bug — every
// `*-server-error` screen at both widths reported an `overlap` such as
// `workflows-load-error-server × workflows-load-retry (57×12px)`, measured on
// the raw server line a7ea79f had just moved behind a CLOSED `<details>`
// disclosure (`ui/src/components/Feedback.tsx`). Nothing overlaps in
// `1b-server-error-1280.png`: the text is folded away, and Chrome still lays it
// out with a real box. So every collector now asks the browser whether it PAINTS
// the element (`checkVisibility`), not just whether it has a box.
//
// The last describe block is the other pass-1 checker fix and lives here for
// the same reason: `plan-steps.ts` (the gate card's “the steps are numbered in
// order” rule) needs a browser and no lab, and this is the no-lab project.
import { expect, test } from "@playwright/test";
import {
  collectPlanNumbering,
  judgePlanNumbering,
  type PlanBlock,
  type PlanBlockKind,
} from "./plan-steps.js";
import {
  collectReflowItems,
  findClippedText,
  findOverlaps,
  findSmallTargets,
  type OverlapHit,
  type TargetHit,
} from "./reflow.js";

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

/** What `elementFromPoint` says owns the centre of `testid` (walking up to the
 * nearest `data-testid`): the fixture's own proof that the control really is
 * behind the scrim — and that a control in the dialog really answers to a
 * touch. */
function ownerAt(testid: string): string {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (el === null) return "missing";
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit === null) return "null";
  const owner = hit.closest("[data-testid]");
  return owner?.getAttribute("data-testid") ?? hit.tagName.toLowerCase();
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

  // 1c new-workflow at 390: the modal is open, so the rows behind it are not
  // touch targets at all. `withDialog` reproduces `NewWorkflowDialog`'s markup
  // (`fixed inset-0 … bg-ink/25` backdrop holding the
  // `role=dialog aria-modal=true` sheet) inside `<main>`, which is where the
  // page renders it, so the checker sees the same tree the finger does.
  test.describe("while a modal is open", () => {
    const sheet = (body: string): string =>
      [
        '<div data-testid="scrim" style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.25)">',
        '<div role="dialog" aria-modal="true" data-testid="the-dialog" style="width:300px;margin:120px auto;background:#fff;padding:8px">',
        body,
        "</div></div>",
      ].join("");
    const behind = (testid: string): string =>
      `<div style="padding-top:60px"><button data-testid="${testid}" class="bordered" aria-label="${testid}"></button></div>`;

    test("(i) a 26px control behind an open modal is not reported", async ({ page }) => {
      await page.setContent(doc(`${behind("behind-i")}${sheet("<p>new workflow</p>")}`));
      // The control is painted, enabled and 26px tall — and the backdrop is
      // what answers a touch on it, so there is no target to judge.
      expect(await page.evaluate(ownerAt, "behind-i")).toBe("scrim");
      expect(await page.evaluate(findSmallTargets)).toEqual([]);
    });

    test("(ii) a 26px control inside the open modal is still reported", async ({ page }) => {
      await page.setContent(
        doc(`${behind("behind-ii")}${sheet(behind("inside-ii").replace("padding-top:60px", ""))}`),
      );
      expect(await page.evaluate(ownerAt, "behind-ii")).toBe("scrim");
      expect(await page.evaluate(ownerAt, "inside-ii")).toBe("inside-ii");
      const hits = await page.evaluate(findSmallTargets);
      expect(hits).toEqual([{ name: "inside-ii", height: 26 }]);
    });

    test("a native <dialog open> is a modal too", async ({ page }) => {
      await page.setContent(
        doc(
          [
            behind("behind-dialog"),
            '<dialog open data-testid="the-dialog" style="position:fixed;left:40px;top:120px;background:#fff">',
            '<button data-testid="inside-dialog" class="bordered" aria-label="inside-dialog"></button>',
            "</dialog>",
          ].join(""),
        ),
      );
      const hits = await page.evaluate(findSmallTargets);
      expect(hits).toEqual([{ name: "inside-dialog", height: 26 }]);
    });

    test("an inert or aria-hidden subtree answers to no touch", async ({ page }) => {
      // No modal here: the page itself parks a subtree out of reach, and a
      // painted 26px button in it is still not a target.
      await page.setContent(
        doc(
          [
            '<div inert data-testid="inert-box">',
            '<button data-testid="inert-btn" class="bordered" aria-label="inert-btn"></button></div>',
            '<div aria-hidden="true" data-testid="hidden-box">',
            '<button data-testid="hidden-btn" class="bordered" aria-label="hidden-btn"></button></div>',
            behind("live-btn"),
          ].join(""),
        ),
      );
      const hits = await page.evaluate(findSmallTargets);
      expect(hits).toEqual([{ name: "live-btn", height: 26 }]);
    });

    test("with no modal open, the 26px control behind where it would be is reported", async ({
      page,
    }) => {
      // The same document minus the dialog: the checker did not simply learn
      // to ignore rows, it ignores them while something is actually open.
      await page.setContent(doc(behind("closed-i")));
      const hits = await page.evaluate(findSmallTargets);
      expect(hitFor("closed-i", hits)).toEqual({ name: "closed-i", height: 26 });
    });
  });
});

/**
 * pass-1 (`out/pass-1-20261101113830`): 20 defects, 19 of them one checker bug.
 * Every `*-server-error` screen at BOTH widths filed
 *
 *   overlap: workflows-load-error-server × workflows-load-retry (57×12px)
 *   overlap: p.wrap-anywhere "server said: Internal Server" × repo-load-retry
 *
 * while `1b-server-error-1280.png` shows a clean block: `Couldn't load the
 * workflow library.`, the hint, `▸ Details`, `Retry` — nothing printed over
 * anything. a7ea79f had moved the server's own words into a CLOSED `<details>`
 * disclosure, and a closed disclosure is exactly the case a box-based checker
 * gets wrong: Chrome lays the folded text out (`getBoundingClientRect` answers a
 * real non-zero box, `display: block`, `visibility: visible`) and paints none of
 * it. The collectors measured ink that is on no screenshot — the probe that
 * reproduced it on the live page printed before/after
 *
 *   WIDTH 1280 before: overlap=[{"a":"workflows-load-error-server","b":"workflows-load-retry","dx":57,"dy":12}]
 *   WIDTH 1280 after:  overlap=[]
 *
 * which is pass-1's defect line, 57×12px and all.
 *
 * `folded` reproduces that block with the app's own geometry — the folded line
 * and the action row occupy the SAME band while the disclosure is shut — and
 * keeps it identical when open by parking the button absolutely. That is the
 * point of the pair: the boxes, the computed styles and the text are the same in
 * both states, so the only thing a collector may legitimately ask is whether the
 * browser paints the element, and the only thing that may change the answer is
 * the `open` attribute.
 *
 *   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts --project=reflow
 */
function folded(open: boolean): string {
  return [
    '<div style="position:relative;width:420px">',
    `<details data-testid="server-details"${open ? " open" : ""}>`,
    '<summary data-testid="server-summary" style="font-size:11px;font-weight:600">Details</summary>',
    // `.wrap-anywhere` is the app's own class on that line.
    '<p data-testid="server-said" style="width:300px;margin:0;overflow-wrap:anywhere">',
    "server said: Internal Server Error: emulated failure</p>",
    "</details>",
    // Parked, not flowed: with the row in the flow the open disclosure pushes it
    // clear of the text and there is nothing to measure either way. The app's
    // own row sits in the band the folded line keeps.
    '<button data-testid="load-retry" style="position:absolute;left:0;top:18px">Retry</button>',
    "</div>",
  ].join("");
}

/**
 * The fixture's own proof: the folded line's box and the button's box really do
 * intersect by more than the 4px floor on both axes, in BOTH states — otherwise
 * “no overlap while closed” would only be proving the fixture never collided.
 */
function foldedBoxesOverlap(): { dx: number; dy: number; serverPainted: boolean } {
  const server = document.querySelector('[data-testid="server-said"]');
  const retry = document.querySelector('[data-testid="load-retry"]');
  if (server === null || retry === null) return { dx: -1, dy: -1, serverPainted: false };
  const a = server.getBoundingClientRect();
  const b = retry.getBoundingClientRect();
  return {
    dx: Math.round(Math.min(a.right, b.right) - Math.max(a.left, b.left)),
    dy: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
    serverPainted: server.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    }),
  };
}

/** The pair that names both elements, or undefined. */
function pairWith(testid: string, hits: OverlapHit[]): OverlapHit | undefined {
  return hits.find((hit) => hit.a === testid || hit.b === testid);
}

test.describe("what the user cannot see is not measured", () => {
  test("(v1) a folded server line over a button is not an overlap", async ({ page }) => {
    await page.setContent(doc(folded(false)));
    const boxes = await page.evaluate(foldedBoxesOverlap);
    // The pass-1 defect's shape, box for box: the two overlap, and Chrome paints
    // only one of them.
    expect(boxes.dx).toBeGreaterThan(4);
    expect(boxes.dy).toBeGreaterThan(4);
    expect(boxes.serverPainted, "closed-details content fails checkVisibility").toBe(false);
    expect(await page.evaluate(findOverlaps)).toEqual([]);
  });

  test("(v2) the same block with <details open> IS an overlap", async ({ page }) => {
    await page.setContent(doc(folded(true)));
    const boxes = await page.evaluate(foldedBoxesOverlap);
    // Same boxes (the button is parked, not flowed), so the ONLY change is that
    // the browser now paints the line — and a painted collision is a defect.
    expect(boxes.dx).toBeGreaterThan(4);
    expect(boxes.dy).toBeGreaterThan(4);
    expect(boxes.serverPainted, "opened-details content passes checkVisibility").toBe(true);
    const hits = await page.evaluate(findOverlaps);
    const hit = pairWith("server-said", hits);
    expect(hit, `the opened line collides with the button: ${JSON.stringify(hits)}`).toBeTruthy();
    expect(hit!.a === "load-retry" || hit!.b === "load-retry").toBe(true);
    // …and the summary above them is not dragged in as a third party.
    expect(pairWith("server-summary", hits)).toBeUndefined();
  });

  test("(v3) a 26px control behind the closed disclosure is not a touch target", async ({
    page,
  }) => {
    const block = (open: boolean): string =>
      `<details data-testid="tgt-details"${open ? " open" : ""}>` +
      '<summary data-testid="tgt-summary">Details</summary>' +
      '<div style="padding-top:60px"><button data-testid="tgt-btn" class="bordered" aria-label="tgt-btn"></button></div>' +
      "</details>";
    await page.setContent(doc(block(false)));
    // Painted-size arithmetic alone sees the box: this is the false positive the
    // fix is for, and `findSmallTargets`' inert/aria-hidden rules (c31bd22) do
    // not cover a closed disclosure.
    expect(
      await page.evaluate(
        () => document.querySelector('[data-testid="tgt-btn"]')!.getBoundingClientRect().height,
      ),
    ).toBe(26);
    expect(await page.evaluate(findSmallTargets)).toEqual([]);
    // Open it and the same control is a target again, at the same 26px.
    await page.setContent(doc(block(true)));
    expect(await page.evaluate(findSmallTargets)).toEqual([{ name: "tgt-btn", height: 26 }]);
  });

  test("(v4) folded content is in no parity inventory, open content is", async ({ page }) => {
    const block = (open: boolean): string =>
      `<details data-testid="inv-details"${open ? " open" : ""}>` +
      "<summary>Details</summary>" +
      '<h2 data-testid="inv-heading">Internal Server Error</h2>' +
      "</details>";
    await page.setContent(doc(block(false)));
    const keys = (await page.evaluate(collectReflowItems)).map((item) => item.key);
    expect(keys, "a heading behind a closed disclosure is not on the screen").not.toContain(
      "testid:inv-heading",
    );
    expect(keys).not.toContain("heading:Internal Server Error");
    // Inventorying it at 1280 and not at 390 would ALSO have invented a parity
    // defect; the collector reads the same rule both times, so it never does.
    await page.setContent(doc(block(true)));
    const opened = (await page.evaluate(collectReflowItems)).map((item) => item.key);
    expect(opened).toContain("testid:inv-heading");
    expect(opened).toContain("heading:Internal Server Error");
  });

  test("(v5) folded text is never a clip defect either", async ({ page }) => {
    const block = (open: boolean): string =>
      `<details data-testid="clip-details"${open ? " open" : ""}>` +
      "<summary>Details</summary>" +
      '<div data-testid="clip-line" style="width:120px;overflow-x:hidden;white-space:nowrap">' +
      "server said: Internal Server Error: emulated failure for the whole library</div>" +
      "</details>";
    await page.setContent(doc(block(false)));
    // The box IS cut short — the check only has to notice nothing paints.
    expect(
      await page.evaluate(
        () =>
          (document.querySelector('[data-testid="clip-line"]') as HTMLElement).scrollWidth -
          (document.querySelector('[data-testid="clip-line"]') as HTMLElement).clientWidth,
      ),
    ).toBeGreaterThan(4);
    expect(await page.evaluate(findClippedText)).toEqual([]);
    await page.setContent(doc(block(true)));
    expect(await page.evaluate(findClippedText)).toEqual([
      { label: "clip-line", text: expect.stringContaining("server said:") },
    ]);
  });
});
/**
 * `plan-steps.ts` — pass-1 defect 2, `run-gate waiting`.
 *
 * The gate card's plan is live model output. In `out/pass-1-20261101102509` the
 * planner wrote its steps as BOLD PARAGRAPHS (“**1. Confirm repository binding
 * and fixture integrity**”, “**2. Execute the gate …**”) with bullet lists under
 * each, so the document holds no `markdown-list-ordered` at all, the old
 * locator returned nothing, and the check red on a plan that reads 1…5 on
 * screen. The contract is the READER's ("the steps are numbered in order, never
 * 1. 1. 1."), not the markup's, so both shapes must satisfy it — and the
 * renderer it exists to catch must still fail, which is what (p3)/(p4) prove.
 *
 * Reading order is judged as SEQUENCES, because live plans number their steps
 * 1…5 and then number an acceptance list 1…3: a fresh "1." opens a new
 * sequence (p7), while three "1."s in a row (p3, p6), a repeat inside a
 * sequence (p8) and a fall that is not a restart (p8) are the defects.
 *
 * `planDoc` reproduces `lib/markdown.tsx`'s DOM, because that shape — not the
 * CSS — is what the collector reads: a `markdown-paragraph` whose own text
 * carries the author's newlines under `white-space: pre-line`, and a
 * `display:flex` `markdown-list-item` whose `aria-hidden` marker span is its
 * own box (flex items are blockified, so the number and the words the browser
 * paints on separate lines arrive on separate lines here too).
 */
function planDoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 13px/19px ui-sans-serif, system-ui, sans-serif; }
    main { padding: 8px; }
    p, ul, ol, pre { margin: 0; }
    ul, ol { padding-left: 0; list-style: none; }
    li { display: flex; gap: 6px; }
    [aria-hidden] { color: #888; }
  </style></head><body><main>
    <div data-testid="approval-summary">
      <div data-testid="plan-view-plain">
        <div style="white-space:pre-line"><div data-testid="markdown-body">${body}</div></div>
      </div>
    </div>
  </main></body></html>`;
}

/** `<p data-testid="markdown-paragraph">…</p>` — the author's newlines kept. */
const para = (inner: string): string => `<p data-testid="markdown-paragraph">${inner}</p>`;
/** A paragraph led by a bold run: the model writing “**1. Confirm …**”. */
const boldPara = (lead: string, ...rest: string[]): string =>
  para(`<strong>${lead}</strong>\n${rest.join("\n")}`);
/** A heading block. */
const heading = (text: string): string => `<p data-testid="markdown-heading">${text}</p>`;
/** A bullet list as the renderer draws it: `·` in its own box, text beside it. */
const bullets = (...items: string[]): string =>
  `<ul data-testid="markdown-list">${items
    .map(
      (item) =>
        `<li data-testid="markdown-list-item"><span aria-hidden="true">·</span><div><span>${item}</span></div></li>`,
    )
    .join("")}</ul>`;
/** A fenced block: payload, never a step (the fixture's copy holds a line that
 * opens “1.” precisely so the collector is caught if it ever reads code). */
const code = (text: string): string =>
  `<pre data-testid="markdown-code" tabindex="0">${text}</pre>`;
/** An ordered list the renderer numbers — the shape the OLD check could see. An
 * item's own html may carry a nested list, as `lib/markdown.tsx` nests it. */
const ordered = (start: number, items: [marker: string, inner: string][]): string =>
  `<ol data-testid="markdown-list-ordered" start="${start}">${items
    .map(
      ([marker, inner]) =>
        `<li data-testid="markdown-list-item"><span aria-hidden="true">${marker}</span><div><span>${inner}</span></div></li>`,
    )
    .join("")}</ol>`;

/** The live pass's plan, block for block, as `run-gate-waiting-1280.png` shows
 * it (hand-copied; the wording of every step, not every wrapped line). */
const LIVE_PLAN_BODY = [
  para(
    "Plan for emu gate journey pass-1-20261101102509 — prove the gate and the plan artifact in repository app",
  ),
  heading("Implementation Plan: emu gate journey pass-1-20261101102509"),
  boldPara(
    "1. Confirm repository binding and fixture integrity",
    "Files touched: <code>./README.md</code>, <code>./pytest.ini</code>,",
    "<code>./tests/test_hello.py</code>, <code>./hello.py</code> (read-only inspection)",
  ),
  bullets(
    "Verify the four expected files exist at the paths listed in the survey.",
    "Confirm pytest.ini declares the test discovery path and that <code>tests/test_hello.py</code> contains at least one assertion that will fail on a clean checkout (per README § M4 exit run iteration 1).",
  ),
  boldPara(
    "Verification:",
    "<code>ls ./README.md ./hello.py ./pytest.ini</code>",
    "<code>./tests/test_hello.py</code> returns all four paths with no errors.",
  ),
  boldPara(
    "2. Execute the gate — run pytest and capture the expected failure",
    "Files touched: none (read-only execution); stdout/stderr captured to a transient log.",
  ),
  bullets(
    "Run <code>python -m pytest --tb=short -q</code> from the repo root.",
    "Assert the exit code is non-zero (gate “fails” as designed for iteration 1).",
    "Record the exact failure message and exit code as the gate proof.",
  ),
  boldPara(
    "Verification:",
    "<code>echo $?</code> after the pytest invocation yields <code>1</code> (or another non-zero code), and the captured output contains a <code>FAILED</code> line referencing <code>tests/test_hello.py</code>.",
  ),
  boldPara(
    "3. Produce the plan artifact",
    "Files touched: <code>./plan-artifact.md</code> (new file, written to the working tree)",
  ),
  bullets(
    "Write this numbered plan (steps 1-5) into <code>./plan-artifact.md</code> with a header block:",
  ),
  code(
    "---\n  journey: pass-1-20261101102509\n  repo: app\n  gate_status: FAILED (expected)\n  artifact_type: implementation-plan\n---\n1. this line is code, not a step",
  ),
  bullets(
    "Include the pytest exit code and first failure line captured in step 2 as an embedded proof block.",
  ),
  boldPara(
    "Verification:",
    "<code>head -80 ./plan-artifact.md</code> shows the YAML front-matter with <code>gate_status: FAILED (expected)</code> and <code>journey: pass-1-20261101102509</code>.",
  ),
  boldPara(
    "4. Validate the artifact is self-consistent",
    "Files touched: <code>./plan-artifact.md</code> (read-back)",
  ),
  bullets(
    "Grep the artifact for the journey ID string <code>pass-1-20261101102509</code> — must appear at least twice (front-matter + proof block).",
    "Confirm the embedded pytest output matches the actual run from step 2 (byte-for-byte on the <code>FAILED</code> line).",
  ),
  boldPara(
    "Verification:",
    "<code>grep -c 'pass-1-20261101102509' ./plan-artifact.md</code> returns ≥ 2; <code>grep 'FAILED' ./plan-artifact.md</code> returns the same line produced in step 2.",
  ),
  boldPara(
    "5. Seal the gate proof — final assertion",
    "Files touched: none (exit-status check only)",
  ),
  bullets(
    "Assert: (a) pytest exited non-zero → gate fired correctly; (b) <code>plan-artifact.md</code> exists, is non-empty, and contains the required front-matter keys → plan artifact is valid.",
    "Print a single summary line: <code>GATE=FAILED ARTIFACT=OK JOURNEY=pass-1-20261101102509</code>.",
  ),
  boldPara(
    "Verification:",
    "The summary line is emitted to stdout and the overall script exit code is 0 (the journey passes even though the gate fails, which is the intended M4 iteration-1 semantics).",
  ),
].join("\n");

const readPlan = async (page: import("@playwright/test").Page) =>
  judgePlanNumbering(await page.evaluate(collectPlanNumbering));

/** One block as the collector reports it (`"text"` = ordinary prose, which the
 * judge does not read as a step). */
const blk = (text: string, kind: PlanBlockKind = "text"): PlanBlock => ({ text, kind });

test.describe("the plan's steps are numbered in order", () => {
  test("(p1) the live pass's plan — bold paragraphs, no ordered list — reads 1…5", async ({
    page,
  }) => {
    await page.setContent(planDoc(LIVE_PLAN_BODY));
    const read = await page.evaluate(collectPlanNumbering);
    const verdict = judgePlanNumbering(read);
    // This is the shape that red-passed: no `markdown-list-ordered` anywhere —
    // the exact locator the check used to assert on reads nothing here, which
    // is why a plan that reads 1…5 on screen failed it.
    expect(read.lists, "the live plan holds no ordered list").toEqual([]);
    expect(
      await page.locator('[data-testid="markdown-list-ordered"] > li > span[aria-hidden]').count(),
      "the OLD locator had nothing to read on this plan",
    ).toBe(0);
    expect(read.blocks.length, "the plan's blocks were read").toBeGreaterThan(15);
    // The collector also tells the judge what the blocks LOOK like, which is
    // what keeps an unnumbered plan-shaped document a defect while a prose plan
    // passes: the `##` heading and the bold-led paragraphs read as steps, the
    // bullet items (unordered) and the plain paragraphs read as prose.
    const kinds = read.blocks.map((block) => block.kind);
    expect(kinds.filter((kind) => kind === "heading")).toEqual(["heading"]);
    expect(
      kinds.filter((kind) => kind === "strong").length,
      "the five step titles (and the bold Verification: lines) lead their paragraph",
    ).toBeGreaterThanOrEqual(5);
    expect(
      kinds.filter((kind) => kind === "item"),
      "· bullets are not steps",
    ).toEqual([]);
    expect(verdict.steps, "the reader counts five steps, numbered in order").toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(verdict.reason).toBe("");
  });

  test("(p2) the same plan written as ONE ordered list reads in order too", async ({ page }) => {
    await page.setContent(
      planDoc(
        [
          heading("Implementation Plan: emu gate journey"),
          ordered(1, [
            ["1.", "Confirm repository binding and fixture integrity"],
            ["2.", "Execute the gate"],
            [
              "3.",
              "Produce the plan artifact" +
                ordered(1, [
                  ["1.", "front-matter keys"],
                  ["2.", "the proof block"],
                ]),
            ],
          ]),
        ].join("\n"),
      ),
    );
    const verdict = await readPlan(page);
    // A step's OWN nested list restarts at 1 by the author's design: rule (1)
    // judges each list on its own items, and the nested items are not steps,
    // so the plan still reads 1, 2, 3.
    expect(verdict.steps, "the plan's steps, not its sub-list").toEqual([1, 2, 3]);
    expect(verdict.reason).toBe("");
  });

  test("(p3) a renderer that prints “1.” for every step still fails", async ({ page }) => {
    // `run-gate-waiting-1280.png` the FIRST time: one authored list broken into
    // a list per step, each starting at 1. Every list is internally
    // consecutive, so only the reading-order walk sees the repeat.
    await page.setContent(
      planDoc(
        [
          heading("Implementation Plan: emu gate journey"),
          ordered(1, [["1.", "Confirm repository binding and fixture integrity"]]),
          ordered(1, [["1.", "Execute the gate"]]),
          ordered(1, [["1.", "Produce the plan artifact"]]),
        ].join("\n"),
      ),
    );
    const verdict = await readPlan(page);
    expect(verdict.ok, "a plan whose steps all read “1.” is a defect").toBe(false);
    expect(verdict.steps).toEqual([1, 1, 1]);
    expect(verdict.reason).toMatch(/3 steps in a row are numbered "1\." \(1, 1, 1\)/);
  });

  test("(p4) a renderer that prints “1.” for every item of ONE list still fails", async ({
    page,
  }) => {
    await page.setContent(
      planDoc(
        ordered(1, [
          ["1.", "Confirm repository binding and fixture integrity"],
          ["1.", "Execute the gate"],
          ["1.", "Produce the plan artifact"],
        ]),
      ),
    );
    const verdict = await readPlan(page);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/ordered list 1 prints 1, 1, 1/);
  });

  test("(p5) fenced code and collapsed JSON never count as steps", async ({ page }) => {
    await page.setContent(
      planDoc(
        [
          boldPara("1. Confirm the binding", "Files touched: <code>./README.md</code>"),
          code("1. not a step\n2. not a step"),
          boldPara("2. Execute the gate", "Files touched: none"),
        ].join("\n"),
      ),
    );
    expect((await readPlan(page)).steps).toEqual([1, 2]);
  });

  test("(p6) the judge on the live plan's OWN text, and on the bug's text", () => {
    // No browser: the judge's input is text, so this is the measurement the
    // acceptance report quotes — the pass-1 plan's lines (the reader's, as
    // `run-gate-waiting-1280.png` shows them) and the bug's lines.
    const live = judgePlanNumbering({
      found: true,
      lists: [],
      where: "out/pass-1-20261101102509/run-gate-waiting-1280.png",
      blocks: [
        blk(
          "Plan for emu gate journey pass-1-20261101102509 — prove the gate and the plan artifact in repository app",
        ),
        blk("Implementation Plan: emu gate journey pass-1-20261101102509", "heading"),
        blk(
          "1. Confirm repository binding and fixture integrity\nFiles touched: ./README.md, ./pytest.ini,",
          "strong",
        ),
        blk("·\nVerify the four expected files exist at the paths listed in the survey."),
        blk("·\nWrite this numbered plan (steps 1-5) into ./plan-artifact.md with a header block:"),
        blk("Verification: head -80 ./plan-artifact.md shows the YAML front-matter"),
        blk(
          "2. Execute the gate — run pytest and capture the expected failure\nFiles touched: none (read-only execution)",
          "strong",
        ),
        blk("3. Produce the plan artifact\nFiles touched: ./plan-artifact.md (new file)", "strong"),
        blk(
          "4. Validate the artifact is self-consistent\nFiles touched: ./plan-artifact.md (read-back)",
          "strong",
        ),
        blk(
          "5. Seal the gate proof — final assertion\nFiles touched: none (exit-status check only)",
          "strong",
        ),
      ],
    });
    expect(live.reason).toBe("");
    expect(live.steps).toEqual([1, 2, 3, 4, 5]);

    const broken = judgePlanNumbering({
      found: true,
      lists: [["1."], ["1."], ["1."]],
      where: "1. 1. 1. fixture",
      blocks: [
        blk("1.\nConfirm repository binding", "item"),
        blk("1.\nExecute the gate", "item"),
        blk("1.\nProduce the plan artifact", "item"),
      ],
    });
    expect(broken.ok).toBe(false);
    expect(broken.reason).toMatch(/3 steps in a row are numbered "1\." \(1, 1, 1\)/);
  });

  test("(p7) two sequences in one plan — steps 1…5, then an acceptance 1…3 — pass", async ({
    page,
  }) => {
    // What a live model plan actually looks like: a numbered set of steps, then
    // a DIFFERENT numbered set (criteria, risks). A fresh "1." opens a new
    // sequence; it is not the renderer's 1. 1. 1. and must not red.
    await page.setContent(
      planDoc(
        [
          heading("Implementation Plan: emu gate journey pass-1-20261101102509"),
          boldPara("1. Confirm the binding", "Files touched: <code>./README.md</code>"),
          boldPara("2. Execute the gate", "Files touched: none"),
          boldPara(
            "3. Produce the plan artifact",
            "Files touched: <code>./plan-artifact.md</code>",
          ),
          boldPara("4. Validate the artifact", "Files touched: <code>./plan-artifact.md</code>"),
          boldPara("5. Seal the gate proof", "Files touched: none"),
          heading("Acceptance"),
          ordered(1, [
            ["1.", "<code>plan-artifact.md</code> exists"],
            ["2.", "the FAILED line is embedded"],
            ["3.", "the script exit code is 0"],
          ]),
        ].join("\n"),
      ),
    );
    const read = await page.evaluate(collectPlanNumbering);
    const verdict = judgePlanNumbering(read);
    expect(
      read.blocks.filter((block) => block.kind === "item").map((block) => block.text),
      "the acceptance items are steps of their own list",
    ).toEqual([
      "1.\nplan-artifact.md exists",
      "2.\nthe FAILED line is embedded",
      "3.\nthe script exit code is 0",
    ]);
    expect(verdict.steps, "the reader sees two sequences").toEqual([1, 2, 3, 4, 5, 1, 2, 3]);
    expect(verdict.reason).toBe("");
  });

  test("(p8) a repeat, a fall and an unnumbered step-list all fail; prose and a 1,1 pair pass", () => {
    const read = (where: string, numbers: number[], kind: PlanBlockKind = "strong") =>
      judgePlanNumbering({
        found: true,
        lists: [],
        where,
        blocks: numbers.map((n) => blk(`${n}. Step ${n}`, kind)),
      });

    const repeat = read("1, 2, 2, 3 fixture", [1, 2, 2, 3]);
    expect(repeat.ok).toBe(false);
    expect(repeat.reason).toMatch(/step 2 is numbered twice in a row/);

    // A restart, then the renderer's signature: the run is what counts, not the
    // position in the plan.
    const restartThenBroken = read("5, 1, 1, 1 fixture", [5, 1, 1, 1]);
    expect(restartThenBroken.reason).toMatch(/3 steps in a row are numbered "1\." \(1, 1, 1\)/);

    const falls = read("1, 2, 3, 2 fixture", [1, 2, 3, 2]);
    expect(falls.reason).toMatch(/falls without starting a new sequence/);

    const jumps = read("1, 3 fixture", [1, 3]);
    expect(jumps.reason).toMatch(/numbering skips/);

    // Two single-item sequences read exactly like the split-list renderer's
    // first two steps and are the model's own doing: only the third "1." in a
    // row is the signature (p3, p6).
    expect(read("1, 1 fixture", [1, 1]).reason).toBe("");
    expect(read("5, 1, 2, 3 fixture", [5, 1, 2, 3]).reason).toBe("");

    // A plan whose blocks look like steps but carry no number at all is the
    // reader-who-cannot-count defect; a plan that is prose only is not.
    const unnumbered = judgePlanNumbering({
      found: true,
      lists: [],
      where: "unnumbered step-shaped fixture",
      blocks: [
        blk("Confirm the binding", "heading"),
        blk("Execute the gate", "heading"),
        blk("Produce the artifact", "heading"),
      ],
    });
    expect(unnumbered.reason).toMatch(
      /3 blocks read as steps .* but none of them carries a number/,
    );

    const prose = judgePlanNumbering({
      found: true,
      lists: [],
      where: "prose fixture",
      blocks: [
        blk("Plan for the gate journey: confirm, execute, publish."),
        blk("·\nConfirm the binding."),
        blk("·\nExecute the gate."),
      ],
    });
    expect(prose.ok).toBe(true);
    expect(prose.steps).toEqual([]);
    expect(prose.reason).toBe("");
  });
});
