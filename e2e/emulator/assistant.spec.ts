// Journey: the Assistant handoff's own screens (docs/design/assistant-handoff/
// HANDOFF.md §1/§3/§4, A8) — the Ask popover with its setup checklist, the two
// SIBLING menus (trust, page context), the 450px side panel, the `/assistant`
// full page and Settings → Assistant.
//
// WHY THIS FILE HAS NO MODEL TURNS. The screen harness proves the FRAME the
// design drew; `e2e/tests/assistant-handoff.spec.ts` and `catchup-lab.spec.ts`
// own the answers. A capture that hinged on a real LLM reply would file a
// design defect every time the collective hesitated, and the report's design
// column would say nothing about the frame. So the journey never sends: the
// popover is opened with ⌘J, `New thread` empties it to the local setup
// message (handoff A3 §2 — a synthesized row, `GET /assistant/status`, no
// model call), and every later frame holds that same thread. Screens are
// therefore `as-popover`, `as-dock`, `as-page` and `as-settings` with NO
// transcript, and they stand on the lab's reads alone.
//
// Alice plays it: the assistant's threads, status and preferences are all
// per-person reads (CONTRACT C2) and the lab's org admin holds no project
// membership (setup.spec.ts' header).
//
// What the journey asserts beyond the screens (a failed check FAILS the
// journey and the fixture records it as kind=assertion):
//   - the popover panel is the design's clipped box (`overflow: hidden`) — the
//     rule that makes the sibling menus necessary rather than decorative;
//   - `assistant-pill-menu` and `assistant-context-menu` render OUTSIDE
//     `assistant-panel` (portals), so the panel's clip can never eat them
//     (handoff §1; issue #62's same family);
//   - the dock is the 450px column at 1280 (at 390 it is the full-width sheet —
//     the documented reflow, not a defect);
//   - `/assistant` carries both breakpoint columns at 1280 — the thread list and
//     the "Looking at" column — and leaving it returns the POPOVER, not the
//     side panel;
//   - none of the mock's characters (▾ ▴ ⤢ ✓ ×) ship as text in the panel
//     (handoff §1: the icons are drawn, not typed).
//
// The badges pair with the handoff's renders. design.ts carries the landmark
// lists; the render files are `docs/design/assistant-handoff/png/<badge>.png`
// per the harness's own loader (e2e/emulator/fixtures.ts `designPngFor` reads
// `EMU_DESIGN_DIRS` with the badge's prefix CUT OFF, so a future `as-` entry in
// e2e/emulator/env.ts resolves `as-popover` to `…/assistant-handoff/png/
// popover.png`), and until that entry exists every `as-*` badge simply has no
// render to match, which the harness treats as exempt rather than failed.
import { expect, test } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { EMU_ALICE_STATE } from "./env.js";

/** The characters the design canvas drew its controls with; the app draws icons
 * instead (Tabler since c283a0e), so not one of these may appear as TEXT. */
const RETIRED_GLYPHS = ["▾", "▴", "⤢", "✓", "×"] as const;

/** Open the Ask popover through the handoff's own door (⌘J — Control on the
 * Linux runner, ⌘ on a mac: `ControlOrMeta` accepts either). A popover a
 * previous step left standing is closed first, so the chord always OPENS. */
async function openAsk(page: Page): Promise<void> {
  const panel = page.getByTestId("assistant-panel");
  if (await panel.isVisible().catch(() => false)) {
    await page.getByTestId("assistant-close").click();
    await expect(panel).toBeHidden({ timeout: 10_000 });
  }
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("assistant-popover"), "⌘J opens Ask").toBeVisible({
    timeout: 10_000,
  });
  await expect(panel, "the popover carries the panel").toBeVisible({ timeout: 10_000 });
}

/** Does `[data-testid=inner]` sit INSIDE `[data-testid=outer]` right now? The
 * sibling-menu rule is about the tree, not the pixels: a menu the panel clips
 * is the bug, wherever it paints. */
async function insideTestid(page: Page, inner: string, outer: string): Promise<boolean> {
  return page.evaluate(
    ([child, ancestor]) =>
      document
        .querySelector(`[data-testid="${child}"]`)
        ?.closest(`[data-testid="${ancestor}"]`) !== null,
    [inner, outer] as [string, string],
  );
}

/** The panel's visible text must not carry one of the mock's characters. */
async function expectNoRetiredGlyphs(page: Page, where: string): Promise<void> {
  const text = await page.getByTestId("assistant-panel").innerText();
  for (const glyph of RETIRED_GLYPHS) {
    expect(text, `${where}: the panel's text carries no ${glyph} glyph`).not.toContain(glyph);
  }
}

test.describe("assistant (alice: the popover and its menus, the side panel, /assistant, settings)", () => {
  test.describe.configure({ mode: "serial", timeout: 8 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("Ask at every size — popover, sibling menus, 450px panel, full page, settings", async ({
    page,
    emu,
  }) => {
    test.setTimeout(7 * 60_000);

    await test.step("popover — Today, ⌘J, a new thread, the setup checklist", async () => {
      await page.goto("/");
      await expect(page.getByTestId("home-page"), "Today renders").toBeVisible({
        timeout: 30_000,
      });
      await openAsk(page);
      const panel = page.getByTestId("assistant-panel");

      // Handoff §1's box: 400px and CLIPPED. The clip is what the two composer
      // menus escape, so it is asserted here rather than assumed.
      const box = await panel.boundingBox();
      expect(box, "the popover panel has a box").not.toBeNull();
      expect(
        Math.abs((box?.width ?? 0) - 400),
        "the popover is the design's 400px box",
      ).toBeLessThanOrEqual(1);
      const overflow = await panel.evaluate((node) => getComputedStyle(node).overflow);
      expect(overflow, "the popover clips its own overflow").toBe("hidden");

      // `New thread` is the door to the empty thread the checklist stands in
      // (handoff A3 §2: a LOCAL message, so this waits on a status read, never
      // on a model).
      await page.getByTestId("assistant-new-conversation").click();
      await expect(
        page.getByTestId("assistant-setup"),
        "an empty thread shows the setup checklist",
      ).toBeVisible({ timeout: 30_000 });
      await expectNoRetiredGlyphs(page, "the popover");
      await emu.screen("as-popover", "setup");
    });

    await test.step("popover — the trust menu is the panel's sibling", async () => {
      await page.getByTestId("assistant-pill").click();
      const menu = page.getByTestId("assistant-pill-menu");
      await expect(menu, "the pill opens the trust menu").toBeVisible({ timeout: 10_000 });
      expect(
        await insideTestid(page, "assistant-pill-menu", "assistant-panel"),
        "the trust menu is NOT inside the clipped panel (it is a sibling)",
      ).toBe(false);
      // The levels themselves are structure the design owns (1o): three radio
      // rows, whatever their copy.
      await expect(menu.getByRole("menuitemradio")).not.toHaveCount(0);
      await emu.screen("as-popover", "trust");
      // Esc closes the MENU and stops there — the panel behind it stays open
      // (ContextButton.tsx's own contract).
      await page.keyboard.press("Escape");
      await expect(menu, "Esc closes the trust menu").toBeHidden({ timeout: 10_000 });
      await expect(page.getByTestId("assistant-panel"), "…not the panel").toBeVisible();
    });

    await test.step("popover — the page-context menu is the panel's sibling", async () => {
      await page.getByTestId("assistant-context-button").click();
      const menu = page.getByTestId("assistant-context-menu");
      await expect(menu, "the context button opens the page-context menu").toBeVisible({
        timeout: 10_000,
      });
      expect(
        await insideTestid(page, "assistant-context-menu", "assistant-panel"),
        "the page-context menu is NOT inside the clipped panel (it is a sibling)",
      ).toBe(false);
      await emu.screen("as-popover", "context");
      await page.keyboard.press("Escape");
      await expect(menu, "Esc closes the page-context menu").toBeHidden({ timeout: 10_000 });
    });

    await test.step("side panel — the 450px column beside the page", async () => {
      await page.getByTestId("assistant-dock").click();
      const panel = page.getByTestId("assistant-panel");
      await expect(panel, "the dock is the same panel at another size").toHaveAttribute(
        "data-variant",
        "dock",
      );
      const box = await panel.boundingBox();
      expect(box, "the docked panel has a box").not.toBeNull();
      expect(
        Math.abs((box?.width ?? 0) - 450),
        "the dock is the design's 450px column",
      ).toBeLessThanOrEqual(2);
      // The setup checklist rode the size change: ONE mounted panel.
      await expect(page.getByTestId("assistant-setup")).toBeVisible();
      await expectNoRetiredGlyphs(page, "the side panel");
      // At 390 the sheet takes the screen (AssistantPopover: below 1024px a
      // column would leave nothing of the page) — the documented reflow, so it
      // needs no allowance and no assertion of its own here.
      await emu.screen("as-dock", "panel");
    });

    await test.step("full page — /assistant with both breakpoint columns", async () => {
      await page.getByTestId("assistant-expand").click();
      await expect(page, "the full page is a real route").toHaveURL(/\/assistant$/, {
        timeout: 15_000,
      });
      await expect(page.getByTestId("assistant-page")).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByTestId("assistant-page-threads"),
        "at 1280 the thread list column stands (it hides below 1000px)",
      ).toBeVisible();
      await expect(
        page.getByTestId("assistant-page-side"),
        "at 1280 the 'Looking at' column stands (it hides below 1240px)",
      ).toBeVisible();
      await expectNoRetiredGlyphs(page, "the full page");
      await emu.screen("as-page", "page");
    });

    await test.step("leaving the full page returns the popover, not the side panel", async () => {
      await page.getByTestId("assistant-expand").click();
      await expect(page, "Exit full page leaves /assistant").not.toHaveURL(/\/assistant/);
      await expect(page.getByTestId("assistant-popover")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("assistant-panel")).toHaveAttribute("data-variant", "popover");
      await expectNoRetiredGlyphs(page, "the popover after full page");
      // Close the surface before the settings leg: it is a SHELL overlay, and
      // a popover parked over Settings is not the screen this badge draws.
      await page.getByTestId("assistant-close").click();
      await expect(page.getByTestId("assistant-panel")).toBeHidden({ timeout: 10_000 });
    });

    await test.step("settings — /settings/assistant: the trust table and the Speech section", async () => {
      await page.goto("/settings/assistant");
      await expect(page.getByTestId("settings-page"), "the Settings page renders").toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("settings-assistant")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("settings-assistant-trust-table"),
        "the trust table the pill's copy comes from",
      ).toBeVisible();
      await expect(
        page.getByTestId("settings-assistant-speech"),
        "the Speech section (handoff A6 §1n)",
      ).toBeVisible();
      await emu.screen("as-settings", "speech");
    });
  });
});
