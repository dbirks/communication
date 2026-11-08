// Journey: the redesign's Catch up screens (boards 8a / 8b / 7b), the icon
// rail (3a/4a) and Today's floating Ask.
//
// `catchup-lab.spec.ts` (e2e/tests, the lab-e2e job) already proves the tour
// END TO END — a real finished run, the assistant's real generator, a real
// agent answering a decision. This journey's job is different: play the
// SCREENS the way a reader does, capture them at 1280 and 390 against the
// harness's landmarks, and file defects when they are wrong. That is why the
// rows here are SEEDED and say so: the generator writes a tour only after a
// real run AND a model call, and the verification lab may not have done
// either when this pass runs — a screen check must not hinge on a model
// agreeing to write a particular story. The seed follows
// `catchup-lab.spec.ts` leg 4 exactly: the store's own rows and document
// shape through the stack's postgres, because ADR-0078 § Decision 7 gives the
// product no route that writes a tour. Never seeded here: GitHub tokens,
// secrets, anything the reply route would post to a real conversation — the
// decision item's `conversation_id` is NULL ON PURPOSE, so the honest dead
// end ("nobody was notified") is the state the click must show.
//
// Alice plays everything: the lab's org admin holds no project membership
// (setup.spec.ts' header) and every catch-up read is project-scoped. The
// seeded rows land in the lab's seeded project, `m4-exit`.
//
// What the journey asserts beyond the screens (like its neighbours, a failed
// check FAILS the journey and the fixture records it as kind=assertion):
//   - the player's `Next stop ›` marks the stop you LEAVE seen (the store's
//     own seen read via GET /catch-up/items/{id}, not a pixel);
//   - clicking a decision option on the no-conversation item shows
//     `catchup-decision-status` in its "nobody was notified" state;
//   - `mark all seen` empties the rest list;
//   - the rail: collapse through the UI's own button (and restore it), the
//     hover label, the Projects popover closing on Esc, and the rail FORCED
//     (no drawer) at 900px;
//   - Today: the floating Ask sits bottom-right at 1280 and at 390, ⌘J opens
//     the assistant popover and ⌘K opens the palette.
//
// The rail ids (`sidebar-rail`, `rail-item-*`, `rail-tooltip`,
// `rail-projects-popover`) are read off ui/src/components/Sidebar.tsx — the
// rail rebuild landed them (4879199); repo-chat-nav.spec.ts already drives
// the same surface, so these checks are real, not guarded skips.
//
// Seeds resolve-or-create on their pass-stamped titles: Playwright restarts
// the worker after a serial-group failure, and the fresh process must reuse
// the dead one's rows, never double-seed them.
import { execDocker } from "../tests/helpers.js";
import { sqlQuote } from "../tests/lab-launcher.js";
import { expect, test } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

/** The lab's seeded project (docs/compatibility/probes/m4/seed.sh). */
const PROJECT_SLUG = "m4-exit";

/**
 * The lab's ONE DOOR for rows the product has no route for is
 * e2e/tests/lab-launcher.ts's exported `seedSql` — but its compose
 * coordinates (`E2E_COMPOSE_PROJECT`/`E2E_COMPOSE_FILES`, e2e/tests/env.js)
 * default to the isolated CI e2e stack, and the emulator loop drives the
 * `communication-m4` lab scripts/lab-up.sh brings up (compose.yml +
 * compose.harness.yml + compose.m4.yml + compose.real.yml). Same door, same
 * `psql -tAqc` contract, the LAB's coordinates — and an exported knob still
 * wins, exactly like seedSql honours it.
 */
function labSql(sql: string): string {
  const project = process.env.E2E_COMPOSE_PROJECT ?? "communication-m4";
  const files = (
    process.env.E2E_COMPOSE_FILES ??
    "compose.yml,compose.harness.yml,compose.m4.yml,compose.real.yml"
  )
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  const args = ["compose", "-p", project];
  for (const file of files) args.push("-f", file);
  args.push(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "communication",
    "-d",
    "communication",
    "-tAqc",
    sql,
  );
  return execDocker(args)
    .toString("utf8")
    .trim();
}

/* ------------------------------------------------------------ the fixture
 * The stop document is the store's own shape (internal/domain/catchup.go:
 * CatchUpStop; `catchup_tour_versions.stops` jsonb), the same document
 * `catchup-lab.spec.ts` leg 4 seeds for its decision beat. `importance` is
 * the server's closed vocabulary (must_know / worth_a_look / routine); the
 * log/files evidence payloads are the shape internal/assistant/catchup_gen.go
 * stamps (a `source` plus the excerpt), and ui/src/components/catchup/
 * Evidence.tsx draws them as the dark log block and the mono file list.
 */
const BUG_TITLE = `Emu catch-up bug ${EMU_PASS_ID}: the cart timer skipped empty carts`;
const PR_TITLE = `Emu catch-up UI ${EMU_PASS_ID}: roomier rows in the run list`;
const PUSH_TITLE = `Emu catch-up push ${EMU_PASS_ID}: lockfile bumps for three patches`;
const RECAP_PREFIX = `Emu catch-up recap ${EMU_PASS_ID}`;

/** A 40-hex commit claim that is NOT one of the design mocks' invented ids
 * (mockdata.ts: a7f310, 9c1e04, e02b9a, …) — this is seeded lab data, served
 * by the API, and the no-made-up-data screen check must never confuse it. */
const COMMIT_SHA = "b6e1c04e7d2a4f8193567ab89cdef0123456789a";
// Issue/PR claims: the mocks' #131/#138/#142 are MOCK_DATA; 900+ is not.
const ISSUE_NUMBER = 907;
const PR_NUMBER = 908;

const STOP_ID = (key: string): string => `emu-${EMU_PASS_ID}-${key}`;

/** One stop, exactly as `decodeCatchUpStops` reads it back. */
function stop(key: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { id: STOP_ID(key), added_in_version: 1, ...fields };
}

/** The bug story: four beats, FOUND → CAUSE → FIXED → FOLLOW-UP, must_know,
 * a log evidence and a files evidence. The titles carry the word "bug" so
 * TourPlayer's bug-story derivation (which reads kind+title, never invents
 * the chain) has true siblings to line up. */
const BUG_STOPS = [
  stop("found", {
    kind: "FOUND",
    title: "Bug found: the cart timer never ran on an empty cart",
    narrative:
      "The seeded fixture story: QA saw the cart summary freeze on an empty cart. The timer that refreshes it never armed, so the panel held its last paint.\nIn production this beat is the assistant's own summary of a finished run — see e2e/tests/catchup-lab.spec.ts for that story being written for real.",
    importance: "must_know",
  }),
  stop("cause", {
    kind: "CAUSE",
    title: "Bug cause: the guard returned before the timer armed",
    narrative:
      "The refresh loop bailed out when the cart had no items, before the arming call. A one-line ordering mistake, invisible until an empty cart lingered long enough.\nThe log block below is what the evidence frame shows — a server-copied excerpt, not a screenshot.",
    importance: "must_know",
    evidence: [
      {
        type: "log",
        source: "run",
        text: "cart refresh: items=0 — returning before arm()\nsummary panel: last paint held for 312s",
      },
    ],
  }),
  stop("fixed", {
    kind: "FIXED",
    title: "Bug fixed: arm first, then guard",
    narrative:
      "The fix moves the guard after the arming call and covers the empty-cart path in the table test. It merged through the pass's pinned pipeline.\nThe file list is the second evidence kind the screen must draw honestly.",
    importance: "must_know",
    evidence: [
      {
        type: "files",
        source: "workspace",
        files: ["internal/cart/timer.go", "internal/cart/timer_test.go"],
      },
    ],
  }),
  stop("followup", {
    kind: "FOLLOW-UP",
    title: "Bug follow-up: a soak test for the lingering cart",
    narrative:
      "The run queued one follow-up: leave a cart empty for five minutes in the soak suite, so the guard-order class of bug cannot come back quietly.",
    importance: "must_know",
  }),
];

/** The UI change: worth_a_look, and the decision the generator is NOT
 * trusted to write — allow_text false, two options, NO conversation behind
 * it, which is the state whose honest copy this journey pins. */
const PR_STOPS = [
  stop("ui-call", {
    kind: "UI CHANGE",
    title: "UI change: roomier run rows, once you say so",
    narrative:
      "The branch widens the run list's rows and moves the status pill out of the title's way. It is ready to ship, but the change is a taste call the assistant will not make alone, so the beat asks.",
    importance: "worth_a_look",
    decision: {
      prompt: "Ship the roomier rows, or trim back to the current density?",
      options: ["Ship the roomier rows", "Trim back to current density"],
      allow_text: false,
    },
  }),
];

/** The routine push: nothing asks anything of you; it belongs to 'the rest'. */
const PUSH_STOPS = [
  stop("routine", {
    kind: "ROUTINE",
    title: "Routine: three dependency patches on the lockfile",
    narrative:
      "A maintenance push updated three direct dependencies to their patch releases. No behaviour change is claimed; the lockfile diff is the whole story.",
    importance: "routine",
  }),
];

/** A uuid as postgres prints it — the seed's proof a row landed. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid the seed stamps into every title, so passes never collide. */
const SEED_SUMMARY =
  `Seeded fixture for the emulator's Catch up screens (${EMU_PASS_ID}) — ` +
  "in production the assistant's own generator writes this row; see " +
  "e2e/tests/catchup-lab.spec.ts for that path proven live.";

function upsertItemSql(title: string, shape: string, resolution: string, refs: unknown): string {
  return (
    `INSERT INTO catchup_work_items (project_id, shape, title, summary, resolution, refs) ` +
    `SELECT (SELECT id FROM projects WHERE slug = ${sqlQuote(PROJECT_SLUG)}), ` +
    `${sqlQuote(shape)}, ${sqlQuote(title)}, ` +
    `${sqlQuote(SEED_SUMMARY)}, ` +
    `${sqlQuote(resolution)}, ${sqlQuote(JSON.stringify(refs))}::jsonb ` +
    `WHERE EXISTS (SELECT 1 FROM projects WHERE slug = ${sqlQuote(PROJECT_SLUG)}) ` +
    `AND NOT EXISTS (SELECT 1 FROM catchup_work_items WHERE title = ${sqlQuote(title)});`
  );
}

function tourVersionSql(title: string, stops: unknown[]): string {
  return (
    `INSERT INTO catchup_tour_versions (work_item_id, version, reason, stops) ` +
    `SELECT w.id, 1, ` +
    `${sqlQuote("Seeded fixture tour for the emulator's Catch up screens " +
      "(e2e/emulator/catchup.spec.ts) — no product route writes tours.")}, ` +
    `${sqlQuote(JSON.stringify(stops))}::jsonb ` +
    `FROM catchup_work_items w WHERE w.title = ${sqlQuote(title)} ` +
    `AND NOT EXISTS (SELECT 1 FROM catchup_tour_versions v ` +
    `WHERE v.work_item_id = w.id AND v.version = 1);`
  );
}

/**
 * Seed the three pieces + the recap in ONE psql session, and read the ids
 * back from the same call (`-tAqc` prints rows only). The recap belongs to
 * alice — a recap is a fact about a reader (ADR-0078 § Decision 1), and
 * alice is the reader this journey plays.
 */
function seedCatchUpFixture(): Record<string, string> {
  const recapText = `${RECAP_PREFIX}: one bug story was found, explained, fixed ` +
    `and left a follow-up; one UI change waits on your call; one routine lockfile ` +
    `push went in on its own. Play the tour or read the pieces below.`;
  const alice =
    `(SELECT u.id FROM users u JOIN oidc_identities oi ON oi.user_id = u.id ` +
    `WHERE oi.subject = 'alice' LIMIT 1)`;
  const sql = [
    upsertItemSql(BUG_TITLE, "issue", "merged", { issue_numbers: [ISSUE_NUMBER], pr_numbers: [PR_NUMBER] }),
    tourVersionSql(BUG_TITLE, BUG_STOPS),
    upsertItemSql(PR_TITLE, "pr", "branch_ready", { pr_numbers: [PR_NUMBER] }),
    tourVersionSql(PR_TITLE, PR_STOPS),
    upsertItemSql(PUSH_TITLE, "push", "merged", { commit_shas: [COMMIT_SHA] }),
    tourVersionSql(PUSH_TITLE, PUSH_STOPS),
    `INSERT INTO catchup_recaps (user_id, "text", "window", project_ids) ` +
    `SELECT ${alice}, ${sqlQuote(recapText)}, 'unseen', ` +
    `ARRAY[(SELECT id FROM projects WHERE slug = ${sqlQuote(PROJECT_SLUG)})]::uuid[] ` +
    `WHERE ${alice} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catchup_recaps r ` +
    `WHERE r.user_id = ${alice} AND r."text" LIKE ${sqlQuote(`${RECAP_PREFIX}%`)});`,
    `SELECT 'bug|' || id::text FROM catchup_work_items WHERE title = ${sqlQuote(BUG_TITLE)} ` +
    `UNION ALL SELECT 'pr|' || id::text FROM catchup_work_items WHERE title = ${sqlQuote(PR_TITLE)} ` +
    `UNION ALL SELECT 'push|' || id::text FROM catchup_work_items WHERE title = ${sqlQuote(PUSH_TITLE)} ` +
    `UNION ALL SELECT 'recap|' || COALESCE((SELECT MAX(id)::text FROM catchup_recaps r ` +
    `WHERE r."text" LIKE ${sqlQuote(`${RECAP_PREFIX}%`)}), 'MISSING');`,
  ].join(" ");
  const out = labSql(sql);
  const ids: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [key, value] = trimmed.split("|");
    if (key && value) ids[key] = value;
  }
  for (const key of ["bug", "pr", "push"]) {
    if (!UUID_RE.test(ids[key] ?? "")) {
      throw new Error(
        `the seeded catch-up ${key} item did not come back with a uuid ` +
          `(seed ${EMU_PASS_ID} needs project ${PROJECT_SLUG} — psql printed [${out}])`,
      );
    }
  }
  if (ids["recap"] === undefined || ids["recap"] === "MISSING") {
    throw new Error(
      `the seeded recap did not land (psql printed [${out}]) — alice must be a ` +
        `seeded user (docs/compatibility/probes/m4/seed.sh)`,
    );
  }
  console.log(
    `catchup emulator fixture seeded: bug=${ids["bug"]} pr=${ids["pr"]} push=${ids["push"]} ` +
      `recap=${ids["recap"]} (pass ${EMU_PASS_ID})`,
  );
  return ids;
}

/* ------------------------------------------------------------ the wire */

interface StopWire {
  id: string;
  title: string;
  seen: boolean;
}
interface ItemWire {
  id: string;
  title: string;
  latest: { version: number; stops: StopWire[] } | null;
}
interface ListWire {
  items: { id: string; unseen_stops: number }[];
  total_unseen: number;
}

async function getItem(page: Page, itemId: string): Promise<ItemWire> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/items/${itemId}`);
  expect(res.status(), `GET /catch-up/items/${itemId}`).toBe(200);
  return (await res.json()) as ItemWire;
}

async function getList(page: Page): Promise<ListWire> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/items`);
  expect(res.status(), "GET /catch-up/items").toBe(200);
  return (await res.json()) as ListWire;
}

test.describe("catch-up (alice: 8a the pile, 8b piece + decision, 7b the tour, the rail, Today's Ask)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: EMU_ALICE_STATE });

  test.setTimeout(480_000);

  test("the reader's pile, one piece of work, the player, the rail, the Ask", async ({
    page,
    emu,
  }) => {
    let ids: Record<string, string> = {};

    await test.step("seed the pass's catch-up fixture (SEEDED FIXTURE — see the header)", async () => {
      ids = seedCatchUpFixture();
    });

    await test.step("8a — /catch-up: chips, recap, tour cards, the rest", async () => {
      await page.goto("/catch-up");
      await expect(page.getByTestId("catchup-page"), "design 8a: the page renders").toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("catchup-recap")).toContainText(RECAP_PREFIX);
      await expect(
        page.getByTestId("catchup-start-tour"),
        "design 8a: the recap's primary verb starts the tour",
      ).toBeVisible();
      // The tour's first card is the focused one, and the pieces this pass
      // seeded are in it or in the rest — real rows the API served. Waited
      // for BEFORE the capture so the screen is recorded with the cards on
      // screen, never in the items-loaded-tour-pending flash.
      await expect(page.getByTestId("catchup-card-1"), { timeout: 30_000 }).toBeVisible();
      await expect(
        page.getByTestId("catchup-rest"),
        "design 8a: the rest panel carries the pieces still owed",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("catchup-see-more").or(page.getByTestId("catchup-rest")),
        "design 8a: more stops (See more) or the rest list must follow the cards",
      ).toBeVisible();
      const rest = page.getByTestId("catchup-rest");
      await expect(rest.getByTestId(`catchup-row-${ids["push"]}`)).toContainText(PUSH_TITLE);
      await emu.screen("cu-8a", "catch-up");
    });

    await test.step("8b — /catch-up/{bug}: stop list, current stop, history", async () => {
      await page.goto(`/catch-up/${ids["bug"]}`);
      await expect(page.getByTestId("catchup-item"), "design 8b: the page renders").toBeVisible({
        timeout: 30_000,
      });
      // The shared tour's four beats (at 390 the same list is the select —
      // the landmark carries that reflow, the behaviour check runs at 1280).
      for (const key of ["found", "cause", "fixed", "followup"]) {
        await expect(
          page.getByTestId(`catchup-item-stop-${STOP_ID(key)}`),
          `design 8b: the stop list is missing its ${key} beat`,
        ).toBeVisible({ timeout: 15_000 });
      }
      await expect(page.getByTestId("catchup-item-current")).toContainText(
        "Bug found: the cart timer never ran on an empty cart",
      );
      await expect(page.getByTestId("catchup-item-history")).toContainText(/tour history/i);
      await emu.screen("cu-8b", "piece");
    });

    await test.step("8b — /catch-up/{pr}: the decision stop renders and its click answers honestly", async () => {
      await page.goto(`/catch-up/${ids["pr"]}`);
      const decision = page.getByTestId("catchup-decision");
      await expect(decision, "design 8b: the worth_a_look piece asks its question").toBeVisible({
        timeout: 30_000,
      });
      await expect(decision).toContainText("Ship the roomier rows, or trim back to the current density?");
      await expect(page.getByTestId("catchup-decision-option-1")).toContainText(
        "Ship the roomier rows",
      );
      await expect(page.getByTestId("catchup-decision-option-2")).toContainText(
        "Trim back to current density",
      );
      // allow_text false: no free-text box, exactly two options.
      await expect(page.getByTestId("catchup-decision-text")).toHaveCount(0);
      await emu.screen("cu-8b", "decision");
      // The click. The item has NO conversation (seeded that way on purpose),
      // so the answer stores and the status line says nobody is notified —
      // the honest expected copy, not a send the pass cannot stand behind.
      const replied = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(
            `/api/v1/catch-up/items/${ids["pr"]}/stops/${STOP_ID("ui-call")}/reply`,
          ),
        { timeout: 30_000 },
      );
      await page.getByTestId("catchup-decision-option-1").click({ timeout: 15_000 });
      const replyResponse = await replied;
      expect(
        replyResponse.status(),
        "the decision reply answered with the 202 the route promises",
      ).toBe(202);
      const replyBody = (await replyResponse.json()) as { conversation_id: string | null };
      expect(replyBody.conversation_id, "the seeded piece has no conversation to answer").toBeNull();
      await expect(page.getByTestId("catchup-decision-status")).toContainText(
        /nobody was notified/,
        { timeout: 30_000 },
      );
    });

    await test.step("7b — /catch-up/tour?item={bug}: the player, and Next marks the stop you LEAVE seen", async () => {
      await page.goto(`/catch-up/tour?item=${ids["bug"]}`);
      await expect(page.getByTestId("tour-player"), "design 7b: the player fills the screen").toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("tour-progress")).toBeVisible();
      await expect(page.getByTestId("tour-current")).toBeVisible();
      // The player is the one page OUTSIDE the shell: no sidebar at all.
      await expect(page.getByTestId("sidebar"), "design 7b: the player is full screen").toHaveCount(0);
      await expect(page.getByTestId("tour-current")).toContainText(
        "Bug found: the cart timer never ran on an empty cart",
      );
      await emu.screen("cu-7b", "tour");

      // Next pays the debt of the stop it leaves — proven on the store's read,
      // not on the player's own optimistic label.
      const before = await getItem(page, ids["bug"]);
      const stopCount = before.latest?.stops.length ?? 0;
      expect(stopCount, "the seeded tour came back with no stops").toBe(4);
      const left = before.latest?.stops[0];
      expect(left?.id, "the tour opens on the FOUND beat").toBe(STOP_ID("found"));
      expect(left?.seen, "the FOUND beat was already seen before Next").toBe(false);
      await page.getByTestId("tour-next").click({ timeout: 15_000 });
      await expect
        .poll(
          async () => {
            const after = await getItem(page, ids["bug"]);
            return after.latest?.stops.find((stop) => stop.id === STOP_ID("found"))?.seen === true;
          },
          { message: "Next did not mark the stop it left behind seen", timeout: 30_000 },
        )
        .toBe(true);

      // The decision beat through the player too (no click — the click was
      // proven on the piece page; this proves the render at 390 as well).
      await page.goto(`/catch-up/tour?item=${ids["pr"]}`);
      await expect(page.getByTestId("tour-player")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("catchup-decision"), "design 7b: the player renders the ask").toBeVisible({
        timeout: 30_000,
      });
      await emu.screen("cu-7b", "decision");
    });

    await test.step("8a — mark all seen empties the pass's debt from the rest list", async () => {
      // Scoped to the pass's own rows on purpose: the list read IS the
      // generator's lazy trigger (ADR-0078 § Migration), and the lab runs
      // real models, so a tour written from this pass's earlier journeys can
      // land between the click and the read. THIS pass's debt going away is
      // the claim the journey owns and can honestly pin.
      await page.goto("/catch-up");
      await expect(page.getByTestId("catchup-page")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("catchup-mark-all-seen").click({ timeout: 15_000 });
      const owed = [ids["bug"], ids["pr"], ids["push"]];
      await expect
        .poll(
          async () => {
            const list = await getList(page);
            return list.items.filter((row) => owed.includes(row.id)).length;
          },
          {
            message: "GET /catch-up/items still owes one of the pass's pieces after mark-all-seen",
            timeout: 60_000,
          },
        )
        .toBe(0);
      for (const itemId of owed) {
        await expect(
          page.getByTestId(`catchup-row-${itemId}`),
          `the rest list still shows ${itemId} after mark-all-seen`,
        ).toHaveCount(0);
      }
    });

    await test.step("3a/4a — the rail: collapse, hover label, Projects popover, the 900px force, restore", async () => {
      await page.goto("/catch-up");
      await expect(page.getByTestId("catchup-page")).toBeVisible({ timeout: 30_000 });
      // Start from the expanded column (the preference is alice's account
      // state; repo-chat-nav.spec.ts restores it too — do not depend on it).
      const collapse = page.getByTestId("sidebar-collapse");
      if (!(await collapse.isVisible().catch(() => false))) {
        await page.getByTestId("sidebar-expand").click({ timeout: 10_000 });
      }
      await expect(collapse, "the expanded column carries its own collapse button").toBeVisible({
        timeout: 10_000,
      });
      // Collapse through the UI's own button (never the pref API).
      await collapse.click();
      await expect(page.getByTestId("sidebar-rail"), "design 3a: the rail replaces the column").toBeVisible({
        timeout: 10_000,
      });
      await emu.screen("rail-3a", "rail");

      // Hover a rail item → the dark label names it (mouse pointer only —
      // Playwright's hover is a mouse hover, which is the design's trigger).
      await page.getByTestId("rail-item-threads").hover();
      const tip = page.getByTestId("rail-tooltip");
      await expect(tip, "design 3a: the hover label names the item").toBeVisible({ timeout: 5_000 });
      await expect(tip).toContainText(/threads/i);
      await page.mouse.move(600, 400);

      // Projects is the one tile with children: click opens the popover,
      // Esc closes it.
      await page.getByTestId("rail-item-projects").click({ timeout: 10_000 });
      const popover = page.getByTestId("rail-projects-popover");
      await expect(popover, "design 3a: Projects opens the popover").toBeVisible({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await expect(popover, "design 3a: Esc closes the popover").toBeHidden({ timeout: 5_000 });

      // Restore the expanded preference through the rail's own expand button.
      await page.getByTestId("sidebar-expand").click({ timeout: 10_000 });
      await expect(collapse, "the column is expanded again for whoever plays next").toBeVisible({
        timeout: 10_000,
      });

      // 4a / finding 07: 768–1023px FORCES the rail whatever the preference
      // says — and it is the rail, not the phone drawer (which starts below
      // 768). The expanded column may only come back as the overlay.
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(page.getByTestId("sidebar-rail"), "900px: the rail is forced").toBeVisible({
        timeout: 10_000,
      });
      await expect(
        page.getByTestId("sidebar-open"),
        "900px: the phone strip (drawer) is NOT the reflow here",
      ).toHaveCount(0);
      await expect(page.getByTestId("sidebar-collapse"), "900px: no expanded column").toBeHidden();
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await test.step("today — the floating Ask at both widths, ⌘J asks, ⌘K searches", async () => {
      await page.goto("/");
      await expect(page.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });
      const fab = page.getByTestId("ask-fab");
      await expect(fab, "finding 08/10: Ask floats over every page").toBeVisible();
      const expectBottomRight = async (label: string): Promise<void> => {
        const box = await fab.boundingBox();
        expect(box, `${label}: the Ask button renders`).not.toBeNull();
        if (box === null) return;
        const right = await page.evaluate(() => window.innerWidth);
        const bottom = await page.evaluate(() => window.innerHeight);
        expect(box.x + box.width, `${label}: pinned to the right edge`).toBeGreaterThan(right - 80);
        expect(box.y + box.height, `${label}: pinned to the bottom edge`).toBeGreaterThan(bottom - 80);
      };
      await expectBottomRight("1280");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(fab).toBeVisible();
      await expectBottomRight("390");
      await page.setViewportSize({ width: 1280, height: 900 });
      await emu.screen("today-ask", "today");

      // ⌘J opens the assistant popover (Chromium on Linux answers Meta; the
      // fallback is shell-journey.spec.ts's, same surface).
      await page.keyboard.press("Meta+j");
      const popover = page.getByTestId("assistant-popover");
      if (!(await popover.isVisible().catch(() => false))) await page.keyboard.press("Control+j");
      await expect(popover, "⌘J opens Ask").toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden({ timeout: 10_000 });

      // ⌘K opens the jump palette (ADR-0050's addendum: K searches, J asks).
      await page.keyboard.press("Meta+k");
      const palette = page.getByTestId("palette-root");
      if (!(await palette.isVisible().catch(() => false))) await page.keyboard.press("Control+k");
      await expect(palette, "⌘K opens the palette").toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden({ timeout: 10_000 });
    });
  });
});
