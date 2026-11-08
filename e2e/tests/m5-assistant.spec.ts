// M5 assistant arm, re-pointed at Assistant v2 (ADR-0050 + its finding-08
// ⌘K/⌘J addendum): ⌘J opens the read-only assistant popover (⌘K belongs to
// the jump palette; the palette's Ask row hands off to the popover). One question
// posted from the popover's composer, an answer rendered in the caller's
// assistant conversation transcript with the tools it looked at, and every
// link the answer carries landing on a real page rather than "Not found".
//
// It runs against the M4 lab by env override only — no second compose
// project:
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
// SKIPPED, NEVER PASSED, WHEN THE DEPLOYMENT HAS NO ASSISTANT: the v1 route
// POST /api/v1/assistant/ask (still mounted, api/openapi.yaml) answers
// `503 assistant_not_configured` when the broker is absent. Test 1 probes
// that exact condition without spending a model turn: a valid question whose
// body carries a secret-shaped string is refused by the broker's egress scan
// (internal/assistant/scan.go) with `400 secret_in_request` BEFORE a single
// byte reaches the model, so the probe answers 400 on a configured lab and
// 503 on one that has no assistant at all — the 503 turns the whole suite
// into a skip with that reason.
//
// THE LINK LEG RE-READS THE SERVED ANSWER, NOT THE PANEL: the links asserted
// in this file are the `links` array of the served assistant row (captured
// off the real POST the UI made): the first link is taken by clicking the
// rendered button, the rest are navigated to the same route that button
// would navigate to. Each landing page must not be the app's "Not found"
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

/**
 * The closed tool registry: every rendered row names one of these.
 *
 * No API endpoint lists the assistant's tools (the assistant surface is
 * /ask, /draft-proposals and the conversation routes only), so this list
 * mirrors the server's single source: the closed `toolClasses` table in
 * internal/assistant/trust.go (ADR-0050 decision 4) — the names the
 * conversation runner registers there are refused outside that table
 * before any class question is asked, and the served `tool_calls` rows
 * carry exactly these registry names. The six v1 read names are
 * registered in internal/assistant/tools.go; the draft, navigation and
 * risky names in internal/assistant/runner.go (`registerTools`).
 *
 * THE DRIFT RULE: when a tool is added to internal/assistant/trust.go,
 * add its name HERE in the same change — the list failing on a newly
 * registered tool (run 41754108482 failed on `ui.navigate`, registered in
 * internal/assistant/runner.go) is this mirror having gone stale, not the
 * broker rendering an unregistered name.
 */
const TOOL_NAMES = [
  // ClassRead (internal/assistant/trust.go; registered in tools.go)
  "project.list",
  "run.list",
  "run.nodes",
  "approval.pending",
  "pipeline.revisions",
  "palette.search",
  "draft.get",
  "workflow.draft",
  "chat.transcript",
  // ClassNavigate (internal/assistant/runner.go)
  "ui.navigate",
  "ui.question",
  // ClassDraftEdit (internal/assistant/runner.go)
  "draft.apply",
  "workflow.create_draft",
  // ClassRisky (internal/assistant/runner.go)
  "run.retry",
  "run.start",
  "approval.decide",
  "permission.allow",
  "pipeline.publish",
];

interface AssistantLinkServed {
  label: string;
  /** The ADR-0050 vocabulary; the v1 broker's key for the same value. */
  route?: string;
  href?: string;
}

interface AssistantAnswerServed {
  answer_markdown: string;
  links: AssistantLinkServed[];
  tool_calls: { name: string; ok: boolean; summary?: string; reason?: string }[];
}

/** A served transcript row (POST /assistant/conversations/{id}/messages). */
interface ServedMessage {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * The prose one line of the served markdown turns into on screen.
 *
 * AnswerProse renders `answer_markdown` through the app's own reader
 * (ui/src/lib/markdown.tsx since 45d40ea, design 2f: `**Adapter swap → PR**`
 * reached the person as literal asterisks), so every marker the reader
 * consumes — code fences, `**strong**`, `*emphasis*`, a link's target, a
 * heading or list marker — is markup, not text, and never appears in the
 * rendered answer. This strips exactly those, and nothing else: a marker the
 * reader leaves alone (the `*` of `2 * 3`, the underscores of `run_pytest_now`,
 * an unclosed `**`) stays here too, and a raw-markdown regression still fails
 * the assertion below because the expected prose has no room for the markers
 * the DOM would then carry.
 */
function renderedProseOf(line: string): string {
  let text = line.trim();
  // A fence line is not prose at all: the reader opens a code block on it and
  // prints only what follows, so its info string never reaches the screen.
  if (/^(?:`{3,}|~{3,})/.test(text)) return "";
  text = text.replace(/^#{1,6}\s+/, ""); // ATX heading: the weight renders, the hashes do not
  text = text.replace(/^>+\s?/, ""); // blockquote
  text = text.replace(/^(?:[-*+]|\d+[.)])\s+/, ""); // list marker (the <li> draws its own)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // an image keeps its alt text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // a link renders its label
  text = text.replace(/`{1,3}([^`]*)`{1,3}/g, "$1"); // code span: mono, no backticks
  // A marker only disappears when it PAIRS: `**x**`, `*x*`, `_x_`, `~~x~~`.
  // An unpaired one is literal text in markdown and stays literal here, which
  // is why `2 * 3`, `**unclosed` and the underscores of `run_pytest_now` reach
  // the screen (and this projection) unchanged.
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2");
  text = text.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2");
  text = text.replace(/~~(.+?)~~/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What the answer element really shows, with nothing collapsed but the
 * whitespace HTML reflows. Compared against `renderedProseOf` of a served line
 * this asks the review's question and nothing looser: the served words, in the
 * served order, with the served punctuation — and no markup characters left
 * sitting in the prose.
 */
async function visibleProse(locator: import("@playwright/test").Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, " ").trim();
}

/**
 * The wording a link row shows for a served label (rcn-review17-2f): the
 * person reads the model's words WITHOUT the raw id it bolted onto them —
 * `Open M4 Exit (01a1aa60…)` reaches the screen as `Open M4 Exit`
 * (`ui/src/components/assistant/draftSteps.ts` `readableLinkLabel`, which
 * drops an id-shaped parenthetical, a uuid, a 26-char ULID or an 8+ hex run,
 * with or without the ellipsis). `""` when the label was nothing but an id:
 * the row then carries the route's own words, which this leg does not
 * re-derive — the destination is proven link by link below.
 */
function servedLabelWithoutIds(label: string): string {
  const idShaped = /[0-9a-f]{4,}|[0-9a-hjkmnp-tv-z]{26}|[\u2026.]\.?/i;
  const text = label
    .replace(/[([{]\s*([^)\]}]{0,120}?)\s*[)\]}]/g, (group: string, inner: string) =>
      /^[0-9a-f\u2026.\s-]+$/i.test(inner) && idShaped.test(inner) ? " " : group,
    )
    .replace(
      /\b(?:[0-9a-f]{8,}(?:-[0-9a-f]{1,12}){0,4}|[0-9a-hjkmnp-tv-z]{26})(?:-?(?:\u2026|\.{2,3}))?(?![0-9a-z])/gi,
      " ",
    )
    .replace(/(?:\s*,\s*){2,}/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

test.describe("M5 assistant — Ctrl J asks the read-only broker", () => {
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
  let answerLinks: AssistantLinkServed[] = [];

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

  test("Ask from the assistant popover: the answer names M4 Exit and shows the tools it used", async () => {
    if (!assistantAvailable) test.skip(true, skipReason);
    const served: AssistantAnswerServed[] = [];
    const onMessageResponse = (res: import("@playwright/test").Response) => {
      const url = res.url();
      const isMessagePost =
        res.request().method() === "POST" &&
        url.includes("/api/v1/assistant/conversations/") &&
        url.endsWith("/messages") &&
        res.status() === 200;
      if (!isMessagePost) return;
      void (async () => {
        const body = (await res.json().catch(() => null)) as {
          messages?: ServedMessage[];
        } | null;
        for (const row of body?.messages ?? []) {
          if (row?.kind !== "assistant") continue;
          const payload = row.payload as unknown as AssistantAnswerServed;
          if (typeof payload?.answer_markdown === "string") served.push(payload);
        }
      })();
    };
    await test.step("Ctrl J opens the assistant popover and the question is sent", async () => {
      await gotoApp(alice, "/");
      alice.on("response", onMessageResponse);
      await alice.keyboard.press("Control+J");
      await expect(alice.getByTestId("assistant-popover")).toBeVisible();
      const input = alice.getByTestId("assistant-composer-input");
      await expect(input).toBeVisible();
      await input.fill(QUESTION);
      // Enter (no Shift) is the composer's own send key (AssistantPanel).
      await input.press("Enter");
    });
    await test.step("the served answer renders in the transcript (bounded wait)", async () => {
      // v2 has no stream either: the transcript appends the whole answer
      // when the turn settles, and one answer is a real model turn
      // (5-60 s on this lab). The answer is scoped to the LAST transcript
      // row — an adopted earlier conversation can already render rows.
      await expect
        .poll(() => served.length, { timeout: ANSWER_TIMEOUT_MS })
        .toBeGreaterThanOrEqual(1);
      const answer = served[served.length - 1];
      answerLinks = answer.links ?? [];
      const lastRow = alice.locator("[data-testid='assistant-msg-assistant']").last();
      const answerEl = lastRow.getByTestId("assistant-answer");
      await expect(answerEl).toBeVisible();
      expect(typeof answer.answer_markdown).toBe("string");
      expect(answer.answer_markdown.length).toBeGreaterThan(0);
    });
    await test.step("the answer names the M4 Exit project the way the component renders it", async () => {
      const answer = served[served.length - 1];
      const answerEl = alice
        .locator("[data-testid='assistant-msg-assistant']")
        .last()
        .getByTestId("assistant-answer");
      await expect(answerEl).toContainText(ALICE.projectName);
      // THE ANSWER IS RENDERED MARKDOWN (45d40ea, design 2f review: the
      // draft's `**Adapter swap → PR**` reached the person as asterisks, so the
      // transcript now runs `answer_markdown` through the app's own reader).
      // The markers are weight, slope and mono on screen, never glyphs — so the
      // served line is put through that same reading before it is compared:
      // every word of the first line the broker served must be on screen, in
      // order. An answer that was dropped, reworded, cut off, or left
      // un-rendered (markers between the words) still fails here.
      const firstLine = answer.answer_markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => renderedProseOf(line).length > 0);
      expect(firstLine, "the served answer carries no text line").toBeTruthy();
      const expected = renderedProseOf(firstLine!);
      expect(
        expected.length,
        `first line ${JSON.stringify(firstLine)} carries prose`,
      ).toBeGreaterThan(0);
      // The served prose, word by word: every character of it has to be on
      // screen in order, and only the whitespace between its words may differ
      // (a flex step row can render `✓` and its text with or without a space).
      const prosePattern = new RegExp(
        expected
          .split(" ")
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s*"),
      );
      await expect
        .poll(() => visibleProse(answerEl), {
          message: `the served answer's first line (${JSON.stringify(firstLine)}) is not the prose on screen`,
        })
        .toMatch(prosePattern);
      // And the markup stayed markup: nothing the first line wrapped in
      // `**strong**` reaches the reader as asterisks.
      for (const strong of firstLine!.matchAll(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g)) {
        await expect(answerEl).not.toContainText(`**${strong[1]}**`);
      }
    });
    await test.step("the tool transparency list renders what the broker reported", async () => {
      const answer = served[served.length - 1];
      const lastRow = alice.locator("[data-testid='assistant-msg-assistant']").last();
      const tools = lastRow.getByTestId("assistant-tools");
      if (answer.tool_calls.length > 0) {
        // Collapsed <details> by default: the component shows it only when
        // the broker really looked things up ("used N tools ▸").
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
          // Status is glyph + text, never colour alone: ✓ ok / × failed.
          await expect(rows.nth(i).locator("span[aria-hidden]").first()).toHaveText(
            call.ok ? "✓" : "×",
          );
        }
      } else {
        // An empty transparency record renders no block at all — the DOM
        // must agree with the served answer rather than invent one.
        await expect(tools).toHaveCount(0);
      }
    });
    await test.step("the answer's links render as buttons with the served wording, ids aside", async () => {
      const buttons = alice
        .locator("[data-testid='assistant-msg-assistant']")
        .last()
        .getByTestId("assistant-link");
      await expect(buttons).toHaveCount(answerLinks.length);
      for (let i = 0; i < answerLinks.length; i++) {
        // Round-17: the row shows the served label minus any raw id the model
        // pasted onto it, and it is never a step row — the step list's `●` (or
        // ✓ / ·) does not lead it.
        const expected = servedLabelWithoutIds(answerLinks[i].label);
        const row = buttons.nth(i);
        if (expected === "") {
          await expect(row).not.toContainText(answerLinks[i].label.trim());
        } else {
          await expect(row).toContainText(expected);
        }
        await expect(row).not.toContainText(/^\s*[\u2713\u25cf\u00b7]\s/);
      }
      await shot(alice, "m5-assistant-01-answer");
    });
  });

  test("every link in the answer lands on a real page", async () => {
    if (!assistantAvailable) test.skip(true, skipReason);
    // ADR-0050's link vocabulary is `route`; the v1-shaped payload carries
    // the same value as `href` — normalise so the leg tests the destination,
    // and the count assertion below still catches a UI that dropped them.
    const links = answerLinks.map((link) => ({
      label: link.label,
      route: link.route ?? link.href ?? "",
    }));
    await test.step(`the answer carried ${links.length} link${links.length === 1 ? "" : "s"}`, async () => {
      // "For every link in the answer": the set is the served answer's
      // `links` array, asserted one by one below — and the transcript must
      // render exactly that many buttons.
      const buttons = alice
        .locator("[data-testid='assistant-msg-assistant']")
        .last()
        .getByTestId("assistant-link");
      await expect(buttons).toHaveCount(links.length);
    });
    for (let i = 0; i < links.length; i++) {
      const { label, route } = links[i];
      await test.step(`link ${i + 1}/${links.length} — “${label}” (${route})`, async () => {
        if (i === 0) {
          // The product's own way to a link: click the rendered button, which
          // navigates to the served route (the popover stays open over the
          // destination — Esc closes it, the conversation survives).
          await alice
            .locator("[data-testid='assistant-msg-assistant']")
            .last()
            .getByTestId("assistant-link")
            .first()
            .click();
        } else {
          // The next link is served its route directly — the same destination
          // the button would navigate to.
          await gotoApp(alice, route);
        }
        // The destination is the served route's PATH and the app served it to
        // the signed-in session — and it is not the app's "Not found" page.
        const expectedPath = new URL(route, BASE_URL).pathname;
        await expect
          .poll(() => new URL(alice.url()).pathname, {
            message: `landed on ${new URL(alice.url()).pathname}, not the served route ${route}`,
          })
          .toBe(expectedPath);
        await expect(alice.getByTestId("user-badge")).toBeVisible();
        await expect(alice.getByText(NOT_FOUND_TEXT)).toHaveCount(0);
        // Close the popover so the next landing is judged on the page, not
        // on the overlay standing over it.
        await alice.keyboard.press("Escape");
        await shot(alice, `m5-assistant-02-link-${i + 1}`);
      });
    }
    await gotoApp(alice, "/");
  });
});
