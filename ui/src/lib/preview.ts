/**
 * The thread row's preview of the agent's last line (design 1b RECENT
 * THREADS, 1g list pane).
 *
 * The wire's `last_agent_line` (ADR-0065) is the first non-empty line of an
 * agent chunk as the agent wrote it — and agents write markdown. Printed raw,
 * the row led with the markup instead of the sentence (`- hello.py: add a
 * docstring…` leaked a literal bullet, the pass-1 review). This is one shared
 * helper for every surface that shows the preview, so the three thread lists
 * (project overview, a project's Threads tab, `/threads`) say the same thing.
 *
 * It only ever REMOVES: leading markdown block markers (`-`, `*`, `+` bullets,
 * `#` headings, `>` quotes, `1.`/`1)` numbered steps — repeated or nested
 * stacks alike) and paired inline emphasis markers (`**b**`, `__b__`, `*i*`,
 * `_i_`, `` `c` ``, `~~s~~`). What is left is the agent's own words, still one
 * line; a line that was ONLY markup previews as the empty string, and the
 * caller then omits the row's last line honestly, exactly as for a null.
 * It adds nothing — no ellipsis, no quoting, no invented text.
 */

/** A leading block marker, once: a bullet, a heading, a quote (marker run
 * included) or a numbered step. A marker may also END the line (an agent
 * sent `- ` and nothing else), which is how a marker-only line previews as
 * nothing. Each alternative consumes at least one character, so repeated
 * stripping always terminates. */
const BLOCK_MARKER = /^(?:[-*+]|#{1,6}|>+|\d+[.)])(?:\s|$)/;

/** Strip the markdown markers a list row should never print. */
export function previewLine(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw.trim();
  while (BLOCK_MARKER.test(text)) {
    text = text.replace(BLOCK_MARKER, "").trim();
  }
  // Paired inline emphasis, bold/strike first so `**x**` cannot be eaten by
  // the single-`*` rule; content may not start or end with a space, so two
  // lone `*` around words stay text (markdown's own rule). `_` only counts
  // between word boundaries: `snake_case` step ids and `a_b` tokens keep
  // their underscores.
  text = text
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/(^|[^\w`])__(\S(?:.*?\S)?)__(?![\w`])/g, "$1$2")
    .replace(/(^|[^\w`])_(\S(?:.*?\S)?)_(?![\w`])/g, "$1$2");
  return text.trim();
}
