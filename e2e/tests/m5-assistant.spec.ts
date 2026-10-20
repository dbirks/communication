// M5 assistant arm (docs/design/assistant-v1.md, ADR-0034): the read-only
// in-app assistant behind Ctrl K — one question posted from the palette's Ask
// row, an answer rendered over the same input with jump links and a collapsed
// list of the tools it looked at, and every link the answer carries landing on
// a real page rather than "Not found".
//
// It runs against the M4 lab by env override only — no second compose project:
//   COMMUNICATION_E2E_M5=1 \
//   E2E_BASE_URL=http://localhost:18091 E2E_API_A_URL=http://localhost:18092 \
//   E2E_API_B_URL=http://localhost:18093 \
//   pnpm exec playwright test tests/m5-assistant.spec.ts
// The lab's "M4 Exit" project (alice = maintainer) comes from
// docs/compatibility/probes/m4/seed.sh, and the LLM collective
// (COMMUNICATION_ASSISTANT_MODEL=qwen3-8-27b) is the broker's model, so one
// answer takes 5-60 s — every wait below is bounded by ANSWER_TIMEOUT_MS, and
// this suite asks exactly one question and resets nothing.
//
// SKIPPED, NEVER PASSED, WHEN THE DEPLOYMENT HAS NO ASSISTANT: the route
// answers `503 assistant_not_configured` (api/openapi.yaml) when the broker
// is absent. Test 1 probes that exact condition without spending a model turn:
// a valid question whose body carries a secret-shaped string is refused by
// the broker's egress scan (internal/assistant/scan.go) with
// `400 secret_in_request` BEFORE a single byte reaches the model, so the
// probe answers 400 on a configured lab and 503 on one that has no assistant
// at all — the 503 turns the whole suite into a skip with that reason.
//
// THE LINK LEG RE-READS THE SERVED ANSWER, NOT THE PANEL: nothing about the
// answer persists past the panel unmounting (assistant-v1.md), and closing the
// palette is exactly what clicking a link does. The links asserted in this
// file are therefore the `links` array of the served answer itself (captured
// off the real POST the UI made): the first link is taken by clicking the
// rendered button, the rest are navigated to the same `href` that button
// would `navigate(href)`. Each landing page must not be the app's "Not found"
// ("That page does not exist.", ui/src/pages/NotFound.tsx). A link that 404s
// is reported as the product bug it is — the assertion is not weakened.
//
// Skipped unless COMMUNICATION_E2E_M5=1, so CI (which has no M4 lab) is
// unaffected — the same gate idiom as m5-journey.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { gotoApp, shot, signIn } from "./helpers.js";

/** The one question this arm asks (the M5 brief's verbatim ask). */
const QUESTION = "Which projects can I see, and is anything waiting for approval?";

/** A real lab answer is a model turn through the LLM collective. */
const ANSWER_TIMEOUT_MS = Number(process.env.E2E_M5_ASSISTANT_ANSWER_TIMEOUT_MS ?? 120_000);

/** The lab's seeded maintainer; the display name is the bare subject. */
const ALICE = { subject: "alice", name: "alice", projectName: "M4 Exit" };

/** The app's own 404 line (ui/src/pages/NotFound.tsx) — what a link must not land on. */
const NOT_FOUND_TEXT = "That page does not exist.";

/**
 * The configuration probe's question: valid (1-2000 chars) and carrying a
 * secret-shaped assignment, so a configured broker refuses it at its egress
 * scan before any model call (400 secret_in_request) while an unconfigured
 * route answers 503 assistant_not_configured. The value is a test fixture
 * string, not a credential.
 */
const PROBE_QUESTION = 'Is the assistant configured? token="sk-abcdefghijklmnop0123456789"';

/** The closed registry (assistant-v1.md § Tools): every rendered row names one of these. */
const TOOL_NAMES = [
  "project.list",
  "run.list",
  "run.nodes",
  "approval.pending",
  "pipeline.revisions",
  "palette.search",
];

interface AssistantLink {
  label: string;
  href: string;
}

interface AssistantAnswerServed {
  answer_markdown: string;
  links: AssistantLink[];
  tool_calls: { name: string; ok: boolean; reason?: string }[];
}

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

test.describe("M5 assistant — Ctrl K asks the read-only broker", () => {
  test.describe.configure({ mode: "serial", timeout: ANSWER_TIMEOUT_MS + 90_000 });
  test.skip(
    !M5_ENABLED,
    "Needs the M4 lab stack (ports 18091-18093) — run with COMMUNICATION_E2E_M5=1",
  );

  let aliceContext: BrowserContext;
  let alice: Page;
  /** Set by test 1's probe: whether the deployment answers ask at all. */
  let assistantAvailable = false;
  let skipReason = "";
  /** The served answer's `links`, in the order the broker sent them. */
  let answerLinks: AssistantLink[] = [];

  test.beforeAll(async ({ browser }) => {
    // The gate-off run has no lab to talk to, so the contexts are only
    // created when this suite can actually run.
    if (!M5_ENABLED) return;
    aliceContext = await browser.newContext();
    alice = await aliceContext.newPage();
  });

  test.afterAll(async () => {
    if (aliceContext) await aliceContext.close();
  });

  test("the lab is seeded, alice signs in, and the assistant is configured", async () => {
    await test.step("the M4 lab answers readiness", async () => {
      await expect
        .poll(
          async () => {
            try {
              return (await aliceContext.request.get(`${BASE_URL}/api/v1/system/readiness`)).ok();
            } catch {
              return false;
            }
          },
          { timeout: 120_000, intervals: [2_000] },
        )
        .toBe(true);
    });
    await test.step("alice (the seeded project maintainer) signs in", async () => {
      // The seed's claim shape exactly: a re-login must not rewrite the lab's
      // stored profiles, so no `name` claim is invented here.
      await signIn(alice, ALICE.subject, { email: `${ALICE.subject}@example.test` });
      await expect(alice.getByTestId("user-badge")).toHaveText(ALICE.name);
    });
    await test.step("the ask route is mounted with a live broker (no model turn spent)", async () => {
      const me = await aliceContext.request.get(`${BASE_URL}/api/v1/me`);
      expect(me.ok(), `GET /api/v1/me answered ${me.status()}`).toBeTruthy();
      const meBody = (await me.json()) as { csrf_token?: string };
      expect(typeof meBody.csrf_token).toBe("string");
      const probe = await aliceContext.request.post(`${BASE_URL}/api/v1/assistant/ask`, {
        headers: { "X-CSRF-Token": meBody.csrf_token! },
        data: { question: PROBE_QUESTION, context: { route: "/" } },
      });
      const body = (await probe.json().catch(() => ({}))) as { degraded?: string; detail?: string };
      if (probe.status() === 503 && body.degraded === "assistant_not_configured") {
        // The feature is absent on this deployment: skip, never pass.
        skipReason = `POST /api/v1/assistant/ask answers 503 assistant_not_configured — the assistant is not enabled on this deployment`;
      } else {
        // Configured: the egress scan refuses the probe before any model call.
        expect(
          probe.status(),
          `the configuration probe answered ${probe.status()} ${JSON.stringify(body)}`,
        ).toBe(400);
        expect(body.degraded).toBe("secret_in_request");
        assistantAvailable = true;
      }
    });
    if (!assistantAvailable) test.skip(true, skipReason);
    await shot(alice, "m5-assistant-00-signed-in");
  });

  test("Ask from the palette: the answer names M4 Exit and shows the tools it used", async () => {
    if (!assistantAvailable) test.skip(true, skipReason);
    const served: AssistantAnswerServed[] = [];
    const onAskResponse = (res: import("@playwright/test").Response) => {
      void (async () => {
        if (res.url().endsWith("/api/v1/assistant/ask") && res.status() === 200)
          served.push((await res.json().catch(() => null)) as AssistantAnswerServed);
      })();
    };
    await test.step("Ctrl K opens the palette and the Ask row leads the results", async () => {
      await gotoApp(alice, "/");
      await alice.keyboard.press("Control+K");
      await expect(alice.getByTestId("palette-input")).toBeVisible();
      await alice.getByTestId("palette-input").fill(QUESTION);
      // The question is non-empty and matches no jump target exactly, so the
      // Ask row is the first caret row of the filtered list.
      const askRow = alice.getByTestId("palette-ask");
      await expect(askRow).toBeVisible();
      await expect(askRow).toContainText(`Ask: ${QUESTION}`);
    });
    await test.step("the served answer renders over the same input (bounded wait)", async () => {
      alice.on("response", onAskResponse);
      await alice.getByTestId("palette-ask").click();
      // v1 has no stream: the panel shows "thinking…" until the whole answer
      // arrives, and one answer is a real model turn (5-60 s on this lab).
      await expect(alice.getByTestId("assistant-answer")).toBeVisible({
        timeout: ANSWER_TIMEOUT_MS,
      });
      await expect.poll(() => served.length).toBe(1);
      const answer = served[0];
      answerLinks = answer.links ?? [];
      expect(typeof answer.answer_markdown).toBe("string");
      expect(answer.answer_markdown.length).toBeGreaterThan(0);
    });
    await test.step("the answer names the M4 Exit project the way the component renders it", async () => {
      const answer = alice.getByTestId("assistant-answer");
      await expect(answer).toContainText(ALICE.projectName);
      // The rendered prose is the served markdown as text (code spans set in
      // mono, everything else verbatim), so the first line must be readable
      // off the served body and present on screen.
      const firstLine = served[0].answer_markdown
        .split(/\r?\n/)
        .map((line) => line.replace(/`/g, "").trim())
        .find((line) => line.length > 0);
      expect(firstLine, "the served answer carries no text line").toBeTruthy();
      await expect(answer).toContainText(firstLine!.slice(0, 40));
    });
    await test.step("the tool transparency list renders what the broker reported", async () => {
      const answer = served[0];
      const tools = alice.getByTestId("assistant-tools");
      if (answer.tool_calls.length > 0) {
        // Collapsed <details> by default: the component shows it only when the
        // broker really looked things up.
        await expect(tools).toBeVisible();
        await expect(tools.locator("summary")).toContainText(
          `used ${answer.tool_calls.length} tool`,
        );
        await tools.locator("summary").click();
        const rows = tools.locator("li");
        await expect(rows).toHaveCount(answer.tool_calls.length);
        for (let i = 0; i < answer.tool_calls.length; i++) {
          const call = answer.tool_calls[i];
          expect(TOOL_NAMES, `rendered a tool outside the closed registry: ${call.name}`).toContain(
            call.name,
          );
          await expect(rows.nth(i)).toContainText(call.name);
          await expect(rows.nth(i)).toContainText(call.ok ? "ok" : "failed");
        }
      } else {
        // An empty transparency record renders no block at all — the DOM must
        // agree with the served answer rather than invent one.
        await expect(tools).toHaveCount(0);
      }
    });
    await test.step("the answer's links render as buttons with the served labels", async () => {
      const buttons = alice.getByTestId("assistant-link");
      await expect(buttons).toHaveCount(answerLinks.length);
      for (let i = 0; i < answerLinks.length; i++) {
        await expect(buttons.nth(i)).toHaveText(answerLinks[i].label);
      }
      // The footer still says what the assistant is: the jump list survives
      // underneath a failed turn, and the box never promises an action.
      await expect(alice.getByTestId("palette-footer")).toContainText("Read-only assistant");
      await shot(alice, "m5-assistant-01-answer");
    });
  });

  test("every link in the answer lands on a real page", async () => {
    if (!assistantAvailable) test.skip(true, skipReason);
    await test.step(`the answer carried ${answerLinks.length} link${answerLinks.length === 1 ? "" : "s"}`, async () => {
      // "For every link in the answer": the set is the served answer's
      // `links` array, asserted one by one below.
      const buttons = alice.getByTestId("assistant-link");
      await expect(buttons).toHaveCount(answerLinks.length);
    });
    for (let i = 0; i < answerLinks.length; i++) {
      const { label, href } = answerLinks[i];
      await test.step(`link ${i + 1}/${answerLinks.length} — “${label}” (${href})`, async () => {
        if (i === 0) {
          // The product's own way to a link: click the rendered button, which
          // closes the panel and navigates to the served href.
          await alice.getByTestId("assistant-link").nth(0).click();
        } else {
          // Nothing about the answer persists past the panel unmounting, so
          // the next link is served its href directly — the same destination
          // the button would navigate to.
          await gotoApp(alice, href);
        }
        // The destination is the served href's PATH and the app served it to
        // the signed-in session — and it is not the app's "Not found" page.
        // The Workbench appends ?node=…&instance=… on auto-select, so the
        // full URL never equals the served href (the other M5 specs compare
        // the path the same way).
        const expectedPath = new URL(href, BASE_URL).pathname;
        await expect
          .poll(() => new URL(alice.url()).pathname, {
            message: `landed on ${new URL(alice.url()).pathname}, not the served href ${href}`,
          })
          .toBe(expectedPath);
        await expect(alice.getByTestId("user-badge")).toBeVisible();
        await expect(alice.getByText(NOT_FOUND_TEXT)).toHaveCount(0);
        await shot(alice, `m5-assistant-02-link-${i + 1}`);
      });
    }
    await gotoApp(alice, "/");
  });
});
