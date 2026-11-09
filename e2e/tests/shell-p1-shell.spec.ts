// Phase 1 acceptance: the app-shell + IA redesign's shell itself.
//
// The sidebar replaces the top app bar, the nav rows point at the canonical
// routes (contract C1), every legacy URL redirects, the tree expansion is a
// persisted preference (contract C2), the Settings → Layout page states the
// shell's fixed behaviour (finding 10: the sidebar is always the project
// tree) and a stored OLD preferences document — one still carrying the three
// retired keys — loads the same shell with no error (T7), the first ⌘K opens the jump palette and ⌘J opens Ask (finding 08,
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
import { expectNoLegacyAppBar, gotoApp, signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiCsrf,
  apiPipelines,
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

/** The library's folder labels as the Workflows page reads them (the filter's
 * own source: the wire's distinct non-empty `folder` values). */
async function apiPipelineFolders(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(BASE_URL + "/api/v1/pipelines");
  if (!res.ok()) throw new Error(`GET /pipelines -> ${res.status()}`);
  const body = (await res.json()) as { pipelines?: { folder?: string | null }[] };
  return (body.pipelines ?? []).map((row) => row.folder ?? "");
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
    // Acceptance T1: the project-scoped Threads tab is `/p/:id/threads`; the
    // old `conversations` spelling of BOTH the tab and a single thread stays
    // alive as a redirect (App.tsx), and the redirect must land on the
    // project-scoped `/p/:id/threads[/:cid]` address, not the global one. This
    // is the URL proof — the browser assertion the box rested on a unit test for.
    if (project)
      rows.push({
        old: `/p/${project.id}/conversations`,
        canonical: `/p/${project.id}/threads`,
      });
    if (project && conversation)
      rows.push({
        old: `/p/${project.id}/conversations/${conversation.id}`,
        canonical: `/p/${project.id}/threads/${conversation.id}`,
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
      `all ${rows.length} legacy URLs (library, agents, steps, inbox, board, p/<id>/pipelines, projects/<id>, projects/<id>/runs/<run>?view=timeline, projects/<id>/conversations/<c>, p/<id>/conversations, p/<id>/conversations/<c>) land on their canonical URLs with query state preserved — /inbox and /board land on Today, and the project-scoped p/<id>/conversations[/] lands on p/<id>/threads[/] (T1)`,
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

  // T7: the client's three removed layout settings (finding 10) still live in
  // rows the server saved BEFORE the cut — `GET /me/preferences` answers them
  // and `parseLayout` (ui/src/lib/prefs.ts) drops them. A stored OLD document
  // must therefore cost nothing: the shell loads clean, with the answers the
  // 08/10 decisions fixed (always the project tree, always the floating Ask,
  // folders as a Workflows filter).
  test("T7 — an OLD stored preferences document (the retired layout keys) still loads today's shell", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const csrf = await apiCsrf(request);
    const stopWatching = watchPageErrors(page);
    // Every console error the OLD document can cause, collected across the
    // reloads below: a client that still reads `projects_mode` (or trips on a
    // document carrying it) shows up here, not only as a wrong pixel.
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The one documented exemption, shared with m5-layout's ledger: an
      // UPSTREAM (502/503/504) failure of the model-backed approval summary is
      // the gateway's outcome, not this shell's, and the page shows it honestly.
      const url = message.location()?.url ?? "";
      if (
        /\/api\/v1\/approvals\/[^/?#]+\/summary(?:[?#]|$)/.test(url) &&
        /status of 50[234]\b/.test(message.text())
      ) {
        return;
      }
      consoleErrors.push(`${message.text()} @ ${url || "?"}`);
    });
    // The document BEFORE the write, restored in the `finally` — the lab's
    // admin is shared state and the next shell test reads this document too.
    const before = await apiPreferences(request);
    // The rail is the one OTHER preference this test must not fight: the tree
    // assertions need the expanded column, and an expanded rail is restored
    // through the UI's own door below (same state, the user's own toggle).
    const railWasStored = await storedRailState(request);
    let railTouched = false;
    try {
      // Write an OLD payload — the three keys finding 10 removed from the
      // client, through the same /me/preferences API the app uses. The
      // server's `layout` section still stores them (its shape is unchanged),
      // so this is a real pre-finding-10 row, not a made-up document.
      const written = await request.patch(BASE_URL + "/api/v1/me/preferences", {
        data: {
          layout: {
            projects_mode: "switcher",
            ask_placement: "sidebar",
            show_workflow_folders: true,
          },
        },
        headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
      });
      expect(
        written.status(),
        `PATCH /me/preferences (old payload) -> ${written.status()}: ${await written
          .text()
          .catch(() => "?")}`,
      ).toBe(200);
      const stored = await apiPreferences(request);
      // The row really is an OLD one — otherwise the reload below proves nothing.
      expect(stored.layout.projects_mode).toBe("switcher");
      expect(stored.layout.ask_placement).toBe("sidebar");
      expect(stored.layout.show_workflow_folders).toBe(true);

      // Fresh document load: the client must read it and IGNORE the three keys.
      await gotoApp(page, "/");
      await expect(page.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });
      if (await storedRailState(request)) {
        await page.getByTestId("sidebar-expand").click({ timeout: 10_000 });
        railTouched = true;
        await expect(page.getByTestId("sidebar-collapse")).toBeVisible({ timeout: 15_000 });
      }
      const project = (await apiProjects(request))[0];
      expect(project, "the lab seeds at least one project").toBeTruthy();
      // `projects_mode: "switcher"` is gone: the sidebar is the project TREE
      // and the deleted switcher does not mount.
      await expect(
        page.getByTestId(`sidebar-project-toggle-${project.id}`),
        "an old projects_mode does not put the switcher back",
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("project-switcher")).toHaveCount(0);
      // `ask_placement: "sidebar"` is gone: Ask floats on every page.
      await expect(
        page.getByTestId("ask-fab"),
        "an old ask_placement does not move Ask back into the sidebar",
      ).toBeVisible();
      // `show_workflow_folders` is gone: the sidebar has no folder rows.
      await expect(page.locator('[data-testid^="sidebar-workflow-folder-"]')).toHaveCount(0);

      // The Workflows list: the folder FILTER (when the library carries
      // folders), never the retired grouped folder rows.
      await gotoApp(page, "/workflows");
      await expect(page.getByTestId("workflows-list")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid^="workflow-folder-header-"]')).toHaveCount(0);
      const folders = (await apiPipelineFolders(request)).filter((name) => name !== "");
      if (folders.length > 0) {
        await expect(
          page.getByTestId("workflows-folder-filter"),
          `the library carries folders [${folders.join(", ")}]; an old show_workflow_folders may not hide the filter`,
        ).toBeVisible();
      } else {
        // The design's own rule: an all-unfiled library carries no select
        // (Workflows.tsx), so the honest proof here is the flat list plus the
        // absence of the retired grouped rows asserted above.
        await expect(page.getByTestId("workflows-folder-filter")).toHaveCount(0);
      }

      // No console error survived the old document (and no uncaught one).
      // And the retired keys are READ AND IGNORED, not silently rewritten:
      // the client owns only `expanded`, so the old row is still the old row.
      const afterLoad = await apiPreferences(request);
      expect(afterLoad.layout.projects_mode, "the client rewrote a key it no longer owns").toBe(
        "switcher",
      );
      expect(consoleErrors, "console errors under an old preferences row").toEqual([]);
      stopWatching();
      await checkShellScreen(page, "home under an old preferences row", undefined);
      await evidence(
        page,
        "shell-p1-old-prefs",
        `a stored document still carrying projects_mode=switcher / ask_placement=sidebar / show_workflow_folders=true loads with no console error: the sidebar shows the project tree (no project-switcher, no folder rows), Ask floats (ask-fab), the Workflows list is flat with ${folders.length} folder name(s) behind the toolbar filter and no grouped folder rows`,
      );
    } finally {
      // Restore the document (best effort: a restore failure must not bury the
      // real one — the next shell test's own settle point reports a stranded
      // preference).
      await request
        .patch(BASE_URL + "/api/v1/me/preferences", {
          data: {
            layout: {
              projects_mode: before.layout.projects_mode,
              ask_placement: before.layout.ask_placement,
              show_workflow_folders: before.layout.show_workflow_folders,
            },
          },
          headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
        })
        .catch(() => undefined);
      if (railTouched && railWasStored) {
        await page
          .getByTestId("sidebar-collapse")
          .click({ timeout: 10_000 })
          .catch(() => undefined);
      }
      await expect
        .poll(async () => await storedRailState(request), { timeout: 15_000 })
        .toBe(railWasStored)
        .catch(() => undefined);
    }
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
    // Acceptance T11 (the box rested on Sidebar.test.tsx): the label is the
    // design's ONE dark chip. Prove it ON THE RENDERED PAGE — the computed
    // background is the ink colour (`--color-ink: #1e1d1a` = rgb(30, 29, 26),
    // asserted as rgb so it holds whatever the token's spelling is), and the
    // chip points back at the tile with its arrow (`rail-tooltip-arrow`, the
    // 8px ink square rotated 45° onto the tooltip's left edge).
    await expect(tip, "the dark label paints in the ink colour (design 3a/4a)").toHaveCSS(
      "background-color",
      "rgb(30, 29, 26)",
    );
    const arrow = page.getByTestId("rail-tooltip-arrow");
    await expect(arrow, "the label carries the arrow pointing back at the tile").toHaveCount(1);
    await expect(arrow, "…and the arrow is the same ink").toHaveCSS(
      "background-color",
      "rgb(30, 29, 26)",
    );
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
        "hovering the rail's Today tile prints the rail-tooltip label 'Today' in the ink colour rgb(30, 29, 26) with its rail-tooltip-arrow (and leaving takes it), and the ⌘\\ chord (Control+\\ on this lab) collapses the column to the rail and re-expands it at 1500px, restoring the saved preference (redesign 4a)",
      );
    } finally {
      await restoreColumnState(page, found);
    }
  });

  // Acceptance T4: the design canvas is 1440×900, and the acceptance line is
  // the ruler one reads there — the page band's H1 sits at ONE left edge and
  // ONE baseline across routes, measured as `x` and `y + height` (the typographic
  // baseline of a single-line 22px/28px title is its bottom box edge). The band
  // is `ds/Page`'s shared `page-band`; emulator/projects.spec.ts holds the same
  // ruler at 1280 across four layout kinds — this is its 1440 sibling over the
  // five routes the checklist names (Today, Projects, Threads, a real Workflow
  // page, Settings).
  test("at 1440x900 the band title's left edge and baseline do not move between routes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 1440, height: 900 });
    const pipelines = await apiPipelines(page.request);
    expect(pipelines.length, "the lab seeds at least one workflow").toBeGreaterThan(0);
    const stopWatching = watchPageErrors(page);
    const measured: { route: string; x: number; baseline: number }[] = [];
    for (const route of [
      "/",
      "/projects",
      "/threads",
      `/workflows/${pipelines[0].id}`,
      "/settings/layout",
    ]) {
      await page.goto(BASE_URL + route, { waitUntil: "domcontentloaded" });
      const band = page.getByTestId("page-band");
      await expect(
        band,
        `${route}: the shared header band (page-band) carries the page's title`,
      ).toBeVisible({ timeout: 30_000 });
      const title = band.getByRole("heading", { level: 1 });
      await expect(title, `${route}: the band owns the page's one H1`).toHaveCount(1);
      const box = await title.boundingBox();
      expect(box, `${route}: the band's H1 is laid out`).not.toBeNull();
      measured.push({ route, x: box!.x, baseline: box!.y + box!.height });
    }
    const [first, ...rest] = measured;
    for (const row of rest) {
      expect(
        Math.abs(row.x - first.x),
        `${first.route} title x=${first.x} vs ${row.route} title x=${row.x}: one title left edge at 1440 (±1px)`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(row.baseline - first.baseline),
        `${first.route} title baseline=${first.baseline} vs ${row.route} baseline=${row.baseline}: one title baseline (y + height) at 1440 (±1px)`,
      ).toBeLessThanOrEqual(1);
    }
    await checkShellScreen(page, "the five routes measured at 1440x900", stopWatching);
    await evidence(
      page,
      "shell-p1-title-ruler-1440",
      `the page-band H1's x and baseline (y + height) agree within 1px across /, /projects, /threads, /workflows/<id> and /settings/layout at 1440x900 (${measured.map((m) => `${m.route}@${m.x}/${m.baseline}`).join(" ")})`,
    );
  });

  // Acceptance T5's second half: ⌘J answers from more than Today. The shell
  // mounts the popover once (Shell.tsx), so the chord must open it on every
  // shell page; the Today chord and the sidebar's Search field (sidebar-search
  // → palette) are proven by the ⌘K/⌘J test above — these are the Threads and
  // Workflow-page presses the checklist asks for.
  test("⌘J opens Ask from the Threads and Workflow pages, not just Today", async ({ page }) => {
    await signIn(page, "admin");
    const pipelines = await apiPipelines(page.request);
    expect(pipelines.length, "the lab seeds at least one workflow").toBeGreaterThan(0);
    const stopWatching = watchPageErrors(page);
    for (const route of ["/threads", `/workflows/${pipelines[0].id}`]) {
      await page.goto(BASE_URL + route, { waitUntil: "domcontentloaded" });
      await expect(
        page.getByTestId("ask-fab"),
        `the floating Ask sits on ${route} too (finding 08)`,
      ).toBeVisible({ timeout: 30_000 });
      await pressChord(page, "j", async () => {
        return (await page.getByTestId("assistant-popover").count()) > 0;
      });
      await expect(
        page.getByTestId("assistant-popover"),
        `⌘J opens Ask from ${route}`,
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("assistant-popover")).toBeHidden();
    }
    stopWatching();
    await evidence(
      page,
      "shell-p1-ask-two-pages",
      "⌘J (Meta/Ctrl+j in this lab) opens the assistant popover from /threads and a Workflow page as well as Today, and Escape closes it on both",
    );
  });

  // Acceptance T11: the THIRD door to the column is the edge drag —
  // `sidebar-resize-handle` (Sidebar.tsx's EdgeResizeHandle, RAIL_EDGE_SNAP_PX
  // = 120). The pointer travels a ghost and the column SNAPS: dragging the
  // rail's edge right past ~120px opens the column; dragging the expanded
  // column's edge left back below it snaps the rail shut. Like the ⌘\ test
  // above it, this writes the saved preference, so it runs at a ≥1024px width
  // and restores what it found in a `finally`.
  test("dragging the edge handle past ~120px snaps the column open, back below snaps the rail shut", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    const stopWatching = watchPageErrors(page);
    const found = await settleDesktopColumn(page);
    try {
      // The item's starting state: the preference COLLAPSED at ≥1024px.
      if (found === "column") {
        await page.getByTestId("sidebar-collapse").click({ timeout: 10_000 });
      }
      await expect(
        page.getByTestId("sidebar-rail"),
        "the drag journey starts from the chosen rail (1500px honours the collapsed pref)",
      ).toBeVisible({ timeout: 15_000 });
      const railHandle = page.getByTestId("sidebar-resize-handle");
      await expect(railHandle, "the rail's right edge carries the drag handle").toBeVisible({
        timeout: 10_000,
      });
      const railBox = await railHandle.boundingBox();
      expect(railBox, "the rail's edge handle is laid out").not.toBeNull();
      await page.mouse.move(railBox!.x + railBox!.width / 2, railBox!.y + 300);
      await page.mouse.down();
      // Past the 120px threshold — the snap fires on the pointermove, mid-drag.
      await page.mouse.move(400, railBox!.y + 300, { steps: 16 });
      await expect(
        page.getByTestId("sidebar-collapse"),
        "dragging the rail's edge past ~120px snapped the column open",
      ).toBeVisible({ timeout: 15_000 });
      await page.mouse.up();

      // The mirror half: the expanded column's edge, dragged back below the
      // threshold, snaps the rail closed.
      const colHandle = page.getByTestId("sidebar-resize-handle");
      await expect(
        colHandle,
        "the expanded column's right edge carries the same handle",
      ).toBeVisible({ timeout: 10_000 });
      const colBox = await colHandle.boundingBox();
      expect(colBox, "the expanded column's edge handle is laid out").not.toBeNull();
      await page.mouse.move(colBox!.x + colBox!.width / 2, colBox!.y + 300);
      await page.mouse.down();
      await page.mouse.move(40, colBox!.y + 300, { steps: 16 });
      await expect(
        page.getByTestId("sidebar-expand"),
        "dragging the expanded column's edge back below ~120px snapped the rail closed",
      ).toBeVisible({ timeout: 15_000 });
      await page.mouse.up();
      await expect(
        page.getByTestId("sidebar-rail"),
        "the rail is what stands at the end of the drag",
      ).toBeVisible();
      await checkShellScreen(page, "edge-handle snaps both ways", stopWatching);
      await evidence(
        page,
        "shell-p1-edge-drag",
        "dragging sidebar-resize-handle right past the 120px snap point opened the column and dragging the expanded column's edge left back below it snapped the rail shut (RAIL_EDGE_SNAP_PX, redesign T11); the rail's hover label is proven by the rail-label test and the Projects popover's Esc by the emulator's rail step",
      );
    } finally {
      await restoreColumnState(page, found);
    }
  });

  // Acceptance T11's keyboard half: the rail's Projects popover is a real
  // keyboard surface — ds/Popover parks the caret on the first item, ↑/↓ rove
  // and Enter activates. Esc-closing the same popover is already proven
  // (e2e/emulator/catchup.spec.ts' rail step); ↓-moves and Enter-navigates are
  // what was missing. The forced rail at 900px mounts the tiles without the
  // test ever touching the saved preference.
  test("the rail's Projects popover walks on ↓ and navigates on Enter", async ({ page }) => {
    await signIn(page, "admin");
    const projects = await apiProjects(page.request);
    const project = projects.find((p) => p.slug === "m4-exit") ?? projects[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(BASE_URL + `/p/${project.id}`, { waitUntil: "domcontentloaded" });
    const stopWatching = watchPageErrors(page);
    await expect(page.getByTestId("sidebar-rail"), "900px forces the rail").toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("rail-item-projects").click({ timeout: 10_000 });
    const popover = page.getByTestId("rail-projects-popover");
    await expect(popover, "the Projects tile opens the popover").toBeVisible({ timeout: 10_000 });
    // T11's visual bit: the popover points at its tile — the shared
    // `ds/Popover` arrow square on the edge facing the trigger.
    await expect(
      popover.getByTestId("menu-arrow"),
      "T11: the rail Projects popover carries its arrow",
    ).toBeVisible({ timeout: 10_000 });
    const firstRow = popover.locator('[data-testid^="rail-project-"]').first();
    await expect(firstRow, "on open the caret parks on the popover's first item").toBeFocused({
      timeout: 10_000,
    });
    // The active project's repositories ride below its row (design 4a), so the
    // roving caret has somewhere to go even in a single-project lab.
    const repoHref = `/p/${project.id}/app`;
    await expect(
      popover.locator(`a[href="${repoHref}"]`),
      "the popover lists the active project's `app` repository beside its row",
    ).toBeVisible({ timeout: 15_000 });
    // Walk the caret down until it lands on the repository link — the same ↓ a
    // keyboard reader presses.
    let hops = 0;
    for (;;) {
      const active = await page.evaluate(() => document.activeElement?.getAttribute("href") ?? "");
      if (active === repoHref) break;
      expect(
        hops++ < 12,
        `the roving caret reached the repository link within the popover's items (stopped on [${active}], ${hops} presses in)`,
      ).toBe(true);
      await page.keyboard.press("ArrowDown");
    }
    await expect(
      popover.locator(`a[href="${repoHref}"]`),
      "↓ moved the caret between the popover's items",
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page,
      `Enter activates the focused item — the popover's app row must open ${repoHref}`,
    ).toHaveURL(new URL(repoHref, BASE_URL).href, { timeout: 15_000 });
    stopWatching();
    await evidence(
      page,
      "shell-p1-rail-popover-keys",
      "in the rail's Projects popover ArrowDown moves the caret between items and Enter activates the focused one (the caret walked from the project row to its app repository and the route changed); Esc closing the popover is proven in e2e/emulator/catchup.spec.ts' rail step (redesign T11)",
    );
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
