// M5 layout arm of the exit suite: a regression gate for the class of bug
// browser QA found on the run page header at 390px (fixed in e609b00 — "header
// and digests fit 390px", which was proved by hand and is now proved by a test).
//
// It runs against the M4 lab by env override only, exactly like m5-journey and
// m5-inbox — no second compose project:
//   COMMUNICATION_E2E_M5=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/m5-layout.spec.ts --reporter=line
// The lab's identities come from docs/compatibility/probes/m4/seed.sh: alice is
// maintainer of `m4-exit` (so she sees the project, its runs list, a run, its
// conversations), admin is org admin with the library role (so /workflows, one
// pipeline page, /profiles and /ops render their authoring surfaces rather than
// their read-only fallbacks — the controls are where overflow lives).
//
// WHAT IT CLAIMS, exactly: for each screen the brief names, at 390x844 (phone)
// and 1500x950 (desktop), the viewer's session really is signed in, the page
// that answered is the screen under test, the *document* does not scroll
// sideways (`documentElement.scrollWidth <= window.innerWidth`), the page left
// its loading state (no `Spinner` — `ui/src/components/Feedback.tsx` renders
// "· <label>…" — still reading), and the browser logged no console error and no
// uncaught exception. It claims nothing about visual quality, tap targets, or
// whether content inside an explicitly scrollable box (`overflow-x: auto`) is
// reachable: a panel that scrolls itself is the design's answer to a narrow
// screen, not a bug. A table that pushes the *page* sideways is.
//
// HOW SIGN-IN IS PROVED AT EVERY WIDTH: `GET /api/v1/me` through the page's own
// request context (which shares the browser's cookie jar) returns 200 with the
// expected `display_name`/`email`, and the URL is still the path that was asked
// for rather than an `/auth/…` redirect. The sidebar-footer name
// (`user-badge`) is NOT that proof at phone width: the badge lives in the
// sidebar footer, and below the `md:` breakpoint the sidebar is the drawer
// behind the phone top strip's menu button, so a hidden badge there means
// "narrow screen", not "signed out". The badge is therefore only asserted at
// desktop width, where the sidebar rail is designed to be visible.
//
// ONE TEST PER SCREEN × VIEWPORT, no serial mode and no shared page: a failing
// screen reports itself and stops nothing, so the run says which screens are
// narrow-screen-safe instead of stopping at the first. Each test gets its own
// signed-in context; only the ids read off served pages are shared (worker
// scope, read-only, and a failure there is reported per test rather than
// skipping the arm).
//
// NO HARD-CODED UUIDS: every id is read off the served page the way the other
// specs do — a project by slug, the first run row's `data-testid`, the first
// pipeline name button, the first conversation row (creating one through the
// project's own form, with no first prompt, only if the lab has none).
//
// Skipped unless COMMUNICATION_E2E_M5=1, so CI is unaffected. Every wait is
// bounded, and a failure names the widest element on the page (the DOM is
// walked for the largest right edge that is not inside its own scroller), so
// the report says what overflowed rather than that something did.
import {
  test as base,
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { BASE_URL } from "./env.js";
import { expectNoLegacyAppBar, gotoApp, openProjectBySlug, shot, signIn } from "./helpers.js";

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

/** The lab project alice is maintainer of (seed.sh `M4_SEED_PROJECT_SLUG`). */
const PROJECT_SLUG = process.env.E2E_M5_LAYOUT_PROJECT_SLUG ?? "m4-exit";

/** A section that never stops spinning is a failure, not a wait. */
const LOADED_TIMEOUT_MS = Number(process.env.E2E_M5_LAYOUT_LOADED_TIMEOUT_MS ?? 60_000);

/** How long the lab gets to come up before the arm says it is not there. */
const READINESS_TIMEOUT_MS = Number(process.env.E2E_M5_LAYOUT_READY_TIMEOUT_MS ?? 120_000);

/** Layout settles after web fonts and the first data paint; this is not a wait
 * for server state, so it stays small and fixed. */
const SETTLE_MS = Number(process.env.E2E_M5_LAYOUT_SETTLE_MS ?? 750);

/** Each test signs its own session in and measures one screen at one width. */
const TEST_TIMEOUT_MS = Number(
  process.env.E2E_M5_LAYOUT_TEST_TIMEOUT_MS ?? LOADED_TIMEOUT_MS + 60_000,
);

/** The Tailwind `md:` width from which the sidebar (and its footer's
 * signed-in name) is rendered as the fixed rail instead of the drawer. */
const BADGE_MIN_WIDTH = 768;

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "1500x950", width: 1500, height: 950 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

/** Which signed-in member is meant to see a screen (see the header comment). */
type Viewer = "alice" | "admin";

/** Ids discovered from served pages; never seeded into this file. */
interface Lab {
  projectPath: string; // /p/{m4-exit id}
  runPath: string; // /runs/{run id}
  pipelinePath: string; // /workflows/{pipeline id}
  conversationPath: string; // /threads/{conversation id}
}

interface Screen {
  label: string;
  viewer: Viewer;
  /** Resolved after the discovery fixture read the ids off the served pages. */
  path: (lab: Lab) => string;
  /** Which served element proves this screen rendered for this viewer. */
  anchor: string;
  /** Why this screen is on the list — printed into the failure message. */
  why: string;
}

/** One screen at one viewport: what the document measured and what it logged. */
interface FitReport {
  scrollWidth: number;
  innerWidth: number;
  clientWidth: number;
  widest: string[];
}

const screens: Screen[] = [
  {
    label: "/inbox",
    viewer: "alice",
    path: () => "/inbox",
    anchor: "inbox-greeting",
    why: "the landing screen",
  },
  {
    label: "/projects",
    viewer: "alice",
    path: () => "/projects",
    anchor: "projects-heading",
    why: "the project list",
  },
  {
    label: "project overview",
    viewer: "alice",
    path: (lab) => lab.projectPath,
    anchor: "project-name",
    why: "attention, recent runs, repos, members and conversations on one page",
  },
  {
    label: "runs list",
    viewer: "alice",
    path: (lab) => `${lab.projectPath}/runs`,
    anchor: "project-runs",
    why: "one row per run, with digests and elapsed times",
  },
  {
    label: "run page",
    viewer: "alice",
    path: (lab) => lab.runPath,
    anchor: "workbench",
    why: "the screen QA found overflowing at 390px (e609b00), now the graph-first Run Workbench",
  },
  {
    label: "/workflows",
    viewer: "admin",
    path: () => "/workflows",
    anchor: "library-page",
    why: "the org pipeline library",
  },
  {
    label: "pipeline page",
    viewer: "admin",
    path: (lab) => lab.pipelinePath,
    anchor: "pipeline-page",
    why: "revisions, drafts and the definition graph",
  },
  {
    label: "/profiles",
    viewer: "admin",
    path: () => "/profiles",
    anchor: "agents-page",
    why: "the agent profile table",
  },
  {
    label: "/ops",
    viewer: "admin",
    path: () => "/ops",
    anchor: "ops-resource-limits",
    why: "scheduler and worker tables",
  },
  {
    label: "conversation page",
    viewer: "alice",
    path: (lab) => lab.conversationPath,
    anchor: "conversation-title",
    why: "transcript, composer and session meta",
  },
];

/** Opens a page that is signed in as `viewer` and laid out at `viewport`. */
type OpenViewer = (viewer: Viewer, viewport: Viewport) => Promise<Page>;

type ViewerFixtures = { openViewer: OpenViewer };
type LabFixtures = { lab: Lab };

const test = base.extend<ViewerFixtures, LabFixtures>({
  // Test scope: every test gets its own browser context, so a screen that
  // crashes the page or trips its own timeout cannot leave the next screen
  // looking at a dead document — that is what made the old serial chain skip
  // nine screens after one failed.
  openViewer: async ({ browser }, use) => {
    const opened: Page[] = [];
    await use(async (viewer, viewport) => {
      const page = await newSignedInPage(browser, viewer);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      opened.push(page);
      return page;
    });
    for (const page of opened) {
      await page
        .context()
        .close()
        .catch(() => {});
    }
  },
  // Worker scope: read-only facts about the lab (which ids exist), read once
  // per worker by its own signed-in pages, which are then closed.
  lab: [
    async ({ browser, playwright }, use) => {
      const request = await playwright.request.newContext();
      try {
        await use(await discoverLab(browser, request));
      } finally {
        await request.dispose().catch(() => {});
      }
    },
    { scope: "worker" },
  ],
});

test.describe.configure({ timeout: TEST_TIMEOUT_MS });

test.describe("M5 layout: no horizontal page scroll on the main screens", () => {
  test.skip(!M5_ENABLED, "Needs the M4 lab stack (port 18091) — run with COMMUNICATION_E2E_M5=1");

  // One test per screen at one viewport: independent, non-serial, soft within
  // itself (an overflow and the console errors it caused are both reported).
  for (const screen of screens) {
    for (const viewport of VIEWPORTS) {
      test(`${screen.label} fits at ${viewport.name} as ${screen.viewer}`, async ({
        openViewer,
        lab,
      }) => {
        const page = await openViewer(screen.viewer, viewport);
        await checkScreen(page, screen, viewport, lab);
      });
    }
  }
});

/**
 * A fresh context, signed in through the mock IdP at desktop size, with the
 * console ledger attached before the first navigation. The caller resizes it;
 * sign-in itself is proved by the API, not by the responsive sidebar.
 */
async function newSignedInPage(browser: Browser, viewer: Viewer): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  attach(page);
  // The seed's claim shape exactly, as m5-inbox does it: only an `email`
  // claim, so the display name stays the bare subject.
  await signIn(page, viewer, { email: `${viewer}@example.test` });
  await expectSignedIn(page, viewer, `${viewer} after sign-in`);
  return page;
}

/**
 * The width-independent sign-in proof: the session cookie the page carries is
 * accepted by the API for the member this screen is meant to be (`GET
 * /api/v1/me` is 401 for a signed-out browser — `ui/src/components/
 * RequireAuth.tsx`), and the body names them. Only the two claims this arm
 * depends on are read out of the body: `csrf_token` is a session secret and is
 * never printed.
 */
async function expectSignedIn(page: Page, viewer: Viewer, where: string): Promise<void> {
  const response = await page.request.get(`${BASE_URL}/api/v1/me`);
  expect(
    response.status(),
    `${where}: GET /api/v1/me returned ${response.status()} — 401 means the app is not signed in`,
  ).toBe(200);
  const me = (await response.json()) as {
    display_name?: string;
    email?: string | null;
    is_org_admin?: boolean;
  };
  expect(me.display_name, `${where}: signed in as ${JSON.stringify(me.display_name)}`).toBe(viewer);
  expect(me.email, `${where}: unexpected email claim`).toBe(`${viewer}@example.test`);
  if (viewer === "admin") {
    // /workflows, the pipeline page, /profiles and /ops are on this list because
    // admin's role makes their authoring controls render; that fact is part of
    // the sign-in proof, not an assumption about the page.
    expect(me.is_org_admin, `${where}: admin does not hold the organization admin role`).toBe(true);
  }
}

/**
 * One screen, one viewport: the page is already signed in as its intended
 * viewer (see `newSignedInPage`); navigate to the screen, prove the document
 * that answered is that screen and that the session is still the expected one,
 * wait for it to leave its loading state, then measure it and report anything
 * the browser logged.
 */
async function checkScreen(
  page: Page,
  screen: Screen,
  viewport: Viewport,
  lab: Lab,
): Promise<void> {
  const path = screen.path(lab);
  expect(path, `the ${screen.label} path was never discovered`).toMatch(/^\//);
  await gotoApp(page, path);
  await page.waitForLoadState("load").catch(() => {});
  // The ledger starts at this screen's own document: an error logged while the
  // sign-in redirect chain was being torn down is not this screen's finding.
  // Everything caught after this point is quoted verbatim.
  const logged = ledgerFor(page);
  logged.length = 0;

  const where = `${screen.viewer}@${viewport.name} ${path}`;
  // Width-independent: the session is live and the router did not bounce to
  // /auth/… — the failure the old badge-based check reported for a page that
  // was signed in and merely too narrow to show the name.
  await expectSignedIn(page, screen.viewer, where);
  expect(new URL(page.url()).pathname, `${where}: landed somewhere else`).toBe(path);
  // The old top app bar's `aria-label="Primary"` header/nav is gone — Sidebar
  // v3 replaced it (regression gate for the app-shell redesign).
  await expectNoLegacyAppBar(page);
  if (viewport.width >= BADGE_MIN_WIDTH) {
    await expect(
      page.getByTestId("user-badge"),
      `${where}: the sidebar footer hides the signed-in name at a width that shows it`,
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByTestId(screen.anchor), `${where}: never rendered`).toBeVisible({
    timeout: 30_000,
  });

  await expect
    .poll(() => pendingSpinners(page), { timeout: LOADED_TIMEOUT_MS, intervals: [500] })
    .toEqual([]);
  // Layout is not final until the fonts are in and the last section has painted.
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  const fit = await measureDocument(page);
  const overflowing = fit.scrollWidth > fit.innerWidth;
  expect
    .soft(
      overflowing,
      `${where} (${screen.why}): the DOCUMENT scrolls sideways — ` +
        `documentElement.scrollWidth ${fit.scrollWidth}px > window.innerWidth ${fit.innerWidth}px ` +
        `(clientWidth ${fit.clientWidth}px). Widest elements past the viewport edge, outermost ` +
        `right first: ${fit.widest.join(" | ") || "none — the overflow belongs to <html>/<body> itself"}. ` +
        `Elements inside their own scrollable box are excluded: those scroll by design.`,
    )
    .toBe(false);
  expect
    .soft(
      logged,
      `${where}: the browser logged ${logged.length} console error(s) / uncaught exception(s):\n` +
        logged.join("\n"),
    )
    .toEqual([]);
  if (overflowing || logged.length > 0) {
    const file = await shot(page, `m5-layout-${viewport.name}-${slugOf(screen.label)}`);
    // The screenshot is evidence, not a build artifact: .playwright-cli/ is
    // gitignored, and the path is printed so a human can open it.
    // eslint-disable-next-line no-console
    console.log(`[m5-layout] evidence for ${where}: ${file}`);
  }
}

/**
 * Read every id the screens need off the served pages, with two throwaway
 * signed-in sessions that are closed as soon as the ids are known. A failure
 * here is a broken lab, not a broken layout, and it is reported as a setup
 * error on each test rather than as a skipped arm.
 */
async function discoverLab(browser: Browser, request: APIRequestContext): Promise<Lab> {
  const lab: Lab = { projectPath: "", runPath: "", pipelinePath: "", conversationPath: "" };
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${BASE_URL}/api/v1/system/readiness`)).ok();
        } catch {
          return false;
        }
      },
      {
        timeout: READINESS_TIMEOUT_MS,
        intervals: [2_000],
        message: "the lab never answers readiness",
      },
    )
    .toBe(true);

  const alice = await newSignedInPage(browser, "alice");
  const admin = await newSignedInPage(browser, "admin");
  try {
    // The project, read from the list by slug (route contract C1: `/p/:id`).
    lab.projectPath = await openProjectBySlug(alice, PROJECT_SLUG);
    expect(lab.projectPath).toMatch(/^\/p\/[0-9a-f-]{36}$/);

    // One run, named by the runs list's own row id.
    await gotoApp(alice, `${lab.projectPath}/runs`);
    await expect(alice.getByTestId("project-runs")).toBeVisible({ timeout: 30_000 });
    const row = alice.locator('[data-testid^="run-row-"]').first();
    await expect(row, "the lab's runs list has no run row").toBeVisible({
      timeout: LOADED_TIMEOUT_MS,
    });
    const testid = await row.getAttribute("data-testid");
    const runId = (testid ?? "").slice("run-row-".length);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    // Route contract C1: the workbench deep link is the project-less
    // `/runs/:runId` (the old `/projects/:id/runs/:runId` URL redirects).
    lab.runPath = `/runs/${runId}`;

    // One pipeline, opened from the workflows list by clicking its row —
    // the new /workflows row (WorkflowRow) exposes the pipeline link to
    // `/workflows/:id`, not the old `pipeline-name-*` button.
    await gotoApp(admin, "/workflows");
    await expect(admin.getByTestId("library-page")).toBeVisible({ timeout: 30_000 });
    const wfRow = admin
      .getByTestId("workflows-list")
      .locator('a[href^="/workflows/"]')
      .first();
    await expect(wfRow, "the lab's workflows list has no pipeline row").toBeVisible({
      timeout: LOADED_TIMEOUT_MS,
    });
    await wfRow.click();
    await admin.waitForURL(/\/workflows\/[0-9a-f-]{36}/, { timeout: 30_000 });
    lab.pipelinePath = new URL(admin.url()).pathname;
    expect(lab.pipelinePath).toMatch(/^\/workflows\/[0-9a-f-]{36}$/);

    // One conversation, or the product's own create-with-no-prompt.
    lab.conversationPath = await firstConversationPath(alice, lab.projectPath);
    // Route contract C1: the standalone thread page is `/threads/:id`.
    expect(lab.conversationPath).toMatch(/^\/threads\/[0-9a-f-]{36}$/);
  } finally {
    for (const page of [alice, admin]) {
      await page
        .context()
        .close()
        .catch(() => {});
    }
  }
  return lab;
}

/** Messages the browser reported for a page, collected per page. */
const ledgers = new WeakMap<Page, string[]>();

/** Attach the listeners once per page; repeat calls return the existing ledger. */
function attach(page: Page): void {
  if (ledgers.has(page)) return;
  const logged: string[] = [];
  ledgers.set(page, logged);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    logged.push(`console.error: ${oneLine(message.text())}`);
  });
  page.on("pageerror", (error) => {
    logged.push(`uncaught: ${oneLine(error.stack ?? error.message)}`);
  });
}

/** The ledger for a page (attaching on first use). */
function ledgerFor(page: Page): string[] {
  attach(page);
  return ledgers.get(page) as string[];
}

/**
 * Spinner labels still on the page. `ui/src/components/Feedback.tsx` renders
 * every one as `· <label>…` inside a `role="status"` paragraph, which is the
 * "· Loading…" the brief names; `Reading your projects` (Inbox) and
 * `Checking readiness` (Operations) are the same state in other words, so the
 * gate covers the whole Spinner vocabulary rather than one verb.
 */
function pendingSpinners(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="status"]'))
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((text) => /^·\s+(Loading|Reading|Checking|Resolving)\b/i.test(text)),
  );
}

/**
 * Walk the rendered tree for what sticks out past the viewport, so a failure
 * names the element instead of a pixel count. An element is NOT reported when
 * an ancestor scrolls it (`overflow-x`/`overflow-y` auto, scroll or hidden):
 * such a box is clipped or panned by its own container and contributes nothing
 * to `documentElement.scrollWidth` — that is the design's answer to a narrow
 * screen. Positions are printed too, because a `fixed` element can be wide
 * without ever moving the document's scroll width; the assertion is always
 * `scrollWidth <= innerWidth`, and this walk is the diagnosis that comes with it.
 */
function measureDocument(page: Page): Promise<FitReport> {
  return page.evaluate(() => {
    const inner = window.innerWidth;
    const label = (el: Element, right: number): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const testid = el.getAttribute("data-testid");
      const classes = Array.from(el.classList)
        .slice(0, 3)
        .map((name) => `.${name}`)
        .join("");
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const bits = [
        `<${tag}${id}${testid ? `[testid=${testid}]` : ""}${classes}>`,
        `right ${Math.round(right)}px`,
        `w ${Math.round(el.getBoundingClientRect().width)}px`,
        `pos ${window.getComputedStyle(el).position}`,
      ];
      return text ? `${bits.join(" ")} "${text}"` : bits.join(" ");
    };
    const inOwnScroller = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = window.getComputedStyle(p);
        if (["auto", "scroll", "hidden"].includes(style.overflowX)) return true;
        if (["auto", "scroll", "hidden"].includes(style.overflowY)) return true;
      }
      return false;
    };
    const hits: Array<{ right: number; sel: string }> = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= inner + 0.5) continue;
      if (inOwnScroller(el)) continue;
      hits.push({ right: box.right, sel: label(el, box.right) });
    }
    hits.sort((a, b) => b.right - a.right);
    const widest: string[] = [];
    for (const hit of hits) {
      if (widest.length >= 5) break;
      if (!widest.includes(hit.sel)) widest.push(hit.sel);
    }
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      innerWidth: inner,
      clientWidth: doc.clientWidth,
      widest,
    };
  });
}

/**
 * A conversation to open, found the way a user finds one: the project page's own
 * CONVERSATIONS rows. Only when the lab has none does this arm create one, and
 * it creates it with no first prompt — the route makes `prompt` optional
 * (`api/openapi.yaml`, `ConversationCreate`), so nothing is queued, no worker
 * claims a turn, and the conversation page still renders its transcript,
 * composer and session meta, which is what this arm measures.
 */
async function firstConversationPath(page: Page, projectPath: string): Promise<string> {
  await gotoApp(page, projectPath);
  const rows = page.locator('[data-testid^="conversation-row-"]');
  await expect(
    page.getByTestId("conversation-list").or(page.getByTestId("conversation-list-empty")).first(),
  ).toBeVisible({ timeout: LOADED_TIMEOUT_MS });
  if ((await rows.count()) > 0) {
    await rows.first().click();
    // The row's anchor is the standalone thread page (route contract C1).
    await page.waitForURL(/\/threads\/[0-9a-f-]{36}/, { timeout: 30_000 });
    return new URL(page.url()).pathname;
  }
  // The create form lives in a dialog; open it before the fields exist.
  await page.getByTestId("conversations-new-open").click();
  await page.getByTestId("new-conversation-dialog").waitFor();
  await page.getByTestId("conversation-new-title").fill(`m5-layout-${STAMP}`);
  await pickFirstOption(page, "conversation-new-profile");
  await page.getByTestId("conversation-new-submit").click();
  await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return new URL(page.url()).pathname;
}

/** Select the first real option of a `<select>` — the lab's data, not a name. */
async function pickFirstOption(page: Page, testid: string): Promise<void> {
  const select = page.getByTestId(testid);
  const value = await select.locator("option").evaluateAll((options) => {
    const first = options.find(
      (option) => option instanceof HTMLOptionElement && option.value !== "",
    );
    return first instanceof HTMLOptionElement ? first.value : "";
  });
  expect(value, `${testid} offers no option — the lab has no agent profiles?`).not.toBe("");
  await select.selectOption(value);
}

/** Collapse a browser message to one line so a failure stays readable. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

/** Make a screen label safe to use as a filename. */
function slugOf(label: string): string {
  return (
    label
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "root"
  );
}

/** Distinguishes a created conversation between runs of this arm. */
const STAMP =
  process.env.E2E_M5_LAYOUT_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
