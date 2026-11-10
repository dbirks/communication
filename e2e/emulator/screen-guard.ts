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
//   (c) The chrome may not speak the IMPLEMENTATION's words. Finding 12's
//       copy pass (acceptance T9) retired "control plane", "server build",
//       "scaffold", "decision word" and "winner" (the 04 DecisionBar made the
//       "not a decision word" path — and T10's box — dead), and it retired
//       quoting a bare HTTP status in prose (`The control plane answered 404`).
//       These phrases run over the SAME stripped chrome text as rule (a):
//       `<code>`/`<pre>` and the model-/person-written regions are cut the
//       same way, because a YAML comment saying "the control plane" inside a
//       template preview is still code. The rulebook allow-lists NOTHING for
//       this family — no product noun is called "winner" — so unlike rule (a)
//       there is no token list to punch through. A bare status code
//       (404/409/500/503) is only a hit when it reads as PROSE: word-bounded
//       exactly like a word (so a run id, a digest or `404ms` never hit) and
//       flanked on at least one side by a letter or a space (so a JSON body's
//       `"status":500,` or a dotted version `1.404.2` never hit either).
//
// WHAT THE COLLECTORS MAY NOT DO: they are serialized by `page.evaluate` like
// every emulator collector (`collectReflowItems.toString()`-style), so each
// references nothing but its own argument and the page. The exclusions travel
// as plain string arrays.

/** One captured screen's retired-IA hits. */
export interface ScreenGuardHit {
  /** The retired word found in the chrome text (rule a), lower-cased. */
  words: string[];
  /** The implementation words found in the chrome text (rule c): each
   * IMPLEMENTATION_PHRASES entry matched, plus each bare BARE_STATUS_CODES
   * prose hit as the digits found (e.g. `"404"`). */
  implementation: string[];
  /** The rendered text AROUND each rule-(c) hit (≤ 3, ±30 chars). */
  implementationSnippets: string[];
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
 * The implementation words finding 12 retired from visible copy (T9), plus
 * the "decision word" sentence the closed-button DecisionBar deleted (T10).
 * Matched case-insensitively with the same word boundaries as rule (a)
 * ("Scaffolded" is not "scaffold"), and allow-listed by NOTHING.
 */
const IMPLEMENTATION_PHRASES = [
  "control plane",
  "server build",
  "scaffold",
  "decision word",
  "winner",
];

/**
 * The bare HTTP statuses f12 called out ("The control plane answered 404").
 * Only PROSE hits count: word-bounded (no digit/hex neighbour — a run id,
 * digest or port can never match) AND at least one side a letter, a space or
 * the text's edge — the JSON `"status":500,` sits between a colon and a
 * comma and is data, not a sentence.
 */
const BARE_STATUS_CODES = ["404", "409", "500", "503"];

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
  // The Assistant handoff's surfaces that sit OUTSIDE the transcript box
  // (`assistant-messages`, already listed) but still speak with the server's —
  // not the app's — words: the panel header's thread title (`conversation.title`,
  // the name the assistant gave the thread), the composer's sr-only context chip
  // when a draft ask named a chat (that IS the thread's own title), the change
  // chip's row list and the full page's CHANGES rows — every one of those
  // strings is model- or person-authored content (`assistant_changes.summary`,
  // `RecentConversation.title`). The chrome beside them ("New thread", "undo
  // all", "LOOKING AT", "TRUST") stays scanned: only the rows are excluded.
  "assistant-thread-title",
  "assistant-context-chip",
  "assistant-change-list",
  "assistant-page-change",
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
  /** The implementation phrases (rule c; word-bounded, case-insensitive). */
  phrases: string[];
  /** The bare status codes rule (c) reads as prose. */
  codes: string[];
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
    phrases: IMPLEMENTATION_PHRASES,
    codes: BARE_STATUS_CODES,
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

  // (c) The implementation words, over the SAME stripped chrome text. The
  // phrases match exactly like rule (a)'s words. A bare status code must read
  // as prose: word-bounded (wordChar already refuses digits and hex letters,
  // so ids, digests, `4040`, `404ms` and `1404` cannot hit) and flanked on at
  // least one side by a letter, a space or the text's edge — the extra arm is
  // what keeps machine data (`"status":500,`, `v1.404.2`) out of the filing.
  const implementation: string[] = [];
  const implSnippets: string[] = [];
  const pushImpl = (label: string, at: number, length: number): void => {
    if (!implementation.includes(label)) implementation.push(label);
    if (implSnippets.length < 3) {
      const window = collapse(
        text.slice(
          Math.max(0, at - SNIPPET_CONTEXT),
          Math.min(text.length, at + length + SNIPPET_CONTEXT),
        ),
      );
      if (window && !implSnippets.includes(window)) implSnippets.push(window);
    }
  };
  for (const phrase of input.phrases) {
    const needle = phrase.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(needle, from);
      if (at < 0) break;
      const before = at > 0 ? text.charAt(at - 1) : "";
      const after = at + needle.length < text.length ? text.charAt(at + needle.length) : "";
      if (!wordChar(before) && !wordChar(after)) pushImpl(phrase, at, needle.length);
      from = at + 1;
    }
  }
  const proseSide = (ch: string): boolean => ch === "" || ch === " " || /[A-Za-z]/.test(ch);
  for (const code of input.codes) {
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(code, from);
      if (at < 0) break;
      const before = at > 0 ? text.charAt(at - 1) : "";
      const after = at + code.length < text.length ? text.charAt(at + code.length) : "";
      if (!wordChar(before) && !wordChar(after) && (proseSide(before) || proseSide(after))) {
        pushImpl(code, at, code.length);
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

  return { words, routes, snippets, implementation, implementationSnippets: implSnippets };
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
  if (hit.implementation.length > 0) {
    // Rule (c) files its own line: these are not retired IA nouns but the
    // implementation words finding 12 cut from visible copy (T9) and the
    // "decision word" sentence T10 deleted — the reader's words, not the
    // code's.
    const where =
      hit.implementationSnippets.length > 0
        ? ` — matched in: ${hit.implementationSnippets
            .slice(0, 3)
            .map((s) => `“${s}”`)
            .join(" ; ")}`
        : "";
    parts.push(
      `implementation words in visible chrome text: ${hit.implementation
        .slice(0, 5)
        .join(", ")}${where} — finding 12: name the reader's problem, not the build`,
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
