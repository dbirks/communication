// Phase 1 acceptance, redesign R8: the app shell itself — the project rail,
// the top bar, the scope sheet on a phone, the redirects of every old address,
// the one layout preference the app still persists, and the two assistant
// doors (Search or ask ⌘K, Quick chat ⌘J / the mic).
//
// The sidebar is deleted (docs/design/redesign/CONTRACT.md "What happens to the
// old app"), so this suite names the REPLACEMENT the contract draws and proves
// that, not the old column:
//
//   rail (64px)  `project-rail`, `rail-tile-all`, `rail-tile-<projectId>`,
//                `rail-add-project`, `rail-manage`, `rail-account`
//   top bar (60px) `top-bar`, `top-bar-context`, `top-bar-scope-name`,
//                `pill-home|pill-chats|pill-factory`, `search-or-ask`,
//                `top-bar-mic`
//   phone (below 768px) `scope-open` → `scope-sheet` (`scope-row-*`,
//                `scope-account`), `scope-backdrop`
//   gone: the drawer, the collapsed rail + its ⌘\ chord, the edge-drag snap,
//         the rail's Projects popover, the floating Ask button, Settings →
//         Layout (its retired keys are proven READ AND IGNORED in T7 below).
//
// The scope is a URL prefix (`/p/:projectId/...`), so the scope claims here are
// URL claims: the pill's links carry the scope, the rail's tiles keep the
// SECTION while they change the project, and Manage is global.
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1 (the issue2 suites' env-gate idiom).
// Every page runs checkShellScreen (axe serious/critical, no sideways scroll,
// no pageerror) plus noSidewaysScrollInShell — with `h-dvh overflow-hidden` on
// the shell root the DOCUMENT can no longer scroll sideways at all, so the
// scroll check has to look at the region that owns scrolling now. Every step
// leaves an evidence() screenshot + log line.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { expectNoLegacyAppBar, gotoApp, signIn } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiCsrf,
  apiPreferences,
  apiProjectWithRepo,
  apiProjects,
  checkShellScreen,
  evidence,
  noSidewaysScrollInShell,
  signInNarrow,
  watchPageErrors,
} from "./shell-helpers.js";

/** The Manage destinations CONTRACT §7 names, in order. */
const MANAGE_SECTIONS = [
  "projects",
  "repositories",
  "people",
  "runners",
  "agents",
  "secrets",
] as const;

/**
 * Press a ⌘-chord the way this lab's keyboard allows. The app binds
 * `metaKey || ctrlKey` for ⌘K/⌘J (CommandPalette.tsx's hold-to-talk, the
 * assistant chord in AssistantPopover.tsx); `Meta+k`/`Meta+j` carry no browser
 * default on the lab's Linux Chromium, so they are tried first and `Control+…`
 * is the documented fallback (the idiom shell-journey.spec.ts already uses).
 */
async function pressChord(page: Page, key: string, opened: () => Promise<boolean>) {
  await page.keyboard.press(`Meta+${key}`);
  if (!(await opened())) {
    await page.keyboard.press(`Control+${key}`);
  }
}

/** The data-testid the app computes for an id is not needed here: the rail
 * keys its tiles by the raw project id (`rail-tile-${project.id}`). */

/** The repository page this suite can drive: one project that carries a repo,
 * and that repo's name (the page is `/p/:projectId/:repo`). */
async function repoPagePath(page: Page): Promise<{ path: string; repo: string }> {
  const project = await apiProjectWithRepo(page.request);
  const res = await page.request.get(`${BASE_URL}/api/v1/projects/${project.id}/repos?limit=50`);
  if (!res.ok()) throw new Error(`GET /projects/${project.id}/repos -> ${res.status()}`);
  const body = (await res.json()) as { items?: { name: string }[] };
  const repo = (body.items ?? [])[0];
  if (!repo) throw new Error(`project ${project.id} reported a repository but listed none`);
  return { path: `/p/${project.id}/${encodeURIComponent(repo.name)}`, repo: repo.name };
}

/** What element carries the caret right now (testid, href or tag). */
async function caretOn(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "(nothing)";
    const testid = el.getAttribute("data-testid");
    if (testid) return `[${testid}]`;
    const href = el.getAttribute("href");
    return href ? `a[href="${href}"]` : `${el.tagName.toLowerCase()}`;
  });
}

/** One rail tile or pill item's href, resolved against the app origin. */
async function hrefOf(target: Locator): Promise<string> {
  const href = await target.getAttribute("href");
  if (href === null) throw new Error("the element carries no href");
  return new URL(href, BASE_URL).pathname + new URL(href, BASE_URL).search;
}

/** The shell frame in pixels: the rail's box, the bar's box and the content
 * region's top-left corner — the three numbers CONTRACT "Shell" fixes. The rail
 * is optional because the phone mounts none, and every box is bounded so a
 * missing element is an error rather than a wait. */
interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function measureFrame(
  page: Page,
  opts: { rail?: boolean } = {},
): Promise<{ rail: FrameBox | null; bar: FrameBox; content: FrameBox }> {
  const box = async (target: Locator, name: string): Promise<FrameBox> => {
    const b = await target.boundingBox({ timeout: 10_000 });
    if (!b) throw new Error(`${name} is not laid out on ${page.url()}`);
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: b.height };
  };
  const rail =
    opts.rail === false ? null : await box(page.getByTestId("project-rail"), "project-rail");
  const bar = await box(page.getByTestId("top-bar"), "top-bar");
  const content = await box(page.locator("main").first(), "<main>");
  return { rail, bar, content };
}

/** The rail's width, with the phone (no rail) reported as the failure it is. */
function railWidth(frame: { rail: FrameBox | null }): number {
  if (!frame.rail)
    throw new Error("the rail did not mount — measureFrame was asked for a phone frame");
  return frame.rail.width;
}

test.describe("shell p1 — rail, top bar, scope, redirects, preferences, ask doors", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(8 * 60_000);

  test("rail shell: no legacy header, the pill and the rail link the canonical routes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    // The IdP chain lands on the API origin's embedded build; the journey
    // runs against the dev origin, where the current source is served.
    await gotoApp(page, "/");
    const stopWatching = watchPageErrors(page);
    await expectNoLegacyAppBar(page); // header[aria-label="Primary"] is gone
    const projects = await apiProjects(page.request);
    const project = projects[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();

    // The frame: rail + bar, and the old column is not there at all.
    await expect(page.getByTestId("project-rail")).toBeVisible();
    await expect(page.getByTestId("top-bar")).toBeVisible();
    await expect(page.getByTestId("sidebar"), "the 220px column is deleted").toHaveCount(0);
    for (const gone of [
      "sidebar-link-home",
      "sidebar-link-threads",
      "sidebar-link-workflows",
      "sidebar-link-profiles",
      "sidebar-project-toggle",
      "rail-tooltip",
      "rail-projects-popover",
      "sidebar-resize-handle",
      "phone-top-strip",
      "project-switcher",
      "ask-fab",
    ]) {
      await expect(
        page.locator(`[data-testid^="${gone}"]`),
        `${gone} is gone with the sidebar`,
      ).toHaveCount(0);
    }

    // The pill: the three daily places, at the unscoped (All) routes.
    expect(await hrefOf(page.getByTestId("pill-home"))).toBe("/");
    expect(await hrefOf(page.getByTestId("pill-chats"))).toBe("/chats");
    expect(await hrefOf(page.getByTestId("pill-factory"))).toBe("/factory");
    await expect(page.getByTestId("pill-home")).toContainText("Home");
    await expect(page.getByTestId("pill-chats")).toContainText("Chats");
    await expect(page.getByTestId("pill-factory")).toContainText("Factory");
    await expect(page.getByTestId("search-or-ask")).toBeVisible();
    await expect(page.getByTestId("top-bar-scope-name")).toHaveText("All projects");
    // Manage is NOT in the pill — it lives in the rail; the pill holds exactly
    // the three daily places.
    const pill = page.getByRole("navigation", { name: "Sections" });
    await expect(pill.getByRole("link")).toHaveCount(3);

    // The rail: All, one tile per project, the "+", the gear and the account.
    expect(await hrefOf(page.getByTestId("rail-tile-all"))).toBe("/");
    expect(await hrefOf(page.getByTestId(`rail-tile-${project.id}`))).toBe(`/p/${project.id}`);
    expect(await hrefOf(page.getByTestId("rail-add-project"))).toBe("/manage/projects?new=1");
    expect(await hrefOf(page.getByTestId("rail-manage"))).toBe("/manage/projects");
    await expect(page.getByTestId("rail-account").getByTestId("user-menu")).toBeVisible();
    await expect(page.getByTestId("rail-account").getByTestId("user-badge")).toBeVisible();
    await expect(
      page.getByTestId("scope-open"),
      "the scope trigger is the phone's door",
    ).toHaveCount(0);

    // In a project the pill carries the scope, and the rail's tiles keep the
    // SECTION while they change the project (CONTRACT "Shell").
    await gotoApp(page, `/p/${project.id}/chats`);
    await expect(page.getByTestId("chats")).toBeVisible();
    expect(await hrefOf(page.getByTestId("pill-home"))).toBe(`/p/${project.id}`);
    expect(await hrefOf(page.getByTestId("pill-chats"))).toBe(`/p/${project.id}/chats`);
    expect(await hrefOf(page.getByTestId("pill-factory"))).toBe(`/p/${project.id}/factory`);
    expect(await hrefOf(page.getByTestId("rail-tile-all"))).toBe("/chats");
    await expect(page.getByTestId("top-bar-scope-name")).toHaveText(project.name);

    // Manage is the one home for the administrative destinations, and the rail's
    // ⚙ tile is its door: the nav lists the six sections CONTRACT names, in
    // CONTRACT's order (`/manage` with no section is Projects).
    await gotoApp(page, "/manage");
    const nav = page.getByTestId("manage-nav").first();
    await expect(nav).toBeVisible();
    expect(await hrefOf(nav.locator("[data-testid=manage-nav-projects]"))).toBe("/manage/projects");
    const navOrder = await nav
      .locator("[data-testid^=manage-nav-]")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node.getAttribute("data-testid") ?? "").replace("manage-nav-", "")),
      );
    expect(navOrder, "Manage's nav lists the sections in the order CONTRACT names them").toEqual([
      ...MANAGE_SECTIONS,
    ]);

    await gotoApp(page, "/");
    await checkShellScreen(page, "home with the rail", undefined);
    await noSidewaysScrollInShell(page);
    stopWatching();
    await evidence(
      page,
      "shell-p1-rail",
      "the rail (All, one tile per project, +, Manage, the account) and the 60px top bar replace the sidebar: the pill links /, /chats and /factory and carries the scope on a project page, the rail's tiles link /p/<id> and keep the section, the '+' deep-links New project, and the deleted column's rows, tooltip, popover, edge handle, phone strip, project switcher and floating Ask mount nowhere",
    );
  });

  test("legacy routes redirect to the canonical redesigned URLs", async ({ page }) => {
    await signIn(page, "admin");
    const project = (await apiProjects(page.request))[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();
    const pipelines = await page.request
      .get(`${BASE_URL}/api/v1/pipelines`)
      .then((r) => r.json())
      .then((b: { pipelines?: { id: string }[] }) => b.pipelines ?? []);
    const conversations = await page.request
      .get(`${BASE_URL}/api/v1/conversations?limit=50`)
      .then((r) => r.json())
      .then((b: { items?: { id: string }[] }) => b.items ?? []);

    const rows: { old: string; canonical: string }[] = [
      // CONTRACT "Redirects": Threads became Chats, Workflows became Factory,
      // the settings pages became Manage sections, the board and Today's
      // neighbours became Home.
      { old: "/threads", canonical: "/chats" },
      { old: "/workflows", canonical: "/factory" },
      { old: "/library", canonical: "/factory" },
      { old: "/agents", canonical: "/manage/agents" },
      { old: "/profiles", canonical: "/manage/agents" },
      { old: "/steps", canonical: "/manage/agents?tab=steps" },
      { old: "/workflows/steps", canonical: "/manage/agents?tab=steps" },
      { old: "/workflows/collections", canonical: "/manage/agents?tab=skills" },
      { old: "/projects", canonical: "/manage/projects" },
      { old: "/ops", canonical: "/manage/runners" },
      { old: "/settings/operations", canonical: "/manage/runners" },
      { old: "/settings/assistant", canonical: "/manage/agents?tab=assistant" },
      // Finding 03 retired the Inbox and the Board as destinations; both land
      // on Home, which is where their behaviour lives now.
      { old: "/inbox", canonical: "/" },
      { old: "/board", canonical: "/" },
      { old: "/catch-up", canonical: "/" },
      { old: `/p/${project.id}/pipelines`, canonical: `/p/${project.id}/factory` },
      { old: `/p/${project.id}/workflows`, canonical: `/p/${project.id}/factory` },
      { old: `/p/${project.id}/runs`, canonical: `/p/${project.id}/factory` },
      { old: `/projects/${project.id}`, canonical: `/p/${project.id}` },
      { old: `/p/${project.id}/settings`, canonical: `/manage/projects/${project.id}` },
      {
        old: `/p/${project.id}/members`,
        canonical: `/manage/people?project=${encodeURIComponent(project.id)}`,
      },
      // The project-scoped Threads tab and the single thread (T1's proof):
      // both old spellings land on the SCOPED chats address, not the global one.
      { old: `/p/${project.id}/conversations`, canonical: `/p/${project.id}/chats` },
      { old: `/p/${project.id}/threads`, canonical: `/p/${project.id}/chats` },
    ];
    if (pipelines.length > 0) {
      rows.push({
        old: `/workflows/${pipelines[0].id}`,
        canonical: `/factory/${pipelines[0].id}`,
      });
      rows.push({
        old: `/workflows/${pipelines[0].id}/history`,
        canonical: `/factory/${pipelines[0].id}?panel=versions`,
      });
      rows.push({
        old: `/workflows/${pipelines[0].id}/yaml`,
        canonical: `/factory/${pipelines[0].id}?panel=yaml`,
      });
    }
    if (conversations.length > 0) {
      rows.push({
        old: `/threads/${conversations[0].id}`,
        canonical: `/chats/${conversations[0].id}`,
      });
      rows.push({
        old: `/p/${project.id}/conversations/${conversations[0].id}`,
        canonical: `/p/${project.id}/chats/${conversations[0].id}`,
      });
      rows.push({
        old: `/projects/${project.id}/conversations/${conversations[0].id}`,
        canonical: `/p/${project.id}/chats/${conversations[0].id}`,
      });
    }
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      await gotoApp(page, row.old);
      // The redirect is a client-side `<Navigate replace>`: the document lands
      // on the old address first, so the URL is polled, not read once.
      await expect
        .poll(
          async () => {
            const landed = new URL(page.url());
            return `${landed.pathname}${landed.search}`;
          },
          { message: `${row.old} must land on ${row.canonical} with its query preserved` },
        )
        .toBe(row.canonical);
    }
    // The workbench permalink keeps the ADR-0043 view state byte-for-byte.
    const runs = await page.request
      .get(`${BASE_URL}/api/v1/runs?limit=5`)
      .then((r) => r.json())
      .then((b: { runs?: { id: string; project_id: string }[] }) => b.runs ?? []);
    if (runs.length > 0) {
      const old = `/projects/${runs[0].project_id}/runs/${runs[0].id}?view=timeline`;
      await gotoApp(page, old);
      await expect
        .poll(async () => {
          const landed = new URL(page.url());
          return `${landed.pathname}${landed.search}`;
        })
        .toBe(`/runs/${runs[0].id}?view=timeline`);
    }
    await evidence(
      page,
      "shell-p1-redirects",
      `all ${rows.length} pre-redesign addresses (threads, workflows, library, agents, profiles, steps, collections, projects, ops, settings tabs, inbox, board, catch-up, the project tabs, project settings/members and the scoped conversations/threads spellings) land on their redesigned URL with the query preserved, and a run permalink keeps ?view=timeline`,
    );
  });

  test("the repository's List | Lanes choice persists across reload — /me/preferences carries it", async ({
    page,
  }) => {
    await signIn(page, "admin");
    // The project tree died with the sidebar, so the ONE layout choice the
    // redesigned app still persists is the repository page's view (design 3a):
    // the same contract C2 round-trip (PATCH → GET → survives a reload), on the
    // key that survives (`layout.expanded["repo-view:<name>"]`).
    const { path, repo } = await repoPagePath(page);
    const key = `repo-view:${repo}`;
    await gotoApp(page, path);
    const stopWatching = watchPageErrors(page);
    const toggle = page.getByTestId("repo-view-toggle");
    await expect(toggle, "the repository page carries the List | Lanes control").toBeVisible({
      timeout: 30_000,
    });
    const lanes = page.getByTestId("repo-view-lanes");
    const list = page.getByTestId("repo-view-list");
    // Start from List so the journey always writes something.
    if ((await lanes.getAttribute("aria-pressed")) === "true") {
      await list.click();
      await expect(lanes).toHaveAttribute("aria-pressed", "false");
    }
    const beforeDoc = await apiPreferences(page.request);
    expect(
      beforeDoc.layout.projects_mode,
      "the wire still carries the retired layout keys",
    ).toBeTruthy();

    const patch = page.waitForRequest(
      (req) => req.url().includes("/api/v1/me/preferences") && req.method() === "PATCH",
    );
    await lanes.click();
    const patchRequest = await patch;
    const body = JSON.parse((await patchRequest.postData()) ?? "{}") as {
      layout?: { expanded?: Record<string, boolean> };
    };
    expect(
      body.layout?.expanded?.[key],
      `the PATCH names this repository's view key (${key})`,
    ).toBe(true);
    await patchRequest.response();
    await expect(lanes, "the chosen arm reads as pressed").toHaveAttribute("aria-pressed", "true");
    await expect(list).toHaveAttribute("aria-pressed", "false");
    const stored = await apiPreferences(page.request);
    expect(stored.layout.expanded[key], "GET /me/preferences reflects the change").toBe(true);
    // Reload: the page re-reads the preference, so the choice survives.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("repo-view-lanes")).toHaveAttribute("aria-pressed", "true", {
      timeout: 30_000,
    });
    await checkShellScreen(page, "repository in Lanes", stopWatching);
    // Put the choice back the way the person would, so no other suite inherits
    // a repository it did not choose to open in Lanes.
    await page.getByTestId("repo-view-list").click();
    await expect
      .poll(async () => (await apiPreferences(page.request)).layout.expanded[key] ?? false)
      .toBe(false);
    await evidence(
      page,
      "shell-p1-repo-view",
      `Lanes on "${repo}" PATCHes /api/v1/me/preferences (layout.expanded["${key}"]=true), the GET returns it, the choice is still Lanes after a reload, and the List click writes it back — the one persisted layout choice the redesigned shell keeps`,
    );
  });

  // T7: the client's three removed layout settings still live in rows the
  // server saved BEFORE the cut — `GET /me/preferences` answers them and
  // `parseLayout` (ui/src/lib/prefs.ts) drops them. A stored OLD document must
  // cost nothing in the REDESIGNED shell either: rail, top bar and every page
  // load clean, the retired keys are read and IGNORED (not rewritten), and the
  // doors the 08/10 decisions fixed are the ones the redesign draws.
  test("T7 — an OLD stored preferences document (the retired layout keys) still loads today's shell", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const csrf = await apiCsrf(request);
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
    try {
      // Write an OLD payload — the three keys finding 10 removed from the
      // client, through the same /me/preferences API the app uses. The server's
      // `layout` section still stores them (its shape is unchanged), so this is
      // a real pre-finding-10 row, not a made-up document.
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
      // `projects_mode: "switcher"` is gone: no switcher mounts anywhere, and
      // the rail (the redesign's project list) does.
      await gotoApp(page, "/");
      await expect(page.getByTestId("home-all")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("project-rail"),
        "an old projects_mode does not eat the rail",
      ).toBeVisible();
      await expect(page.getByTestId("top-bar")).toBeVisible();
      await expect(page.getByTestId("project-switcher")).toHaveCount(0);
      // `ask_placement: "sidebar"` is gone: there is no floating Ask any more,
      // and the redesign's two doors answer instead — Search or ask and the mic.
      await expect(page.getByTestId("ask-fab"), "the Ask float stays retired").toHaveCount(0);
      await expect(page.getByTestId("search-or-ask")).toBeVisible();
      await expect(page.getByTestId("top-bar-mic")).toBeVisible();
      // The Quick chat panel is the Ask surface an old ask_placement cannot
      // move back into a column: it opens and closes from the top bar.
      await pressChord(page, "j", async () => (await page.getByTestId("quick-chat").count()) > 0);
      await expect(page.getByTestId("quick-chat")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("quick-chat")).toBeHidden();

      // `show_workflow_folders` is gone: the old library address answers the
      // Factory floor, which groups nothing — no folder rows, no folder select.
      await gotoApp(page, "/workflows");
      await expect(page.getByTestId("factory-index")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid^="workflow-folder-header-"]')).toHaveCount(0);
      await expect(page.getByTestId("workflows-folder-filter")).toHaveCount(0);

      // Project home and Manage both answer under the old document too.
      const project = (await apiProjects(request))[0];
      await gotoApp(page, `/p/${project.id}`);
      await expect(page.getByTestId("project-home")).toBeVisible({ timeout: 30_000 });
      await gotoApp(page, "/manage/agents");
      await expect(page.getByTestId("manage-agents")).toBeVisible({ timeout: 30_000 });
      await noSidewaysScrollInShell(page);

      // No console error survived the old document (and no uncaught one).
      // And the retired keys are READ AND IGNORED, not silently rewritten:
      // the client owns only `expanded`, so the old row is still the old row.
      const afterLoad = await apiPreferences(request);
      expect(afterLoad.layout.projects_mode, "the client rewrote a key it no longer owns").toBe(
        "switcher",
      );
      expect(afterLoad.layout.ask_placement, "the client rewrote ask_placement").toBe("sidebar");
      expect(
        afterLoad.layout.show_workflow_folders,
        "the client rewrote show_workflow_folders",
      ).toBe(true);
      expect(consoleErrors, "console errors under an old preferences row").toEqual([]);
      await evidence(
        page,
        "shell-p1-old-prefs",
        "a stored document still carrying projects_mode=switcher / ask_placement=sidebar / show_workflow_folders=true loads the redesigned shell with no console error: the rail and the top bar mount, the switcher and the floating Ask mount nowhere, ⌘J opens and Escape closes Quick chat, /workflows answers the Factory floor with no folder rows, and the retired keys are still exactly as stored",
      );
    } finally {
      // Restore the document (best effort: a restore failure must not bury the
      // real one).
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
      await expect
        .poll(async () => (await apiPreferences(request)).layout.projects_mode, { timeout: 15_000 })
        .toBe(before.layout.projects_mode)
        .catch(() => undefined);
    }
  });

  test("⌘K opens Search; ⌘J and the mic open Quick chat; esc and the × close them", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await gotoApp(page, "/");
    await expect(page.getByTestId("home-all")).toBeVisible();
    // The FIRST ⌘K opens Search (the palette engine is unchanged; the field in
    // the bar is its door), and Quick chat never answers ⌘K.
    await pressChord(page, "k", async () => (await page.getByTestId("palette-input").count()) > 0);
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expect(page.getByTestId("quick-chat")).toHaveCount(0);
    await evidence(
      page,
      "shell-p1-palette-open",
      "the first ⌘K (Meta/Ctrl+K in this lab) opens Search, not Quick chat",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
    await evidence(page, "shell-p1-palette-esc", "Escape closes Search");
    // "Search or ask" is the field the rail replaced the sidebar's with.
    await page.getByTestId("search-or-ask").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
    await evidence(
      page,
      "shell-p1-search-field",
      "the top bar's Search or ask field (search-or-ask) opens Search and Escape closes it",
    );
    // ⌘J opens Quick chat — and only Quick chat.
    await pressChord(page, "j", async () => (await page.getByTestId("quick-chat").count()) > 0);
    await expect(page.getByTestId("quick-chat")).toBeVisible();
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quick-chat")).toBeHidden();
    await evidence(
      page,
      "shell-p1-ask-chord",
      "⌘J opens the docked Quick chat panel and Escape closes it (the assistant popover is gone)",
    );
    // The mic is the other door to Ask: it opens the same surface, and its ×
    // closes it (the floating Ask button it replaced is retired).
    await page.getByTestId("top-bar-mic").click();
    await expect(page.getByTestId("quick-chat")).toBeVisible();
    await page.getByTestId("quick-chat-close").click();
    await expect(page.getByTestId("quick-chat")).toBeHidden();
    await checkShellScreen(page, "home after the ask doors", stopWatching);
    await evidence(
      page,
      "shell-p1-ask-doors",
      "the top bar's mic opens Quick chat and its × (quick-chat-close) closes it — the two Ask doors the redesign names, with no floating button",
    );
  });

  test("⌘J and the mic open Quick chat from the Chats list and Manage, not just Home", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    for (const route of ["/chats", "/manage/projects"]) {
      await gotoApp(page, route);
      await expect(
        page.getByTestId("top-bar-mic"),
        `the mic sits on ${route} too (CONTRACT: every top bar carries it)`,
      ).toBeVisible({ timeout: 30_000 });
      await pressChord(page, "j", async () => (await page.getByTestId("quick-chat").count()) > 0);
      await expect(page.getByTestId("quick-chat"), `⌘J opens Ask from ${route}`).toBeVisible();
      // Quick chat is a surface you keep: an outside click and a page change
      // never close it (its own unit contract), so ⌘J — the same chord, which
      // toggles — is the keyboard door out on a page like /chats, where the
      // page's own prompt takes the caret back the moment the panel opens.
      await page.getByTestId("top-bar-context").click();
      await expect(
        page.getByTestId("quick-chat"),
        `an outside click keeps Ask open on ${route}`,
      ).toBeVisible();
      await pressChord(page, "j", async () => (await page.getByTestId("quick-chat").count()) === 0);
      await expect(page.getByTestId("quick-chat"), `⌘J closes Ask again on ${route}`).toBeHidden();
      await page.getByTestId("top-bar-mic").click();
      await expect(page.getByTestId("quick-chat"), `the mic opens Ask from ${route}`).toBeVisible();
      // With the caret inside the panel, Escape is the other way out.
      await page.getByTestId("assistant-composer-input").click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByTestId("quick-chat"),
        `Escape closes Ask from ${route} once the caret is inside`,
      ).toBeHidden();
      await page.getByTestId("top-bar-mic").click();
      await expect(page.getByTestId("quick-chat")).toBeVisible();
      await page.getByTestId("quick-chat-close").click();
      await expect(page.getByTestId("quick-chat")).toBeHidden();
    }
    stopWatching();
    await evidence(
      page,
      "shell-p1-ask-two-pages",
      "⌘J opens and closes Quick chat from /chats and /manage as well as Home (the shell owns the surface, and a page's own autofocus cannot trap it), an outside click keeps it, the mic opens it, and Escape closes it with the caret inside — no floating button anywhere",
    );
  });

  test("at 1500x950 the rail is the frame: no phone scope trigger, no sheet", async ({ page }) => {
    await signIn(page, "admin");
    await gotoApp(page, "/factory");
    await expect(page.getByTestId("project-rail")).toBeVisible();
    await expect(page.getByTestId("top-bar")).toBeVisible();
    await expect(
      page.getByTestId("scope-open"),
      "the 36px scope button is the phone's",
    ).toHaveCount(0);
    await expect(page.getByTestId("scope-sheet")).toHaveCount(0);
    await expect(page.getByTestId("scope-backdrop")).toHaveCount(0);
    await noSidewaysScrollInShell(page);
  });

  // The rail is the frame from 768px up (CONTRACT "Phone": below 768 the rail
  // does not mount). The old forced-rail band (768–1023) is gone with the
  // column, so a tablet window is not a special case any more — and, as the old
  // test insisted, changing the width must never write the stored document.
  test("at 900x800 the rail is still the frame, the sheet does not mount, and the width writes nothing", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await gotoApp(page, "/factory");
    const storedBefore = (await apiPreferences(page.request)).layout.expanded;
    await expect(page.getByTestId("project-rail")).toBeVisible();
    const stopWatching = watchPageErrors(page);
    const wide = await measureFrame(page);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId("project-rail")).toBeVisible();
    await expect(page.getByTestId("scope-open"), "a tablet window is not a phone").toHaveCount(0);
    await expect(page.getByTestId("scope-sheet")).toHaveCount(0);
    await expect(
      page.getByTestId("top-bar-phone-slot"),
      "the phone strip is phone-only",
    ).toHaveCount(0);
    // The pill keeps its WORDS at a tablet width (they are sr-only on a phone).
    await expect(page.getByTestId("pill-chats")).toContainText("Chats");
    const narrow = await measureFrame(page);
    // And widening comes back to the same frame — nothing was forced, because
    // nothing is chosen by width above the phone cut.
    await page.setViewportSize({ width: 1500, height: 950 });
    await expect(page.getByTestId("project-rail")).toBeVisible();
    const back = await measureFrame(page);
    for (const [name, a, b] of [
      ["rail width", railWidth(wide), railWidth(narrow)],
      ["rail width after widening", railWidth(wide), railWidth(back)],
      ["bar height", wide.bar.height, back.bar.height],
      ["content top-left x", wide.content.x, back.content.x],
      ["content top-left y", wide.content.y, back.content.y],
    ] as const) {
      expect(
        Math.abs(a - b),
        `900px and 1500px agree on ${name} (${a} vs ${b})`,
      ).toBeLessThanOrEqual(1);
    }
    const storedAfter = (await apiPreferences(page.request)).layout.expanded;
    expect(
      storedAfter,
      `resizing the frame wrote to the stored preferences (before ${JSON.stringify(
        storedBefore,
      )}, after ${JSON.stringify(storedAfter)})`,
    ).toEqual(storedBefore);
    await checkShellScreen(page, "/factory at 900px", stopWatching);
    await evidence(
      page,
      "shell-p1-rail-900",
      "at 900x800 the rail and the 60px top bar are still the frame (no scope trigger, no sheet, no phone strip, the pill still shows its words), the frame's rail width / bar height / content corner match the 1500px numbers within 1px, and the resize PATCHed nothing",
    );
  });

  // The frame's exact edge: `Shell`'s NARROW_QUERY is `(max-width: 767.98px)`,
  // so 767 is the last phone width and 768 is the first rail width. Pinning
  // both sides is what keeps the cutoff from drifting back a breakpoint by
  // accident. The phone's `scope-open` button replaces the drawer's menu.
  test("the phone frame ends at 768px: 767 opens the scope sheet, 768 is the rail", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 767, height: 900 });
    await gotoApp(page, "/factory");
    const strip = watchPageErrors(page);
    const phone = await measureFrame(page, { rail: false });
    await expect(
      page.getByTestId("project-rail"),
      "767 is a phone: the rail does not mount",
    ).toHaveCount(0);
    await expect(page.getByTestId("scope-open"), "767 opens the scope sheet").toBeVisible();
    await expect(
      page.getByTestId("top-bar-phone-slot"),
      "the phone's claimed-left strip mounts hidden until a page claims it",
    ).toBeHidden();
    await expect(page.getByTestId("scope-sheet"), "a closed sheet is unmounted").toHaveCount(0);
    await page.getByTestId("scope-open").click();
    await expect(page.getByTestId("scope-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("scope-sheet")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? ""))
      .toBe("scope-open");
    expect(phone.bar.height, "the phone bar is the 52px bar").toBeLessThanOrEqual(53);
    // The phone's second bar row is the editor's claim on the left region
    // (CONTRACT "Shell": a page replaces the scope name with `<TopBarLeft>`).
    const pipelines = await page.request
      .get(`${BASE_URL}/api/v1/pipelines`)
      .then((r) => r.json())
      .then((b: { pipelines?: { id: string }[] }) => b.pipelines ?? []);
    if (pipelines.length > 0) {
      await gotoApp(page, `/factory/${pipelines[0].id}`);
      await expect(
        page.getByTestId("top-bar-phone-slot"),
        "the editor claims the phone strip",
      ).toBeVisible({
        timeout: 30_000,
      });
      await gotoApp(page, "/factory");
      await expect(page.getByTestId("top-bar-phone-slot")).toBeHidden();
    }

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByTestId("project-rail"), "768 is not a phone").toBeVisible();
    await expect(page.getByTestId("scope-open"), "768 has no scope trigger").toHaveCount(0);
    await expect(page.getByTestId("top-bar-phone-slot"), "768 has no phone strip").toHaveCount(0);
    const desktop = await measureFrame(page);
    expect(desktop.bar.height, "and the bar is the 60px one").toBeGreaterThanOrEqual(59);
    await checkShellScreen(page, "/factory at the 768px frame cut", strip);
    await evidence(
      page,
      "shell-p1-frame-cut-768",
      "the phone frame stops below 768px: 767 mounts no rail but the 52px bar with its scope trigger (the sheet opens, Escape closes it and hands the caret back to scope-open), 768 mounts the 64px rail and the 60px bar with no scope trigger",
    );
  });

  // The rail's tiles are the hover label's replacement: CONTRACT draws them as
  // 38px initials with native `title` tooltips, and the words they hide are the
  // tile's accessible name. The ⌘\ chord is retired with the column — so the
  // honest claim is that it now changes NOTHING (no panel, no preference write).
  test("the rail names every project, and the retired ⌘\\ chord changes nothing", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await gotoApp(page, "/");
    const stopWatching = watchPageErrors(page);
    const projects = await apiProjects(page.request);
    expect(projects.length, "the lab seeds at least one project").toBeGreaterThan(0);
    const before = await apiPreferences(page.request);

    await expect(page.getByTestId("rail-tile-all")).toHaveAttribute("title", "All projects");
    await expect(page.getByTestId("rail-tile-all")).toHaveAttribute("aria-label", "All projects");
    for (const project of projects.slice(0, 6)) {
      const tile = page.getByTestId(`rail-tile-${project.id}`);
      await expect(
        tile,
        `the tile for "${project.name}" carries its name as the hover label`,
      ).toHaveAttribute("title", project.name);
      await expect(tile).toHaveAttribute("aria-label", project.name);
    }
    await expect(page.getByTestId("rail-manage")).toHaveAttribute("aria-label", "Manage");
    await expect(page.getByTestId("rail-add-project")).toHaveAttribute("aria-label", "Add project");
    // The rail is 64px, so the words cannot print on the tile — that is the
    // design, and the tooltip is the label. The tile shows its two letters.
    const all = page.getByTestId("rail-tile-all");
    expect((await all.innerText()).trim(), "All").toBe("All");

    // The retired chord: pressed at every width the shell draws, it opens no
    // panel and PATCHes no preference.
    for (const width of [1500, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.keyboard.press("Meta+\\");
      await page.keyboard.press("Control+\\");
      await expect(page.getByTestId("scope-sheet")).toHaveCount(0);
      await expect(page.locator('[data-testid^="sidebar"]')).toHaveCount(0);
      await expect(page.getByTestId("project-rail")).toBeVisible();
    }
    const after = await apiPreferences(page.request);
    expect(after.layout, "the ⌘\\ chord owns nothing: the document is unchanged").toEqual(
      before.layout,
    );
    await page.setViewportSize({ width: 1500, height: 950 });
    await checkShellScreen(page, "rail labels", stopWatching);
    await evidence(
      page,
      "shell-p1-rail-labels",
      `every rail tile carries its project's name as title + aria-label (All projects, ${projects
        .slice(0, 6)
        .map((p) => p.name)
        .join(
          ", ",
        )}), the tiles print only their initials in the 64px rail, and the retired ⌘\\ chord at 1500px and 900px opens nothing and PATCHes nothing`,
    );
  });

  // Acceptance T4's successor: the design canvas is 1440×900 and the acceptance
  // line there is the FRAME. The shared page band is gone on the redesigned
  // pages (each one scrolls itself inside the shell), so the ruler this suite
  // holds is CONTRACT's own numbers: a 64px rail, a 60px bar, and one content
  // corner — the same on every route, so nothing steps sideways between places.
  test("at 1440x900 the rail, the bar and the content corner do not move between routes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    await page.setViewportSize({ width: 1440, height: 900 });
    const project = (await apiProjects(page.request))[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();
    const stopWatching = watchPageErrors(page);
    const measured: { route: string; rail: number; bar: number; x: number; y: number }[] = [];
    for (const route of ["/", `/p/${project.id}`, "/chats", "/factory", "/manage/projects"]) {
      await gotoApp(page, route);
      const frame = await measureFrame(page);
      measured.push({
        route,
        rail: railWidth(frame),
        bar: frame.bar.height,
        x: frame.content.x,
        y: frame.content.y,
      });
      await expect(
        page.getByTestId("top-bar-context"),
        `${route}: the bar owns one left region`,
      ).toBeVisible();
      expect(
        await page.getByTestId("page-band").count(),
        `${route}: the redesigned pages draw no shared title band (the bar is the frame)`,
      ).toBeLessThanOrEqual(1);
      await noSidewaysScrollInShell(page);
    }
    const [first, ...rest] = measured;
    for (const row of rest) {
      for (const key of ["rail", "bar", "x", "y"] as const) {
        expect(
          Math.abs(row[key] - first[key]),
          `${first.route} ${key}=${first[key]} vs ${row.route} ${key}=${row[key]}: one frame at 1440x900 (±1px)`,
        ).toBeLessThanOrEqual(1);
      }
    }
    expect(first.rail, `the rail is the 64px column CONTRACT draws (measured ${first.rail})`).toBe(
      64,
    );
    expect(first.bar, `the bar is the 60px band CONTRACT draws (measured ${first.bar})`).toBe(60);
    await checkShellScreen(page, "the five routes measured at 1440x900", stopWatching);
    await evidence(
      page,
      "shell-p1-frame-ruler-1440",
      `the shell frame is one geometry at 1440x900 across /, /p/<id>, /chats, /factory and /manage/projects (rail ${first.rail}px, bar ${first.bar}px, content corner ${first.x}/${first.y}, every route within 1px of the first): ${measured
        .map((m) => `${m.route}@${m.rail}/${m.bar}/${m.x}/${m.y}`)
        .join(" ")}`,
    );
  });

  // The rail's Projects popover is gone (a tile is a link, never a menu); the
  // scope's keyboard surface is the phone's sheet. It is a real dialog: the
  // caret lands on it, Tab reaches its rows, Enter navigates, and Escape hands
  // the caret back to the button the sheet came from.
  test("the scope sheet walks on Tab, navigates on Enter, and gives the caret back on Escape", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const projects = await apiProjects(page.request);
    const project = projects[0];
    expect(project, "the lab seeds at least one project").toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoApp(page, "/");
    const stopWatching = watchPageErrors(page);
    await page.getByTestId("scope-open").focus();
    expect(await caretOn(page)).toBe("[scope-open]");
    await page.keyboard.press("Enter");
    const sheet = page.getByTestId("scope-sheet");
    await expect(sheet, "Enter on the scope button opens the sheet").toBeVisible();
    await expect(sheet).toHaveAttribute("role", "dialog");
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect
      .poll(() => caretOn(page), { message: "the caret lands inside the sheet" })
      .toBe("[scope-sheet]");
    // Escape closes it and hands the caret back to the button it came from.
    await page.keyboard.press("Escape");
    await expect(sheet, "Escape closes the sheet").toBeHidden();
    await expect
      .poll(() => caretOn(page), { message: "Escape hands the caret back to scope-open" })
      .toBe("[scope-open]");
    // Re-open on Enter and walk: the sheet's rows are real links in DOM order
    // (a row is `scope-row-<projectId>`; the all-scope row is `scope-row-all`).
    await page.keyboard.press("Enter");
    await expect(sheet, "Enter opens the sheet again").toBeVisible();
    await expect
      .poll(() => caretOn(page), { message: "the caret lands inside the reopened sheet" })
      .toBe("[scope-sheet]");
    let hops = 0;
    const targetRow = `[scope-row-${project.id}]`;
    for (;;) {
      const active = await caretOn(page);
      if (active === targetRow) break;
      expect(
        hops++ < 12,
        `the caret reached "${project.name}" within the sheet's rows (stopped on [${active}], ${hops} presses in)`,
      ).toBe(true);
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(
      page,
      `Enter activates the focused row — the sheet's "${project.name}" row must open /p/${project.id}`,
    ).toHaveURL(new URL(`/p/${project.id}`, BASE_URL).href, { timeout: 15_000 });
    await expect(sheet, "choosing a row also closes the sheet").toBeHidden();
    stopWatching();
    await evidence(
      page,
      "shell-p1-scope-keys",
      "the phone scope sheet is a keyboard surface: Enter opens it, the caret lands inside it, Tab walks its rows, Enter on a project row navigates to /p/<id>, choosing a row closes it, and Escape closes it and returns the caret to scope-open (the rail's Projects popover is retired with the rail)",
    );
  });

  test.describe("narrow 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the scope sheet opens from the phone bar and esc closes it", async ({ page }) => {
      await signInNarrow(page, "admin"); // sheet left open by the helper
      const stopWatching = watchPageErrors(page);
      const sheet = page.getByTestId("scope-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("scope-row-all")).toBeVisible();
      await expect(sheet.getByTestId("scope-row-manage")).toBeVisible();
      await expect(sheet.getByTestId("scope-account").getByTestId("user-menu")).toBeVisible();
      await evidence(
        page,
        "shell-p1-sheet-open",
        "at 390x844 the top bar's scope button opens the scope sheet with the rail's rows and the account menu inside",
      );
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(
        page.getByTestId("scope-backdrop"),
        "the sheet took its backdrop with it",
      ).toHaveCount(0);
      // The other two doors out: the trigger again, then the backdrop.
      await page.getByTestId("scope-open").click();
      await expect(sheet).toBeVisible();
      await page.getByTestId("scope-backdrop").click({ position: { x: 350, y: 400 } });
      await expect(sheet).toBeHidden();
      // And the pill is icons only, with the words kept for a reader.
      await expect(page.getByTestId("pill-chats")).toHaveText("Chats");
      await expect(page.getByTestId("pill-chats").locator(".sr-only")).toBeVisible();
      await checkShellScreen(page, "home at phone width", stopWatching);
      await evidence(
        page,
        "shell-p1-sheet-esc",
        "at 390x844 Escape and the backdrop both close the scope sheet, the pill keeps its labels sr-only, and the page stays without sideways scroll",
      );
    });
  });

  // gh-3: a signed-out visitor sees the sign-in screen alone — no shell chrome
  // of any kind — for `/` and every deep link, at desktop and phone width; the
  // deep link rides along as `return_to` so a sign-in lands back on the page.
  test("signed-out visitors see only the sign-in screen — no rail, no top bar", async ({
    page,
  }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      for (const path of ["/", "/factory"]) {
        await gotoApp(page, path);
        const stopWatching = watchPageErrors(page);
        const signIn = page.getByTestId("sign-in");
        await expect(signIn).toBeVisible();
        // No shell element at all — the chrome must not mount.
        await expect(page.getByTestId("project-rail")).toHaveCount(0);
        await expect(page.getByTestId("top-bar")).toHaveCount(0);
        await expect(page.getByTestId("sidebar"), "no leftover column").toHaveCount(0);
        const expectedHref =
          path === "/" ? "/auth/login?return_to=%2F" : "/auth/login?return_to=%2Ffactory";
        await expect(signIn).toHaveAttribute("href", expectedHref);
        await checkShellScreen(page, `signed-out ${path}`, stopWatching);
        await evidence(
          page,
          "shell-p1-signed-out",
          `signed-out ${path} renders the sign-in screen only — no rail, no top bar, no app chrome`,
        );
      }
    }
  });
});
