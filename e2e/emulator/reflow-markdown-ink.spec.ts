// reflow-markdown-ink.spec.ts — the artifact/gate rule “no escaped markdown
// reached the reader”, on its own terms (`markdown-ink.ts`,
// `run-gate-artifacts.spec.ts`).
//
// Two shapes, both from Actions run 41542324484 (fingerprint
// 5b0127b528fd724f, pass-3's `plan.md`):
//
//   • a plan that QUOTES A SHELL COMMAND in a code span legitimately carries
//     `printf 'README.md\nhello.py\n…'` — CommonMark shows a code span exactly
//     as the author typed it, and those `\n` are the command's own bytes;
//   • the pass-1 defect the line was written for is the `model.chat` envelope
//     printed with the plan escaped INSIDE it, which puts `\n` in the plan's
//     SENTENCES and `\*\*` where its steps were bold.
//
// A rule that cannot tell those two apart reds on a plan that renders
// perfectly; a rule that stops looking for `\n` at all lets the envelope leak
// back in. The fixtures below are the pair that keeps both honest.
//
// No lab, no app build: `page.setContent` fixtures, run by the config's
// `reflow` project — the same no-lab home `plan-steps.ts` judges live in.
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts --project=reflow
import { expect, test } from "@playwright/test";
import { collectDocumentProse, escapedMarkdownFault } from "./markdown-ink.js";

/** The artifact preview's own markup: `markdown-paragraph` blocks whose inline
 * code is a `<code>` run, the way `ui/src/lib/markdown.tsx` paints it. */
function previewDoc(blocks: string[]): string {
  return `<!doctype html><meta charset=utf8><div data-testid="artifact-preview-prose">${blocks.join(
    "\n",
  )}</div>`;
}

const P = (inner: string): string =>
  `<p data-testid="markdown-paragraph"><span>${inner}</span></p>`;

async function readProse(page: import("@playwright/test").Page): Promise<string> {
  return page.getByTestId("artifact-preview-prose").evaluate(collectDocumentProse);
}

test.describe("no escaped markdown reached the reader", () => {
  test("(m1) pass-3's plan: a code span quoting printf is shell, not escaping", async ({
    page,
  }) => {
    await page.setContent(
      previewDoc([
        P("Confirm repository structure matches the survey manifest."),
        P(
          "Verification: diff &lt;(ls -1) &lt;(printf <code>README.md\\nhello.py\\npytest.ini\\ntests/test_hello.py\\n</code>) exits 0.",
        ),
        P("Run <code>pytest --tb=short -q</code> from the repo root."),
      ]),
    );
    const prose = await readProse(page);
    expect(prose, "the code's own bytes never join the prose the rule scans").not.toContain(
      "README.md\\nhello.py",
    );
    expect(escapedMarkdownFault(prose), "the plan carries no escape in its prose").toBe("");
  });

  test("(m2) the envelope leak the rule exists for: escaped newlines between sentences", async ({
    page,
  }) => {
    await page.setContent(
      previewDoc([
        // What pass-1's artifact page actually printed: the stored payload
        // read as text, the plan escaped inside it.
        P(
          '{"endpoint":"https://models.example/v1","model":"qwen","text":"Plan:\\n\\n## Step one"}',
        ),
      ]),
    );
    const prose = await readProse(page);
    expect(escapedMarkdownFault(prose)).toMatch(/escaped control character/);
  });

  test("(m3) escaped markup in prose is a fault; escaped markup in code is not", async ({
    page,
  }) => {
    await page.setContent(
      previewDoc([
        P("Do this \\*\\*loudly\\*\\* now."),
        P("Write it as <code>\\*\\*literal\\*\\*</code>."),
      ]),
    );
    const leaked = await page
      .getByTestId("markdown-paragraph")
      .first()
      .evaluate(collectDocumentProse);
    expect(escapedMarkdownFault(leaked)).toMatch(/backslash-escaped markdown marker/);

    await page.setContent(previewDoc([P("The rule reads <code>\\*\\*literal\\*\\*</code> only.")]));
    expect(escapedMarkdownFault(await readProse(page))).toBe("");
  });

  test("(m4) a fenced block keeps its payload out of the scan", async ({ page }) => {
    await page.setContent(
      previewDoc([
        P("Seal it with:"),
        `<div data-testid="markdown-code-box"><pre data-testid="markdown-code">print("a\\nb")\\nprint("c")</pre></div>`,
        P("and the plan ends here."),
      ]),
    );
    expect(escapedMarkdownFault(await readProse(page))).toBe("");
  });
});
