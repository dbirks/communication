// Phase 1 acceptance: the app-shell + IA redesign's shell itself.
//
// The sidebar replaces the top app bar, the nav rows point at the canonical
// routes (contract C1), every legacy URL redirects, the tree expansion is a
// persisted preference (contract C2), the Settings → Layout page states the
// shell's fixed behaviour (finding 10: the sidebar is always the project
// tree), the first ⌘K opens the jump palette and ⌘J opens Ask (finding 08,
// superseding ADR-0050's first-press-opens-Ask toggle), and at phone width
// (below 768px, finding 07) the sidebar is a drawer that Escape closes. Between 768px and
// 1024px the shell forces the collapsed rail — no drawer, no labels — without
// touching the stored `sidebar:collapsed` preference.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1 (skipped everywhere else — the
// issue2 suites' env-gate idiom). Every page runs checkShellScreen (axe
// serious/critical, no sideways scroll, no pageerror); every step leaves an
// evidence() screenshot + log line.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { expectNoLegacyAppBar, signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiPreferences,
  apiProjects,
  apiRuns,
  apiConversations,
  checkShellScreen,
  evidence,
  signInNarrow,
  watchPageErrors,
} from "./shell-helpers.js";

/**
 * Press a ⌘-chord the way this lab's keyboard allows. The app binds
 * `metaKey || ctrlKey` for ⌘K/⌘J (CommandPalette.tsx, AssistantPopover.tsx);
 * `Meta+k`/`Meta+j` carry no browser default on the lab's Linux Chromium, so
 * they are tried first and `Control+…` is the documented fallback (the idiom
 * shell-journey.spec.ts already uses).
 */
async function pressChord(page: Page, key: string, opened: () => Promise<boolean>) {
  await page.keyboard.press(`Meta+${key}`);
  if (!(await opened())) {
    await page.keyboard.press(`Control+${key}`);
  }
}

/**
 * Press the ⌘\\ (⌃\\ here) COLUMN TOGGLE and wait for its effect. Unlike
 * opening the palette, a chord press is a toggle: firing the fallback while
 * the first press is still landing would toggle straight back, so the first
 * press gets a settle window before the fallback is tried, and the fallback
 * gets the full window. `settled` is the observable end state the toggle must
 * reach (e.g. "the rail is mounted").
 */
async function pressToggleChord(page: Page, settled: () => Promise<boolean>) {
  await page.keyboard.press("Meta+\\");
  await expect
    .poll(settled, { timeout: 3_000 })
    .toBe(true)
    .catch(async () => {
      await page.keyboard.press("Control+\\");
      await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    });
}

/** Is the column collapsed in the SAVED document? A ≥1024px viewport must show
 * exactly what the document says (the forced-rail zone never rewrites it), so
 * the stored answer doubles as the settle TARGET after a resize out of that
 * zone — `setViewportSize` is not one by itself, and the forced rail carries
 * the same `sidebar-expand` the chosen rail does. */
async function storedRailState(request: APIRequestContext): Promise<boolean> {
  return (await apiPreferences(request)).layout.expanded["sidebar:collapsed"] === true;
}

/** Wait for the shell at 1500px to show the saved column state, both halves of
 * it: the control that belongs and the one that must not mount. Returns which
 * state was found, so the caller can put it back. */
async function settleDesktopColumn(page: Page): Promise<"rail" | "column"> {
  const rail = await storedRailState(page.request);
  await expect(
    page.getByTestId(rail ? "sidebar-expand" : "sidebar-collapse"),
    `1500px shows the saved column state (sidebar:collapsed=${rail})`,
  ).toBeVisible();
  await expect(
    page.getByTestId(rail ? "sidebar-collapse" : "sidebar-expand"),
    "…and the other width's control does not mount",
  ).toHaveCount(0);
  return rail ? "rail" : "column";
}

/** Put the saved column state back through the UI's own doors. Best effort on
 * purpose: this runs in a `finally`, and a restore that throws would bury the
 * real failure behind its own. */
async function restoreColumnState(page: Page, want: "rail" | "column"): Promise<void> {
  try {
    if ((await storedRailState(page.request)) === (want === "rail")) return;
    await page.setViewportSize({ width: 1500, height: 950 });
    const door = page.getByTestId(want === "rail" ? "sidebar-collapse" : "sidebar-expand");
    if (await door.isVisible().catch(() => false)) {
      await door.click({ timeout: 10_000 });
    } else {
      await pressToggleChord(page, () =>
        page.getByTestId(want === "rail" ? "sidebar-expand" : "sidebar-collapse").isVisible(),
      );
    }
    await expect(
      page.getByTestId(want === "rail" ? "sidebar-expand" : "sidebar-collapse"),
      `the saved column state (${want}) is restored`,
    ).toBeVisible({ timeout: 15_000 });
  } catch {
    // The next shell test's own settle point reports a stranded preference.
  }
}

/** The sidebar's nav rows and the canonical route each must point at.
 * Handoff 2c/3c: Today (`/`, what the row called Home) and Threads
 * (`/threads`) are the cross-project rows; the Inbox and Board rows are gone
 * (Inbox folded into Today, the Board's behavior into the repository page's
 * Lanes view), and finding 03 unmounted `/inbox` and `/board` — both now
 * redirect to `/`. Finding 02: the LIBRARY block is gone — Workflows and
 * Agents are top-level rows (Steps is a tab of the Workflows page at
 * `/workflows/steps`, not a sidebar row; the row says `Agents`, not
 * `Agent profiles`). */
const NAV: { testid: string; href: string }[] = [
  { testid: "sidebar-link-home", href: "/" },
  { testid: "sidebar-link-threads", href: "/threads" },
  { testid: "sidebar-link-workflows", href: "/workflows" },
  { testid: "sidebar-link-profiles", href: "/profiles" },
];

test.describe("shell p1 — app shell, nav, redirects, preferences, palette, drawer", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(8 * 60_000);

  test("sidebar shell: no legacy primary header, nav rows point at canonical routes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    // The IdP chain lands on the API origin's embedded build; the journey
    // runs against the dev origin, where the current source is served.
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    const stopWatching = watchPageErrors(page);
    await expectNoLegacyAppBar(page); // header[aria-label="Primary"] is gone
    await expect(page.getByTestId("sidebar")).toBeVisible();
    for (const row of NAV) {
      const link = page.getByTestId(row.testid);
      await expect(link).toBeVisible();
      const href = await link.getAttribute("href");
      expect(href, `${row.testid} href`).toBe(row.href);
    }
    // Finding 02: the LIBRARY block is gone — no section label, no Steps row,
    // and the Agents row says `Agents`.
    await expect(page.getByText("LIBRARY")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-link-steps")).toHaveCount(0);
    // (the row carries a count chip, so match the label word, not the line)
    await expect(page.getByTestId("sidebar-link-workflows")).toContainText(/Workflows/);
    await expect(page.getByTestId("sidebar-link-profiles")).toContainText(/Agents/);
    await checkShellScreen(page, "home with sidebar", stopWatching);
    await evidence(
      page,
      "shell-p1-sidebar",
      "the sidebar is present, the old header[aria-label=Primary] app bar is gone, all four nav rows (Today, Threads, Workflows, Agents) link to the canonical routes, and no Steps row or LIBRARY label exists (finding 02)",
    );
  });

  test("legacy routes redirect to the canonical URLs", async ({ page }) => {
    await signIn(page, "admin");
    const project = (await apiProjects(page.request))[0];
    const runs = await apiRuns(page.request);
    const conversation = (await apiConversations(page.request))[0];
    const rows: { old: string; canonical: string }[] = [
      { old: "/library", canonical: "/workflows" },
      { old: "/agents", canonical: "/profiles" },
      // Finding 02: Steps is a tab of the Workflows page; the old addresses
      // redirect there.
      { old: "/steps", canonical: "/workflows/steps" },
      // Finding 03: `/inbox` and `/board` are no longer destinations — both
      // land on Today.
      { old: "/inbox", canonical: "/" },
      { old: "/board", canonical: "/" },
    ];
    if (project)
      // Finding 02: the project Workflows tab is `/p/:id/workflows`; the old
      // `pipelines` spelling stays alive as a redirect.
      rows.push({
        old: `/p/${project.id}/pipelines`,
        canonical: `/p/${project.id}/workflows`,
      });
    if (project) rows.push({ old: `/projects/${project.id}`, canonical: `/p/${project.id}` });
    if (project && runs.length > 0)
      rows.push({
        old: `/projects/${project.id}/runs/${runs[0].id}?view=timeline`,
        canonical: `/runs/${runs[0].id}?view=timeline`,
      });
    if (project && conversation)
      rows.push({
        old: `/projects/${project.id}/conversations/${conversation.id}`,
        canonical: `/threads/${conversation.id}`,
      });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      await page.goto(BASE_URL + row.old, { waitUntil: "domcontentloaded" });
      await expect(page, `${row.old} must land on ${row.canonical}`).toHaveURL(
        new RegExp(
          `${BASE_URL.replace(/:/g, "\\:")}${row.canonical.replace(/[/?&=]/g, (c) => (c === "/" ? "/" : "\\" + c))}$`,
        ),
      );
    }
    await evidence(
      page,
      "shell-p1-redirects",
      `all ${rows.length} legacy URLs (library, agents, steps, inbox, board, p/<id>/pipelines, projects/<id>, projects/<id>/runs/<run>?view=timeline, projects/<id>/conversations/<c>) land on their canonical URLs with query state preserved — /inbox and /board land on Today`,
    );
  });

  test("tree expansion persists across reload — /me/preferences carries it", async ({ page }) => {
    await signIn(page, "admin");
    const projects = await apiProjects(page.request);
    const project = projects.find((p) => p.name === "M4 Exit") ?? projects[0];
    expect(project, "a project exists to expand in the tree").toBeTruthy();
    const toggle = page.getByTestId(`sidebar-project-toggle-${project.id}`);
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute("aria-expanded");
    const beforeDoc = await apiPreferences(page.request);
    expect(beforeDoc.layout.projects_mode).toBe("tree");
    const patch = page.waitForRequest(
      (req) => req.url().includes("/api/v1/me/preferences") && req.method() === "PATCH",
    );
    await toggle.click();
    const patchRequest = await patch;
    const body = JSON.parse((await patchRequest.postData()) ?? "{}") as {
      layout?: { expanded?: Record<string, boolean> };
    };
    // The expanded map is keyed "project:<id>" (the sidebar's own keying).
    const key = Object.keys(body.layout?.expanded ?? {}).find((k) => k.endsWith(project.id));
    expect(key, "the PATCH names this project's expansion").toBeTruthy();
    const targetExpanded = body.layout!.expanded![key!];
    // The chevron flips optimistically before the write lands: wait for the
    // PATCH answer before the read-back, or the GET races the write and
    // reads the pre-save document (a read-before-write, not a persistence
    // bug).
    await patchRequest.response();
    // The re-render after the PATCH can lag the request itself, so poll the
    // attribute until it flips instead of reading it once.
    await expect(async () => await toggle.getAttribute("aria-expanded")).not.toBe(before);
    const after = await toggle.getAttribute("aria-expanded");
    expect(after, "the attribute matches the PATCHed value").toBe(String(targetExpanded));
    const stored = await apiPreferences(page.request);
    const storedKey = Object.keys(stored.layout.expanded).find((k) => k.endsWith(project.id));
    expect(storedKey, "the stored expansion map names this project").toBeTruthy();
    expect(stored.layout.expanded[storedKey!], "GET /me/preferences reflects the change").toBe(
      targetExpanded,
    );
    // Reload: the tree re-reads the preference, so the expansion survives.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`sidebar-project-toggle-${project.id}`)).toHaveAttribute(
      "aria-expanded",
      String(targetExpanded),
    );
    await evidence(
      page,
      "shell-p1-tree-expand",
      `expanding "${project.name}" PATCHes /api/v1/me/preferences (layout.expanded), the GET returns it, and the expansion is still applied after a reload`,
    );
  });

  test("Settings → Layout: the sidebar is always the tree; Ask is the ⌘J float on every page", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/settings/layout", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("settings-layout")).toBeVisible();
    // Finding 10: the three layout preferences are gone — the page states the
    // shell's fixed behaviour instead of offering choices.
    await expect(page.getByTestId("settings-layout-sidebar-note")).toContainText(
      /always the project tree/i,
    );
    await expect(page.getByTestId("settings-layout-chord-k")).toContainText(
      "⌘K opens Search · ⌘J opens Ask",
    );
    for (const gone of [
      "settings-layout-projects-mode",
      "settings-layout-ask-placement",
      "settings-layout-workflow-folders",
    ]) {
      await expect(page.getByTestId(gone), `finding 10 removed the ${gone} control`).toHaveCount(0);
    }
    await checkShellScreen(page, "settings layout", stopWatching);
    await evidence(
      page,
      "shell-p1-settings-layout",
      "the Settings → Layout tab shows the sidebar note and the ⌘K/⌘J chord line; the projects-mode, ask-placement and workflow-folders groups are gone",
    );
    // The sidebar is always the project tree: a real project's expansion
    // chevron renders, and the deleted switcher does not.
    const project = (await apiProjects(page.request))[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`sidebar-project-toggle-${project.id}`)).toBeVisible();
    await expect(page.getByTestId("project-switcher")).toHaveCount(0);
    // Finding 08/10: Ask is one floating button on every page — the
    // placement setting is gone, so the float is here whatever was stored.
    await expect(page.getByTestId("ask-fab")).toBeVisible();
    await checkShellScreen(page, "home with the ask float", stopWatching);
    await evidence(
      page,
      "shell-p1-ask-floating",
      "the sidebar shows the project tree and the floating Ask button (ask-fab) renders on the home page with no preference to set",
    );
  });

  test("⌘K opens the palette; ⌘J and the Ask button open the assistant; esc closes both", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-page")).toBeVisible();
    // Finding 08 supersedes ADR-0050's first-press-opens-Ask toggle: the
    // FIRST ⌘K opens the jump palette, and the assistant never answers ⌘K.
    await pressChord(page, "k", async () => {
      return (await page.getByTestId("palette-input").count()) > 0;
    });
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expect(page.getByTestId("assistant-popover")).toHaveCount(0);
    await evidence(
      page,
      "shell-p1-palette-open",
      "the first ⌘K (Meta/Ctrl+K in this lab) opens the jump palette, not the assistant",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
    await evidence(page, "shell-p1-palette-esc", "Escape closes the command palette");
    // ⌘J opens the assistant popover — and only the popover.
    await pressChord(page, "j", async () => {
      return (await page.getByTestId("assistant-popover").count()) > 0;
    });
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await evidence(
      page,
      "shell-p1-ask-chord",
      "⌘J opens the assistant popover (finding 08: Ask has its own chord)",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("assistant-popover")).toBeHidden();
    await evidence(page, "shell-p1-ask-esc", "Escape closes the assistant popover");
    // The floating Ask button opens the same surface as the chord.
    await page.getByTestId("ask-fab").click();
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("assistant-popover")).toBeHidden();
    await evidence(
      page,
      "shell-p1-ask-fab",
      "the floating Ask button (ask-fab) opens and Escape closes the assistant popover",
    );
    // The sidebar's Search field is the palette's other door.
    await page.getByTestId("sidebar-search").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
    stopWatching();
    await evidence(
      page,
      "shell-p1-sidebar-search",
      "the sidebar's Search ⌘K field (sidebar-search) opens the jump palette and Escape closes it",
    );
  });

  test("at 1500x950 the sidebar is always visible (no drawer control)", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("sidebar-open")).toBeHidden();
  });

  // Finding 07 redrew the responsive contract: 768–1023px is a tablet, not a
  // phone. The phone frame (drawer + `phone-top-strip`) only mounts below 768px
  // (it stopped at 1024px), and in this zone the 52px RAIL is FORCED whatever
  // the saved `sidebar:collapsed` preference says — `Shell`'s `RAIL_QUERY`, not
  // a stylesheet, so the labelled column, its `New thread` and its nav rows do
  // not merely hide, they do not mount. The preference itself is never
  // rewritten (it rides `layout.expanded["sidebar:collapsed"]` on the wire), and
  // widening brings the saved state back on its own.
  test("at 900x800 the rail is forced and the stored preference is untouched", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    // The starting point is the EXPANDED column at desktop width: this is the
    // preference the forced rail must not overwrite.
    await expect(
      page.getByTestId("sidebar-collapse"),
      "1500px honours the expanded pref",
    ).toBeVisible();
    const storedBefore = (await apiPreferences(page.request)).layout.expanded;
    expect(
      storedBefore["sidebar:collapsed"],
      `the session starts with the expanded column (stored expanded map: ${JSON.stringify(storedBefore)})`,
    ).not.toBe(true);

    await page.setViewportSize({ width: 900, height: 800 });
    const stopWatching = watchPageErrors(page);
    // The rail is what mounts: its expand control is there, the expanded
    // column's controls are not.
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("sidebar-expand")).toBeVisible();
    await expect(page.getByTestId("sidebar-collapse")).toHaveCount(0);
    await expect(page.getByTestId("new-chat")).toHaveCount(0);
    await expect(page.getByTestId("new-chat-rail"), "the rail's + is the same verb").toBeVisible();
    for (const row of NAV) {
      await expect(
        page.getByTestId(row.testid),
        `${row.testid} does not mount at 900px`,
      ).toHaveCount(0);
    }
    await expect(
      page.getByTestId("rail-item-workflows"),
      "the rail's Workflows tile (redesign 4a: `rail-item-*`, the old `sidebar-rail-library` is gone)",
    ).toBeVisible();
    await expect(page.getByTestId("rail-item-agents"), "the rail's Agents tile").toBeVisible();
    // And it is not the phone: no drawer, no top strip, at a width the phone
    // frame used to own. The rail's own OVERLAY (4a: expand at a rail width)
    // is not open either.
    await expect(page.getByTestId("sidebar-open")).toHaveCount(0);
    await expect(page.getByTestId("phone-top-strip")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-backdrop")).toHaveCount(0);
    await expect(
      page.getByTestId("rail-overlay-backdrop"),
      "the forced rail stands alone — no overlay over the content",
    ).toHaveCount(0);

    // The forced rail wrote nothing: the stored preference still says expanded.
    const storedAfter = (await apiPreferences(page.request)).layout.expanded;
    expect(
      storedAfter["sidebar:collapsed"],
      `the rail-only width left the stored preference alone (before ${JSON.stringify(
        storedBefore["sidebar:collapsed"],
      )}, after ${JSON.stringify(storedAfter["sidebar:collapsed"])})`,
    ).not.toBe(true);

    // Widen, and the saved column comes back by itself — the proof that the
    // rail was forced by width, not by a rewritten preference.
    await page.setViewportSize({ width: 1500, height: 950 });
    await expect(
      page.getByTestId("sidebar-collapse"),
      "1500px honours the pref again",
    ).toBeVisible();
    await expect(page.getByTestId("new-chat")).toBeVisible();
    await checkShellScreen(page, "/workflows with the rail forced at 900px", stopWatching);
    await evidence(
      page,
      "shell-p1-rail-900",
      "at 900x800 the shell forces the 52px rail (no drawer, no top strip, no nav labels), the stored sidebar:collapsed preference is unchanged, and widening restores the saved column (finding 07)",
    );
  });

  // The frame's exact edge: `Shell`'s NARROW_QUERY is `(max-width:
  // 767.98px)` (finding 07 — it was 1023.98px), so 767 is the last phone width
  // and 768 is the first rail width. Pinning both sides is what keeps the
  // cutoff from drifting back a breakpoint by accident.
  test("the phone frame ends at 768px: 767 is the drawer, 768 is the rail", async ({ page }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 767, height: 900 });
    await page.goto(BASE_URL + "/workflows", { waitUntil: "domcontentloaded" });
    const strip = watchPageErrors(page);
    await expect(page.getByTestId("phone-top-strip"), "767 is a phone").toBeVisible();
    await expect(page.getByTestId("sidebar-open"), "767 opens the drawer").toBeVisible();
    await expect(page.getByTestId("sidebar"), "a closed drawer is unmounted").toHaveCount(0);

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByTestId("phone-top-strip"), "768 is not a phone").toHaveCount(0);
    await expect(page.getByTestId("sidebar-open"), "768 has no drawer control").toHaveCount(0);
    await expect(page.getByTestId("sidebar-expand"), "768 shows the forced rail").toBeVisible();
    await checkShellScreen(page, "/workflows at the 768px frame cut", strip);
    await evidence(
      page,
      "shell-p1-frame-cut-768",
      "the phone frame stops below 768px: 767 mounts the top strip and drawer, 768 mounts the forced rail with no drawer control (finding 07)",
    );
  });

  // Redesign 4a redrew the collapsed rail: no words and no initials on the
  // tiles any more — hover or keyboard focus on a tile prints the one dark
  // label (`rail-tooltip`) 8px off the rail's edge, and the third door to the
  // column is the ⌘\ chord (⌃\ on this lab's keyboard) next to the expand
  // button and the edge handle. The chord toggles the SAVED preference at
  // ≥1024px (inside the forced-rail zone it opens an overlay instead), so the
  // toggle runs at 1500px and ends EXPANDED — the preference as it was found.
  test("the rail's hover label, and ⌘\\ collapses and re-expands the column at 1500px", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    const stopWatching = watchPageErrors(page);

    // The hover label, read at the FORCED rail (900px): the tiles mount there
    // without the test writing the stored preference at all.
    await page.setViewportSize({ width: 900, height: 800 });
    const today = page.getByTestId("rail-item-today");
    await expect(today, "900px forces the rail with the Today tile").toBeVisible();
    const tip = page.getByTestId("rail-tooltip");
    await expect(tip, "no label before the pointer arrives").toHaveCount(0);
    await today.hover();
    await expect(tip, "hover on the rail's Today tile prints the label").toBeVisible({
      timeout: 5_000,
    });
    await expect(tip).toHaveRole("tooltip");
    await expect(tip, "the label carries the tile's word").toContainText("Today");
    await page.mouse.move(600, 400); // leave the rail entirely
    await expect(tip, "leaving the rail takes the label with it").toBeHidden({ timeout: 5_000 });

    // The chord at a width where it owns the preference (≥1024px). Start from
    // what the saved pref says — EXPANDED on a lab that behaves — and put that
    // state back at the end, in a `finally`, so a failure halfway through the
    // toggle cannot strand the eight shell tests that run after this one.
    //
    // The resize itself is NOT a settle point, and that is what hung acceptance
    // 42456100374 for its whole 8-minute budget: the rail the hover leg just
    // used at 900px is FORCED and carries the same `sidebar-expand` the chosen
    // rail does, so the old `if (sidebar-expand.isVisible()) click()` aimed at
    // a rail mid-unmount — the expanded column the 1500px width brings back
    // never mounts that testid again, and with no action timeout the click
    // waited for it until the test died. Waiting on the state the SAVED
    // document commands at a width that honours it settles the frame first, and
    // every click after it lands on a rail that is staying.
    await page.setViewportSize({ width: 1500, height: 950 });
    const found = await settleDesktopColumn(page);

    try {
      if (found === "rail") {
        await page.getByTestId("sidebar-expand").click({ timeout: 30_000 });
        await expect(
          page.getByTestId("sidebar-collapse"),
          "the rail's expand button starts the test from the column",
        ).toBeVisible({ timeout: 30_000 });
      }
      await expect(
        page.getByTestId("sidebar-collapse"),
        "1500px starts from the expanded column",
      ).toBeVisible();
      await pressToggleChord(page, () => page.getByTestId("sidebar-expand").isVisible());
      await expect(
        page.getByTestId("sidebar-expand"),
        "⌘\\ collapsed the column to the rail",
      ).toBeVisible({ timeout: 30_000 });
      // The rail it collapsed to is the clickable kind: no rail-zone overlay
      // and no drawer backdrop left standing over the column's edge.
      await expect(page.getByTestId("sidebar-collapse")).toHaveCount(0);
      await expect(page.getByTestId("rail-overlay-backdrop")).toHaveCount(0);
      await expect(page.getByTestId("sidebar-backdrop")).toHaveCount(0);
      await pressToggleChord(page, () => page.getByTestId("sidebar-collapse").isVisible());
      await expect(
        page.getByTestId("sidebar-collapse"),
        "⌘\\ expanded the column again",
      ).toBeVisible({ timeout: 30_000 });
      await checkShellScreen(page, "rail label + ⌘\\ toggle", stopWatching);
      await evidence(
        page,
        "shell-p1-rail-label-chord",
        "hovering the rail's Today tile prints the rail-tooltip label 'Today' (and leaving takes it), and the ⌘\\ chord (Control+\\ on this lab) collapses the column to the rail and re-expands it at 1500px, restoring the saved preference (redesign 4a)",
      );
    } finally {
      await restoreColumnState(page, found);
    }
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("phone drawer opens from the menu button and esc closes it", async ({ page }) => {
      await signInNarrow(page, "admin"); // drawer left open by the helper
      const stopWatching = watchPageErrors(page);
      await expect(page.getByTestId("sidebar").last()).toBeVisible();
      await evidence(
        page,
        "shell-p1-drawer-open",
        "at 390x844 the menu button opens the sidebar drawer with the nav rows inside",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sidebar").last()).toBeHidden();
      await checkShellScreen(page, "home at phone width", stopWatching);
      await evidence(
        page,
        "shell-p1-drawer-esc",
        "at 390x844 Escape closes the drawer and the page stays without sideways scroll",
      );
    });
  });

  // gh-3: a signed-out visitor sees the sign-in screen alone — no sidebar, no
  // app chrome — for `/` and every deep link, at desktop and phone width; the
  // deep link rides along as `return_to` so a sign-in lands back on the page.
  test("signed-out visitors see only the sign-in screen — no sidebar, no app chrome", async ({
    page,
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      // `/board` is retired (finding 03): `/workflows` is a real deep link now.
      for (const path of ["/", "/workflows"]) {
        await page.goto(BASE_URL + path, { waitUntil: "domcontentloaded" });
        const stopWatching = watchPageErrors(page);
        const signIn = page.getByTestId("sign-in");
        await expect(signIn).toBeVisible();
        // No sidebar element at all — the shell chrome must not mount.
        await expect(page.getByTestId("sidebar")).toHaveCount(0);
        const expectedHref =
          path === "/" ? "/auth/login?return_to=%2F" : "/auth/login?return_to=%2Fworkflows";
        await expect(signIn).toHaveAttribute("href", expectedHref);
        await checkShellScreen(page, `signed-out ${path}`, stopWatching);
        await evidence(
          page,
          "shell-p1-signed-out",
          `signed-out ${path} renders the sign-in screen only — no sidebar, no app chrome`,
        );
      }
    }
  });
});
