// markdown-ink.ts — did the document's OWN markup reach the reader as ink?
// (`run-gate-artifacts.spec.ts`, the artifact page's “no escaped markdown in
// the document” line).
//
// The defect this rule exists for is from pass-1 design review item 4
// (`artifact-plan-md-1280.png`): the artifact page printed the `model.chat`
// envelope — `{endpoint, model, text}` — with the plan escaped INSIDE the
// string, so the reader saw `\n` where the document's line breaks were and
// `\*\*` where its steps were bold. That signature lives in the document's
// PROSE, and only there: CommonMark renders a code span, inline or fenced,
// exactly as the author typed it, and a plan quoting `printf 'README.md\n
// hello.py'` carries a literal `\n` in that code because it is SHELL. Reading
// the two the same way reds on a plan that renders perfectly — Actions run
// 41542324484, pass-3, fingerprint 5b0127b528fd724f, where the numbered 1…6
// plan and its code spans were fine and the check still failed.
//
// So the read is scoped: what the reader sees as ESCAPED MARKUP is the text
// of the document OUTSIDE its code, and that is what the rule judges. An
// envelope leak still trips it (its `\n` sit between the plan's sentences, in
// prose), and so does a backslash-escaped `*`, `_`, `#`, `[` or a stray
// double backslash.
//
// `collectDocumentProse` runs INSIDE the page via `locator.evaluate`, so it is
// serialized to source: DOM only, self-contained, no reference to this module
// (the same rule `plan-steps.ts` and `reflow.ts` collect under).
// `escapedMarkdownFault` is pure and unit-tested in
// `reflow-markdown-ink.spec.ts` against both the live plan's shape and the
// envelope leak.

/** The escape signatures that mean “this document was never unescaped”. */
const ESCAPES: ReadonlyArray<{ read: RegExp; says: string }> = [
  { read: /\\[nrt]/, says: "an escaped control character (\\n, \\r or \\t)" },
  { read: /\\[*_`#[\]\\]/, says: "a backslash-escaped markdown marker" },
];

/**
 * The prose of a rendered markdown document: every text node it paints, with
 * the code the author wrote kept out. `code` (an inline span) and `pre` (a
 * fenced block, whatever wrapper the renderer gives it) are removed before the
 * text is read, because what they hold is bytes, not escaping.
 */
export function collectDocumentProse(root: HTMLElement): string {
  const read = root.cloneNode(true) as HTMLElement;
  for (const box of Array.from(read.querySelectorAll("code, pre"))) box.remove();
  return (read.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** "" when the document's prose carries no escaped markup; otherwise the
 * offending sequence and where it sits, in the words a defect line needs. */
export function escapedMarkdownFault(prose: string): string {
  for (const escape of ESCAPES) {
    const match = escape.read.exec(prose);
    if (match === null) continue;
    const at = match.index ?? 0;
    const window = prose.slice(Math.max(0, at - 40), at + 40).trim();
    return `the document's prose carries ${escape.says} (“${match[0]}”) — …${window}…`;
  }
  return "";
}
