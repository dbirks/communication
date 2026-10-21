// Phase 1 acceptance: the app-shell + IA redesign's shell itself.
//
// The sidebar replaces the top app bar, the nav rows point at the canonical
// routes (contract C1), every legacy URL redirects, the tree expansion is a
// persisted preference (contract C2), the Settings → Layout controls change
// the shell, ⌘K opens the command palette, and at phone width the sidebar is
// a drawer that Escape closes.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1 (skipped everywhere else — the
// issue2 suites' env-gate idiom). Every page runs checkShellScreen (axe
// serious/critical, no sideways scroll, no pageerror); every step leaves an
// evidence() screenshot + log line.
import { expect, test } from "@playwright/test";
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

/** The sidebar's seven nav rows and the canonical route each must point at. */
const NAV: { testid: string; href: string }[] = [
  { testid: "sidebar-link-home", href: "/" },
  { testid: "sidebar-link-inbox", href: "/inbox" },
  { testid: "sidebar-link-board", href: "/board" },
  { testid: "sidebar-link-threads", href: "/threads" },
  { testid: "sidebar-link-workflows", href: "/workflows" },
  { testid: "sidebar-link-steps", href: "/steps" },
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
    await checkShellScreen(page, "home with sidebar", stopWatching);
    await evidence(
      page,
      "shell-p1-sidebar",
      "the sidebar is present, the old header[aria-label=Primary] app bar is gone, and all seven nav rows link to the canonical C1 routes",
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
    ];
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
      `all ${rows.length} legacy URLs (library, agents, projects/<id>, projects/<id>/runs/<run>?view=timeline, projects/<id>/conversations/<c>) land on their canonical C1 URLs with query state preserved`,
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

  test("Settings → Layout: switcher mode swaps the sidebar; floating ask shows ask-float", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/settings/layout", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("settings-layout")).toBeVisible();
    await checkShellScreen(page, "settings layout", stopWatching);
    await evidence(
      page,
      "shell-p1-settings-layout",
      "the Settings → Layout tab renders the projects-mode, ask-placement and workflow-folder groups",
    );
    // Projects mode: tree → switcher changes the shell's project block.
    await page.getByTestId("settings-layout-projects-mode-option-switcher").click();
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-switcher")).toBeVisible();
    await evidence(
      page,
      "shell-p1-switcher-mode",
      "choosing the switcher projects mode re-renders the sidebar's project block as the project switcher",
    );
    // Ask placement: sidebar → floating moves the assistant to the float.
    await page.goto(BASE_URL + "/settings/layout", { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-layout-ask-placement-option-floating").click();
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ask-float")).toBeVisible();
    await checkShellScreen(page, "home with floating ask", stopWatching);
    await evidence(
      page,
      "shell-p1-ask-floating",
      "choosing the floating ask placement renders the ask-float control on the home page",
    );
    // Restore the defaults so later suites see the shell's default state.
    await page.goto(BASE_URL + "/settings/layout", { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-layout-projects-mode-option-tree").click();
    await page.getByTestId("settings-layout-ask-placement-option-sidebar").click();
  });

  test("⌘K opens the ask surface (ADR-0050); ⌘K again opens the palette; esc closes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-page")).toBeVisible();
    // The journey's chord: ⌘K opens the global ask surface. ADR-0050 made
    // that surface the assistant popover (it owns ⌘K); ⌘K while it is open
    // opens the jump palette instead — the palette assertion rides press two.
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    await evidence(
      page,
      "shell-p1-palette-open",
      "⌘K (Ctrl+K in this lab) opens the global ask surface (the ADR-0050 assistant popover)",
    );
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await evidence(
      page,
      "shell-p1-palette-second-press",
      "a second ⌘K while the assistant is open opens the jump palette",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
    stopWatching();
    await evidence(page, "shell-p1-palette-esc", "Escape closes the command palette");
  });

  test("at 1500x950 the sidebar is always visible (no drawer control)", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto(BASE_URL + "/board", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("sidebar-open")).toBeHidden();
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
});
