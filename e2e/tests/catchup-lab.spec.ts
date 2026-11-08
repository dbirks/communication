// T17 · Catch up, proven end to end in the lab (ADR-0078 § Migration, step 2).
//
// The acceptance bar this suite exists for: "catch up is shown working end to
// end in the lab: a finished run produces a tour, it appears unseen, playing it
// marks it seen, and a decision reply reaches the agent." Every leg is one
// real journey over the lab's own HTTP surface and browser — no stubbed
// generator, no seeded tour except the fourth leg, which says so in its name.
//
// It runs against the real-model M4 lab ONLY (compose.yml + compose.harness.yml
// + compose.m4.yml + compose.real.yml, i.e. the `lab-e2e` acceptance job): the
// tour is written by the server's own assistant over ADR-0034's egress, so a
// deployment with no model has nothing to prove here. The gate is the same
// env-flag idiom as the neighbouring real-agent suites, and the skip message
// names the flag and the lab URL exactly like they do:
//   COMMUNICATION_E2E_ISSUE2=1 E2E_BASE_URL=http://localhost:18091 \
//     pnpm exec playwright test tests/catchup-lab.spec.ts
//
// WHY THE COOLDOWN KNOB MATTERS HERE: `GET /catch-up/items` schedules the pass
// (ADR-0078's lazy trigger) and each run is retried no sooner than
// COMMUNICATION_CATCHUP_GEN_COOLDOWN after the last attempt. The lab sets that
// to 20s (compose.real.yml) so a first attempt that the model answered badly
// is retried inside this file's bounded wait; with the shipped 10m default one
// bad answer would block the tour past any deadline a test could carry. The
// wait below is still bounded and still fails loudly — a generator that never
// writes is a FAILURE this suite reports with the last list read in hand.
//
// Lab identities and the `m4-exit` project come from
// docs/compatibility/probes/m4/seed.sh: alice is its maintainer, admin holds
// the library role that publishes a pipeline. This suite ADDS a pipeline, a
// run, a thread and (leg 4 only) one work item, all stamped; it resets nothing
// and touches no other suite's rows.
//
// Every leg calls the local `evidence()` helper: a full-page screenshot into
// ${E2E_EVIDENCE_DIR ?? "test-results/catchup"}/<name>.png plus one console
// line `EVIDENCE <name>: <what it proves>`.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { AGENT_TURN_TIMEOUT_MS, BASE_URL } from "./env.js";
import { gotoApp, scrollToTopForCapture, signIn } from "./helpers.js";
import {
  apiAgentProfiles,
  apiCsrf,
  apiPublishPipeline,
  apiScratchProject,
  apiStartRun,
  type Csrf,
  type ProjectRow,
} from "./shell-helpers.js";
import { seedSql, sqlQuote } from "./lab-launcher.js";

/** The gate: the real-model M4 lab only, exactly like the issue2 suites. */
const CATCHUP_ENABLED = process.env.COMMUNICATION_E2E_ISSUE2 === "1";
const CATCHUP_GATE =
  "requires the real-model M4 lab (COMMUNICATION_E2E_ISSUE2=1, E2E_BASE_URL=http://localhost:18091)";

/** Unique per run so re-runs never collide with their own earlier rows. */
const STAMP = process.env.E2E_SHELL_STAMP ?? `c${Date.now().toString(36)}`;
const SLUG = `catchup-lab-${STAMP}`;
const PROJECT_SLUG = "m4-exit";
/** The seeded repository binding (docs/compatibility/probes/m4/seed.sh). */
const REPO_BINDING = "app";
/** The lab's real agent profile (the one issue2-conversations drives a turn on). */
const PROFILE = "m4-implementer";
const PONG = "Reply with exactly the word: pong";

/** A worker prepare plus one printf node is minutes, not seconds; bounded. */
const RUN_TIMEOUT_MS = Number(process.env.E2E_CATCHUP_RUN_TIMEOUT_MS ?? 420_000);
/** The brief's own bound on the generator: poll every 10s for up to 6 min. */
const TOUR_TIMEOUT_MS = Number(process.env.E2E_CATCHUP_TOUR_TIMEOUT_MS ?? 360_000);
const TOUR_POLL_MS = 10_000;
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/catchup";

/** One piece of journey evidence: a screenshot plus a single log line. */
async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await scrollToTopForCapture(page);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/* ------------------------------------------------ the wire's catch-up shapes
 * The read-only mirror of internal/api/catch_up.go's views — the fields this
 * journey asserts, nothing else. The closed vocabularies are the server's
 * (internal/domain/catchup.go), restated here so a widening on the wire that
 * this file did not ask for shows up as a failure, not a shrug. */

const IMPORTANCES = ["must_know", "worth_a_look", "routine"] as const;
const EVIDENCE_TYPES = ["log", "diff", "screenshot", "files"] as const;

interface CatchUpListRow {
  id: string;
  title: string;
  unseen_stops: number;
  total_stops: number;
  importance: string;
  refs?: { run_ids?: string[] };
}
interface CatchUpListBody {
  items: CatchUpListRow[];
  total_unseen: number;
  oldest_unseen_at: string | null;
}
interface CatchUpStopWire {
  id: string;
  title: string;
  narrative: string;
  kind?: string;
  importance: string;
  added_in_version: number;
  seen: boolean;
  evidence?: Record<string, unknown>[];
  decision?: { prompt: string; options: string[]; allow_text: boolean };
}
interface CatchUpItemBody {
  id: string;
  title: string;
  source_run_id: string | null;
  conversation_id: string | null;
  latest: { version: number; reason: string; stops: CatchUpStopWire[] } | null;
}

async function getJson<T>(request: APIRequestContext, route: string): Promise<T> {
  const res = await request.get(BASE_URL + route);
  if (!res.ok()) throw new Error(`GET ${route} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** POST with the session's CSRF pair (mutations 403 without it). */
async function postJson<T>(
  request: APIRequestContext,
  csrf: Csrf,
  route: string,
  body: unknown,
): Promise<T> {
  const res = await request.post(BASE_URL + route, {
    data: body,
    headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
  });
  const text = await res.text().catch(() => "?");
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(`POST ${route} -> ${res.status()}: ${text.slice(0, 400)}`);
  }
  return text === "" ? ({} as T) : (JSON.parse(text) as T);
}

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "interrupted"];

/**
 * The run the generator owes a tour for: one deterministic `process.exec` node
 * (the same twin trick every lab suite uses — no model endpoint on the worker,
 * no real agent turn), so the cheapest thing that still MOVES A RUN TO A
 * TERMINAL STATUS is what the tour is written about. `goal` is the sentence
 * the DATA block quotes, so the story has something true to say.
 */
const SCRATCH_YAML = (
  slug: string,
): string => `# catchup-lab scratch run: one deterministic process.exec node.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Catch-up lab scratch run: one deterministic node, no model call, terminal on its own.
spec:
  inputs:
    type: object
    required: [goal, repository]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the run set out to do (the tour quotes it).
      repository:
        type: string
        minLength: 1
        description: Project repository binding name, e.g. app.
  outputs:
    type: object
    required: [note]
    properties:
      note: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 900
    maxNodeExecutions: 3
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: note
    kind: process.exec
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"note":"the note step printed its line; nothing else ran"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [note]
      properties:
        note: {type: string}
  resultBindings:
    note: \${{ nodes.note.outputs.note }}
`;

/**
 * The stop document the store writes (internal/domain/catchup.go: CatchUpStop)
 * — the exact jsonb shape `catchup_tour_versions.stops` holds and
 * `decodeCatchUpStops` reads back. Leg 4 writes one of these itself.
 */
function decisionStopJson(stopId: string): string {
  return JSON.stringify([
    {
      id: stopId,
      title: "The reminder window it shipped with",
      narrative:
        "The run set the reminder to 24 hours and finished. It wants to know whether that was the right call.",
      kind: "YOUR CALL",
      importance: "must_know",
      added_in_version: 1,
      evidence: [
        {
          type: "log",
          source: "run",
          text: "reminder window set to 24h by the seeded decision fixture",
        },
      ],
      decision: {
        // "Change to 12h" FIRST so the option the journey clicks —
        // `catchup-decision-option-1`, the ordinal the label carries — is the
        // one whose text the leg then demands to see verbatim in the thread.
        prompt: "Keep 24h or change to 12h?",
        options: ["Change to 12h", "Keep 24h"],
        allow_text: false,
      },
    },
  ]);
}

test.describe("catch up in the lab (tour from a finished run → unseen → seen → decision reply)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!CATCHUP_ENABLED, CATCHUP_GATE);
  test.use({ viewport: { width: 1440, height: 900 } });

  let admin: Page;
  let alice: Page;
  let adminContext: BrowserContext;
  let aliceContext: BrowserContext;
  let project: ProjectRow;
  let runId = "";
  let runStatus = "";
  let itemId = "";

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    aliceContext = await browser.newContext();
    admin = await adminContext.newPage();
    alice = await aliceContext.newPage();
    // The mock IdP takes any subject; the lab's rows decide what each one sees.
    await signIn(admin, "admin", { email: "admin@example.test" });
    await signIn(alice, "alice", { email: "alice@example.test" });
    project = await apiScratchProject(alice.request);
    expect(project.slug, "the lab seeded the project this suite writes into").toBe(PROJECT_SLUG);
  });

  test.afterAll(async () => {
    for (const context of [adminContext, aliceContext]) {
      if (context) await context.close();
    }
  });

  test("leg 1: a finished run produces a tour the API serves", async () => {
    // A worker prepare plus the generator's model call, then the poll's own
    // bound — the ceiling sits above both so the poll reports the cause.
    test.setTimeout(RUN_TIMEOUT_MS + TOUR_TIMEOUT_MS + 120_000);

    // --- start the cheapest run the lab already runs successfully. ---
    const adminCsrf = await apiCsrf(admin.request);
    const { revisionId } = await apiPublishPipeline(
      admin.request,
      adminCsrf,
      SLUG,
      SCRATCH_YAML(SLUG),
    );
    const aliceCsrf = await apiCsrf(alice.request);
    runId = await apiStartRun(alice.request, aliceCsrf, project.id, revisionId, {
      goal: `Catch up on the scratch note run ${STAMP}`,
      repository: REPO_BINDING,
    });
    console.log(`catchup-lab: run ${runId} started in project ${project.slug} (${revisionId})`);

    // --- wait for a FINISHED run: completed or failed both are finished. ---
    const runDeadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const run = await getJson<{ status: string }>(alice.request, `/api/v1/runs/${runId}`);
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        runStatus = run.status;
        break;
      }
      if (Date.now() >= runDeadline) {
        throw new Error(
          `run ${runId} never reached a terminal status within ${RUN_TIMEOUT_MS} ms ` +
            `(last read: ${run.status}) — the tour has nothing to be written about`,
        );
      }
      await alice.waitForTimeout(5_000);
    }
    console.log(`catchup-lab: run ${runId} finished as ${runStatus}`);

    // --- the list read IS the trigger (ADR-0078 § Migration). Poll it. ---
    let found: CatchUpItemBody | null = null;
    let lastList = "";
    const inspected = new Set<string>();
    const deadline = Date.now() + TOUR_TIMEOUT_MS;
    while (found === null) {
      const list = await getJson<CatchUpListBody>(
        alice.request,
        "/api/v1/catch-up/items?include_seen=true",
      );
      lastList = JSON.stringify(list);
      // Newest first, and only the rows this poll has not already opened:
      // `source_run_id` is the item read's member, not the list row's.
      for (const row of list.items) {
        if (inspected.has(row.id)) continue;
        inspected.add(row.id);
        const item = await getJson<CatchUpItemBody>(
          alice.request,
          `/api/v1/catch-up/items/${row.id}`,
        );
        if (item.source_run_id === runId) {
          found = item;
          break;
        }
      }
      if (found !== null) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `the generator never wrote a catch-up item for run ${runId} within ` +
            `${TOUR_TIMEOUT_MS} ms of the run finishing as ${runStatus} — every ` +
            `GET /catch-up/items in that window scheduled a pass and none of its ` +
            `items names this run. Last list read: ${lastList}`,
        );
      }
      await alice.waitForTimeout(TOUR_POLL_MS);
    }

    // --- the tour itself: beats the surface can render, with server-held facts.
    const item = found as CatchUpItemBody;
    itemId = item.id;
    expect(item.latest, `work item ${itemId} carries no tour (latest is null)`).not.toBeNull();
    const latest = item.latest as NonNullable<CatchUpItemBody["latest"]>;
    expect(latest.version, "the tour's version starts at 1").toBeGreaterThanOrEqual(1);
    expect(latest.stops.length, "the tour has no stops").toBeGreaterThanOrEqual(1);
    for (const stop of latest.stops) {
      expect(stop.title.trim().length, `stop ${stop.id} has no title`).toBeGreaterThan(0);
      expect(stop.narrative.trim().length, `stop ${stop.id} has no narrative`).toBeGreaterThan(0);
      expect(IMPORTANCES, `stop ${stop.id} importance ${stop.importance}`).toContain(
        stop.importance as (typeof IMPORTANCES)[number],
      );
      // `kind` is omitempty on the wire (the model may leave the label out);
      // when it writes one, it is a short label, never a markup or a link.
      if (stop.kind !== undefined) {
        expect(stop.kind.trim().length, `stop ${stop.id} carries an empty kind`).toBeGreaterThan(0);
        expect(
          stop.kind.length,
          `stop ${stop.id} kind is over the 64-char bound`,
        ).toBeLessThanOrEqual(64);
      }
      for (const [index, entry] of (stop.evidence ?? []).entries()) {
        const type = entry["type"];
        expect(
          typeof type === "string" &&
            (EVIDENCE_TYPES as readonly string[]).includes(type as string),
          `stop ${stop.id} evidence ${index} has no server type: ${JSON.stringify(entry)}`,
        ).toBe(true);
        // Server-filled means the server's OWN copy of the excerpt it showed the
        // model: the generator stamps `source` and hands over `text` verbatim
        // (internal/assistant/catchup_gen.go builds the object, not the model).
        if (type === "log" || type === "files") {
          expect(
            typeof entry["text"] === "string" && (entry["text"] as string).length > 0,
            `stop ${stop.id} evidence ${index} carries no server-copied text`,
          ).toBe(true);
        }
      }
    }

    await gotoApp(alice, "/catch-up");
    await evidence(
      alice,
      "catchup-leg1-tour-written",
      `run ${runId.slice(0, 8)} finished as ${runStatus} and the assistant wrote work item ` +
        `${itemId} with a v${latest.version} tour of ${latest.stops.length} stop(s): ` +
        `"${item.title}" — "${latest.stops[0].title}"`,
    );
  });

  test("leg 2: the item appears unseen", async () => {
    test.setTimeout(180_000);
    expect(itemId, "leg 1 never named an item").not.toBe("");
    const item = await getJson<CatchUpItemBody>(alice.request, `/api/v1/catch-up/items/${itemId}`);
    const unseenStops = (item.latest?.stops ?? []).filter((stop) => !stop.seen).length;
    expect(unseenStops, `item ${itemId} arrived with nothing unseen to show`).toBeGreaterThan(0);

    await gotoApp(alice, "/catch-up");
    await expect(alice.getByTestId("catchup-page")).toBeVisible({ timeout: 30_000 });
    // The navigation's own badge: "{n} unseen", n >= 1 — the number the sidebar
    // draws comes from this reader's unseen count.
    const badge = alice.getByTestId("sidebar-link-catch-up");
    await expect(badge, "the sidebar offers no unseen count at all").toContainText(
      /[1-9][0-9]* unseen/,
      { timeout: 30_000 },
    );
    // The row: keyed on the item id, inside THE REST (the tour cards above it
    // carry beats, not rows, so the row is the claim that this PIECE is owed).
    const rest = alice.getByTestId("catchup-rest");
    await expect(rest, "the rest panel never appeared").toBeVisible({ timeout: 30_000 });
    const row = rest.getByTestId(`catchup-row-${itemId}`);
    await expect(row, `no catch-up row for item ${itemId}`).toBeVisible({ timeout: 30_000 });
    await expect(row, "the row does not name the work item the API served").toContainText(
      item.title,
    );
    await evidence(
      alice,
      "catchup-leg2-unseen",
      `sidebar-link-catch-up reads "${(await badge.innerText()).replace(/\s+/g, " ").trim()}" and ` +
        `catchup-row-${itemId} is in the rest list carrying "${item.title}"`,
    );
  });

  test("leg 3: playing the tour marks every stop seen", async () => {
    test.setTimeout(240_000);
    const before = await getJson<CatchUpItemBody>(
      alice.request,
      `/api/v1/catch-up/items/${itemId}`,
    );
    const stopCount = before.latest?.stops.length ?? 0;
    expect(stopCount, "there is no tour to play").toBeGreaterThan(0);

    await gotoApp(alice, `/catch-up/tour?item=${itemId}`);
    await expect(alice.getByTestId("tour-player")).toBeVisible({ timeout: 30_000 });
    await expect(alice.getByTestId("tour-current")).toBeVisible({ timeout: 30_000 });
    // One `tour-next` per beat: leaving a stop is what pays that stop's debt
    // (ui/src/pages/TourPlayer.tsx's payStop), and the click past the last beat
    // lands on the tour's own "caught up" screen.
    for (let step = 0; step < stopCount; step += 1) {
      await alice.getByTestId("tour-next").click({ timeout: 15_000 });
      await alice.waitForTimeout(500);
    }
    await expect(alice.getByTestId("tour-caught-up"), "the tour never ended").toBeVisible({
      timeout: 30_000,
    });
    await alice.getByTestId("tour-close").click({ timeout: 15_000 });
    await evidence(
      alice,
      "catchup-leg3-played",
      `walked all ${stopCount} stop(s) of item ${itemId} with tour-next and closed it — ` +
        `the player's own caught-up screen was reached`,
    );

    // Seen is the reader's fact, recorded stop by stop.
    await expect
      .poll(
        async () => {
          const after = await getJson<CatchUpItemBody>(
            alice.request,
            `/api/v1/catch-up/items/${itemId}`,
          );
          return (after.latest?.stops ?? []).filter((stop) => stop.seen).length;
        },
        { message: `not every stop of ${itemId} came back seen`, timeout: 60_000 },
      )
      .toBe(stopCount);

    // And the unseen read no longer owes it: neither on the wire, nor on the page.
    await expect
      .poll(
        async () => {
          const list = await getJson<CatchUpListBody>(alice.request, "/api/v1/catch-up/items");
          return list.items.filter((row) => row.id === itemId).length;
        },
        { message: `GET /catch-up/items still lists ${itemId} as unseen`, timeout: 60_000 },
      )
      .toBe(0);

    await gotoApp(alice, "/catch-up");
    await expect(alice.getByTestId(`catchup-row-${itemId}`), {
      message: "the page still shows the row with show-seen off",
    }).toHaveCount(0);
    await evidence(
      alice,
      "catchup-leg3-seen",
      `every stop of ${itemId} reads seen, GET /catch-up/items answers without it, and the ` +
        `row is gone from /catch-up with show-seen off`,
    );
  });

  test("leg 4 (SEEDED FIXTURE): a decision reply reaches the lab agent", async () => {
    // The model is never asked to write a decision: whether it asks a question
    // at all is its own call (internal/assistant/catchup_gen.go keeps one only
    // when the work has a thread to answer it). So this leg SEEDS the tour
    // document the generator would have written — one stop carrying
    // `decision` — on a work item pointed at a REAL thread driven by the LAB
    // AGENT, and then proves the product half: the click, the reply, the turn.
    test.setTimeout(AGENT_TURN_TIMEOUT_MS + 300_000);

    // --- a real one-off thread with the lab agent, through the API (the same
    // create + first turn the New-thread dialog drives in issue2). ---
    const csrf = await apiCsrf(alice.request);
    const profiles = await apiAgentProfiles(alice.request);
    const profile = profiles.find((row) => row.name === PROFILE) ?? profiles[0];
    expect(profile, "the lab holds no agent profile to thread with").toBeDefined();
    const threadTitle = `catchup decision thread ${STAMP}`;
    const thread = await postJson<{ id: string; active_turn?: { id?: string } | null }>(
      alice.request,
      csrf,
      `/api/v1/projects/${project.id}/conversations`,
      { agent_profile_id: profile.id, title: threadTitle, prompt: PONG },
    );
    const threadId = thread.id;
    expect(threadId, "the thread create named no id").toMatch(/^[0-9a-f-]{36}$/);
    console.log(`catchup-lab: thread ${threadId} opened on profile ${profile.name}`);

    // Wait out the FIRST turn. The product's own gate on a second prompt is
    // "this conversation has a non-terminal turn" (the 409 the surface has its
    // busy line for), and `active_turn` IS that read — the store's active-turn
    // select names only a non-terminal one. `status` is NOT the gate: the
    // worker moves a thread to `idle` only when it closes the agent session,
    // which is its own patience, not the turn's.
    const idleDeadline = Date.now() + AGENT_TURN_TIMEOUT_MS;
    for (;;) {
      const chat = await getJson<{ status: string; active_turn: unknown | null }>(
        alice.request,
        `/api/v1/conversations/${threadId}`,
      );
      if (chat.active_turn === null) break;
      if (Date.now() >= idleDeadline) {
        throw new Error(
          `thread ${threadId} still carried a live turn after ${AGENT_TURN_TIMEOUT_MS} ms ` +
            `(last read: ${JSON.stringify(chat)}) — the lab agent never finished its answer ` +
            `to "${PONG}", so a decision reply would only prove the busy path`,
        );
      }
      await alice.waitForTimeout(2_000);
    }
    // And the turn that just ended is the agent's answer, not a failure the
    // wait above could not see: the store's own row names both.
    const firstTurn = newestTurnRow(threadId);
    expect(
      firstTurn,
      `thread ${threadId} has no turn at all — the create carried its prompt, so this is the ` +
        `lab's own turn write missing, not a slow model`,
    ).not.toBe("");
    expect(
      firstTurn.startsWith("completed "),
      `the first turn of ${threadId} ended ${firstTurn} instead of completed on "${PONG}"`,
    ).toBe(true);
    console.log(`catchup-lab: thread ${threadId} answered and is idle — turn row [${firstTurn}]`);

    // --- the seeded tour: one work item, one stop, one question. The document
    // is the store's own shape (internal/domain/catchup.go: CatchUpStop); the
    // rows go in through the stack's postgres because NO ROUTE WRITES A TOUR —
    // ADR-0078 § Decision 7: the only writer of a shared tour is the server's
    // own assistant. This fixture stands in for that writer and says so.
    const seededTitle = `catchup seeded decision ${STAMP}`;
    const stopId = `decided-${STAMP}`;
    const seededItemId = seedDecisionItem(project.id, threadId, seededTitle, stopId);

    // --- the click: the option, the status line the surface owns. ---
    await gotoApp(alice, `/catch-up/${seededItemId}`);
    await expect(alice.getByTestId("catchup-item")).toBeVisible({ timeout: 30_000 });
    const decision = alice.getByTestId("catchup-decision");
    await expect(decision, "the piece page shows no decision for the seeded stop").toBeVisible({
      timeout: 30_000,
    });
    await expect(decision).toContainText("Keep 24h or change to 12h?");
    const option = alice.getByTestId("catchup-decision-option-1");
    await expect(option, "the first option is not the answer this leg sends").toContainText(
      "Change to 12h",
    );
    const replied = alice.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/v1/catch-up/items/${seededItemId}/stops/${stopId}/reply`),
      { timeout: 30_000 },
    );
    await option.click({ timeout: 15_000 });
    const replyResponse = await replied;
    expect(
      replyResponse.status(),
      `the decision reply answered ${replyResponse.status()}, not the 202 the route promises`,
    ).toBe(202);
    const replyBody = (await replyResponse.json()) as {
      reply_id: string;
      conversation_id: string | null;
      turn_id: string | null;
    };
    expect(replyBody.conversation_id, "the reply did not name the thread it went into").toBe(
      threadId,
    );
    expect(replyBody.turn_id, "the reply did not name the turn it opened").not.toBeNull();
    await expect(alice.getByTestId("catchup-decision-status")).toContainText(
      /Sent to the agent.*Change to 12h/,
      { timeout: 30_000 },
    );
    await evidence(
      alice,
      "catchup-leg4-sent",
      `clicked catchup-decision-option-1 ("Change to 12h") on the SEEDED item ` +
        `${seededItemId}: ${replyResponse.status()} named conversation ${threadId} and turn ` +
        `${replyBody.turn_id}, and catchup-decision-status says it was sent`,
    );

    // --- the thread's own read: the message arrived verbatim, and a new agent
    // turn is what the reply opened. The turn may already be over by the time
    // this read lands, so the wire's ACTIVE turn is one proof and the turn the
    // reply response named is the other. ---
    const chatWire = await getJson<{
      status: string;
      active_turn?: { id: string; prompt?: string; status?: string } | null;
    }>(alice.request, `/api/v1/conversations/${threadId}`);
    const active = chatWire.active_turn ?? null;
    if (active !== null) {
      expect(active.prompt, "the active turn is not the reply's prompt").toBe("Change to 12h");
      expect(["queued", "leased", "running"], `turn status ${active.status}`).toContain(
        active.status as string,
      );
    }
    // The durable half: the reply is a turn on THIS thread whose prompt is the
    // option's text byte for byte, and it is a turn the agent took (or is
    // taking) — the same statuses the wire shows, read after the fact so a
    // fast answer cannot make this leg depend on catching it live.
    const turnRow = newestTurnRow(threadId);
    expect(
      turnRow,
      `the thread's wire read answered ${JSON.stringify(chatWire)} with no turn carrying the reply`,
    ).not.toBe("");
    expect(
      turnRow.endsWith(" Change to 12h"),
      `the thread's newest turn is [${turnRow}], not a turn whose prompt is exactly ` +
        `"Change to 12h" — the reply must reach the agent as plain text`,
    ).toBe(true);
    expect(
      ["queued", "leased", "running", "completed"],
      `the reply's turn answered with status [${turnRow}]`,
    ).toContain(turnRow.split(" ")[0]);
    console.log(
      `catchup-lab: reply reached thread ${threadId} — turn row [${turnRow}], wire status ` +
        `${chatWire.status}${active ? ` with active turn ${active.status}` : ""}`,
    );
    await gotoApp(alice, `/threads/${threadId}`);
    await evidence(
      alice,
      "catchup-leg4-thread",
      `the thread's own page after the click — the agent was handed "Change to 12h" as a plain ` +
        `user message (turn row: ${turnRow}); the decision is a sentence to an agent, never a gate`,
    );
  });
});

/**
 * Insert the leg-4 fixture the only way a tour can be written from outside the
 * assistant: through the stack's own postgres (`seedSql`, the m4 seed's one
 * door, exported from lab-launcher.ts so no spec re-implements the docker
 * plumbing). The work item's id comes back from the INSERT's own RETURNING —
 * psql -tA prints rows only, so what returns IS the proof the write landed.
 */
function seedDecisionItem(
  projectId: string,
  conversationId: string,
  title: string,
  stopId: string,
): string {
  const stops = decisionStopJson(stopId);
  const summary =
    "Seeded by e2e/tests/catchup-lab.spec.ts leg 4: a question with a thread to answer it. " +
    "In production the assistant's own generator is the only writer of a tour.";
  const sql =
    `INSERT INTO catchup_work_items (project_id, shape, title, summary, resolution, refs, ` +
    `conversation_id) VALUES (${sqlQuote(projectId)}::uuid, 'pr', ${sqlQuote(title)}, ` +
    `${sqlQuote(summary)}, 'open', '{}'::jsonb, ${sqlQuote(conversationId)}::uuid) ` +
    `RETURNING id::text;`;
  const inserted = seedSqlRows(sql);
  const itemId = inserted[inserted.length - 1] ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new Error(`the seeded work item did not come back with one uuid, got [${inserted}]`);
  }
  // The tour version, in the store's own document shape. version 1, and the
  // stop's added_in_version says it was born there — the same stamp the
  // generator's writer gives a first beat (ADR-0078 § Decision 3).
  seedSqlRows(
    `INSERT INTO catchup_tour_versions (work_item_id, version, reason, stops) VALUES ` +
      `(${sqlQuote(itemId)}::uuid, 1, ` +
      `${sqlQuote("Seeded decision fixture for the catch-up lab journey (e2e leg 4).")}, ` +
      `${sqlQuote(stops)}::jsonb);`,
  );
  console.log(`seeded catchup decision item ${itemId} on thread ${conversationId}`);
  return itemId;
}

/** One statement through the lab's postgres; its printed rows, one per line. */
function seedSqlRows(sql: string): string[] {
  const out = seedSql(sql);
  return out
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line !== "");
}

/** The thread's newest turn as the store holds it: `<status> <prompt>` on one
 * line, through the stack's own postgres (the read that answers what the wire
 * no longer carries once a turn is terminal). */
function newestTurnRow(conversationId: string): string {
  const rows = seedSqlRows(
    `SELECT status || ' ' || regexp_replace(prompt, '\n', ' ', 'g') FROM conversation_turns ` +
      `WHERE conversation_id = ${sqlQuote(conversationId)}::uuid ORDER BY created_at DESC LIMIT 1;`,
  );
  return rows[0] ?? "";
}
