// A8 — lab acceptance for the Assistant handoff (docs/design/assistant-handoff/
// HANDOFF.md + CONTRACT.md): the setup checklist, the three frame sizes and the
// sibling menus, a credentials answer that names a slug and never a token, the
// real-GitHub add-a-repo approval, the page-context assumed line and its
// switch, the trust pill against the deterministic judge stub, dictation
// through fake media devices, and the settings read.
//
// It runs against the M4 lab by env override only — the same gate idiom as
// m5-assistant.spec.ts (skipped, never passed, when COMMUNICATION_E2E_M5 is
// unset, so CI's lab-less runs are unaffected):
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 \
//   E2E_TEST_REPO_TOKEN_FILE=$HOME/.config/communication/test-repo-token \
//   pnpm --dir e2e exec playwright test tests/assistant-handoff.spec.ts
//
// THE TWO MODELS ARE NOT THE SAME MODEL: the assistant's chat model is the
// real LLM collective (one answer is 5-90 s, so every answer wait is bounded by
// ANSWER_TIMEOUT_MS), while speech and the decision judge are the deterministic
// stub of e2e/stubs/assistant_stub.py (fixed transcript "what workflows do I
// have", fixed verdicts, POST /control/judge {"state":"down"|"ok"},
// GET /control/stats). The stub's counters are part of the assertions: a
// no_ask turn must not consult the judge at all, an ask_risky turn must.
//
// THE TOKEN NEVER SURFACES: legs 3-4 read the repo token from the file named
// by E2E_TEST_REPO_TOKEN_FILE and hand it to the API exactly once; its value
// is never logged, attached, or written into a screenshot name, and leg 3
// asserts the answer carries the credential's SLUG and not its value.
//
// The legs are serial by design: 3 creates the credential leg 4 consumes, and
// 6 flips the shared judge switch (restored in a finally so the lab never
// stays down for the suites behind this one).
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { ADMIN_SUBJECT, gotoApp, shot, signIn } from "./helpers.js";

// Serial mode forbids launchOptions inside a describe (it would force a new
// worker mid-suite), so the fake media devices are declared at the file's top
// level: every leg runs in a browser whose mic is a deterministic fake. Only
// leg 7 ever records — the others never touch the device.
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

/** A real lab answer is a model turn through the LLM collective (5-90 s). */
const ANSWER_TIMEOUT_MS = Number(process.env.E2E_ASST_ANSWER_TIMEOUT_MS ?? 180_000);

/** The lab's speech + judge stub (e2e/stubs/assistant_stub.py, published on 18098). */
const STUB_URL = process.env.E2E_ASSISTANT_STUB_URL ?? "http://localhost:18098";

/** The lab's seeded maintainer (project maintainer, NOT org admin). */
const ALICE = { subject: "alice", name: "alice" };

/** One stamp per run: the credential and the project created by legs 3-4. */
const STAMP = Date.now().toString(36);
const CREDENTIAL_SLUG = `assistant-github-${STAMP}`;
const PROJECT_NAME = `asst-${STAMP}`;
const REPO_URL = "github.com/dbirks/comms-test-repo-1";
const REPO_GIT_URL = "https://github.com/dbirks/comms-test-repo-1.git";

/** The seeded lab project every read here rides on. */
const M4_PROJECT_SLUG = "m4-exit";

/**
 * The trust menu's copy, hardcoded from docs/design/assistant-handoff/HANDOFF.md
 * § 4 (the brief forbids importing anything from ui/ — the spec re-reads the
 * contract, not the component's source).
 */
const TRUST_COPY = [
  {
    testid: "assistant-pill-option-ask_all",
    label: "Ask before every change",
    blurb: "You confirm every change.",
  },
  {
    testid: "assistant-pill-option-ask_risky",
    label: "Ask when it looks risky",
    blurb: "A decision model checks each call. Flagged ones wait for you.",
  },
  {
    testid: "assistant-pill-option-no_ask",
    label: "Don't ask",
    blurb: "Everything runs. Each action is listed in the thread.",
  },
] as const;

/** The characters the handoff retires from the panel (mock glyphs, never real text). */
const RETIRED_GLYPHS = ["▾", "▴", "⤢", "✓", "×"] as const;

interface StubStats {
  transcriptions: number;
  judge_calls: number;
  judge_state: string;
}

async function stubStats(request: APIRequestContext): Promise<StubStats> {
  const res = await request.get(`${STUB_URL}/control/stats`);
  expect(res.status(), "the speech+judge stub answers /control/stats").toBe(200);
  return (await res.json()) as StubStats;
}

async function setJudge(request: APIRequestContext, state: "down" | "ok"): Promise<void> {
  const res = await request.post(`${STUB_URL}/control/judge`, { data: { state } });
  expect(res.status(), `POST /control/judge {"state":"${state}"} accepted`).toBe(200);
}

/**
 * Open the Ask popover on Today with the handoff's chord (⌘J — Control+J on
 * this runner, the same chord m5-assistant.spec.ts drives). A popover left
 * open by the previous leg is closed first, so the chord always opens.
 */
async function openAsk(page: Page): Promise<Locator> {
  const panel = page.getByTestId("assistant-panel");
  if (await panel.isVisible().catch(() => false)) {
    await page.getByTestId("assistant-close").click();
    await expect(panel).toBeHidden();
  }
  await page.keyboard.press("Control+J");
  await expect(page.getByTestId("assistant-popover")).toBeVisible();
  await expect(panel).toBeVisible();
  return panel;
}

/** Start a fresh thread from the panel header (the thread then holds only the setup checklist). */
async function startNewThread(page: Page): Promise<void> {
  await page.getByTestId("assistant-new-conversation").click();
  await expect(page.getByTestId("assistant-setup")).toBeVisible({ timeout: 30_000 });
}

/** Type a question into the composer and send it on Enter (the composer's own send key). */
async function ask(page: Page, question: string): Promise<void> {
  const input = page.getByTestId("assistant-composer-input");
  // A previous leg's turn can still be in flight; the composer re-enables the
  // moment it settles. Bound the wait, but bound it like a model turn.
  await expect(input, `the composer is ready for: ${question}`).toBeEnabled({
    timeout: ANSWER_TIMEOUT_MS,
  });
  await input.fill(question);
  await input.press("Enter");
}

const assistantRow = (page: Page): Locator => page.locator("[data-testid='assistant-msg-assistant']");

/** The whole transcript, for failure messages that must not be a bare timeout. */
async function transcriptText(page: Page): Promise<string> {
  return ((await page.getByTestId("assistant-body").innerText().catch(() => "(no transcript)"))
    .replace(/\s+/g, " ")
    .trim());
}

/**
 * Wait for the NEXT assistant answer row (there are `previous` already) and
 * return its visible text. A bounded wait, never an open-ended one: 5-90 s per
 * real model turn.
 */
async function nextAnswerText(page: Page, previous: number): Promise<string> {
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  let retries = 0;
  for (;;) {
    if ((await assistantRow(page).count()) > previous) break;
    // The collective's transient 429 (see `waitForApprovalCard`): the app's
    // own Retry re-sends the refused question; twice, then it is a failure.
    const retry = page.getByTestId("assistant-send-retry").last();
    if (await retry.isVisible().catch(() => false)) {
      if (retries >= 2) {
        throw new Error(
          `the model refused the ask twice (429-class)\nTRANSCRIPT: ${await transcriptText(page)}`,
        );
      }
      retries += 1;
      await retry.click();
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no assistant answer within ${ANSWER_TIMEOUT_MS} ms\nTRANSCRIPT: ${await transcriptText(page)}`,
      );
    }
    await page.waitForTimeout(500);
  }
  return assistantRow(page).last().innerText().then((text) => text.replace(/\s+/g, " ").trim());
}

/** Expand the answer's `used N tools` disclosure and return its rows' text. */
async function toolsTextOf(row: Locator): Promise<string> {
  const tools = row.getByTestId("assistant-tools");
  const summary = tools.locator("summary");
  if (await summary.isVisible().catch(() => false)) await summary.click().catch(() => undefined);
  const text = await tools.textContent().catch(() => null);
  return (text ?? "").replace(/\s+/g, " ");
}

/** True when `locator` sits inside an element carrying `testid` as an ancestor. */
async function insideTestid(page: Page, menuTestid: string, ancestorTestid: string): Promise<boolean> {
  return page.evaluate(
    ([menu, ancestor]) =>
      document
        .querySelector(`[data-testid="${menu}"]`)
        ?.closest(`[data-testid="${ancestor}"]`) !== null,
    [menuTestid, ancestorTestid] as const,
  );
}

/** Set the trust level through the composer's pill. */
async function setTrustLevel(page: Page, level: "ask_all" | "ask_risky" | "no_ask"): Promise<void> {
  await page.getByTestId("assistant-pill").click();
  await expect(page.getByTestId("assistant-pill-menu")).toBeVisible();
  await page.getByTestId(`assistant-pill-option-${level}`).click();
  await expect(page.getByTestId("assistant-pill-menu")).toBeHidden();
}

/** The session's CSRF headers (mutations ride X-CSRF-Token + Origin, m5 idiom). */
async function csrfHeaders(context: BrowserContext): Promise<Record<string, string>> {
  const me = await context.request.get(`${BASE_URL}/api/v1/me`);
  expect(me.status(), "read the session's csrf token (GET /api/v1/me)").toBe(200);
  const { csrf_token: csrf } = (await me.json()) as { csrf_token: string };
  return { Origin: BASE_URL, "X-CSRF-Token": csrf };
}

/** The seeded lab project's id, by slug, from the caller's own project list. */
async function m4ProjectId(context: BrowserContext): Promise<string> {
  const res = await context.request.get(`${BASE_URL}/api/v1/projects`);
  expect(res.status(), "list the caller's projects (GET /api/v1/projects)").toBe(200);
  const { items } = (await res.json()) as { items: { id: string; slug: string }[] };
  const m4 = (items ?? []).find((row) => row.slug === M4_PROJECT_SLUG);
  expect(m4, `the lab's ${M4_PROJECT_SLUG} project is seeded (found: ${JSON.stringify((items ?? []).map((row) => row.slug))})`).toBeTruthy();
  return m4!.id;
}

/**
 * Wait for the conversation's approval card, answering at most TWO follow-up
 * questions with an affirmative option when the first answer asks instead of
 * proposing (the handoff's add-a-repo leg allows this; a third ask fails with
 * the transcript, never silently). A shared-lab turn can also be refused
 * BEFORE it reaches the model (the collective's 429 lands as an `assistant-
 * error` with the app's own Retry, issue #63): the wait presses Retry at most
 * twice, then reports the failure with the transcript.
 */
async function waitForApprovalCard(page: Page, card: Locator): Promise<void> {
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  let followUps = 0;
  let rateLimitRetries = 0;
  for (;;) {
    if (await card.last().isVisible().catch(() => false)) return;
    const retry = page.getByTestId("assistant-send-retry").last();
    if (await retry.isVisible().catch(() => false)) {
      if (rateLimitRetries >= 2) {
        throw new Error(
          `the model refused the ask twice (429-class)\nTRANSCRIPT: ${await transcriptText(page)}`,
        );
      }
      rateLimitRetries += 1;
      await retry.click();
      continue;
    }
    const question = page.getByTestId("assistant-question").last();
    if (await question.isVisible().catch(() => false)) {
      if (followUps >= 2) {
        throw new Error(
          `the assistant kept asking instead of proposing after ${followUps} follow-ups\nTRANSCRIPT: ${await transcriptText(page)}`,
        );
      }
      followUps += 1;
      const options = question.getByTestId("assistant-question-option");
      const yes = options.filter({ hasText: /yes|create|do it|go ahead|add/i }).first();
      const target = (await yes.count()) > 0 ? yes : options.first();
      await expect(target, "the open question carries at least one answer").toBeVisible({
        timeout: 30_000,
      });
      await target.click();
      // The answer posts a new turn; loop waits for its card or next question.
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no assistant-approval card within ${ANSWER_TIMEOUT_MS} ms\nTRANSCRIPT: ${await transcriptText(page)}`,
      );
    }
    await page.waitForTimeout(1_000);
  }
}

test.describe("Assistant handoff A8 — lab acceptance", () => {
  test.describe.configure({ mode: "serial", timeout: ANSWER_TIMEOUT_MS + 180_000 });
  test.skip(
    !M5_ENABLED,
    "Needs the M4 lab stack (ports 18091-18093, stub on 18098) — run with COMMUNICATION_E2E_M5=1",
  );

  const tokenFile = process.env.E2E_TEST_REPO_TOKEN_FILE ?? "";
  const tokenSkip =
    "needs E2E_TEST_REPO_TOKEN_FILE (the repo-token file legs 3-4 post through the API; CI always sets it)";

  let aliceContext: BrowserContext;
  let alice: Page;

  test.beforeAll(async ({ browser }) => {
    if (!M5_ENABLED) return;
    aliceContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    alice = await aliceContext.newPage();
    await aliceContext.request.get(`${BASE_URL}/api/v1/system/readiness`);
    await signIn(alice, ALICE.subject, { email: `${ALICE.subject}@example.test` });
    await expect(alice.getByTestId("user-badge")).toHaveText(ALICE.name);
  });

  test.afterAll(async ({ request }) => {
    // Whatever leg 6 did to it, the shared lab never stays with its judge down.
    if (M5_ENABLED) {
      await request
        .post(`${STUB_URL}/control/judge`, { data: { state: "ok" } })
        .catch(() => undefined);
    }
    if (aliceContext) await aliceContext.close();
  });

  test("1. a new thread on Today opens with the setup checklist", async () => {
    await alice.setViewportSize({ width: 1280, height: 860 });
    await gotoApp(alice, "/");
    await openAsk(alice);
    await startNewThread(alice);
    const setup = alice.getByTestId("assistant-setup");
    await expect(setup).toBeVisible();
    const rows = alice.getByTestId("assistant-setup-row");
    await expect(rows).not.toHaveCount(0);
    const text = (await setup.innerText()).replace(/\s+/g, " ");
    expect(text).toContain("Chat model");
    expect(text).toContain("Speech model");
    expect(text).toContain("qwen3-asr-stub");
    expect(text).toContain("Decision model");
    expect(text).toContain("judge-stub");
    expect(text).toMatch(/worker/i);
    expect(text).toMatch(/GitHub credential/i);
    expect(text).toMatch(/project/i);
    expect(text).toMatch(/workflow/i);
    await expect(alice.getByTestId("assistant-starter")).toHaveCount(3);
    expect(text).toContain("used system.status");
    await shot(alice, "asst-01-setup");
  });

  test("2. frame: popover geometry, sibling menus, side panel, full page", async () => {
    await alice.setViewportSize({ width: 1280, height: 860 });
    await gotoApp(alice, "/");
    const panel = await openAsk(alice);

    await test.step("the popover is the 400px clipped box", async () => {
      const box = await panel.boundingBox();
      expect(box, "the assistant panel has a box").toBeTruthy();
      expect(Math.abs(box!.width - 400)).toBeLessThanOrEqual(1);
      const overflow = await panel.evaluate((node) => getComputedStyle(node).overflow);
      expect(overflow).toBe("hidden");
    });

    await test.step("the trust menu leaves the panel and carries the § 4 copy", async () => {
      await alice.getByTestId("assistant-pill").click();
      const menu = alice.getByTestId("assistant-pill-menu");
      await expect(menu).toBeVisible();
      expect(await insideTestid(alice, "assistant-pill-menu", "assistant-panel")).toBe(false);
      for (const level of TRUST_COPY) {
        const option = alice.getByTestId(level.testid);
        await expect(option, `trust option ${level.testid}`).toBeVisible();
        const text = (await option.innerText()).replace(/\s+/g, " ");
        expect(text).toContain(level.label);
        expect(text).toContain(level.blurb);
      }
      await shot(alice, "asst-02-trust-menu");
      await alice.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    });

    await test.step("the context menu leaves the panel and names the page", async () => {
      await alice.getByTestId("assistant-context-button").click();
      const menu = alice.getByTestId("assistant-context-menu");
      await expect(menu).toBeVisible();
      expect(await insideTestid(alice, "assistant-context-menu", "assistant-panel")).toBe(false);
      await expect(menu).toContainText("Today");
      await shot(alice, "asst-02-context-menu");
      await alice.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    });

    await test.step("the dock is the 450px side panel and the page steps aside", async () => {
      await alice.getByTestId("assistant-dock").click();
      await expect(panel).toHaveAttribute("data-variant", "dock");
      const box = await panel.boundingBox();
      expect(box, "the docked panel has a box").toBeTruthy();
      expect(Math.abs(box!.width - 450)).toBeLessThanOrEqual(2);
      const main = alice.locator("main");
      const mainBox = await main.boundingBox();
      expect(mainBox, "the shell's main column has a box").toBeTruthy();
      const viewportWidth = await alice.evaluate(() => window.innerWidth);
      expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(viewportWidth - 450 + 2);
      await shot(alice, "asst-02-dock");
    });

    await test.step("full page: /assistant with the breakpoint columns", async () => {
      await alice.getByTestId("assistant-dock").click(); // back to the popover first
      await expect(panel).toHaveAttribute("data-variant", "popover");
      await alice.getByTestId("assistant-expand").click();
      await expect(alice).toHaveURL(/\/assistant/);
      const threads = alice.getByTestId("assistant-page-threads");
      const side = alice.getByTestId("assistant-page-side");
      await alice.setViewportSize({ width: 1300, height: 900 });
      await expect(threads).toBeVisible();
      await expect(side).toBeVisible();
      await shot(alice, "asst-02-full-page-1300");
      await alice.setViewportSize({ width: 990, height: 900 });
      await expect(threads).toBeHidden();
      await alice.setViewportSize({ width: 1100, height: 900 });
      await expect(side).toBeHidden();
    });

    await test.step("leaving full page returns to the popover at 400px", async () => {
      await alice.setViewportSize({ width: 1280, height: 860 });
      await alice.getByTestId("assistant-expand").click();
      await expect(alice).not.toHaveURL(/\/assistant/);
      await expect(alice.getByTestId("assistant-popover")).toBeVisible();
      const box = await panel.boundingBox();
      expect(box, "the returned panel has a box").toBeTruthy();
      expect(Math.abs(box!.width - 400)).toBeLessThanOrEqual(1);
      // Handoff § 1: the mock's characters never ship as text.
      const panelText = await panel.innerText();
      for (const glyph of RETIRED_GLYPHS) {
        expect(panelText, `the panel's text carries no ${glyph}`).not.toContain(glyph);
      }
      await shot(alice, "asst-02-back-to-popover");
    });
  });

  test("3. a credentials answer names the slug and never the token", async () => {
    test.skip(!tokenFile, tokenSkip);
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(token.length, "the token file is not empty").toBeGreaterThan(0);

    await test.step("admin (an org admin, second identity) creates the org secret", async () => {
      // A SECOND BROWSER CONTEXT with an explicit EMPTY storageState: the
      // admin door is unreachable from a context born carrying alice's session.
      const adminContext = await alice.context().browser()!.newContext({
        storageState: { cookies: [], origins: [] },
      });
      try {
        const admin = await adminContext.newPage();
        await signIn(admin, ADMIN_SUBJECT, { email: `${ADMIN_SUBJECT}@example.test` });
        const projectId = await m4ProjectId(adminContext);
        const created = await adminContext.request.post(
          `${BASE_URL}/api/v1/projects/${projectId}/secrets`,
          {
            headers: await csrfHeaders(adminContext),
            data: {
              slug: CREDENTIAL_SLUG,
              purpose: "github_repo",
              delivery_mode: "integration_broker",
              scope: "org",
              value: token, // handed to the API exactly here; never logged, never a screenshot name
            },
          },
        );
        expect(
          created.status(),
          `create the ${CREDENTIAL_SLUG} org secret (POST /projects/{id}/secrets)`,
        ).toBe(201);
      } finally {
        await adminContext.close();
      }
    });

    await test.step("alice asks and the answer names the credential by slug only", async () => {
      await gotoApp(alice, "/");
      await openAsk(alice);
      await startNewThread(alice);
      const before = await assistantRow(alice).count();
      await ask(alice, "do you have access to any github tokens?");
      const answer = await nextAnswerText(alice, before);
      expect(answer, "the answer names the credential's slug").toContain(CREDENTIAL_SLUG);
      expect(answer, "the answer never repeats the token value").not.toContain(token);
      const tools = await toolsTextOf(assistantRow(alice).last());
      expect(tools, `the tool line cites credential.list (saw: ${tools})`).toContain(
        "credential.list",
      );
      await shot(alice, "asst-03-credentials-answer");
      await alice.getByTestId("assistant-close").click();
    });
  });

  test("4. add a repo: the proposal card, the confirm, the project for real", async () => {
    test.skip(!tokenFile, tokenSkip);
    await gotoApp(alice, "/");
    await openAsk(alice);
    await startNewThread(alice);
    const conversationIds: string[] = [];
    const onPost = (request: import("@playwright/test").Request) => {
      const match = /\/api\/v1\/assistant\/conversations\/([^/]+)\/messages$/.exec(request.url());
      if (request.method() === "POST" && match) conversationIds.push(match[1]);
    };
    alice.on("request", onPost);
    try {
      await ask(
        alice,
        `add ${REPO_URL} as a new project called ${PROJECT_NAME} using the credential ${CREDENTIAL_SLUG}`,
      );
      const card = alice.getByTestId("assistant-approval");
      await waitForApprovalCard(alice, card);
      await expect(card.last()).toBeVisible();
      const cardText = (await card.last().innerText()).replace(/\s+/g, " ");
      expect(cardText).toContain("NEEDS YOUR OK");
      expect(cardText).toContain(PROJECT_NAME);
      expect(cardText).toContain("dbirks/comms-test-repo-1");
      expect(cardText).toContain("main");
      await expect(card.last().getByTestId("assistant-approval-reason")).toContainText(
        "Creates a project and connects a repository.",
      );
      await shot(alice, "asst-04-approval-card");

      await card.last().getByTestId("assistant-approval-confirm").click();
      // NOTE: the shared lab's image predates the CONFIRMED-state fix in flight
      // (docs/design/assistant-handoff TASKS A7 review); this assertion is the
      // contract, kept even while that one line stays red locally.
      await expect(card.last()).toContainText("CONFIRMED", { timeout: 60_000 });
      await shot(alice, "asst-04-confirmed");

      // The sidebar grew the project WITHOUT a reload.
      await expect(
        alice.getByRole("link", { name: PROJECT_NAME }).first(),
        "the sidebar shows the new project without a reload",
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      alice.off("request", onPost);
    }

    await test.step("the API confirms the project, the repo and the logged change", async () => {
      const projects = await aliceContext.request.get(`${BASE_URL}/api/v1/projects`);
      expect(projects.status(), "list projects after the assistant created one").toBe(200);
      const { items } = (await projects.json()) as {
        items: { id: string; name: string; slug: string }[];
      };
      const created = (items ?? []).find((row) => row.name === PROJECT_NAME);
      expect(created, `project ${PROJECT_NAME} exists`).toBeTruthy();

      const repos = await aliceContext.request.get(
        `${BASE_URL}/api/v1/projects/${created!.id}/repos`,
      );
      expect(repos.status(), "list the new project's repos").toBe(200);
      const { items: reposList } = (await repos.json()) as {
        items: { git_url: string; default_branch: string; credential?: string }[];
      };
      const repo = (reposList ?? []).find((row) => row.git_url === REPO_GIT_URL);
      expect(repo, `${REPO_GIT_URL} is on the project`).toBeTruthy();
      expect(repo!.default_branch, "repo.check's branch rode onto the project").toBe("main");
      expect(repo!.credential ?? "none", "the repo is bound to the credential").toBe("configured");

      expect(conversationIds.length, "the leg posted at least one message").toBeGreaterThan(0);
      let changeKinds: string[] = [];
      await expect
        .poll(
          async () => {
            const changes = await aliceContext.request.get(
              `${BASE_URL}/api/v1/assistant/conversations/${conversationIds[0]}/changes`,
            );
            if (!changes.ok()) return false;
            changeKinds = (((await changes.json()) as { changes?: { kind: string }[] })
              .changes ?? []).map((row) => row.kind);
            return changeKinds.includes("project_create");
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    });
  });

  test("5. page context: the answer says what it assumed, and the switch stops sending it", async () => {
    await gotoApp(alice, "/");
    const runLink = alice.locator('a[href*="/runs/"]').first();
    await expect(runLink, "Today carries a run of the seeded project").toBeVisible({
      timeout: 30_000,
    });
    const runHref = (await runLink.getAttribute("href"))!;
    await gotoApp(alice, runHref);
    await openAsk(alice);
    await startNewThread(alice);

    await test.step("with context on, the answer names what it assumed", async () => {
      const before = await assistantRow(alice).count();
      await ask(alice, "why is it stuck?");
      await nextAnswerText(alice, before);
      const assumed = alice.getByTestId("assistant-assumed").last();
      await expect(assumed, "the answer says which page item it took").toBeVisible({
        timeout: 15_000,
      });
      await expect(assumed).toContainText(/run/i);
      await shot(alice, "asst-05-assumed");
    });

    await test.step("unchecking the switch drops `context` from the next post", async () => {
      await alice.getByTestId("assistant-context-button").click();
      const send = alice.getByTestId("assistant-context-send");
      await expect(send).toBeChecked();
      await send.uncheck();
      await alice.keyboard.press("Escape");
      const nextPost = alice.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          /\/api\/v1\/assistant\/conversations\/[^/]+\/messages$/.test(request.url()),
        { timeout: ANSWER_TIMEOUT_MS },
      );
      const before = await assistantRow(alice).count();
      await ask(alice, "and now, one line: what should I look at first?");
      const body = (await nextPost).postDataJSON() as Record<string, unknown>;
      expect(
        body.context,
        `the unchecked switch sends no context (body keys: ${Object.keys(body).join(",")})`,
      ).toBeUndefined();
      await nextAnswerText(alice, before);
      // Put the switch back for every leg and every person after this one.
      await alice.getByTestId("assistant-context-button").click();
      await alice.getByTestId("assistant-context-send").check();
      await expect(alice.getByTestId("assistant-context-send"), "context rides again").toBeChecked();
      await alice.keyboard.press("Escape");
    });
    await alice.getByTestId("assistant-close").click();
  });

  test("6. trust levels and the judge: no_ask never consults, ask_risky does, down asks the person", async ({
    request,
  }) => {
    await gotoApp(alice, "/");
    await openAsk(alice);
    await startNewThread(alice);

    await test.step("Don't ask: the turn runs with the judge untouched", async () => {
      await setTrustLevel(alice, "no_ask");
      const before = await stubStats(request);
      const answerBefore = await assistantRow(alice).count();
      await ask(alice, "what workflows do I have?");
      await nextAnswerText(alice, answerBefore);
      const after = await stubStats(request);
      expect(
        after.judge_calls,
        `a no_ask turn must not consult the judge (${before.judge_calls} → ${after.judge_calls})`,
      ).toBe(before.judge_calls);
      const tools = await toolsTextOf(assistantRow(alice).last());
      expect(tools, `no judge tag under Don't ask (saw: ${tools})`).not.toContain("judge");
      await shot(alice, "asst-06-no-ask");
    });

    await test.step("Ask when it looks risky: the judge is consulted and allows", async () => {
      await setTrustLevel(alice, "ask_risky");
      const before = await stubStats(request);
      const answerBefore = await assistantRow(alice).count();
      await ask(alice, "what workflows do I have?");
      await nextAnswerText(alice, answerBefore);
      const after = await stubStats(request);
      expect(
        after.judge_calls,
        `an ask_risky turn consults the judge (${before.judge_calls} → ${after.judge_calls})`,
      ).toBeGreaterThan(before.judge_calls);
      const tools = await toolsTextOf(assistantRow(alice).last());
      expect(tools, `the tool line carries the verdict (saw: ${tools})`).toContain("judge allowed");
      await shot(alice, "asst-06-judge-allowed");
    });

    await test.step("judge down: a risky ask gates with 'didn't answer' and Dismiss works", async () => {
      await setJudge(request, "down");
      try {
        const answerBefore = await assistantRow(alice).count();
        await ask(alice, "start a new run of feature-development in M4 Exit");
        const card = alice.getByTestId("assistant-approval");
        const deadline = Date.now() + ANSWER_TIMEOUT_MS;
        let judgeDownRetries = 0;
        for (;;) {
          const gated = await card
            .last()
            .getByTestId("assistant-approval-reason")
            .isVisible()
            .catch(() => false);
          if (gated) break;
          const retry = alice.getByTestId("assistant-send-retry").last();
          if (await retry.isVisible().catch(() => false)) {
            if (judgeDownRetries >= 2) {
              throw new Error(
                `the model refused the gated ask twice\nTRANSCRIPT: ${await transcriptText(alice)}`,
              );
            }
            judgeDownRetries += 1;
            await retry.click();
            continue;
          }
          const answered = await assistantRow(alice).count();
          if (answered > answerBefore + 2) {
            throw new Error(
              `the turn ended with no gate card\nTRANSCRIPT: ${await transcriptText(alice)}`,
            );
          }
          if (Date.now() > deadline) {
            throw new Error(
              `no approval card within ${ANSWER_TIMEOUT_MS} ms while the judge was down\nTRANSCRIPT: ${await transcriptText(alice)}`,
            );
          }
          await alice.waitForTimeout(1_000);
        }
        await expect(card.last().getByTestId("assistant-approval-reason")).toContainText(
          "didn't answer",
        );
        await shot(alice, "asst-06-judge-down");
        await card.last().getByTestId("assistant-approval-dismiss").click();
      } finally {
        // The lab never stays down, even when the leg above throws.
        await setJudge(request, "ok");
      }
    });
    await alice.getByTestId("assistant-close").click();
  });

  test("7. dictation: the mic appends to the box and the sent bubble is marked spoken", async ({
    browser,
  }) => {
    // A context with microphone granted and an empty storageState, signed in
    // as alice (the fake-device args are the file's top-level launchOptions).
    const dictationContext = await browser.newContext({
      permissions: ["microphone"],
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await dictationContext.newPage();
      await page.setViewportSize({ width: 1280, height: 860 });
      await signIn(page, ALICE.subject, { email: `${ALICE.subject}@example.test` });
      await gotoApp(page, "/");
      await openAsk(page);
      await startNewThread(page);
      const stats0 = await stubStats(dictationContext.request);
      const input = page.getByTestId("assistant-composer-input");
      await input.fill("hey,");
      await page.getByTestId("mic-button").click();
      await expect(page.getByTestId("listening-bar")).toBeVisible();
      await expect(page.getByTestId("composer-box")).toHaveClass(/border-dashed/);
      await shot(page, "asst-07-listening");
      await page.waitForTimeout(2_000);
      await page.getByTestId("mic-button").click();
      // The stub's fixed transcript APPENDS to what the person typed.
      await expect(input).toHaveValue("hey, what workflows do I have", { timeout: 45_000 });
      await expect
        .poll(async () => (await stubStats(dictationContext.request)).transcriptions, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(stats0.transcriptions + 1);
      await page.getByTestId("assistant-send").click();
      await expect(
        page.getByTestId("assistant-msg-user").last().getByTestId("assistant-spoken"),
        "a dictated send carries the spoken tag",
      ).toBeVisible();
      await shot(page, "asst-07-spoken");
    } finally {
      await dictationContext.close();
    }
  });

  test("8. /settings/assistant shows the speech triple and the judge", async () => {
    await gotoApp(alice, "/settings/assistant");
    const speech = alice.getByTestId("settings-assistant-speech");
    await expect(speech).toBeVisible();
    await expect(speech).toContainText("qwen3-asr-stub");
    await expect(speech).toContainText("set · never shown");
    await expect(alice.getByTestId("settings-assistant-decision-model")).toContainText("judge-stub");
    await shot(alice, "asst-08-settings");
  });
});
