/**
 * Markdown, read — not rendered by a dependency.
 *
 * A plan body arrives as markdown because an agent wrote it (`## Step`,
 * `**Files**`, back-ticked paths). Shown raw, the reader parses the markup
 * instead of the plan — the pass-2 design review saw `## Implementation Plan`
 * and `` `pytest.ini` `` printed inside a gate card. The app has no markdown
 * library (`ui/package.json`) and this is not worth shipping one for: the
 * subset a plan, an approval comment or an assistant answer actually uses is
 * small, and what falls outside that subset stays legible text rather than
 * markup the reader has to parse by hand. The one renderer the app already had is the assistant's
 * `AnswerProse` (`components/assistant/MessageList.tsx`) — private, and only
 * paragraphs plus code spans, which cannot read a plan's headings and steps.
 * Its `ADR-0020` rule holds here too: nothing is turned into HTML.
 *
 * The rules, in the order the block scanner applies them:
 *
 * - a ``` fence is a code block: mono, whitespace kept, no inline markup;
 * - `#`…`######` at the start of a line is a heading (level kept);
 * - `-`/`*`/`+` start a bullet, `1.`/`2)` an ordered item, `>` a quote;
 *   a nested list item (indented) becomes a list INSIDE the item above it, so
 *   the outer list stays one list and keeps counting (see `MarkdownListItem`);
 * - `---`, `***` and `___` on their own line are a rule;
 * - anything else is a paragraph; blank lines separate blocks.
 *
 * Inline: `` `code` `` becomes mono, `**strong**`/`__strong__` become bold,
 * `*emphasis*`/`_emphasis_` become italic, `[label](url)` becomes a link — and
 * only an `http(s)` link: a `javascript:` or `file:` target is reduced to its
 * label, because this text is agent output and a click is not a place to
 * re-discover that.
 *
 * And these nest, because a plan writes them nested: a step heading is bold and
 * names a file in code INSIDE that bold (`**Patch \`hello.py\` so the gate can
 * be *disarmed* (…)**`), an emphasis can carry a strong or a link, and a link's
 * label can carry either. Only a code span is never read again — what an agent
 * typed between the backticks is what the reader sees. The pass-2 review graded
 * this DEFECT on `artifact-plan-md-1280.png`, where the first version of the
 * parser printed the bold run's own backticks and asterisks at the reader.
 *
 * What is left out stays readable rather than pretty: tables keep their pipe
 * rows as paragraph text, and a marker with nothing to close it is text — which
 * is what markdown itself renders for it.
 *
 * Nothing here is a security boundary. Untrusted HTML is previewed in a
 * sandboxed frame on another origin (`ADR-0020`, `components/Artifacts.tsx`);
 * this module never sees HTML, it emits React text nodes.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** One block of a markdown document. */
export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | MarkdownListBlock
  | { kind: "rule" };

/**
 * A list, with the number its first marker asked for.
 *
 * `start` is what an ordered list's numbering counts from (CommonMark reads it
 * off the FIRST marker, so `3. a\n4. b` prints 3, 4). A bullet list carries 1
 * and never shows it.
 */
export interface MarkdownListBlock {
  kind: "list";
  ordered: boolean;
  /** Nesting level of this list: 0 at the document margin, 1 inside an item. */
  depth: number;
  /** The number of the first item (`1.` → 1, `3)` → 3). */
  start: number;
  items: MarkdownListItem[];
}

/**
 * One item of a list: its own text, plus the blocks written UNDER it.
 *
 * This is the shape that keeps a numbered plan numbered. The scanner used to
 * emit a step's nested `   - Files: …` bullet as a SIBLING block, and because a
 * list only continues the block directly before it, the next `1.` opened a new
 * list whose first number is 1 — so `run-gate-waiting-1280.png` printed
 * “1. Confirm… 1. Execute… 1. Produce…” for a six-step plan. An author writes
 * those indented lines as part of the step, so they are stored as part of the
 * step (`children`), the outer list is never interrupted, and the numbers run
 * 1…N like the author's own ordering. Blank lines between items are the same
 * case: they separate the author's paragraphs, not two lists.
 */
export interface MarkdownListItem {
  text: string;
  children: MarkdownBlock[];
}

/**
 * An inline span: plain text, code, strong, emphasis, or a link with a resolved
 * href.
 *
 * `strong`, `italic` and `link` carry the spans written INSIDE them
 * (`children`) when there is markup in there — `` **Patch `hello.py` so the
 * gate can be *disarmed*** `` is a strong holding a code span and an emphasis —
 * and leave it out when the span is one plain run (`**prove**`), which is what
 * every plan step that does not nest has always been. `text` is the span's text
 * either way, with the markers read rather than printed.
 */
export type MarkdownInline =
  | { kind: "text" | "code"; text: string }
  | { kind: "strong" | "italic"; text: string; children?: MarkdownInline[] }
  | { kind: "link"; text: string; href: string | null; children?: MarkdownInline[] };

/** A scheme a link may point at; everything else loses its target. */
const SAFE_LINK = /^https?:\/\//i;
/** `## Heading`, with no leading indentation deeper than a code block's. */
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^([ \t]*)([-*+])\s+(.*)$/;
const ORDERED = /^([ \t]*)(\d+)([.)])\s+(.*)$/;
const QUOTE = /^>[ \t]?(.*)$/;
const RULE = /^[ \t]*(?:([-*_])[ \t]*){3,}$/;
const FENCE = /^[ \t]*(```+|~~~+)(.*)$/;

/** The leading marker stripped from a list item's text. */
function listItemMarker(text: string): string {
  return text.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
}
/** A line's indentation in spaces (a tab counts as two). */
function indentWidth(line: string): number {
  return (/^[ \t]*/.exec(line) ?? [""])[0].replace(/\t/g, "  ").length;
}
/** A line with its indentation removed — what the block patterns match on. */
function undented(line: string): string {
  return line.replace(/^[ \t]+/, "");
}

/** One open list: how deep it is indented, the blocks it was written into, the
 * list itself, and the item its deeper lines belong to. The scanner keeps a
 * stack of these, outermost first, which is what lets `  - Files:` below
 * `1. Confirm` be the step's own content instead of a rival list. */
interface OpenList {
  indent: number;
  /** The block list this list was pushed into (the document's, or an item's). */
  owner: MarkdownBlock[];
  list: MarkdownListBlock;
  item: MarkdownListItem;
}

/**
 * Split markdown into blocks. A list keeps going across its own items — with
 * their nested lists, indented continuation lines and blank lines — until a
 * block at its own margin says otherwise; a paragraph is one block per source
 * line-group, so the author's line breaks survive (a plan's step-per-line shape
 * is content).
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  /** Lines of the paragraph being collected; flushed by a blank line. */
  let paragraph: string[] = [];
  /** The open ``` fence, null while outside one. `inItem` remembers whether the
   * fence was opened inside a list item, so closing it can leave that item open. */
  let fence: {
    marker: string;
    owner: MarkdownBlock[];
    inItem: boolean;
    lines: string[];
  } | null = null;
  const open: OpenList[] = [];
  /** Whether the last content line was part of a list item: that is what lets
   * an UNINDENTED line keep the item's sentence going (CommonMark's lazy
   * continuation) instead of starting a paragraph beside the list. */
  let itemIsRecent = false;

  const endLists = () => {
    open.length = 0;
    itemIsRecent = false;
  };
  /** The blocks a line indented `indent` belongs to: the open item's own
   * children when it is written deeper than that item, the document's root
   * otherwise. Asking this before ending the lists is the whole trick — an
   * indented block is *inside* the step, so the step's list does not end. */
  const containerFor = (indent: number): MarkdownBlock[] => {
    const level = open.at(-1);
    return level && indent > level.indent ? level.item.children : blocks;
  };
  /** Hand the collected paragraph lines to `container` (the root paragraph also
   * ends any list: prose at the margin is not a step's continuation). */
  const flushParagraphInto = (container: MarkdownBlock[]) => {
    if (paragraph.length === 0) return;
    container.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
    if (container === blocks) endLists();
  };
  const flushParagraph = () => flushParagraphInto(blocks);
  /** A block line: its paragraph goes with it, and a block at the document's
   * margin closes the open list rather than nesting inside its last item. */
  const pushBlock = (indent: number, block: MarkdownBlock) => {
    const container = containerFor(indent);
    flushParagraphInto(container);
    container.push(block);
    if (container === blocks) endLists();
    else itemIsRecent = true;
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      // Inside a fence everything is bytes: a `#` there is not a heading.
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0]) {
        const inItem = fence.inItem;
        fence.owner.push({ kind: "code", text: fence.lines.join("\n") });
        fence = null;
        // The list the fence sat inside is still the open one: a step that
        // shows a command does not stop being step 2.
        itemIsRecent = inItem;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      const indent = indentWidth(line);
      const owner = containerFor(indent);
      flushParagraphInto(owner);
      fence = { marker: fenceMatch[1], owner, inItem: owner !== blocks, lines: [] };
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      // A blank line between two steps is the author's spacing, not a second
      // list: the open list survives it, and only an indented-or-marker line
      // that follows decides whether the item is still being written.
      itemIsRecent = false;
      continue;
    }
    const indent = indentWidth(line);
    const text = undented(line);
    const heading = HEADING.exec(text);
    if (heading) {
      pushBlock(indent, { kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (RULE.test(text) && !/\w/.test(text)) {
      pushBlock(indent, { kind: "rule" });
      continue;
    }
    const quote = QUOTE.exec(text);
    if (quote) {
      pushBlock(indent, { kind: "quote", text: quote[1] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      // A list marker interrupts whatever prose came before it (`01` writes its
      // steps as `prose` then `1.`), so the paragraph goes to the document
      // first and the marker starts clean.
      flushParagraph();
      addListItem({
        open,
        blocks,
        indent,
        ordered: ordered !== null,
        start: ordered ? Number(ordered[2]) : 1,
        text: listItemMarker(bullet ? bullet[3] : ordered![4]),
      });
      itemIsRecent = true;
      continue;
    }
    // Not a block start: either the open step's own sentence continuing, or a
    // paragraph. Deeper than the step is always its continuation; at its own
    // margin only straight after the step's line (no blank between).
    const level = open.at(-1);
    if (level && (indent > level.indent || (itemIsRecent && indent <= level.indent))) {
      level.item.text = joinItemText(level.item.text, text);
      itemIsRecent = true;
      continue;
    }
    // Prose at the document's margin, written after a blank line, is not the
    // step's sentence: the list it follows is over. The paragraph buffer keeps
    // its own lines — blank lines, not consecutive prose, separate paragraphs.
    endLists();
    paragraph.push(text);
  }
  // An unterminated fence (a truncated plan) still shows what it had.
  if (fence) fence.owner.push({ kind: "code", text: fence.lines.join("\n") });
  flushParagraph();
  return blocks;
}

/** Two written lines of one item are one sentence to a reader. */
function joinItemText(before: string, after: string): string {
  return before === "" ? after : `${before} ${after}`;
}

/** Place one list marker line on the open-list stack. */
function addListItem(input: {
  open: OpenList[];
  blocks: MarkdownBlock[];
  indent: number;
  ordered: boolean;
  start: number;
  text: string;
}): void {
  const { open, blocks, indent, ordered, start, text } = input;
  // Any list indented deeper than this line closed when the author dedented.
  while (open.length > 0 && open.at(-1)!.indent > indent) open.pop();
  const level = open.at(-1);
  let owner: MarkdownBlock[];
  let list: MarkdownListBlock;
  if (level && level.indent === indent && level.list.ordered === ordered) {
    // The same list, the next item: the number keeps counting from `list.start`.
    owner = level.owner;
    list = level.list;
  } else {
    // Either a deeper list (owned by the item above it — the nested `- Files:`
    // under a step) or the marker kind changing at this indent (a bullet list
    // starting where the numbered one ended, CommonMark's own split).
    if (level && level.indent === indent) {
      owner = level.owner;
      list = newList(ordered, level.list.depth, start);
    } else if (level) {
      owner = level.item.children;
      list = newList(ordered, level.list.depth + 1, start);
    } else {
      owner = blocks;
      list = newList(ordered, 0, start);
    }
    owner.push(list);
  }
  const item: MarkdownListItem = { text, children: [] };
  list.items.push(item);
  // Truncate to this line's depth: a deeper level from an earlier branch of the
  // tree is closed (`  - b` then `1. two` — the nested list is over).
  while (open.length > 0 && open.at(-1)!.indent >= indent) open.pop();
  open.push({ indent, owner, list, item });
}

function newList(ordered: boolean, depth: number, start: number): MarkdownListBlock {
  return { kind: "list", ordered, depth, start: ordered ? start : 1, items: [] };
}

/** A link target: no spaces, with one level of nested parens (`alert(1)`). */
const LINK = /^\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/;
/** A letter or digit — what makes `_…_` an underscore INSIDE a word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** CommonMark's punctuation: what a delimiter may be flanked by and still mean markup. */
const PUNCTUATION = /[\p{P}\p{S}]/u;

/**
 * Inline markup as spans — and spans INSIDE spans.
 *
 * The first version matched a `**…**` run and handed the reader the author's own
 * characters for whatever was inside it, so the gate plan's
 * `**Patch \`hello.py\` so the gate can be *disarmed* (…)**` printed its
 * backticks and asterisks (`artifact-plan-md-1280.png`, run-gate-waiting): bold
 * is a step's shape, and the step still names a file and italicises a word
 * inside itself. Markdown nests, so this parses in two passes like CommonMark
 * does:
 *
 * 1. `tokeniseInline` walks the line once, cutting out code spans and links
 *    (whose insides are parsed on their own, so a code span is never read as
 *    markup at all) and recording every `*`/`_` run with the two answers
 *    `canOpen`/`canClose` from its neighbours; and
 * 2. `pairEmphasis` walks those runs left to right, and a closer takes the
 *    NEAREST unmatched opener of its own marker — which is what makes
 *    `*a **b** c*` an emphasis holding a strong rather than the eaten-alive
 *    mess a single find-the-last-asterisk regex produces, and what leaves
 *    `*a *b*` the literal `*` in front that CommonMark leaves.
 *
 * `**` pairs as strong, a single marker as emphasis, and a run longer than the
 * pair it feeds keeps its leftovers as text. A marker that never pairs is text
 * (`2 * 3 * 4`, `**unclosed`, a lone backtick, the underscores of
 * `run_pytest_now_`), exactly as markdown itself renders it, and a
 * `javascript:` target is still reduced to its label.
 */
export function parseInline(text: string): MarkdownInline[] {
  return runsOf(pairEmphasis(tokeniseInline(text ?? "")));
}

/**
 * One token of the inline scanner: a run of source with the role the markup
 * gives it. Delimiter runs are mutable — a pair takes its markers off `run`, and
 * whatever is left over stays visible text.
 */
interface InlineToken {
  kind: "text" | "code" | "link" | "delim" | "strong" | "italic";
  /** What a reader sees: the literal text, a code span's contents, a span's text. */
  text: string;
  /** The line of the source this token sits on (emphasis never runs across one). */
  line: number;
  /** A link's resolved target, or null when it is not http(s). */
  href?: string | null;
  /** A delimiter run: its character, its original and remaining length, and whether its neighbours let it open or close a span. */
  marker?: string;
  run?: number;
  runLength?: number;
  canOpen?: boolean;
  canClose?: boolean;
  /** A span (strong/emphasis) or a link: the tokens its markers wrapped. */
  children?: InlineToken[];
}

/** The neighbours of a delimiter run; the edge of the text counts as whitespace. */
function isSpace(char: string): boolean {
  return char === "" || /\s/.test(char);
}
function isPunctuation(char: string): boolean {
  return char !== "" && PUNCTUATION.test(char);
}
function isWordChar(char: string): boolean {
  return char !== "" && WORD_CHAR.test(char);
}

/**
 * Whether a run of `marker` can open or close a span — CommonMark's flanking
 * rules, the two parts of which read the characters either side of the run:
 *
 * - a run opens when it is tight onto what follows (not onto whitespace) and
 *   what precedes it is not a bare word character when the run hugs
 *   punctuation; it closes in the mirror-image case;
 * - a run that could do BOTH (`snake_case_names`) does neither, which is why an
 *   intra-word `_` is typography; and
 * - `_*_` additionally never pairs between letters or digits at all, so
 *   `run_pytest_now_` keeps every underscore it wrote.
 */
function delimiterRun(source: string, at: number, marker: string, line: number): InlineToken {
  let end = at;
  while (end < source.length && source[end] === marker) end += 1;
  const before = at === 0 ? "" : source[at - 1];
  const after = end < source.length ? source[end] : "";
  const left =
    !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
  const right =
    !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
  let canOpen = left && (!right || isPunctuation(before));
  let canClose = right && (!left || isPunctuation(after));
  if (marker === "_") {
    canOpen = canOpen && !isWordChar(before);
    canClose = canClose && !isWordChar(after);
  }
  return {
    kind: "delim",
    text: source.slice(at, end),
    line,
    marker,
    run: end - at,
    runLength: end - at,
    canOpen,
    canClose,
  };
}

/** The next run of exactly `length` backticks at or after `from`, or -1. */
function closingBackticks(source: string, from: number, length: number): number {
  let at = source.indexOf("`", from);
  while (at !== -1) {
    let end = at;
    while (end < source.length && source[end] === "`") end += 1;
    if (end - at === length) return at;
    at = source.indexOf("`", end);
  }
  return -1;
}

/** Cut one line of markdown into text, code spans, links and delimiter runs. */
function tokeniseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = "";
  let line = 0;
  const flush = (): void => {
    if (buffer === "") return;
    tokens.push({ kind: "text", text: buffer, line });
    buffer = "";
  };
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === "`") {
      let end = at;
      while (end < source.length && source[end] === "`") end += 1;
      const run = end - at;
      const close = closingBackticks(source, end, run);
      if (close !== -1) {
        // A code span is never parsed further, and its own markers are not its
        // content: what the author typed between the fences is the text.
        flush();
        let content = source.slice(end, close);
        if (
          content.length >= 2 &&
          content.startsWith(" ") &&
          content.endsWith(" ") &&
          !/^\s*$/.test(content)
        ) {
          content = content.slice(1, -1);
        }
        tokens.push({ kind: "code", text: content, line });
        at = close + run;
        continue;
      }
      buffer += source.slice(at, end);
      at = end;
      continue;
    }
    if (char === "[") {
      const link = LINK.exec(source.slice(at));
      if (link) {
        flush();
        const label = tokeniseAndPair(link[1]);
        const target = link[2];
        tokens.push({
          kind: "link",
          text: plainText(label),
          line,
          href: SAFE_LINK.test(target) ? target : null,
          children: label,
        });
        at += link[0].length;
        continue;
      }
      buffer += char;
      at += 1;
      continue;
    }
    if (char === "*" || char === "_") {
      flush();
      const run = delimiterRun(source, at, char, line);
      tokens.push(run);
      at += run.runLength ?? 1;
      continue;
    }
    if (char === "\n") line += 1;
    buffer += char;
    at += 1;
  }
  flush();
  return tokens;
}

/**
 * CommonMark's rule of 3: a run that could both open and close may not pair at
 * a distance that is a multiple of 3 (unless both runs are), which is what keeps
 * `*foo*bar*` from reading its own asterisks as emphasis.
 */
function blockedByThree(opener: InlineToken, closer: InlineToken): boolean {
  const eitherServesBoth =
    (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
  if (!eitherServesBoth) return false;
  const sum = (opener.runLength ?? 0) + (closer.runLength ?? 0);
  const bothWhole = (opener.runLength ?? 0) % 3 === 0 && (closer.runLength ?? 0) % 3 === 0;
  return sum % 3 === 0 && !bothWhole;
}

/** The nearest still-openable run of the closer's own marker, or -1. */
function findOpener(openers: InlineToken[], closer: InlineToken): number {
  for (let index = openers.length - 1; index >= 0; index -= 1) {
    const candidate = openers[index];
    if (candidate.marker !== closer.marker) continue;
    if (!candidate.canOpen || (candidate.run ?? 0) <= 0) {
      openers.splice(index, 1);
      continue;
    }
    if (blockedByThree(candidate, closer)) continue;
    return index;
  }
  return -1;
}

/** Tokenise and pair a fragment that stands on its own (a link label). */
function tokeniseAndPair(source: string): InlineToken[] {
  return pairEmphasis(tokeniseInline(source));
}

/** What a list of tokens prints, markers read and leftovers kept. */
function plainText(tokens: InlineToken[]): string {
  return tokens.map((token) => token.text).join("");
}

/**
 * Pair the delimiter runs into spans, in place. A closer takes the nearest
 * opener of its marker on the same line; `**` consumes two markers a side and
 * `*` one, so a run of three leaves a leftover that can still pair again — and
 * the tokens between a pair become that span's own `children`, which is where
 * the nesting comes from.
 */
function pairEmphasis(tokens: InlineToken[]): InlineToken[] {
  const openers: InlineToken[] = [];
  let index = 0;
  while (index < tokens.length) {
    const closer = tokens[index];
    if (closer.kind !== "delim") {
      index += 1;
      continue;
    }
    // Where the closer lives now: it moves left every time a pair is cut out.
    let position = index;
    while (closer.canClose && (closer.run ?? 0) > 0) {
      const openerIndex = findOpener(openers, closer);
      if (openerIndex < 0) break;
      const opener = openers[openerIndex];
      const openerAt = tokens.indexOf(opener);
      if (openerAt < 0 || openerAt >= position || opener.line !== closer.line) break;
      const inner = tokens.slice(openerAt + 1, position);
      if (inner.length === 0) break;
      const strong = (opener.run ?? 0) >= 2 && (closer.run ?? 0) >= 2;
      const used = strong ? 2 : 1;
      const span: InlineToken = {
        kind: strong ? "strong" : "italic",
        text: plainText(inner),
        line: closer.line,
        children: inner,
      };
      opener.run = (opener.run ?? 0) - used;
      closer.run = (closer.run ?? 0) - used;
      // A run that gave fewer markers than it had keeps the rest as the literal
      // markers CommonMark prints (`***x***`, `*a b**`).
      for (const run of [opener, closer]) {
        if ((run.run ?? 0) > 0) run.text = (run.marker ?? "").repeat(run.run ?? 0);
      }
      const replacement: InlineToken[] = [];
      if ((opener.run ?? 0) > 0) replacement.push(opener);
      replacement.push(span);
      if ((closer.run ?? 0) > 0) replacement.push(closer);
      tokens.splice(openerAt, position - openerAt + 1, ...replacement);
      // Whatever was open BETWEEN the pair is inside the span now; it can never
      // pair with anything outside it.
      openers.length = openerIndex;
      if ((opener.run ?? 0) > 0) openers.push(opener);
      position = openerAt + replacement.length - ((closer.run ?? 0) > 0 ? 1 : 0);
      if ((closer.run ?? 0) === 0) break;
    }
    if ((closer.run ?? 0) > 0 && closer.canOpen) openers.push(closer);
    const after = tokens.indexOf(closer);
    index = after < 0 ? position : after + 1;
  }
  return tokens;
}

/**
 * A token list as runs, with adjacent plain text merged. A span carries its
 * nested runs only when there is markup inside it: `**prove**` stays the single
 * text span it always was, so nothing that read this output before nesting has
 * to be re-learned.
 */
function runsOf(tokens: InlineToken[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer === "") return;
    out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  for (const token of tokens) {
    if (token.kind === "text" || token.kind === "delim") {
      buffer += token.text;
      continue;
    }
    flush();
    if (token.kind === "code") {
      out.push({ kind: "code", text: token.text });
      continue;
    }
    const children = token.children ? runsOf(token.children) : [];
    const nested = children.length === 1 && children[0].kind === "text";
    if (token.kind === "link") {
      const link: MarkdownInline = { kind: "link", text: token.text, href: token.href ?? null };
      out.push(nested ? link : { ...link, children });
      continue;
    }
    const span: MarkdownInline = { kind: token.kind, text: token.text };
    out.push(nested ? span : { ...span, children });
  }
  flush();
  return out;
}

/** A fence anywhere on a line (a plan's ``` block). */
const INLINE_CODE = /`[^`\n]+`/;
/** A paired strong run anywhere in the text. */
const INLINE_STRONG = /\*\*[^*\n]+\*\*|__[^_\n]+__/;
/** A markdown link with its target. */
const INLINE_LINK = /\[[^\]\n]*\]\([^)\s]+\)/;

/**
 * Whether `text` carries markdown at all.
 *
 * The gate card's body is prose *or* a markdown document, and the two deserve
 * different renderers: prose is shown verbatim with its whitespace (the promise
 * `PlanView`'s plain-text arm already makes — "a gate that carries prose instead
 * of a plan is still decidable"), while markup is read as markup. Deciding that
 * here rather than at the call site keeps one rule for every surface that shows
 * agent text.
 */
export function looksLikeMarkdown(text: string): boolean {
  const source = text ?? "";
  for (const line of source.split("\n")) {
    if (
      FENCE.test(line) ||
      HEADING.test(line) ||
      QUOTE.test(line) ||
      BULLET.test(line) ||
      ORDERED.test(line) ||
      RULE.test(line)
    ) {
      return true;
    }
  }
  return INLINE_CODE.test(source) || INLINE_STRONG.test(source) || INLINE_LINK.test(source);
}

/**
 * Render inline markdown to React nodes (text, `<code>`, `<strong>`, `<em>`,
 * `<a>`), nested as the author wrote them — a code span inside a bold step is a
 * `<code>` inside the `<strong>`, never a backtick in the reader's face.
 */
export function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((run, index) => renderSpan(run, String(index)));
}

/** One span, and whatever it holds. */
function renderSpan(run: MarkdownInline, key: string): ReactNode {
  // A code span's contents are never read as markup, and plain text has nothing
  // to hold: only strong, emphasis and a link's label carry nested runs.
  const inner =
    "children" in run && run.children
      ? run.children.map((child, index) => renderSpan(child, `${key}-${index}`))
      : run.text;
  if (run.kind === "code") {
    return (
      <code key={key} className="rounded-[2px] bg-fill px-[3px] font-mono text-[.94em]">
        {inner}
      </code>
    );
  }
  if (run.kind === "strong") {
    return (
      <strong key={key} className="font-semibold">
        {inner}
      </strong>
    );
  }
  if (run.kind === "italic") {
    return (
      <em key={key} className="italic">
        {inner}
      </em>
    );
  }
  if (run.kind === "link") {
    return run.href ? (
      <a
        key={key}
        href={run.href}
        rel="noreferrer noopener"
        className="text-accent-text hover:text-ink"
      >
        {inner}
      </a>
    ) : (
      <span key={key}>{inner}</span>
    );
  }
  return <span key={key}>{inner}</span>;
}

export interface MarkdownBodyProps {
  text: string;
  className?: string;
  /** Tag for a paragraph; the caller's own typography carries the size. */
  paragraphClassName?: string;
}

/**
 * A markdown document as prose. The container carries the caller's class so
 * the surrounding screen (a gate card, a plan panel) owns the type scale; the
 * markup only ever adds structure — heading weight, list markers, mono code.
 */
export function MarkdownBody({ text, className = "", paragraphClassName = "" }: MarkdownBodyProps) {
  const blocks = parseMarkdown(text);
  return (
    <div className={className} data-testid="markdown-body">
      {blocks.map((block, index) => renderBlock(block, String(index), paragraphClassName))}
    </div>
  );
}

/**
 * One fenced code block. The box never grows with its longest line (see the
 * `width:0` note inside), but a box whose lines are cut mid-word at the right
 * edge gave no hint that anything lived past the fold (pass-1 review minor 3:
 * the 2e gate plan's wide python fence ended at `…SCHEDUL` with no scrollbar
 * in sight). The hint is a right-edge fade that stands only while there is
 * more content off to the right: it is measured at mount, on every scroll of
 * the box, and whenever the box or the window resizes, and it clears the
 * moment the reader reaches the end of the line. The pre keeps keyboard
 * scroll (`tabIndex`), and the fade never eats a click.
 */
function MarkdownCode({ text }: { text: string }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = preRef.current;
    if (!el) return undefined;
    const measure = () => setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [text]);
  return (
    <div className="relative max-w-full" data-testid="markdown-code-box">
      <pre
        ref={preRef}
        tabIndex={0}
        data-testid="markdown-code"
        // `width:0` + `min-width:100%`: a fence's longest line may be a 400-character
        // JSON string, and a box with a definite width contributes nothing to an
        // ancestor's max-content size — so the code scrolls inside its own box at
        // 390 instead of pushing the page sideways (`artifact-plan-md-390.png`).
        style={{ width: 0, minWidth: "100%" }}
        className="max-w-full overflow-x-auto rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px]"
      >
        {text}
      </pre>
      <span
        aria-hidden
        data-testid="markdown-code-fade"
        data-more={moreRight ? "true" : "false"}
        className={`pointer-events-none absolute inset-y-[1px] right-[1px] w-[40px] rounded-r-[2px] bg-[linear-gradient(to_right,transparent,var(--color-paper))] transition-opacity duration-150 ${
          moreRight ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}

/**
 * One block, keyed. A list item's own children come back through here, which is
 * what makes nesting real: the nested `- Files:` bullets are drawn inside their
 * step, so the numbered plan above them is never interrupted and never restarts
 * its numbering at 1 (the shape `run-gate-waiting-1280.png` showed).
 */
function renderBlock(block: MarkdownBlock, key: string, paragraphClassName: string): ReactNode {
  if (block.kind === "heading") {
    const size = block.level <= 1 ? "text-[13.5px]" : "text-[12.5px]";
    return (
      <p
        key={key}
        data-testid="markdown-heading"
        className={`${size} mt-[6px] font-bold first:mt-0`}
      >
        {renderInline(block.text)}
      </p>
    );
  }
  if (block.kind === "code") {
    return <MarkdownCode key={key} text={block.text} />;
  }
  if (block.kind === "quote") {
    return (
      <p
        key={key}
        data-testid="markdown-quote"
        className={`border-l-2 border-line pl-[8px] text-ink-2 ${paragraphClassName}`}
      >
        {renderInline(block.text)}
      </p>
    );
  }
  if (block.kind === "rule") {
    return <hr key={key} data-testid="markdown-rule" className="border-t border-line" />;
  }
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List
        key={key}
        // The author's own first number is the list's start (`3.` begins at 3);
        // every later item is numbered by the list, not by its marker, exactly
        // as an `<ol>` does it — which is why a plan that writes `1.` for all
        // six steps still reads 1…6.
        start={block.ordered ? block.start : undefined}
        data-testid={block.ordered ? "markdown-list-ordered" : "markdown-list"}
        className={`space-y-[2px] ${block.depth > 0 ? "ml-[16px]" : ""}`}
      >
        {block.items.map((item, itemIndex) => (
          <li
            key={itemIndex}
            className="flex gap-[6px] break-words"
            data-testid="markdown-list-item"
          >
            <span aria-hidden className="shrink-0 text-faint">
              {block.ordered ? `${block.start + itemIndex}.` : "\u00b7"}
            </span>
            <div className="min-w-0 space-y-[2px]">
              {renderInline(item.text)}
              {item.children.map((child, childIndex) =>
                renderBlock(child, `${key}-${itemIndex}-${childIndex}`, paragraphClassName),
              )}
            </div>
          </li>
        ))}
      </List>
    );
  }
  return (
    <p
      key={key}
      data-testid="markdown-paragraph"
      className={`break-words whitespace-pre-line ${paragraphClassName}`}
    >
      {renderInline(block.text)}
    </p>
  );
}
