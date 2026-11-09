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
// (g7)–(g9) judge the guard's SECOND phrase list (rule c, acceptance T9/T10):
// finding 12's implementation words — "control plane", "server build",
// "scaffold", "decision word", "winner", and a bare 404/409/500/503 read as
// prose — over the same exclusions, with the numbers-in-data refusals the
// rule depends on.
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

  test("(g7) the implementation words in the app's own chrome file (rule c, T9/T10)", async ({
    page,
  }) => {
    // The strings finding 12 rewrote word for word, and the "decision word"
    // sentence the closed-button DecisionBar deleted (T10). Each is said here
    // the way the OLD copy said it, in plain app chrome.
    for (const [label, body] of [
      ["server build", `<p>! not available yet — this server build predates the reads</p>`],
      ["control plane", `<p>The control plane answered and this page shows no more.</p>`],
      ["scaffold", `<p>this page shows no scaffold for a run it cannot see</p>`],
      ["decision word", `<p>“Ship it” is not a decision word — choose the decision:</p>`],
      ["winner", `<p>someone decided this gate first — what you see now is the winner's</p>`],
      ["bare 404 in prose", `<p>The control plane answered 404 — this page shows nothing.</p>`],
      ["bare 409 in prose", `<p>Your decision hit a 409 conflict; the gate is already decided.</p>`],
      ["bare 500 mid-sentence", `<p>The server gave a 500 and stopped.</p>`],
      ["bare 503 at the end", `<p>The assistant is not reachable right now: 503</p>`],
    ] as const) {
      await page.setContent(DOC(body));
      const hit = await guard(page);
      expect(hit.implementation, `${label} must file under rule (c)`).not.toHaveLength(0);
    }
    // The rule (c) hit is its own line in the defect detail, worded so a
    // reader of the report knows WHICH rule broke (finding 12, not the IA
    // rename) and can see the chrome around it.
    await page.setContent(DOC(`<p>The control plane answered 404 here.</p>`));
    const hit = await guard(page);
    expect(hit.implementation).toContain("control plane");
    expect(hit.implementation, "the prose 404 files beside the phrase").toContain("404");
    expect(hit.words, "rule (c) does not leak into the retired-words list").toEqual([]);
    const detail = screenGuardDetail(hit);
    expect(detail).toContain("implementation words in visible chrome text");
    expect(detail).toContain("finding 12");
    expect(
      detail.length,
      "a rule-(c) detail stays inside the fixture's MAX_DETAIL",
    ).toBeLessThanOrEqual(500);
  });

  test("(g8) rule (c) shares rule (a)'s exclusions — and numbers inside data never file",
    async ({ page }) => {
      const sentence = `<p>The control plane answered 404 — no scaffold, the server build is old.</p>`;
      // Same structural cut as the chat scan: code font and the written regions
      // are not the app's chrome (a template YAML comment, a model-written
      // thread title, a seeded piece's narrative).
      for (const region of [
        `<div>${sentence}</div>`, // control: OUTSIDE every exclusion, it files
      ]) {
        await page.setContent(DOC(region));
        expect((await guard(page)).implementation).not.toHaveLength(0);
      }
      for (const region of [
        `<code>${sentence}</code>`,
        `<pre>${sentence}</pre>`,
        `<textarea>${sentence}</textarea>`,
      ]) {
        await page.setContent(DOC(region));
        expect(
          (await guard(page)).implementation,
          `${region.slice(0, 24)}… is code or a written region, not chrome copy`,
        ).toEqual([]);
      }
      for (const testid of ["transcript-item", "artifact-preview-prose", "catchup-row-7", "tour-current"]) {
        await page.setContent(DOC(`<div data-testid="${testid}">${sentence}</div>`));
        expect(
          (await guard(page)).implementation,
          `${testid} holds model/user text`,
        ).toEqual([]);
      }
      // Numbers inside DATA are not prose: the word-bounds refuse ids, digests
      // and units, and the letter/space flank refuses machine shapes — while
      // the SAME digits as a word of the sentence do file (checked in g7).
      for (const body of [
        `<p>run 01a1b404c7d2 is not visible to you</p>`,
        `<p>digest 404abcd deadbeef</p>`,
        `<p>the timeout was 500ms, not a status</p>`,
        `<p>worker on port 4040 answered fine</p>`,
        `<p>value 1404 and 25033 round the column</p>`,
        `<p>{"status":500,"type":"about:blank"} stayed collapsed raw text</p>`,
        `<p>build v1.404.2 shipped quietly</p>`,
        // Word-bounded phrases too: a stem inside a longer word is not the word.
        `<p>the scheduler scaffolded the tree in 12ms</p>`,
        `<p>winners never cry</p>`,
      ]) {
        await page.setContent(DOC(body));
        const hit = await guard(page);
        expect(hit.implementation, `${body} is data or a longer word, not prose`).toEqual([]);
      }
    });

  test("(g9) a clean page files nothing under either rule, and the two rules file alone",
    async ({ page }) => {
      // The REWRITTEN chrome (what shipped): the reader's words, no numbers.
      await page.setContent(
        DOC(
          `<p>This run doesn't exist or you don't have access to it.</p>` +
            `<p>Priya approved this 20 seconds ago. Your decision wasn't recorded.</p>`,
        ),
      );
      const clean = await guard(page);
      expect(clean.words).toEqual([]);
      expect(clean.implementation).toEqual([]);
      expect(clean.implementationSnippets).toEqual([]);
      // A retired-words hit alone still files only rule (a)…
      await page.setContent(DOC(`<nav><a href="/chat">Chat</a></nav>`));
      const iaOnly = await guard(page);
      expect(iaOnly.words).toEqual(["chat"]);
      expect(iaOnly.implementation).toEqual([]);
      // …and an implementation word alone files only rule (c), each with its
      // own context windows (dedupe reads them separately in fixtures.ts).
      await page.setContent(DOC(`<p>This server build predates the cross-project reads.</p>`));
      const implOnly = await guard(page);
      expect(implOnly.words).toEqual([]);
      expect(implOnly.implementation).toEqual(["server build"]);
      expect(implOnly.implementationSnippets.length).toBeGreaterThan(0);
      expect(implOnly.implementationSnippets[0].toLowerCase()).toContain("server build");
    });
});
