// screen-guard.ts — the two IA rules the redesign made product-wide, checked on
// EVERY captured screen (the reason T1/T3 were only unit-proven before this
// file: `communication-spec` renamed the surface — "conversation" → "thread",
// the Inbox folded into Today, the Board into the repository's Lanes view — and
// a stray nav row or a `conversation` in a heading is exactly the regression a
// per-page unit test cannot see. `fixtures.ts` runs the collectors returned by
// `screenGuardFor` inside every `emu.screen()` capture at both widths and files
// a `retired-ia` defect for each hit, so the whole 160+ screen pass is the
// proof.
//
// The two rules, verbatim from the brief:
//
//   (a) The page's VISIBLE text may not contain the retired nouns
//       chat / chats / conversation / conversations. It is scanned as
//       `document.body.innerText` (rendered text only) with the parts a
//       MODEL or a PERSON wrote cut out — a thread transcript, an artifact's
//       markdown, a tour's narrative, an assistant reply — because the app
//       does not own that prose and the rule is about the app's CHROME, not
//       about a run that happened to say "conversation" in a log line. The
//       `<code>`/`<pre>` cut is the same reason: a real revision digest, a
//       YAML `kind: model.chat` line or a `conversation_id` field name is
//       CODE, not a label. On top of the structural cut an ALLOW-LIST holds
//       the product nouns that legitimately survive — the closed node-kind
//       ids (`model.chat`, `agent.acp`, …) spelled exactly as the compiler
//       names them — so a node-type id shown in a mono/code chip never
//       trips the check.
//
//   (b) No anchor may point at the retired destinations: `href="/inbox"` or
//       `href="/board"`, or any href starting with those (`/inbox/…`,
//       `/board?tab=…`). Both are unmounted (finding 03) and redirect to `/`,
//       so a link still drawing one is a dead-end the reader can click.
//
// WHAT THE COLLECTORS MAY NOT DO: they are serialized by `page.evaluate` like
// every emulator collector (`collectReflowItems.toString()`-style), so each
// references nothing but its own argument and the page. The exclusions travel
// as plain string arrays.

/** One captured screen's retired-IA hits. */
export interface ScreenGuardHit {
  /** The retired word found in the chrome text (rule a), lower-cased. */
  words: string[];
  /** The retired destination hrefs found on the page (rule b). */
  routes: string[];
  /** The rendered text AROUND each word hit (≤ 3, ±30 chars, whitespace
   * collapsed) — the diagnosis the word alone never gives: a seed's thread
   * title, a shipped template's description and a stray nav row all print
   * `chat`, and only the context tells them apart. */
  snippets: string[];
}

/** The retired nouns, word-bounded and case-insensitive. */
const RETIRED_WORDS = ["chat", "chats", "conversation", "conversations"];

/**
 * The product nouns the chrome legitimately keeps. Each is matched as the WHOLE
 * token it is (`model.chat`), not as the retired word inside it, so the entry
 * only ever suppresses the exact id — a bare "Chat" label or a "Conversations"
 * heading still files. The closed node-kind vocabulary (`internal/domain`'s
 * NodeKind) is the family that reaches the screen this way: Studio draws a
 * node's `kind` in a mono chip and `communication-spec` names them, so the
 * string is served truth about the pipeline, not leftover IA copy.
 */
const ALLOWED_PRODUCT_TOKENS = [
  "model.chat",
  "agent.acp",
  "process.exec",
  "pipeline.child",
  "human.approval",
  "model.chat,",
  "agent.acp,",
];

/** The page-owned content regions a MODEL or a PERSON wrote — the app is not
 * the author of their text, so the retired-word rule does not apply to it.
 * Every id here is a container the transcript / artifact / assistant / catch-up
 * surfaces render their authored prose inside. */
const WRITTEN_CONTENT_TESTIDS = [
  "transcript",
  "transcript-item",
  "transcript-mail-cards",
  "transcript-empty",
  "agent-message-body",
  "agent-plan",
  "agent-plan-raw",
  "assistant-messages",
  "assistant-history",
  "assistant-history-item",
  "artifact-preview-prose",
  "artifact-preview-raw",
  "artifact-preview-markdown",
  "artifact-preview-panel",
  "artifact-preview-frame",
  "artifact-raw-block",
  "catchup-item-current",
  "catchup-item-title",
  "catchup-decision",
  "catchup-recap",
  "tour-current",
  "run-drawer-summary",
  "run-drawer-events",
  "run-drawer-event-item",
  "inputs-yaml-preview",
];

/** The same rule for the regions whose id is per-row: a seeded or generated
 * piece of work owns its own title, summary and narrative (ADR-0078 § Decision
 * 3 — those strings are MODEL OUTPUT, "rendered as text"), so a rest row, a tour
 * card or a stop-list row may legitimately print whatever the assistant wrote
 * about the work. The app-chrome words beside them ("Issue", "merged") come from
 * a closed vocabulary and are never the retired nouns, so nothing is lost. */
const WRITTEN_CONTENT_TESTID_PREFIXES = [
  "catchup-row-",
  "catchup-card-",
  "catchup-item-stop-",
  "home-callout-",
];

/** The collector's argument — serialized, so plain data. */
export interface ScreenGuardInput {
  /** CSS selectors for the regions excluded from the word scan. */
  excludeSelectors: string[];
  /** Exact tokens suppressed from the word scan even outside a region. */
  allowedTokens: string[];
  /** The retired word list (word-bounded, case-insensitive). */
  words: string[];
  /** The retired destination prefixes. */
  routePrefixes: string[];
}

/** Build the collector argument from this file's own lists. */
export function screenGuardInput(): ScreenGuardInput {
  const excludeSelectors = ["code", "pre", "textarea", "[role='textbox']"];
  for (const testid of WRITTEN_CONTENT_TESTIDS) {
    excludeSelectors.push(`[data-testid="${testid}"]`);
  }
  for (const prefix of WRITTEN_CONTENT_TESTID_PREFIXES) {
    excludeSelectors.push(`[data-testid^="${prefix}"]`);
  }
  return {
    excludeSelectors,
    allowedTokens: ALLOWED_PRODUCT_TOKENS,
    words: RETIRED_WORDS,
    routePrefixes: ["/inbox", "/board"],
  };
}

/**
 * The page-side collector (serialized by `page.evaluate`, DOM only, no module
 * references). Returns the retired words visible in the page's chrome and the
 * retired destination hrefs it links to.
 */
export function screenGuardFind(input: ScreenGuardInput): ScreenGuardHit {
  // (a) The chrome text: the whole body's rendered innerText, minus every
  // excluded region's own innerText (the run-gate artifact scan removes the
  // preview the same way — substring removal, because innerText of the body is
  // what the reader actually sees). Then each allowed product token is blanked
  // so a node-kind id like `model.chat` does not register its word.
  let text = document.body ? document.body.innerText : "";
  for (const selector of input.excludeSelectors) {
    try {
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i += 1) {
        const own = (nodes[i] as HTMLElement).innerText;
        if (own) text = text.split(own).join(" ");
      }
    } catch {
      // A selector that matches nothing leaves the scan over the full text.
    }
  }
  for (const token of input.allowedTokens) {
    const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, " ");
  }

  const wordChar = (ch: string | undefined): boolean =>
    ch !== undefined && ch !== "" && /[A-Za-z0-9_]/.test(ch);
  const words: string[] = [];
  // The context around each hit (first 3, ± SNIPPET_CONTEXT chars): the
  // defect detail is read by whoever fixes the copy, and `visible chrome
  // text: chat` on its own cannot say WHICH chat — a seeded thread title in
  // the sidebar, a shipped template's description, or a real nav row.
  const SNIPPET_CONTEXT = 30;
  const snippets: string[] = [];
  const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
  const lowered = text.toLowerCase();
  for (const word of input.words) {
    const needle = word.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(needle, from);
      if (at < 0) break;
      const before = at > 0 ? text.charAt(at - 1) : "";
      const after = at + needle.length < text.length ? text.charAt(at + needle.length) : "";
      if (!wordChar(before) && !wordChar(after)) {
        if (!words.includes(word)) words.push(word);
        if (snippets.length < 3) {
          const window = collapse(
            text.slice(
              Math.max(0, at - SNIPPET_CONTEXT),
              Math.min(text.length, at + needle.length + SNIPPET_CONTEXT),
            ),
          );
          if (window && !snippets.includes(window)) snippets.push(window);
        }
      }
      from = at + 1;
    }
  }

  // (b) The retired destinations, matched on the anchor's own href attribute
  // (react-router writes the `to` verbatim, so `/inbox` is exactly that): the
  // whole value or a value starting with the prefix plus a path/query boundary.
  const routes: string[] = [];
  const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (let i = 0; i < anchors.length; i += 1) {
    const href = anchors[i].getAttribute("href") ?? "";
    if (!href) continue;
    for (const prefix of input.routePrefixes) {
      const boundary =
        href === prefix ||
        href.startsWith(`${prefix}/`) ||
        href.startsWith(`${prefix}?`) ||
        href.startsWith(`${prefix}#`);
      if (boundary) {
        if (!routes.includes(href)) routes.push(href);
        break;
      }
    }
  }

  return { words, routes, snippets };
}

/** One defect detail for a screen's hits — the `; ` join keeps each hit on its
 * own and stays inside the fixture's MAX_DETAIL. */
export function screenGuardDetail(hit: ScreenGuardHit): string {
  const parts: string[] = [];
  if (hit.words.length > 0) {
    // The first 3 matched snippets travel with the words so the filing is
    // diagnosable without a rerun: each window is ±30 chars of the rendered
    // chrome around a hit, collapsed to one line.
    const where =
      hit.snippets.length > 0
        ? ` — matched in: ${hit.snippets.slice(0, 3).map((s) => `“${s}”`).join(" ; ")}`
        : "";
    parts.push(
      `retired IA word in visible chrome text: ${hit.words
        .slice(0, 5)
        .join(", ")}${where} — the surface says thread / Today, not this`,
    );
  }
  if (hit.routes.length > 0) {
    parts.push(
      `link to a retired destination: ${hit.routes
        .slice(0, 5)
        .join(", ")} — /inbox and /board are unmounted (finding 03)`,
    );
  }
  return parts.join(" | ");
}
