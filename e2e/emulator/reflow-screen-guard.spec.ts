// reflow-screen-guard.spec.ts — the IA screen-guard (screen-guard.ts), on its
// own terms.
//
// The guard runs inside every `emu.screen()` capture, so its false positives and
// its misses are only visible against a real lab pass — which is exactly how a
// rule like this goes wrong quietly: too eager and every screen files a defect,
// too weak and the copy regression it exists to catch walks straight through.
// These fixtures pin both edges with `page.setContent` markup, so the rule is
// judged without a lab, the same no-lab home `plan-steps.ts` and
// `markdown-ink.ts` judges theirs.
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts --project=reflow
//
// The markup mirrors the real components: `ShapeLabel`'s mono spans, the
// transcript's `transcript-item` rows, the artifact preview's
// `artifact-preview-prose`, the rest list's `catchup-row-<id>` — so a rename of
// one of those testids shows up HERE rather than as a screen full of defects.
import { expect, test } from "./fixtures.js";
import {
  screenGuardDetail,
  screenGuardFind,
  screenGuardInput,
  type ScreenGuardHit,
} from "./screen-guard.js";

/** The guard, run over the page exactly as `fixtures.ts` runs it in a capture. */
async function guard(page: import("@playwright/test").Page): Promise<ScreenGuardHit> {
  return page.evaluate(screenGuardFind, screenGuardInput());
}

const DOC = (inner: string): string =>
  `<!doctype html><meta charset=utf8><body><div data-testid="guard-root">${inner}</div></body>`;

test.describe("the IA screen-guard (T1/T3)", () => {
  test("(g1) the retired words in the app's own chrome file", async ({ page }) => {
    for (const [label, body] of [
      ["a nav row", `<nav><a href="/conversations">Conversations</a></nav>`],
      ["a rail tooltip", `<span role="tooltip">Chat</span>`],
      ["a heading", `<h1>Chats</h1>`],
      ["a button", `<button>Start a conversation</button>`],
    ] as const) {
      await page.setContent(DOC(body));
      const hit = await guard(page);
      expect(hit.words, `${label} carries a retired word`).not.toHaveLength(0);
    }
  });

  test("(g2) the retired destinations file, at the boundary and below it", async ({ page }) => {
    for (const href of ["/inbox", "/board", "/inbox/12", "/board?tab=runs", "/inbox#top"]) {
      await page.setContent(DOC(`<a href="${href}">a row</a>`));
      const hit = await guard(page);
      expect(hit.routes, `${href} is a retired destination`).toContain(href);
    }
    // A word that merely STARTS with the prefix is not the retired route.
    await page.setContent(DOC(`<a href="/inbox-rules">Notes</a><a href="/boardman">Guy</a>`));
    expect((await guard(page)).routes, "a prefix collision is not the dead route").toEqual([]);
  });

  test("(g3) what a MODEL or a PERSON wrote never files", async ({ page }) => {
    const sentences = [
      `<p>The conversation moved on.</p>`,
      `<p>Ask the chat model to retry.</p>`,
    ];
    for (const sentence of sentences) {
      for (const region of [
        `data-testid="transcript"`,
        `data-testid="transcript-item"`,
        `data-testid="agent-message-body"`,
        `data-testid="assistant-messages"`,
        `data-testid="artifact-preview-prose"`,
        `data-testid="artifact-preview-raw"`,
        `data-testid="catchup-item-current"`,
        `data-testid="catchup-recap"`,
        `data-testid="tour-current"`,
      ]) {
        await page.setContent(DOC(`<div ${region}>${sentence}</div>`));
        const hit = await guard(page);
        expect(
          hit.words,
          `${region} holds model output; ${sentence} must not file`,
        ).toEqual([]);
      }
    }
    // Per-row regions: a seeded or generated piece owns its title and summary.
    for (const testid of ["catchup-row-abc", "catchup-card-1", "catchup-item-stop-x", "home-callout-1"]) {
      await page.setContent(DOC(`<div data-testid="${testid}"><span>${sentences[0]}</span></div>`));
      expect((await guard(page)).words, `${testid} is model output`).toEqual([]);
    }
  });

  test("(g4) code font and the product's own node-kind ids never file", async ({ page }) => {
    for (const body of [
      // `model.chat` reaches the screen as a `kind` id — the brief's named
      // allow-list case — whether the renderer chose code font or a mono chip.
      `<p>kind: <code>model.chat</code></p>`,
      `<span class="font-mono">model.chat</span>`,
      `<pre>nodes:\n  - kind: model.chat\n    id: plan</pre>`,
      `<span>agent.acp</span>`,
      `<span>human.approval</span>`,
      // A field NAME the API really has, printed as chrome text.
      `<p>conversation_id is null</p>`,
      // What the rename actually says: thread, never the retired noun.
      `<a href="/threads">Threads</a><button>New thread</button><h1>Catch up</h1>`,
    ]) {
      await page.setContent(DOC(body));
      const hit = await guard(page);
      expect(hit.words, `${body} is code or a product noun, not retired IA copy`).toEqual([]);
    }
  });

  test("(g5) one hit does not hide another, and a clean page files nothing", async ({ page }) => {
    // Real nav rows are separate blocks, and the guard reads what the browser
    // RENDERS: two inline anchors with no whitespace between them paint as one
    // word, and a rule that matched that would be matching typography, not copy.
    await page.setContent(
      DOC(
        `<nav><div><a href="/inbox">Inbox</a></div><div><a href="/conversations">Conversations</a></div></nav>` +
          `<div data-testid="transcript"><p>the conversation moved</p></div>`,
      ),
    );
    const hit = await guard(page);
    expect(hit.routes).toEqual(["/inbox"]);
    // The WORD the page printed, not a stem of it: "Conversations" is the
    // plural the rule lists, and the word-boundary check is what stops the
    // shorter entries from matching inside a longer one.
    expect(hit.words).toEqual(["conversations"]);
    expect(hit.words).not.toContain("conversation");
    expect(hit.words).not.toContain("chats");

    await page.setContent(DOC(`<p>This conversation is a thread now.</p>`));
    expect((await guard(page)).words, "the singular form files too").toEqual(["conversation"]);

    await page.setContent(
      DOC(
        `<a href="/p/1/threads">Threads</a><a href="/catch-up">Catch up</a>` +
          `<span>Push to main</span><span>branch ready</span>`,
      ),
    );
    const clean = await guard(page);
    expect(clean.words, "the redesigned vocabulary files nothing").toEqual([]);
    expect(clean.routes, "the canonical routes file nothing").toEqual([]);
    expect(clean.snippets, "a clean page has nothing to show around a word").toEqual([]);
  });

  test("(g6) a filed word carries its context, so the defect says WHERE it printed", async ({
    page,
  }) => {
    // The acceptance 42558168285 lesson: `visible chrome text: chat` on 24
    // screens named the word but not the source. Each hit now travels with a
    // ±30-char window of the rendered chrome around it (first 3, whitespace
    // collapsed), and the defect detail prints those windows.
    await page.setContent(
      DOC(
        `<aside><span>Emu rcn chat 4255 — a seeded thread title</span></aside>` +
          `<p>Description: draft a plan for a goal with a chat model, hold it.</p>`,
      ),
    );
    const hit = await guard(page);
    expect(hit.words).toEqual(["chat"]);
    // Both rendered windows show the word and the words printed beside it.
    expect(hit.snippets.length, "one window per hit, capped at 3").toBeLessThanOrEqual(3);
    expect(hit.snippets.length, "each of the two hits keeps its own window").toBeGreaterThanOrEqual(
      2,
    );
    for (const snippet of hit.snippets) {
      expect(snippet.toLowerCase(), `“${snippet}” is the chrome around a hit`).toContain("chat");
    }
    expect(
      hit.snippets.some((s) => s.includes("Emu rcn chat")),
      `a window names the seeded title: ${JSON.stringify(hit.snippets)}`,
    ).toBe(true);
    expect(
      hit.snippets.some((s) => s.includes("with a chat model")),
      `a window names the shipped description: ${JSON.stringify(hit.snippets)}`,
    ).toBe(true);
    const detail = screenGuardDetail(hit);
    expect(detail, "the detail prints the matched windows").toContain("matched in:");
    expect(detail).toContain("Emu rcn chat");
    expect(
      detail.length,
      "one defect detail stays inside the fixture's MAX_DETAIL",
    ).toBeLessThanOrEqual(500);
  });
});
