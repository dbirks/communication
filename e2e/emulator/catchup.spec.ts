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
//
// The screen journey is ONE big test; the proofs that do not need its live
// screens (the 8a wire dials, the player's key contract, Today's empty-state
// briefing) run as their OWN serial tests in this file's describe, each on its
// own timeout. The big-backlog banner proof (acceptance T14) sits in a describe
// of its own below them all: it seeds its own pile, marks it seen again before
// it ends, and has no business being skipped because a capture went red.
// Appended to the journey they starved the screen captures:
// acceptance 42506795206 saw the 480 s budget expire mid-empty-state, cutting
// the leg off with `Test ended` / `Failed to find context` at its context
// close. The serial order keeps each test's server-side precondition (the
// journey's mark-all-seen still runs before the dials; the keyboard piece's
// seed is resolve-or-create and every test that needs it re-reads it).
import { seedSqlInProject, sqlQuote } from "../tests/lab-launcher.js";
import { signIn } from "../tests/helpers.js";
import { apiMutate, expect, test } from "./fixtures.js";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

/** The lab's seeded project (docs/compatibility/probes/m4/seed.sh). */
const PROJECT_SLUG = "m4-exit";

/**
 * The lab's ONE DOOR for rows the product has no route for is
 * e2e/tests/lab-launcher.ts's exported seed (shared `psql -tAqc` contract,
 * shared error shape) — but its compose coordinates (`E2E_COMPOSE_PROJECT`,
 * e2e/tests/env.js) default to the isolated CI e2e stack, and the emulator
 * loop drives the `communication-m4` lab scripts/lab-up.sh brings up
 * (compose.yml + compose.harness.yml + compose.m4.yml + compose.real.yml).
 * Same door, the LAB's project — and an exported knob still wins, exactly
 * like seedSql honours it. The helper finds postgres by compose LABELS and
 * `docker exec`s the running container directly: no compose config render,
 * so a verification job that starts the lab but never exports the gateway
 * keys `compose.real.yml` interpolates (`${LLMC_API_KEY:?}`) to the
 * Playwright process seeds just the same.
 */
function labSql(sql: string): string {
  return seedSqlInProject(sql, process.env.E2E_COMPOSE_PROJECT ?? "communication-m4");
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

/**
 * `#rrggbb` → the `rgb(r, g, b)` string a browser reports for it.
 *
 * The catch-up project square is painted with the API's own palette entry
 * (`ui/src/components/catchup/RestList.tsx` → `projectColor(item.project.color)`),
 * and `getComputedStyle().backgroundColor` reports a resolved `rgb(…)`, never the
 * hex the source wrote. Comparing the row's painted colour to the API's colour
 * therefore needs this one conversion — the same arithmetic the browser does.
 */
function hexToRgb(hex: string): string {
  const digits = hex.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

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
    `${sqlQuote(
      "Seeded fixture tour for the emulator's Catch up screens " +
        "(e2e/emulator/catchup.spec.ts) — no product route writes tours.",
    )}, ` +
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
  const recapText =
    `${RECAP_PREFIX}: one bug story was found, explained, fixed ` +
    `and left a follow-up; one UI change waits on your call; one routine lockfile ` +
    `push went in on its own. Play the tour or read the pieces below.`;
  const alice =
    `(SELECT u.id FROM users u JOIN oidc_identities oi ON oi.user_id = u.id ` +
    `WHERE oi.subject = 'alice' LIMIT 1)`;
  const sql = [
    upsertItemSql(BUG_TITLE, "issue", "merged", {
      issue_numbers: [ISSUE_NUMBER],
      pr_numbers: [PR_NUMBER],
    }),
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
      // Newest-first read of the recap, NOT `MAX(id)`: postgres has no `max()`
      // for uuid (acceptance 42460068894 — `function max(uuid) does not exist`),
      // so the id comes back through the table's own newest-recap ordering
      // (catchup_recaps_user_written_idx: written_at DESC, id DESC).
      `UNION ALL SELECT 'recap|' || COALESCE((SELECT r.id::text FROM catchup_recaps r ` +
      `WHERE r."text" LIKE ${sqlQuote(`${RECAP_PREFIX}%`)} ` +
      `ORDER BY r.written_at DESC, r.id DESC LIMIT 1), 'MISSING');`,
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
  latest: { version: number; stops: StopWire[]; created_at?: string } | null;
  /** The members who finished the NEWEST version — the roster `CatchUpItem.tsx`
   * draws as initials plus a named line (acceptance T15). */
  seen_by?: { id: string; name: string; seen_at: string }[];
}
interface ListWire {
  items: { id: string; unseen_stops: number; updated: boolean }[];
  total_unseen: number;
  oldest_unseen_at: string | null;
}
interface TourWire {
  stops: { work_item_id: string; stop: { id: string; importance: string } }[];
  total_unseen_stops: number;
  more_available: boolean;
  built_from: number;
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

interface VisitSuggestion {
  window: string | null;
  visits_per_week: number;
}

async function getSuggestion(page: Page): Promise<VisitSuggestion> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/visits/suggestion`);
  expect(res.status(), "GET /catch-up/visits/suggestion").toBe(200);
  return (await res.json()) as VisitSuggestion;
}

async function getTour(page: Page): Promise<TourWire> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/tour`);
  expect(res.status(), "GET /catch-up/tour").toBe(200);
  return (await res.json()) as TourWire;
}

/* ------------------------------------------- the surface a piece shows in
 * Design 8a: "the rest" LEAVES OUT any piece with a stop in the tour cards
 * above it — the rest holds only the pieces the cards do not touch at all
 * (ui/src/components/catchup/RestList.tsx's `tourStopsByItem` filter; page 1
 * of the tour is 4 beats). A carded piece's remaining stops are reachable
 * through "See more" and on its piece page, so it is never repeated below.
 * The tour page is the design's OPINIONATED SUMMARY — `GET /catch-up/tour`
 * gives every unseen piece its single best beat before any piece gets a
 * second one — so with this pass's three seeds page 1 is one stop from the bug
 * story, the PR that waits on your call and the routine push, plus the bug's
 * NEXT stop. All three seeds are therefore carded and the rest stands EMPTY —
 * with its honest line, not a silent panel.
 * `readPieceSurface` states the contract rather than a lucky ranking: the piece
 * is on the page in the surface its own unseen beats belong to, and it is NAMED
 * there — the work-item title in the row, every carded beat's title among the
 * cards, each card reached by its own "Start here ›" (ui/src/components/catchup/
 * TourCards.tsx links a card to `/catch-up/<work-item-id>?stop=…`). */

/** Collapse whitespace the way the browser reads it, so a title with a newline
 * in the store still matches the text a card or a row renders. */
function normText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The tour cards that belong to one piece, picked by their "Start here ›"
 * href — the card's only link. */
function pieceCards(page: Page, pieceId: string): Locator {
  return page
    .locator("[data-testid^='catchup-card-']")
    .filter({ has: page.locator(`a[href*="/catch-up/${pieceId}"]`) });
}

interface PieceSurface {
  surface: "cards" | "row" | "both" | "missing";
  /** The piece named in the surface that owes it, and 8a's exclusion honoured: a
   * piece with ANY carded stop is not repeated in the rest. */
  titled: boolean;
  why: string;
}

async function readPieceSurface(
  page: Page,
  pieceId: string,
  title: string,
  beats: string[],
): Promise<PieceSurface> {
  const row = page.getByTestId("catchup-rest").getByTestId(`catchup-row-${pieceId}`);
  const cards = pieceCards(page, pieceId);
  const rows = await row.count();
  const featured = await cards.count();
  const wanted = beats.map(normText).filter((text) => text !== "");
  if (featured > 0) {
    // Carded — in the whole or in part. 8a: the piece is NOT in the rest
    // either way; its uncarded stops live behind "See more" and on its piece
    // page. Every card names one of the piece's owed beats and answers to its
    // own "Start here ›".
    const texts = (await cards.allInnerTexts().catch(() => [])).map(normText);
    const links = await cards
      .locator("a")
      .allInnerTexts()
      .catch(() => []);
    const fullyCarded = wanted.length > 0 && featured >= wanted.length;
    const titled =
      rows === 0 &&
      featured === texts.length &&
      links.length === featured &&
      links.every((link) => /start here/i.test(link)) &&
      texts.every((text) => wanted.some((beat) => text.includes(beat))) &&
      (!fullyCarded || wanted.every((beat) => texts.some((text) => text.includes(beat))));
    return {
      surface: rows > 0 ? "both" : "cards",
      titled,
      why:
        `${featured} tour card(s) whose "Start here ›" link targets /catch-up/${pieceId} ` +
        `carrying their beat titles (${wanted.join(" / ")})` +
        (rows > 0
          ? `, repeated in the rest as catchup-row-${pieceId} — 8a says a piece with any carded stop is not`
          : ""),
    };
  }
  const rowText = normText(await row.innerText().catch(() => ""));
  return {
    surface: rows > 0 ? "row" : "missing",
    titled: rows > 0 && rowText.includes(normText(title)),
    why: `catchup-row-${pieceId} carrying "${title}" (${featured} of ${wanted.length} beats carded)`,
  };
}

/** The pass's beats still unseen on the wire — what the page must show, read
 * from the same item the browser reads, never from the seed's own constants. */
async function unseenBeatTitles(page: Page, pieceId: string): Promise<string[]> {
  const item = await getItem(page, pieceId);
  const titles = (item.latest?.stops ?? []).filter((stop) => !stop.seen).map((stop) => stop.title);
  expect(
    titles.length,
    `the seeded piece ${pieceId} has no tour with unseen beats to show`,
  ).toBeGreaterThan(0);
  return titles;
}

/**
 * Resolve-or-create the keyboard piece through the SAME seed door as the tour
 * pieces, and return its id. It exists for the two proofs that no longer share
 * the screen journey's timeout: the wire dials need a piece this pass has NOT
 * marked seen (the journey's mark-all-seen has paid its three main pieces by
 * then), so the page is not in its caught-up state and the rest list — the
 * `show seen` checkbox's home — draws; and the player's key contract needs
 * fresh stop ids the reader never paid, which is what makes `S marks the
 * current stop seen` a real claim and not a re-read of old ink.
 *
 * Idempotent on purpose: both callers run the same guarded upsert, so the
 * second test and a fresh process after a worker restart reuse the dead one's
 * rows, never double-seed them.
 */
async function seedKeyboardPiece(page: Page): Promise<string> {
  const keysTitle = `Emu catch-up keys ${EMU_PASS_ID}: the arrows walked the beats`;
  const keysStop = (key: string, title: string, narrative: string, importance: string) =>
    stop(key, { kind: "ROUTINE", title, narrative, importance });
  const seedOut = labSql(
    upsertItemSql(keysTitle, "issue", "merged", { issue_numbers: [911] }) +
      " " +
      tourVersionSql(keysTitle, [
        keysStop(
          "keys-a",
          "Keyboard beat one: S pays the beat you sit on",
          "The first seeded keyboard beat. Nothing asks anything here; the stop exists so the S key has a debt to pay while the player sits on it.",
          "must_know",
        ),
        keysStop(
          "keys-b",
          "Keyboard beat two: the arrows walk between beats",
          "The second seeded keyboard beat. The player's → lands here and ← walks back, and the reader never leaves the keyboard.",
          "worth_a_look",
        ),
      ]) +
      ` SELECT 'keys|' || id::text FROM catchup_work_items WHERE title = ${sqlQuote(keysTitle)};`,
  );
  const keysId = /keys\|([0-9a-fA-F-]{36})/.exec(seedOut)?.[1] ?? "";
  expect(
    keysId,
    `the keyboard fixture piece did not come back with a uuid (psql printed [${seedOut}])`,
  ).toMatch(UUID_RE);
  const fresh = await getItem(page, keysId);
  expect(
    (fresh.latest?.stops ?? []).filter((one) => !one.seen).length,
    "both keyboard beats are unseen when the leg opens (a replay after a mid-leg failure owes this leg a fresh read)",
  ).toBe(2);
  return keysId;
}

/**
 * The lab's seeded project (docs/compatibility/probes/m4/seed.sh), read from
 * the caller's OWN list — never a hard-coded uuid. Every catch-up read here is
 * project-scoped, so a proof that wants the seeded rows needs this id.
 */
async function m4ExitProjectId(page: Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "GET /api/v1/projects answers").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((project) => project.slug === PROJECT_SLUG)?.id ?? "";
  expect(id, `the seeded '${PROJECT_SLUG}' project exists`).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/**
 * The TWO strings `ui/src/pages/CatchUpItem.tsx` computes from a reader's
 * display name — the seen line's first name (`firstName`) and the avatar's
 * initials (`SeenByAvatars`). Reproduced here (rather than imported, since the
 * emulator must not depend on the app's bundle) so the browser proof compares
 * the page against the rule the design states instead of against a hard-coded
 * "BB" that would silently rot the day a seeded subject's name changes.
 */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  ).slice(0, 2);
}

/**
 * Sign the lab's seeded `bob` in through the mock IdP in HIS OWN browser
 * context and read the display name the directory holds for him. The context is
 * an EXPLICIT empty state: this file's describes carry alice's `storageState`,
 * and @playwright/test merges it into every `browser.newContext()` that does not
 * name one, so the unnamed default is born signed in and `signIn` can never
 * reach the IdP door (acceptance 42524332059 — the same reason
 * `gate-decision-conflict.spec.ts` opens its second identity this way). The
 * claims are the seed's own shape (`docs/compatibility/probes/m4/seed.sh`
 * `login()`: `{"email":"<subject>@example.test"}`), so the profile row this
 * proof reads is the row the lab wrote.
 */
async function signInSecondReader(
  browser: Browser,
): Promise<{ page: Page; context: BrowserContext; name: string }> {
  const context = await browser.newContext({
    baseURL: EMU_BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await context.newPage();
    await signIn(page, "bob", { email: "bob@example.test" });
    const me = await page.request.get(`${EMU_BASE_URL}/api/v1/me`);
    expect(me.status(), "GET /api/v1/me as the second reader answers").toBe(200);
    const name = String(((await me.json()) as { display_name?: string }).display_name ?? "").trim();
    expect(name, "the second reader has a display name for the roster to print").not.toBe("");
    return { page, context, name };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

test.describe("catch-up (alice: 8a the pile, 8b piece + decision, 7b the tour, the rail, Today's Ask)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: EMU_ALICE_STATE });

  test("the reader's pile, one piece of work, the player, the rail, the Ask", async ({
    page,
    emu,
  }) => {
    // The screen journey keeps the 480 s budget it has always had; the proofs
    // appended after it (this file's other tests) pay their OWN timeouts, so
    // no slow leg can starve these captures (acceptance 42506795206).
    test.setTimeout(480_000);
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
      // seeded are in it or in the rest — real beats and rows the API served.
      // Waited for BEFORE the capture so the screen is recorded with the cards on
      // screen, never in the items-loaded-tour-pending flash.
      await expect(
        page.getByTestId("catchup-card-1"),
        "design 8a: the tour's first card renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("catchup-rest"),
        "design 8a: the rest panel carries the pieces still owed",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("catchup-see-more"),
        "design 8a: more stops (See more) must follow the cards",
      ).toBeVisible();
      // Design 8a with the summary tour: the rest shows only the pieces the
      // cards do not touch. This pass's page 1 carries one stop from each seed
      // plus the bug's NEXT stop, so all three are carded and the rest stands
      // EMPTY — every piece named on the cards, none repeated below. Each
      // piece is checked in the surface its own unseen beats belong to, and named
      // there — and the ordering itself is checked on the wire below, because a
      // four-beat story that filled page 1 is exactly what the summary rule forbids.
      const tourWire = await getTour(page);
      const order = tourWire.stops.map((entry) => entry.work_item_id);
      const pieces = new Set(order).size;
      expect(
        pieces,
        `the tour's page 1 came from ${pieces} piece(s): ${order.join(", ")}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        order.slice(0, pieces),
        "the tour's page 1 repeated a piece before every piece had one beat",
      ).toEqual([...new Set(order.slice(0, pieces))]);
      const surfaces: string[] = [];
      for (const piece of [
        { key: "bug", id: ids["bug"], title: BUG_TITLE, owed: ["cards"] },
        { key: "pr", id: ids["pr"], title: PR_TITLE, owed: ["cards"] },
        { key: "push", id: ids["push"], title: PUSH_TITLE, owed: ["cards"] },
      ]) {
        const beats = await unseenBeatTitles(page, piece.id);
        await expect
          .poll(async () => (await readPieceSurface(page, piece.id, piece.title, beats)).titled, {
            message: `design 8a: ${piece.title} is not named in the surface its ${beats.length} unseen beat(s) belong to`,
            timeout: 30_000,
          })
          .toBe(true);
        const shown = await readPieceSurface(page, piece.id, piece.title, beats);
        expect(piece.owed, `design 8a: ${piece.title} shows as ${shown.why}`).toContain(
          shown.surface,
        );
        surfaces.push(`${piece.key}=${shown.surface}`);
      }
      // Every carded piece leaves the rest — with all three seeds on page 1
      // there is nothing the cards do not touch, and the empty panel says so.
      await expect(
        page.getByTestId("catchup-rest"),
        "design 8a: the rest lists only pieces with no stop in the tour cards",
      ).toContainText("Everything unseen is in the tour above.");
      console.log(`catch-up 8a surfaces (pass ${EMU_PASS_ID}): ${surfaces.join(" ")}`);
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
      await expect(decision).toContainText(
        "Ship the roomier rows, or trim back to the current density?",
      );
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
          response
            .url()
            .includes(`/api/v1/catch-up/items/${ids["pr"]}/stops/${STOP_ID("ui-call")}/reply`),
        { timeout: 30_000 },
      );
      await page.getByTestId("catchup-decision-option-1").click({ timeout: 15_000 });
      const replyResponse = await replied;
      expect(
        replyResponse.status(),
        "the decision reply answered with the 202 the route promises",
      ).toBe(202);
      const replyBody = (await replyResponse.json()) as { conversation_id: string | null };
      expect(
        replyBody.conversation_id,
        "the seeded piece has no conversation to answer",
      ).toBeNull();
      await expect(page.getByTestId("catchup-decision-status")).toContainText(
        /nobody was notified/,
        { timeout: 30_000 },
      );
    });

    await test.step("7b — /catch-up/tour?item={bug}: the player, and Next marks the stop you LEAVE seen", async () => {
      await page.goto(`/catch-up/tour?item=${ids["bug"]}`);
      await expect(
        page.getByTestId("tour-player"),
        "design 7b: the player fills the screen",
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("tour-progress")).toBeVisible();
      await expect(page.getByTestId("tour-current")).toBeVisible();
      // The player is the one page OUTSIDE the shell: no sidebar at all.
      await expect(page.getByTestId("sidebar"), "design 7b: the player is full screen").toHaveCount(
        0,
      );
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
      await expect(
        page.getByTestId("catchup-decision"),
        "design 7b: the player renders the ask",
      ).toBeVisible({
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
        // And the piece is gone from the OTHER surface too: with every beat seen
        // the tour has nothing left to card for it (design 8a since 5da1b79).
        await expect(
          pieceCards(page, itemId),
          `a tour card still links ${itemId} after mark-all-seen`,
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
      await expect(
        page.getByTestId("sidebar-rail"),
        "design 3a: the rail replaces the column",
      ).toBeVisible({
        timeout: 10_000,
      });
      await emu.screen("rail-3a", "rail");

      // Hover a rail item → the dark label names it (mouse pointer only —
      // Playwright's hover is a mouse hover, which is the design's trigger).
      await page.getByTestId("rail-item-threads").hover();
      const tip = page.getByTestId("rail-tooltip");
      await expect(tip, "design 3a: the hover label names the item").toBeVisible({
        timeout: 5_000,
      });
      await expect(tip).toContainText(/threads/i);
      await page.mouse.move(600, 400);

      // Projects is the one tile with children: click opens the popover,
      // Esc closes it.
      await page.getByTestId("rail-item-projects").click({ timeout: 10_000 });
      const popover = page.getByTestId("rail-projects-popover");
      await expect(popover, "design 3a: Projects opens the popover").toBeVisible({
        timeout: 5_000,
      });
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
        expect(box.y + box.height, `${label}: pinned to the bottom edge`).toBeGreaterThan(
          bottom - 80,
        );
      };
      await expectBottomRight("1280");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(fab).toBeVisible();
      await expectBottomRight("390");
      await page.setViewportSize({ width: 1280, height: 900 });
      await emu.screen("today-ask", "today");

      // ⌘J opens the assistant popover (ControlOrMeta: ⌘ on mac, Ctrl on the
      // Linux runner — the palette and the popover accept either modifier).
      await page.keyboard.press("ControlOrMeta+j");
      const popover = page.getByTestId("assistant-popover");
      await expect(popover, "⌘J opens Ask").toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden({ timeout: 10_000 });

      // ⌘K opens the jump palette (ADR-0050's addendum: K searches, J asks).
      // The palette's wrapper (`palette-root`) is never the visible thing: its
      // children are all `position: fixed`, so the wrapper's own box is empty
      // and Playwright cannot see it — the panel's input is what a person sees
      // and types into, and opening means taking the caret.
      await page.keyboard.press("ControlOrMeta+k");
      const paletteInput = page.getByTestId("palette-input");
      await expect(paletteInput, "⌘K opens the palette").toBeVisible({ timeout: 10_000 });
      await expect(paletteInput, "the palette takes the caret").toBeFocused();
      await page.keyboard.press("Escape");
      await expect(paletteInput, "Esc closes the palette").toBeHidden({ timeout: 10_000 });
    });

    await test.step("shell — ⌘J opens Ask from /threads too (the chord answers every shell page)", async () => {
      // T5's second page: the popover lives in the Shell (Shell.tsx mounts it
      // once), so the chord must open it wherever the Shell stands — Today is
      // already proven above, this is /threads (the shell spec adds the
      // Workflow page press alongside the sidebar-search palette proof).
      await page.goto("/threads");
      await expect(page.getByTestId("threads-page"), "the threads screen renders").toBeVisible({
        timeout: 30_000,
      });
      await page.keyboard.press("ControlOrMeta+j");
      const threadsAsk = page.getByTestId("assistant-popover");
      await expect(threadsAsk, "⌘J opens Ask from /threads too").toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(threadsAsk).toBeHidden({ timeout: 10_000 });
    });

  });

  /* ------------------------------------------------------ the appended proofs
   * run as their own tests since acceptance 42506795206: same serial
   * describe, same acting identities, but each proof pays its OWN timeout.
   * They used to be steps at the END of the screen journey, where one slow
   * leg (the empty-state's second browser context) ran the 480 s budget out
   * and every capture's journey died with it. `emu` is requested (never
   * called) so the recorder still files page/api defects from these tests.
   */

  test("8a on the wire — the 24h chip sends `since`, show-seen sends `include_seen`", async ({
    page,
    emu,
  }) => {
    test.setTimeout(240_000);
    void emu;

    await test.step("seed the keyboard piece (fresh unseen stops — SEEDED FIXTURE)", async () => {
      // The screen journey's mark-all-seen has already paid the pass's three
      // main pieces, so this fresh two-beat piece is what keeps the page out
      // of its caught-up state and the rest list on screen for the dials.
      await seedKeyboardPiece(page);
    });

    await test.step("8a — the 24h window chip sends `since`; show-seen sends `include_seen`", async () => {
      // Design 8a's two wire dials. The window chips are the page's own state
      // ("unseen" sends no `since` at all — api/catchup.ts's windowSince), and
      // the rest list's `show seen` checkbox is what asks the list for
      // `include_seen=true`. The claim is about the REQUEST the click sends,
      // so it is read off the network, not off a re-rendered count.
      await page.goto("/catch-up");
      await expect(page.getByTestId("catchup-page")).toBeVisible({ timeout: 30_000 });
      // The keyboard piece just seeded is unseen, so the page is not in its
      // caught-up state and the rest list — the checkbox's home — draws.
      const chip = page.getByTestId("catchup-window-24h");
      await expect(chip, "design 8a: the window chips name their widths").toBeVisible();
      const sinceRequest = page.waitForRequest(
        (req) =>
          req.method() === "GET" &&
          req.url().includes("/api/v1/catch-up/items") &&
          new URL(req.url()).searchParams.has("since"),
        { timeout: 30_000 },
      );
      await chip.click({ timeout: 15_000 });
      const sent = await sinceRequest;
      const since = new Date(new URL(sent.url()).searchParams.get("since")!);
      const expected = Date.now() - 24 * 3_600_000;
      expect(
        Math.abs(since.getTime() - expected),
        `the 24h chip sent since=${since.toISOString()}, which is not 24 h back (±15 min)`,
      ).toBeLessThan(15 * 60_000);
      await expect(chip, "the clicked chip reads pressed").toHaveAttribute("aria-pressed", "true");
      // `show seen` toggles the rest read onto include_seen=true.
      const seenRequest = page.waitForRequest(
        (req) =>
          req.method() === "GET" &&
          req.url().includes("/api/v1/catch-up/items") &&
          new URL(req.url()).searchParams.get("include_seen") === "true",
        { timeout: 30_000 },
      );
      await expect(
        page.getByTestId("catchup-show-seen"),
        "the rest list carries the show-seen checkbox",
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("catchup-show-seen").click({ timeout: 15_000 });
      await seenRequest;
      // The big-backlog banner is proven in the browser by THIS file's last
      // test ("8a big backlog …"): the pile it needs (> 12 unseen) is seeded
      // there, labelled SEEDED FIXTURE, with the pass's own visit rhythm, and
      // marked seen again before the test ends. The unit proof
      // (ui/src/pages/CatchUp.test.tsx, "shows the big-backlog banner past 12
      // unseen") still holds the threshold arithmetic; what it could never
      // prove is the click.
    });

  });

  test("7b on the keyboard — S pays the stop, → and ← walk, Esc closes, ⌘J asks", async ({
    page,
    emu,
  }) => {
    test.setTimeout(240_000);
    void emu;

    // The same resolve-or-create seed the dial test ran, re-read here so this
    // test stands on its own rows: the dial test only watches the wire, it
    // never pays a stop, so both beats must still be unseen on a fresh pass.
    const keysId = await seedKeyboardPiece(page);

    await test.step("7b — the player's keys: S pays the stop, → and ← walk, Esc closes, ⌘J asks about the stop", async () => {
      // Design 7b's keyboard contract (TourPlayer.tsx), played on the
      // keyboard piece this test seeded (two unseen beats, the player
      // entered by `?item=` so the beat order is this piece's own).
      // Enter the player from the pile, so Esc's way back has a pile to be.
      await page.goto("/catch-up");
      await expect(page.getByTestId("catchup-page")).toBeVisible({ timeout: 30_000 });
      await page.goto(`/catch-up/tour?item=${keysId}`);
      await expect(page.getByTestId("tour-player"), "design 7b: the player opens").toBeVisible({
        timeout: 30_000,
      });
      const current = page.getByTestId("tour-current");
      await expect(current, "the item tour sits on its first beat").toContainText(
        "The first seeded keyboard beat",
        { timeout: 15_000 },
      );

      // S pays the CURRENT stop — proven on the store's read, not the label.
      await page.keyboard.press("s");
      await expect
        .poll(
          async () =>
            (await getItem(page, keysId)).latest?.stops.find((one) => one.id === STOP_ID("keys-a"))
              ?.seen === true,
          {
            message: "S did not mark the current stop seen (GET /catch-up/items/{id})",
            timeout: 30_000,
          },
        )
        .toBe(true);
      // …and it did NOT move the reader: the same beat is still on screen.
      await expect(current).toContainText("The first seeded keyboard beat");

      // ArrowRight walks to the next beat (and pays the one it leaves, which
      // is already paid here), ArrowLeft walks back.
      await page.keyboard.press("ArrowRight");
      await expect(current, "→ moved to the next stop").toContainText(
        "The second seeded keyboard beat",
        { timeout: 15_000 },
      );
      await expect(current, "→ left the first stop's narrative behind").not.toContainText(
        "The first seeded keyboard beat",
      );
      await page.keyboard.press("ArrowLeft");
      await expect(current, "← moved back to the previous stop").toContainText(
        "The first seeded keyboard beat",
        { timeout: 15_000 },
      );

      // ⌘J names the stop the reader sits on: the player hands the assistant
      // the current beat as the ask's context (TourPlayer.tsx's openAskAbout).
      await page.keyboard.press("ControlOrMeta+j");
      const ask = page.getByTestId("assistant-popover");
      await expect(
        ask,
        "⌘J opens Ask from inside the player, with the stop as its context",
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByTestId("assistant-messages"),
        "the ask carries the stop the reader sat on",
      ).toContainText("Keyboard beat one", { timeout: 15_000 });
      await page.keyboard.press("Escape");
      await expect(ask, "Esc takes the Ask away").toBeHidden({ timeout: 10_000 });

      // And Esc from the player itself walks out of the full screen.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("tour-player"), "Esc closes the player").toBeHidden({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("catchup-page"),
        "Esc lands back on the Catch up pile (design 7b: the player is a room you leave)",
      ).toBeVisible({ timeout: 15_000 });
    });

  });

  test("today empty — a member-less reader's empty briefing opens the run form from its one verb", async ({
    browser,
  }) => {
    // Its own test AND its own 240 s budget (acceptance 42506795206): this
    // leg ran LAST inside the screen journey, where the budget expired
    // mid-flight — the trace's `Failed to find context` / `Test ended` at the
    // context close was the 480 s ceiling ending the test, not the empty
    // state being wrong. Every wait below is bounded explicitly and the
    // throwaway context closes under a catch, so this test fails with its own
    // first real error or passes.
    test.setTimeout(240_000);

    await test.step("today — the empty briefing's Start run opens the run form (a lab state with no runs)", async () => {
      // Finding 03 / T3: when Today has nothing running, nothing waiting and
      // no threads, it says so and its ONE verb — `Start run` — opens the run
      // form IN PLACE (`home-start-run-dialog`). The lab's seeded readers all
      // have projects and runs, so the reachable no-runs state is the one the
      // cross-project reads themselves define (ADR-0047: those routes return
      // only rows of projects the caller is a member of): a fresh mock-IdP
      // subject (helpers.signIn's documented use — a readable profile, no
      // membership anywhere) sees an honest empty Today. Its own throwaway
      // context; alice's state and the shared lab data are untouched.
      // An EXPLICIT empty state, never the inherited default: this describe
      // carries `use.storageState` (alice), and @playwright/test merges it into
      // every `browser.newContext()` that does not name one — a context born
      // signed in as alice has no `sign-in` door to walk (acceptance
      // 42524332059's hang; helpers.signIn now refuses that state in seconds).
      const context = await browser.newContext({
        baseURL: EMU_BASE_URL,
        storageState: { cookies: [], origins: [] },
      });
      try {
        const nobody = await context.newPage();
        // The lab's shared sign-in helper (e2e/tests/helpers.ts — the same
        // door setup.spec.ts uses for its storage states): the mock IdP mints
        // any subject typed into its form, so a brand-new member-less reader
        // is the documented path, not a hand-rolled login. signIn bounds its
        // own waits; the test budget above is the outer bound.
        await signIn(nobody, `emu-t3-nobody-${EMU_PASS_ID}`);
        await nobody.goto("/", { timeout: 30_000 });
        await expect(nobody.getByTestId("home-page"), "Today renders").toBeVisible({
          timeout: 30_000,
        });
        const empty = nobody.getByTestId("home-empty");
        await expect(
          empty,
          "a reader with no projects has nothing running and nothing waiting — the empty briefing",
        ).toBeVisible({ timeout: 30_000 });
        await expect(empty).toContainText(/Nothing is running and nothing is waiting on you/i);
        await nobody.getByTestId("home-start-run").click({ timeout: 15_000 });
        // `home-start-run-dialog` is a bare wrapper whose only child is
        // RunFormDialog's `fixed inset-0` overlay — the wrapper's own box is
        // empty, so Playwright calls it HIDDEN even though the dialog opened
        // (acceptance 42535038297: 34 polls all "resolved to the div"; the
        // same bug `palette-root` had, see the ⌘K step above). Assert the
        // dialog's REAL content: its role=dialog box and its heading.
        const dialog = nobody.getByTestId("home-start-run-dialog");
        await expect(
          dialog.getByRole("dialog"),
          "design finding 03: Start run opens the run form in place, not a route",
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          dialog.getByTestId("run-form-title"),
          "the dialog that opened is the run form",
        ).toHaveText("Start a run", { timeout: 15_000 });
        // For THIS reader the form honestly says why there is nothing to pick
        // (StartRunDialog's no-projects line) — the dialog opened, and it is
        // the run form's own chrome rather than a silent no-op.
        await expect(
          dialog.getByTestId("home-start-run-no-projects"),
          "the run form names the reader's own state: no project to start against",
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        // Guarded close: if the leg died mid-page the close must not add a
        // `Failed to find context` red on top of the real failure (1.64's
        // context close takes no timeout — the test budget is the bound).
        await context.close().catch(() => undefined);
      }
    });
  });
});

/* ------------------------------------------------- the big-backlog pile (mock 8a)
 * SEEDED FIXTURE, same door and the same reason as every other row this file
 * writes: mock 8a's “big-backlog state” needs MORE unseen pieces than a
 * journey may honestly manufacture from real runs — `BACKLOG_BANNER_THRESHOLD`
 * (ui/src/components/catchup/BacklogBanner.tsx) is 12, and a pass that waited
 * for the assistant to write 13 true stories would be waiting for a model. So
 * the rows are the store's own (`catchup_work_items` + one ROUTINE beat each,
 * through `catchup_tour_versions`) and the reader's rhythm is the store's own
 * `catchup_visits`, and the API's answer is read back rather than assumed.
 *
 * What is proven here that no unit test can prove:
 *   - the banner RENDERS on the real page with the real list read's numbers;
 *   - `Last 24h` is not a decoration: it moves the page's OWN window state
 *     (the 24h chip becomes the pressed one) and the items request that
 *     follows carries `since` = now − 24 h;
 *   - `Keep all` dismisses the banner for the session (across a reload it is
 *     back; once clicked, moving off the wide window and back does not
 *     re-arm it) — acceptance T14.
 *
 * The rows are marked seen again in this test's `finally`, scoped to the one
 * project they were seeded in, so a later pass, a rerun or another screen's
 * badge never reads this pile.
 */
test.describe("catch-up big backlog (alice: mock 8a's pile and the window it proposes)", () => {
  // Its OWN describe rather than the screen journey's serial group: Playwright
  // skips the rest of a serial group the moment one test in it fails, and this
  // proof — seeded, self-contained, every number re-read from the wire — has no
  // business being collateral damage of a reflow capture.
  test.use({ storageState: EMU_ALICE_STATE });

  const BACKLOG_PREFIX = `Emu catch-up pile ${EMU_PASS_ID}`;
  const BACKLOG_PHRASES = [
    "the retry countdown stopped counting a run that had already gone",
    "the artifact list pages past its first hundred rows",
    "worker heartbeats survive a control-plane replica restart",
    "the audit row names the actor it acted as",
    "the sidebar badge counts one run exactly once",
    "a cancelled run releases the lease it held",
    "the journal replay collapses its invalidations",
    "the run title gives way before it truncates",
    "an expired gate re-arms the row it already had",
    "the idempotency key answers with the stored run",
    "the member picker lists the organization once per page",
    "the plan digest outlives the edit that made it",
    "the catch-up badge follows the reader, not the repository",
  ];

  /** `daysSince` (ui/src/components/catchup/importance.ts) — whole days between
   * an instant and now, rounded UP, minimum 1. The banner's own arithmetic,
   * applied to the timestamp the LIST READ served, so the check compares the
   * screen against the wire rather than against a constant the seed picked. */
  function bannerDays(iso: string | null): number {
    if (iso === null) return 1;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 1;
    return Math.max(1, Math.ceil((Date.now() - then) / 86_400_000));
  }

  /**
   * The pile's SHAPES and RESOLUTIONS, cycled across the seeded pieces so the
   * rest list is not one undifferentiated column (acceptance T14 asserts a row's
   * how-it-landed label and its resolution chip against the row's own seeded
   * shape). Both vocabularies are closed (`catchup_work_items` CHECKs them: shape
   * `issue|pr|push`, resolution `merged|branch_ready|open|run_failed|no_code`),
   * so cycling across 13 phrases lands every value of both and keeps the
   * `ShapeLabel`/`RESOLUTION_WORD` mapping exercised on every label.
   *
   * The refs follow the shape the way `refLabel` expects (an issue number for
   * `issue`, a PR for `pr`, a commit for `push`); the commit shas are 40-hex
   * values that are NOT one of the design mocks' invented ids (mockdata.ts:
   * 9c1e04, a7f310, e02b9a, …), so the no-made-up-data screen check cannot
   * confuse seeded lab data with a mock leak.
   */
  const PILE_SHAPES = ["issue", "pr", "push"] as const;
  const PILE_RESOLUTIONS = ["merged", "branch_ready", "open"] as const;

  /** One seeded piece: the row's shape, resolution and the ref the shape names. */
  function pileShape(index: number): {
    shape: (typeof PILE_SHAPES)[number];
    resolution: (typeof PILE_RESOLUTIONS)[number];
    refs: Record<string, unknown>;
  } {
    const shape = PILE_SHAPES[index % PILE_SHAPES.length];
    const resolution = PILE_RESOLUTIONS[index % PILE_RESOLUTIONS.length];
    if (shape === "pr")
      return { shape, resolution, refs: { pr_numbers: [940 + index] } };
    if (shape === "push")
      // A sha no real run wrote and no design mock invented (see the note above).
      return {
        shape,
        resolution,
        refs: {
          commit_shas: [`c0${String(index).padStart(2, "0")}d1e2f3a4b5c6d7e8f90123456789abcdef01`],
        },
      };
    return { shape, resolution, refs: { issue_numbers: [940 + index] } };
  }

  /**
   * Seed the pile and the rhythm in ONE psql session and read the ids back from
   * the same call. Resolve-or-create per title (a worker restarted after a
   * failure reuses the dead one's rows); the visit insert is guarded so a replay
   * does not stack a second five-day rhythm on the reader.
   *
   * One piece is deliberately back-dated three days: the banner's second number
   * is `daysSince(oldest_unseen_at)` — the reach of the pile — and a pile that
   * is all `now()` would pin only the singular form of a word the design wrote
   * plural.
   */
  function seedBacklogPile(): Map<string, string> {
    const titles = BACKLOG_PHRASES.map(
      (phrase, index) => `${BACKLOG_PREFIX} ${index + 1}: ${phrase}`,
    );
    const alice =
      `(SELECT u.id FROM users u JOIN oidc_identities oi ON oi.user_id = u.id ` +
      `WHERE oi.subject = 'alice' LIMIT 1)`;
    const statements: string[] = [];
    titles.forEach((title, index) => {
      const { shape, resolution, refs } = pileShape(index);
      statements.push(
        upsertItemSql(title, shape, resolution, refs),
        tourVersionSql(title, [
          stop(`pile${index + 1}`, {
            kind: "ROUTINE",
            title: `Pile beat ${index + 1}: ${BACKLOG_PHRASES[index]}`,
            narrative:
              `The seeded fixture pile: one routine piece of work with one beat, written so ` +
              `the big-backlog banner has a real unseen count to name. In production these rows ` +
              `are the assistant's own generator — see e2e/tests/catchup-lab.spec.ts for that path.`,
            importance: "routine",
          }),
        ]),
      );
    });
    statements.push(
      `UPDATE catchup_work_items SET updated_at = now() - interval '3 days' ` +
        `WHERE title = ${sqlQuote(titles[0] ?? "")};`,
      // Alice's rhythm: one visit a day for the last five days. The API's rule
      // (catchUpSuggestion, internal/api/catch_up.go) is the MEDIAN gap: under
      // 36 h → 24 h. Daily stamps answer that whatever else the lab's passes
      // stacked up (their gaps are minutes), and the answer is asserted below.
      `INSERT INTO catchup_visits (user_id, visited_at) ` +
        `SELECT ${alice}, now() - (g.n * interval '1 day') FROM generate_series(1, 5) AS g(n) ` +
        `WHERE ${alice} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catchup_visits v2 ` +
        `WHERE v2.user_id = ${alice} AND v2.visited_at < now() - interval '36 hours');`,
      // The ids come back PAIRED with the title, not as a bare list: the T14
      // rest-row assertions below address a row by its seeded piece, and a
      // `LIKE`-ordered SELECT does not promise the insertion order.
      `SELECT 'pile|' || id::text || '|' || title FROM catchup_work_items ` +
        `WHERE title LIKE ${sqlQuote(`${BACKLOG_PREFIX}%`)};`,
    );
    const out = labSql(statements.join(" "));
    const byTitle = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("pile|")) continue;
      const [, id, ...rest] = trimmed.split("|");
      if (id) byTitle.set(rest.join("|"), id);
    }
    const ids = [...byTitle.values()];
    expect(
      ids.length,
      `the big-backlog seed came back with ${ids.length} of ${titles.length} ids ` +
        `(seed ${EMU_PASS_ID} needs project ${PROJECT_SLUG} — psql printed [${out.slice(0, 400)}])`,
    ).toBe(titles.length);
    for (const id of ids) {
      expect(id, "every seeded pile piece answers with a uuid").toMatch(UUID_RE);
    }
    console.log(
      `catch-up big-backlog fixture seeded: ${ids.length} unseen pieces + a daily rhythm ` +
        `(pass ${EMU_PASS_ID}; marked seen again in this test's finally)`,
    );
    return byTitle;
  }

  test("8a big backlog — the banner names the pile, the click sets the window, Keep all dismisses", async ({
    page,
    emu,
  }) => {
    // Its own budget, like this file's other appended proofs: one psql seed, one
    // page load with two reads, three clicks and a cleanup read.
    test.setTimeout(360_000);

    let projectId = "";
    let seeded = new Map<string, string>();
    let bodyPassed = false;
    try {
      await test.step("seed the pile and the reader's rhythm (SEEDED FIXTURE)", async () => {
        const projects = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
        expect(projects.status(), "GET /api/v1/projects answers").toBe(200);
        projectId =
          (
            (await projects.json()) as { items?: { id: string; slug: string }[] }
          ).items?.find((project) => project.slug === PROJECT_SLUG)?.id ?? "";
        expect(projectId, `the seeded '${PROJECT_SLUG}' project exists`).toMatch(/^[0-9a-f-]{36}$/);
        seeded = seedBacklogPile();
      });

      await test.step("the API's own rule answers 24h for the rhythm it was given", async () => {
        // Asserted, not assumed: the banner's proposal is this answer, and the
        // rule lives in the server (catchUpSuggestion's median gap).
        const suggestion = await getSuggestion(page);
        expect(
          suggestion.window,
          `GET /catch-up/visits/suggestion for a reader with five daily stamps ` +
            `(visits_per_week=${suggestion.visits_per_week})`,
        ).toBe("24h");
      });

      await test.step("8a — the banner counts the pile in the wire's own numbers", async () => {
        await page.goto("/catch-up");
        await expect(page.getByTestId("catchup-page"), "design 8a: the page renders").toBeVisible({
          timeout: 30_000,
        });
        await expect(
          page.getByTestId("catchup-window-unseen"),
          "design 8a: the page opens on the wide window, which is when the banner may speak",
        ).toHaveAttribute("aria-pressed", "true");

        const banner = page.getByTestId("catchup-banner");
        await expect(
          banner,
          `design 8a: a pile past 12 unseen gets the big-backlog banner (${seeded.size} seeded)`,
        ).toBeVisible({ timeout: 45_000 });
        // The two numbers are the list read's, not the seed's: the banner prints
        // `total_unseen` and `daysSince(oldest_unseen_at)`, and a generator pass
        // that lands a true story in between moves both. Polled so the check
        // reads the screen and the wire at the same moment, and says which
        // disagreed when it fails.
        await expect
          .poll(
            async () => {
              const wire = await getList(page);
              if (wire.total_unseen <= 12) {
                return `the wire reads ${wire.total_unseen} unseen — the page has nothing to banner about`;
              }
              const days = bannerDays(wire.oldest_unseen_at);
              const wanted = `${wire.total_unseen} unseen over ${days} ${days === 1 ? "day" : "days"}.`;
              const text = normText(await banner.innerText().catch(() => ""));
              return text.includes(wanted)
                ? ""
                : `the banner reads [${text}], the wire says ${wanted}`;
            },
            {
              message: "design 8a: the banner's counts are the counts the list read served",
              timeout: 45_000,
            },
          )
          .toBe("");
        await expect(
          banner,
          "design 8a: the banner proposes the window the visit reads suggest",
        ).toContainText("Narrow to the last 24h?", { timeout: 30_000 });
        await expect(
          banner.getByTestId("catchup-banner-narrow-24h"),
          "the proposal carries its own verb",
        ).toContainText(/last 24h/i);
        await emu.screen("cu-8a-backlog", "big backlog");
      });

      await test.step("8a — 'Last 24h' moves the window chip AND the request", async () => {
        // The claim is about the REQUEST the click sends, so it is read off the
        // network (the same way the 24h chip is proved in the wire-dials test).
        const sinceRequest = page.waitForRequest(
          (request) =>
            request.method() === "GET" &&
            request.url().includes("/api/v1/catch-up/items") &&
            new URL(request.url()).searchParams.has("since"),
          { timeout: 30_000 },
        );
        await page.getByTestId("catchup-banner-narrow-24h").click({ timeout: 15_000 });
        const sent = await sinceRequest;
        const since = new Date(new URL(sent.url()).searchParams.get("since")!);
        const expected = Date.now() - 24 * 3_600_000;
        expect(
          Math.abs(since.getTime() - expected),
          `the banner's proposal sent since=${since.toISOString()}, which is not 24 h back (±15 min)`,
        ).toBeLessThan(15 * 60_000);
        await expect(
          page.getByTestId("catchup-window-24h"),
          "design 8a: narrowing from the banner IS choosing the 24h chip — one window state",
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.getByTestId("catchup-banner"),
          "design 8a: the banner belongs to the wide window, so the narrow one drops it",
        ).toHaveCount(0);
      });

      await test.step("8a — a reload brings it back; Keep all dismisses it for the session", async () => {
        await page.goto("/catch-up");
        const banner = page.getByTestId("catchup-banner");
        await expect(
          banner,
          "the dismissal is per page-view: the pile is still there, so a fresh view asks again",
        ).toBeVisible({ timeout: 45_000 });
        await page.getByTestId("catchup-banner-keep-all").click({ timeout: 15_000 });
        await expect(banner, "design 8a: Keep all answers the reader's no").toHaveCount(0);
        await expect(
          page.getByTestId("catchup-window-unseen"),
          "Keep all kept the wide window — it dismissed the banner, not the reader's debt",
        ).toHaveAttribute("aria-pressed", "true");
        // And it STAYS dismissed for the session: a window change that would
        // otherwise re-draw it (the banner is a function of the wide window)
        // does not bring it back.
        await page.getByTestId("catchup-window-24h").click({ timeout: 15_000 });
        await page.getByTestId("catchup-window-unseen").click({ timeout: 15_000 });
        await expect(
          banner,
          "design 8a: the dismissal holds for the session, not just the paint it happened on",
        ).toHaveCount(0);
      });

      /* ------------------------------------------------ acceptance T14
       * What the rest list actually SHOWS. The box was proven by unit tests only
       * (RestList.test.tsx / CatchUp.test.tsx): a row's how-it-landed label, its
       * resolution chip and its project colour square are all rendered from the
       * row's OWN seeded fields, and none of that had a browser proof. The pile
       * cycles shape (`issue|pr|push`) and resolution across its pieces, so the
       * three landing labels and the chips are all on screen at once.
       */
      await test.step("T14 — every rest row says how the work landed, its resolution, and paints its project colour", async () => {
        // A fresh view of the WIDE window: the Keep-all dismissal above was
        // session state, and the show-seen checkbox must start OFF for the
        // leave/return leg below.
        await page.goto("/catch-up");
        await expect(page.getByTestId("catchup-page"), "design 8a: the page renders").toBeVisible({
          timeout: 30_000,
        });
        await expect(
          page.getByTestId("catchup-rest"),
          "design 8a: the rest panel carries the pieces the cards do not touch",
        ).toBeVisible({ timeout: 45_000 });

        // The wire is the source of truth for what a row OWES to say — the same
        // read the page made, so every assertion below compares the screen to
        // the server rather than to a constant this file picked.
        const wire = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/items`);
        expect(wire.status(), "GET /catch-up/items answers for the row check").toBe(200);
        const wireItems =
          (
            (await wire.json()) as {
              items?: {
                id: string;
                shape: string;
                resolution: string;
                project: { name: string; color: string };
              }[];
            }
          ).items ?? [];
        const byId = new Map(wireItems.map((item) => [item.id, item]));

        // The landing label the shape earns — `ShapeLabel`'s table.
        const LANDING: Record<string, string> = {
          issue: "Issue",
          pr: "PR only",
          push: "Push to main",
        };
        // `RESOLUTION_WORD` (ui/src/components/catchup/importance.ts) — the
        // vocabulary's own lowercase word, colour-coded but NEVER colour alone.
        const RESOLUTION: Record<string, string> = {
          merged: "merged",
          branch_ready: "branch ready",
          open: "open",
          run_failed: "run failed",
          no_code: "no code",
        };

        // Assert the RENDERED rows, not a pick this file hoped would be on screen:
        // a piece with a stop in the tour cards is excluded from the rest (8a),
        // and which pieces those are is the tour's ranking, not this journey's.
        // Enumerating what is actually painted also proves the count: every row
        // has a wire item, and every landing label the pile seeds appears.
        const rest = page.getByTestId("catchup-rest");
        const rowLocators = rest.locator('[data-testid^="catchup-row-"]');
        await expect
          .poll(async () => rowLocators.count(), {
            message: "design 8a: the rest list drew its rows",
            timeout: 45_000,
          })
          .toBeGreaterThan(0);
        const count = await rowLocators.count();

        const labelsSeen = new Set<string>();
        const resolutionsSeen = new Set<string>();
        for (let at = 0; at < count; at += 1) {
          const row = rowLocators.nth(at);
          const testid = (await row.getAttribute("data-testid")) ?? "";
          const id = testid.slice("catchup-row-".length);
          const piece = byId.get(id);
          expect(
            piece,
            `the rendered rest row ${testid} names a piece GET /catch-up/items served`,
          ).toBeTruthy();
          const { shape, resolution, project } = piece as {
            shape: string;
            resolution: string;
            project: { name: string; color: string };
          };
          const landing = LANDING[shape];
          expect(landing, `${shape} is a shape the rest list knows how to label`).toBeTruthy();
          await expect(
            row,
            `design 8a: a ${shape} row names how the code landed (${landing})`,
          ).toContainText(landing);
          labelsSeen.add(landing);
          // The other two labels belong to the other two shapes — a row that
          // renders a second one is a mis-mapped shape, which is the whole defect
          // this box exists to catch.
          await expect(
            row,
            `design 8a: a ${shape} row wears no other shape's landing label`,
          ).not.toContainText(
            new RegExp(
              `\\b(${Object.entries(LANDING)
                .filter(([key]) => key !== shape)
                .map(([, word]) => word.replace(/ /g, "\\s"))
                .join("|")})\\b`,
            ),
          );

          const chip = RESOLUTION[resolution];
          expect(chip, `${resolution} is a resolution the rest list knows how to word`).toBeTruthy();
          await expect(
            row,
            `design 8a: a ${resolution} row's chip reads "${chip}"`,
          ).toContainText(chip);
          resolutionsSeen.add(chip);

          // The project chip's colour square: `RestList.tsx` paints the square
          // with `projectColor(item.project.color)`, so the pixel a reader sees
          // must BE the colour the API served for this piece's project. The
          // browser resolves any CSS colour to `rgb(…)`, so both sides of the
          // comparison go through the same arithmetic.
          const square = row.locator('span[aria-hidden="true"][style*="background"]').first();
          await expect(square, `design 8a: ${id.slice(0, 8)}… draws a project square`).toHaveCount(
            1,
          );
          const painted = await square.evaluate((el: HTMLElement) => {
            const style = getComputedStyle(el);
            return {
              background: style.backgroundColor,
              width: style.width,
              height: style.height,
              // The fallback the component uses for a project with no stored
              // colour — read from the document so this check never hardcodes it.
              quiet: getComputedStyle(document.documentElement)
                .getPropertyValue("--color-project-quiet")
                .trim(),
            };
          });
          const wantColor = project.color.length > 0 ? project.color : painted.quiet;
          expect(
            wantColor,
            `the API serves a chip colour for ${project.name} (or the document a quiet fallback)`,
          ).toMatch(/^#[0-9a-f]{6}$/i);
          expect(
            painted.background,
            `design 8a: the project square on the ${shape} row paints the API colour ${wantColor} ` +
              `(project ${project.name})`,
          ).toBe(hexToRgb(wantColor));
          // The design owns the size (README-catchup Part C: an 8px square); the
          // colour assertion alone would also pass on a 1px dot or a full-width
          // banner, which is not the chip the mock drew.
          expect(painted.width, `the project square is 8px wide (${id.slice(0, 8)}…)`).toBe("8px");
          expect(painted.height, `the project square is 8px tall (${id.slice(0, 8)}…)`).toBe("8px");
        }

        // The seeded pile cycles all three shapes and all three resolutions, so
        // a rest list that never showed one of them proved nothing about it.
        for (const landing of Object.values(LANDING)) {
          expect(
            labelsSeen.has(landing),
            `design 8a: the rest list showed a "${landing}" row (labels seen: ${[
              ...labelsSeen,
            ].join(", ")})`,
          ).toBe(true);
        }
        for (const chip of ["merged", "branch ready", "open"]) {
          expect(
            resolutionsSeen.has(chip),
            `design 8a: the rest list showed a "${chip}" resolution chip (chips seen: ${[
              ...resolutionsSeen,
            ].join(", ")})`,
          ).toBe(true);
        }
        console.log(
          `catch-up T14 rest rows (pass ${EMU_PASS_ID}): ${count} row(s), labels ` +
            `${[...labelsSeen].join("/")}, chips ${[...resolutionsSeen].join("/")}`,
        );
      });

      await test.step("T14 — a piece whose story moved wears UPDATED, and show seen brings a paid piece back", async () => {
        /* Two halves, both on the same rows:
         *  (1) UPDATED is NOT `unseen_stops > 0`. The store answers it from a seen
         *      row at an OLDER tour version (`catchUpUnseenSQL`'s EXISTS over
         *      catchup_seen_stops with `tour_version < l.version`), which is why
         *      the order below is the proof: mark every v1 beat seen (the piece
         *      LEAVES the list), then append v2 (it comes BACK, wearing UPDATED).
         *      A rewrite before the seen-mark would only show a new piece.
         *  (2) show seen: a piece the reader paid leaves the list, and the
         *      checkbox brings the SAME row (same testid, same piece) back. */
        const wire0 = await getList(page);
        const owed = new Set(wire0.items.map((item) => item.id));
        const candidates = [...seeded.entries()].filter(([, id]) => owed.has(id));
        expect(
          candidates.length,
          "at least two of the pass's seeded pile pieces are still owed, so one can be rewritten and another paid",
        ).toBeGreaterThanOrEqual(2);
        // Take the first piece that still STARTS at version 1: a later pass over
        // the same lab can find a piece an earlier pass already rewrote still
        // owed (the v2 append below is `WHERE NOT EXISTS`-guarded, so the ONLY
        // clean "saw v1, never saw v2" starting state is a never-rewritten
        // piece — acceptance 42558168285's pass-1 shape).
        let movedTitle = "";
        let movedId = "";
        for (const [title, id] of candidates) {
          if ((await getItem(page, id)).latest?.version === 1) {
            movedTitle = title;
            movedId = id;
            break;
          }
        }
        expect(
          movedId,
          "one of the owed pile pieces still starts at tour version 1",
        ).not.toBe("");
        const [paidTitle, paidId] = (candidates.find(([, id]) => id !== movedId) ?? [
          "",
          "",
        ]) as [string, string];
        expect(
          paidId,
          "a second owed pile piece is left for the show-seen half",
        ).not.toBe("");

        /* ---- (1) the story moves: seen at v1, then a second version ---- */
        const movedItem = await getItem(page, movedId);
        expect(movedItem.latest?.version, `${movedTitle} starts at tour version 1`).toBe(1);
        const movedStops = (movedItem.latest?.stops ?? []).map((one) => one.id);
        expect(movedStops.length, `${movedTitle} carries at least one beat`).toBeGreaterThan(0);
        const markedSeen = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/catch-up/items/${movedId}/seen`,
          { version: 1, stop_ids: movedStops },
        );
        expect(
          markedSeen.status(),
          `POST /catch-up/items/${movedId}/seen answers 204 for every v1 beat`,
        ).toBe(204);
        // Paid, so owed on nothing — the list read proves it before the rewrite.
        await expect
          .poll(
            async () => {
              const list = await getList(page);
              return list.items.some((item) => item.id === movedId);
            },
            {
              message: `${movedTitle} is still owed after every v1 beat was marked seen`,
              timeout: 60_000,
            },
          )
          .toBe(false);

        // The rewrite. There is NO product route that writes a tour (ADR-0078
        // § Decision 7 — the generator is the server's own assistant), so this
        // goes through the store's own table like every other seeded row in this
        // file: v1's beat carried forward with its id and origin, plus one beat
        // the reader has never seen (`added_in_version: 2`).
        const appendOut = labSql(
          `INSERT INTO catchup_tour_versions (work_item_id, version, reason, stops) ` +
            `SELECT ${sqlQuote(movedId)}::uuid, 2, ` +
            `${sqlQuote("Seeded rewrite for the emulator's UPDATED badge (e2e/emulator/catchup.spec.ts)")}, ` +
            `${sqlQuote(
              JSON.stringify([
                {
                  id: movedStops[0],
                  title: `Pile beat carried: ${movedTitle}`,
                  narrative:
                    "The beat this piece already told — carried forward with its own id, so a reader who saw it stays read.",
                  kind: "ROUTINE",
                  importance: "routine",
                  added_in_version: 1,
                },
                {
                  id: STOP_ID("t14-new"),
                  title: "Pile beat new: the fix needs a regression test",
                  narrative:
                    "The seeded rewrite: a beat this reader has never seen, which is what turns the piece from read to UPDATED.",
                  kind: "ROUTINE",
                  importance: "routine",
                  added_in_version: 2,
                },
              ]),
            )}::jsonb ` +
            `WHERE NOT EXISTS (SELECT 1 FROM catchup_tour_versions v ` +
            `WHERE v.work_item_id = ${sqlQuote(movedId)}::uuid AND v.version = 2); ` +
            // A real append bumps the work item in the SAME statement that writes
            // the version (ADR-0078: `updated_at` is the clock `since` filters on).
            // The fixture stamps it TWO HOURS back rather than at now(): it stays
            // inside any 24 h window a reader may set, and the tour ranks equal-
            // importance pieces newest-first — a now()-stamped routine beat would
            // lead page 1 of the cards, and the rest list then honestly DROPS the
            // piece (RestList's `tourStopsByItem` exclusion, mock 8a). This proof
            // asserts UPDATED where the rest rows print it, so the piece must not
            // be carded; with twelve fresher routine pieces of the pile ahead of
            // it on a four-stop page, it cannot be.
            `UPDATE catchup_work_items SET updated_at = now() - interval '2 hours' ` +
            `WHERE id = ${sqlQuote(movedId)}::uuid; ` +
            `SELECT 'versions|' || count(*) FROM catchup_tour_versions v ` +
            `WHERE v.work_item_id = ${sqlQuote(movedId)}::uuid;`,
        );
        expect(
          /versions\|2/.test(appendOut),
          `the seeded piece ${movedTitle} grew a second tour version (psql printed [${appendOut}])`,
        ).toBe(true);

        // Back on the page: the piece is OWED again (the new beat) and it wears
        // UPDATED — the badge a story earns only when this reader saw an older
        // version of it. The WIRE is read first: unseen_stops > 0, updated true,
        // and none of its beats on page 1 of the cards — a carded piece is
        // correctly absent from the rest, and that exclusion (not the badge) is
        // what a failing toBeVisible here would otherwise blame the store for
        // (acceptance 42558168285, pass 1: the rewrite's now() bump carded the
        // piece; pass 2: the rest briefly drew it before the tour load excluded
        // it, and the badge check raced that exclusion).
        await expect
          .poll(
            async () => {
              const list = await getList(page);
              const row = list.items.find((item) => item.id === movedId);
              const tour = await getTour(page);
              return (
                (row?.unseen_stops ?? 0) > 0 &&
                row?.updated === true &&
                !tour.stops.some((stop) => stop.work_item_id === movedId)
              );
            },
            {
              message: `the wire owes ${movedTitle} again as UPDATED, on the rest's side (not the cards')`,
              timeout: 60_000,
            },
          )
          .toBe(true);
        await page.goto("/catch-up");
        const movedRow = page.getByTestId("catchup-rest").getByTestId(`catchup-row-${movedId}`);
        await expect(
          movedRow,
          `design 8a: ${movedTitle} is owed again once its story grew a second version`,
        ).toBeVisible({ timeout: 45_000 });
        await expect(
          movedRow,
          "design 8a: a piece whose story moved AFTER this reader saw it is UPDATED",
        ).toContainText("UPDATED");

        /* ---- (2) show seen: a paid piece leaves, and the same row returns ---- */
        await expect(
          page.getByTestId("catchup-rest").getByTestId(`catchup-row-${paidId}`),
          `design 8a: ${paidTitle} starts in the rest list`,
        ).toBeVisible({ timeout: 30_000 });
        const paidItem = await getItem(page, paidId);
        const paidStops = (paidItem.latest?.stops ?? []).map((one) => one.id);
        expect(paidStops.length, `${paidTitle} carries at least one beat`).toBeGreaterThan(0);
        const paidSeen = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/catch-up/items/${paidId}/seen`,
          { version: paidItem.latest?.version ?? 1, stop_ids: paidStops },
        );
        expect(
          paidSeen.status(),
          `POST /catch-up/items/${paidId}/seen answers 204 for every beat`,
        ).toBe(204);
        await expect
          .poll(
            async () => {
              const list = await getList(page);
              return list.items.some((item) => item.id === paidId);
            },
            {
              message: `${paidTitle} is still owed on the wire after its beats were marked seen`,
              timeout: 60_000,
            },
          )
          .toBe(false);
        // The reload is the point: with the checkbox OFF a paid piece is gone
        // from the list, and it is the checkbox that brings it back — not a
        // cached render.
        await page.goto("/catch-up");
        await expect(page.getByTestId("catchup-rest")).toBeVisible({ timeout: 45_000 });
        await expect(
          page.getByTestId(`catchup-row-${paidId}`),
          `design 8a: a piece the reader has paid is gone from the rest`,
        ).toHaveCount(0);

        const showSeen = page.getByTestId("catchup-show-seen");
        await expect(showSeen, "the rest list carries the show-seen checkbox").toBeVisible({
          timeout: 15_000,
        });
        const seenRequest = page.waitForRequest(
          (request) =>
            request.method() === "GET" &&
            request.url().includes("/api/v1/catch-up/items") &&
            new URL(request.url()).searchParams.get("include_seen") === "true",
          { timeout: 30_000 },
        );
        await showSeen.click({ timeout: 15_000 });
        await seenRequest;
        await expect(
          page.getByTestId("catchup-rest").getByTestId(`catchup-row-${paidId}`),
          `design 8a: show seen brings ${paidTitle} back — the same row, the same piece`,
        ).toBeVisible({ timeout: 30_000 });
        // And it reads as paid: the row's own checkbox is what says "this reader
        // owes nothing here" (RestList.tsx checks it at unseen_stops === 0).
        await expect(
          page
            .getByTestId(`catchup-row-${paidId}`)
            .locator('input[type="checkbox"]')
            .first(),
          `design 8a: the brought-back ${paidTitle} row reads as seen`,
        ).toBeChecked();
        await emu.screen("cu-8a-backlog", "updated-and-show-seen");
      });
      bodyPassed = true;
    } finally {
      await test.step("clean up — the pass's pile is marked seen (scoped to this project)", async () => {
        try {
          await cleanUpBacklogPile(page, projectId, [...seeded.values()]);
        } catch (error) {
          if (bodyPassed) throw error;
          // A dead page must not bury the leg's real failure under a second one.
          // Logged LOUD, because 13 unseen pieces left behind is the defect the
          // next pass would otherwise debug without this line.
          console.log(
            `catch-up CLEANUP problem after an already-failing leg (seed ${EMU_PASS_ID}, ` +
              `project ${PROJECT_SLUG}): ${String(error)} — ${seeded.size} seeded pieces ` +
              `may still read unseen`,
          );
        }
      });
    }
  });

  /**
   * The product's own verb, scoped to the one project the rows were seeded in:
   * `POST /api/v1/catch-up/seen-all {projects:[id]}` (204, no body), then the
   * list read proves this pass's pieces are gone. The rows stay, seen, with
   * their SEEDED FIXTURE summary — the alternative (DELETE) is not a route the
   * product has, and the point is the reader's DEBT, which is what every later
   * screen and badge reads.
   */
  async function cleanUpBacklogPile(page: Page, projectId: string, seeded: string[]): Promise<void> {
    if (projectId === "") return;
    const seen = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/catch-up/seen-all`, {
      projects: [projectId],
    });
    expect(
      seen.status(),
      `POST /catch-up/seen-all scoped to ${PROJECT_SLUG} answers 204`,
    ).toBe(204);
    if (seeded.length === 0) return;
    await expect
      .poll(
        async () => {
          const list = await getList(page);
          return list.items.filter((row) => seeded.includes(row.id)).length;
        },
        {
          message:
            "GET /catch-up/items still owes one of the pass's seeded pile pieces after the cleanup",
          timeout: 60_000,
        },
      )
      .toBe(0);
  }

  /* ------------------------------------------------- acceptance T15 (piece page)
   * The piece page's seen-by roster, the "you have not seen the {time} update"
   * sentence, and Copy link — three things the box rested on
   * `ui/src/pages/CatchUpItem.test.tsx` for.
   *
   * The roster is a fact about OTHER readers, so it needs a second identity: a
   * fresh browser context with an EXPLICIT empty storage state (this describe
   * carries alice's, and @playwright/test merges it into every `browser.newContext`
   * that does not name one — the acceptance 42524332059 hang `gate-decision-conflict
   * .spec.ts` documents), signed in through the mock IdP exactly as the lab's seed
   * did (`{"email":"<subject>@example.test"}`, docs/compatibility/probes/m4/seed.sh
   * `login()`). The app derives his display name from those claims
   * (ADR-0012 § 4: name → preferred_username → subject — none here but the
   * subject), so his row is `bob`, and the avatar's initials and the seen line's
   * name are both computed from THAT string by the component.
   *
   * The ordering is the proof, not decoration. `CatchUpItem.tsx` renders
   * `seen by {names} · you have not seen the {updateClock} update` only when
   * `updated` (this reader's recorded version < the newest) AND the roster is
   * non-empty — i.e. somebody finished the NEWEST version while alice stopped at
   * an older one. So: bob finishes v1 (the roster names him) → alice finishes v1
   * too → the story is rewritten → bob finishes the new version (the roster still
   * names him) → alice, who saw v1, reads the update sentence.
   *
   * The rewrite goes through the store's own table: ADR-0078 § Decision 7 gives
   * the product no route that writes a tour, which is why every tour row in this
   * file is seeded.
   */
  test("T15 piece page — seen-by names the other reader, the update sentence fires, Copy link copies", async ({
    browser,
    page,
    emu,
  }) => {
    // Its own budget, like this file's other proofs: one seed, two sign-ins,
    // three seen writes, one rewrite and a page load or two.
    test.setTimeout(300_000);

    const T15_TITLE = `Emu catch-up t15 ${EMU_PASS_ID}: the seen-by roster names the other reader`;

    await test.step("T15 — seed the pass's own piece (two unseen beats)", async () => {
      const out = labSql(
        upsertItemSql(T15_TITLE, "pr", "branch_ready", { pr_numbers: [990] }) +
          " " +
          tourVersionSql(T15_TITLE, [
            stop("t15-a", {
              kind: "UI CHANGE",
              title: "T15 beat one: the roster line and the avatar",
              narrative:
                "The seeded fixture: the first beat of the piece this proof reads. Nothing asks anything here.",
              importance: "worth_a_look",
            }),
            stop("t15-b", {
              kind: "UI CHANGE",
              title: "T15 beat two: the story that moves",
              narrative:
                "The seeded fixture: the second beat. Finishing the newest version is what puts a name in the roster.",
              importance: "worth_a_look",
            }),
          ]) +
          ` SELECT 't15|' || id::text FROM catchup_work_items WHERE title = ${sqlQuote(T15_TITLE)};`,
      );
      const id = /t15\|([0-9a-fA-F-]{36})/.exec(out)?.[1] ?? "";
      expect(
        id,
        `the T15 fixture piece did not come back with a uuid (psql printed [${out}])`,
      ).toMatch(UUID_RE);
      const fresh = await getItem(page, id);
      expect(
        (fresh.latest?.stops ?? []).filter((one) => !one.seen).length,
        "both T15 beats are unseen when the leg opens (a replay after a mid-leg failure owes this leg a fresh read)",
      ).toBe(2);
    });

    // Resolved from the wire, not from the seed: the id every step below acts on.
    const pieceList = await page.request.get(`${EMU_BASE_URL}/api/v1/catch-up/items`, {
      params: { include_seen: "true" },
    });
    expect(pieceList.status(), "GET /catch-up/items (include_seen) answers").toBe(200);
    const pieceId =
      (
        (await pieceList.json()) as { items?: { id: string; title: string }[] }
      ).items?.find((item) => item.title === T15_TITLE)?.id ?? "";
    expect(pieceId, "the T15 fixture piece is in alice's list").toMatch(UUID_RE);

    /** Mark every beat of the piece's NEWEST tour version seen through the
     * product's own route, as the caller whose session `mutatePage` carries.
     * The stop ids come from the read (the store admits only ids the NAMED
     * version carries, so guessing one would mark nothing and the roster would
     * honestly stay empty — a silent red rather than a loud one). */
    const finishLatest = async (mutatePage: Page): Promise<number> => {
      const me = await mutatePage.request.get(`${EMU_BASE_URL}/api/v1/catch-up/items/${pieceId}`);
      expect(me.status(), "GET /catch-up/items/{id} answers for the finisher").toBe(200);
      const item = (await me.json()) as { latest?: { version: number; stops: { id: string }[] } };
      const version = item.latest?.version ?? 0;
      const stopIds = (item.latest?.stops ?? []).map((one) => one.id);
      expect(version, "the piece has a tour version to finish").toBeGreaterThan(0);
      expect(stopIds.length, "the piece's newest tour has beats to finish").toBeGreaterThan(0);
      const seen = await apiMutate(
        mutatePage,
        "POST",
        `${EMU_BASE_URL}/api/v1/catch-up/items/${pieceId}/seen`,
        { version, stop_ids: stopIds },
      );
      expect(
        seen.status(),
        `POST /catch-up/items/${pieceId}/seen answers 204 at version ${version}`,
      ).toBe(204);
      return version;
    };

    let second: { page: Page; context: BrowserContext; name: string } | null = null;
    try {
      await test.step("T15 — a second seeded reader finishes the newest version", async () => {
        const reader = await signInSecondReader(browser);
        second = reader;
        await finishLatest(reader.page);
        // Proven on the wire before the browser is asked to show it: alice's own
        // read lists him, so a missing avatar is the UI's fault, not a write that
        // never landed.
        await expect
          .poll(
            async () => {
              const item = await getItem(page, pieceId);
              return (item.seen_by ?? []).map((seen) => seen.name).join(", ");
            },
            {
              message: "GET /catch-up/items/{id} does not list the second reader in seen_by",
              timeout: 60_000,
            },
          )
          .toMatch(/bob/i);
      });

      await test.step("T15 — as alice the roster shows his initials and names him", async () => {
        // The closure inside `expect.poll`/`toContainText` may run after the
        // outer `second` is reassigned or nulled by a failure path, so this step
        // works from a bound copy of what it needs.
        const secondReader = second as {
          page: Page;
          context: BrowserContext;
          name: string;
        };
        const secondName = secondReader.name;
        await page.goto(`/catch-up/${pieceId}`);
        await expect(
          page.getByTestId("catchup-item"),
          "design 8b: the piece page renders",
        ).toBeVisible({ timeout: 30_000 });
        const roster = page.getByTestId("catchup-item-seen-by");
        await expect(roster, "design 8b: the seen-by avatar strip is drawn").toBeVisible({
          timeout: 30_000,
        });
        // The initials the component computes from his display name (`bob` →
        // first letter of each of up to two words, upper-cased).
        const expected = initialsOf(secondName);
        const avatars = roster.locator("> span");
        await expect
          .poll(async () => avatars.count(), {
            message: "the seen-by strip drew an avatar per reader",
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(1);
        const shown: string[] = [];
        for (let at = 0; at < (await avatars.count()); at += 1) {
          shown.push(((await avatars.nth(at).textContent()) ?? "").trim());
        }
        expect(
          shown,
          `design 8b: the roster carries ${secondName}'s initials (${expected}); avatars read ${JSON.stringify(shown)}`,
        ).toContain(expected);
        const line = page.getByTestId("catchup-item-seen-line");
        await expect(line, "design 8b: the seen line names the reader").toContainText("seen by", {
          timeout: 30_000,
        });
        await expect(line, `design 8b: the seen line names ${secondName}`).toContainText(
          firstNameOf(secondName),
        );
        // The sentence's TAIL is not this step's claim (phase 2 pins the update
        // form the brief asks for); the roster and the name are.
        // Same page, same landmark set as the screen journey's 8b capture — the
        // roster is a fact about this screen, not a new screen.
        await emu.screen("cu-8b", "piece");
      });

      await test.step("T15 — alice saw v1, the story moved, and he saw that too", async () => {
        // Alice finishes what she is looking at: version 1.
        await finishLatest(page);
        // The rewrite: v1's two beats carried forward with their ids and their
        // origin, plus one beat nobody has seen. `added_in_version` is the store's
        // own rule for what a reader still owes (ADR-0078 § Decision 3), so the
        // carried beats stay read and the new one is owed.
        const rewritten = labSql(
          `INSERT INTO catchup_tour_versions (work_item_id, version, reason, stops) ` +
            `SELECT ${sqlQuote(pieceId)}::uuid, 2, ` +
            `${sqlQuote("Seeded T15 rewrite for the update sentence (e2e/emulator/catchup.spec.ts)")}, ` +
            `${sqlQuote(
              JSON.stringify([
                {
                  id: STOP_ID("t15-a"),
                  title: "T15 beat one: the roster line and the avatar",
                  narrative: "Carried forward with its id, so the reader who saw it stays read.",
                  kind: "UI CHANGE",
                  importance: "worth_a_look",
                  added_in_version: 1,
                },
                {
                  id: STOP_ID("t15-b"),
                  title: "T15 beat two: the story that moves",
                  narrative: "Carried forward too.",
                  kind: "UI CHANGE",
                  importance: "worth_a_look",
                  added_in_version: 1,
                },
                {
                  id: STOP_ID("t15-c"),
                  title: "T15 beat new: the second version's own beat",
                  narrative:
                    "The seeded rewrite: the beat that makes the piece UPDATED for a reader who stopped at version 1.",
                  kind: "UI CHANGE",
                  importance: "must_know",
                  added_in_version: 2,
                },
              ]),
            )}::jsonb ` +
            `WHERE NOT EXISTS (SELECT 1 FROM catchup_tour_versions v ` +
            `WHERE v.work_item_id = ${sqlQuote(pieceId)}::uuid AND v.version = 2); ` +
            `UPDATE catchup_work_items SET updated_at = now() WHERE id = ${sqlQuote(pieceId)}::uuid; ` +
            `SELECT 'versions|' || count(*) FROM catchup_tour_versions v ` +
            `WHERE v.work_item_id = ${sqlQuote(pieceId)}::uuid;`,
        );
        expect(
          /versions\|2/.test(rewritten),
          `the T15 piece grew a second tour version (psql printed [${rewritten}])`,
        ).toBe(true);
        // The second reader finishes the NEW version too: the roster only lists
        // readers who finished the newest one, and the update sentence needs a
        // non-empty roster to print a name at all.
        await finishLatest((second as { page: Page }).page);
      });

      await test.step("T15 — alice reads 'you have not seen the {time} update'", async () => {
        const secondName = (second as { name: string }).name;
        await page.goto(`/catch-up/${pieceId}`);
        const line = page.getByTestId("catchup-item-seen-line");
        await expect(
          line,
          `design 8b: alice saw version 1, the story moved, so the line says so and names ${secondName}`,
        ).toContainText(/you have not seen the .* update/, { timeout: 30_000 });
        await expect(line, "design 8b: …and the line still names the reader who finished it").toContainText(
          firstNameOf((second as { name: string }).name),
        );
        // The clock in the sentence is the component's own `clockOf` of the
        // newest version's created_at — compared to the SAME Intl call run in the
        // page, so no hard-coded HH:MM and no timezone assumption.
        const item = await getItem(page, pieceId);
        const latestCreated = item.latest?.created_at;
        expect(latestCreated, "the piece's newest version carries its created_at").toBeTruthy();
        const wantClock = await page.evaluate((iso: string) => {
          return new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(iso));
        }, String(latestCreated));
        await expect(
          line,
          `design 8b: the sentence names the newest version's own clock (${wantClock})`,
        ).toContainText(`you have not seen the ${wantClock} update`);
        // And the roster still draws his initials on the rewritten page.
        await expect(
          page.getByTestId("catchup-item-seen-by").locator("> span"),
          `design 8b: the initials of ${secondName} are still drawn after the rewrite`,
        ).toHaveText(new RegExp(initialsOf(secondName)));
      });

      await test.step("T15 — Copy link puts the piece's own URL on the clipboard", async () => {
        // The clipboard is a permissioned API: Chromium refuses the read without
        // both halves, and Playwright's headless context starts with neither.
        const context = page.context();
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.bringToFront();
        const copy = page.getByTestId("catchup-item-copy");
        await expect(copy, "design 8b: the piece offers Copy link").toBeVisible({
          timeout: 30_000,
        });
        await copy.click({ timeout: 15_000 });
        // The button's own confirmation (it flips to "Copied" and back on a
        // 2 s timer) is the UI's half of the claim…
        await expect(copy, "design 8b: the verb confirms the copy").toContainText(/copied/i, {
          timeout: 1_500,
        });
        // …and the clipboard is the proof: exactly the piece's address, off the
        // origin the page is served from (the component writes
        // `${window.location.origin}/catch-up/${workId}`).
        const origin = new URL(EMU_BASE_URL).origin;
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
            message: "the clipboard does not hold the piece's own URL",
            timeout: 15_000,
          })
          .toBe(`${origin}/catch-up/${pieceId}`);
      });
    } finally {
      // The second context is the journey's own, closed under a catch like the
      // empty-Today proof's (a dead page must not bury the real failure).
      const held = second as { context: BrowserContext } | null;
      if (held !== null) await held.context.close().catch(() => undefined);
      // Leave no debt behind: the pass's own T15 piece is marked seen, scoped to
      // the one project it was seeded in, so a later pass's badge never reads it.
      await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/catch-up/seen-all`, {
        projects: [await m4ExitProjectId(page)],
      }).catch(() => undefined);
    }
  });
});
