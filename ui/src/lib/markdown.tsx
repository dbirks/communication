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

/** An inline span: plain text, code, strong, emphasis, or a link with a resolved href. */
export type MarkdownInline =
  | { kind: "text" | "code" | "strong" | "italic"; text: string }
  | { kind: "link"; text: string; href: string | null };

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

/**
 * Inline markup as spans. Code spans win (a `**` inside `` `…` `` is literal),
 * then strong, then emphasis, then links; what does not parse is text, with no
 * markers left behind for a `javascript:` target.
 */
const CODE_SPAN = /^`([^`]*)`/;
const STRONG = /^(\*\*|__)([^\r\n]+?)\1/;
/** `*emphasis*` / `_emphasis_` — one marker, its run closed on the same line. */
const EMPHASIS = /^([*_])([^\r\n]+?)\1/;
/** A link target: no spaces, with one level of nested parens (`alert(1)`). */
const LINK = /^\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/;
/** Where the next markup marker starts, in the text after position 0. */
const NEXT_MARKER = /`|\*|_|\[/;
/** A letter or digit — what makes `_…_` an underscore INSIDE a word. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whether the `marker` run really wraps `content` in emphasis — CommonMark's
 * flanking rule in the two parts that matter here:
 *
 * - the run may not open onto whitespace or onto another of itself (`* …*`,
 *   `**unclosed`) and may not close on whitespace, or `2 * 3 * 4` and a stray
 *   pair of markers start eating prose;
 * - a `*` run closes whatever follows it, but `_` is the intra-word marker in
 *   `snake_case_names`, so an underscore run counts only when neither neighbour
 *   is a letter or digit. `_(read-only)_` after a space is emphasis; the
 *   underscores of `run_pytest_now_` are typography.
 *
 * Punctuation at either END of the content is fine — that is the shape a plan
 * writes constantly: `*(read-only — no edits)*`.
 */
function isEmphasis(
  marker: string,
  content: string,
  before: string,
  after: string | undefined,
): boolean {
  if (content === "" || content[0] === marker) return false;
  if (/^\s|\s$/.test(content)) return false;
  if (marker === "*") return true;
  return !(WORD_CHAR.test(before) || (after !== undefined && WORD_CHAR.test(after)));
}

/**
 * Inline markup as spans: `` `code` `` is mono, `**strong**`/`__strong__` is
 * bold, `*emphasis*`/`_emphasis_` is italic, `[label](url)` is a link — and only
 * an `http(s)` link keeps its target. A marker that does not open anything
 * (`2 * 3`, a lone backtick, an intra-word `_`) is text, exactly as markdown
 * itself renders it.
 */
export function parseInline(text: string): MarkdownInline[] {
  const source = text ?? "";
  const out: MarkdownInline[] = [];
  let input = source;
  /** How much of `source` is consumed — how to ask what came BEFORE this run. */
  let offset = 0;
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  const take = (count: number): void => {
    input = input.slice(count);
    offset += count;
  };
  while (input !== "") {
    const code = CODE_SPAN.exec(input);
    if (code) {
      flush();
      out.push({ kind: "code", text: code[1] });
      take(code[0].length);
      continue;
    }
    const strong = STRONG.exec(input);
    if (strong) {
      flush();
      out.push({ kind: "strong", text: strong[2] });
      take(strong[0].length);
      continue;
    }
    const link = LINK.exec(input);
    if (link) {
      flush();
      const target = link[2];
      out.push({ kind: "link", text: link[1], href: SAFE_LINK.test(target) ? target : null });
      take(link[0].length);
      continue;
    }
    const emphasis = EMPHASIS.exec(input);
    if (
      emphasis !== null &&
      isEmphasis(
        emphasis[1],
        emphasis[2],
        offset === 0 ? "" : source[offset - 1],
        input[emphasis[0].length],
      )
    ) {
      flush();
      out.push({ kind: "italic", text: emphasis[2] });
      take(emphasis[0].length);
      continue;
    }
    // No span starts here: take the text up to the next marker (or all of it),
    // and never zero characters — an unclosed marker must not spin the loop.
    const after = input.slice(1).search(NEXT_MARKER);
    const next = after < 0 ? input.length : after + 1;
    const advance = next <= 0 ? 1 : next;
    buffer += input.slice(0, advance);
    take(advance);
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

/** Render inline markdown to React nodes (text, `<code>`, `<strong>`, `<em>`, `<a>`). */
export function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((run, index) => {
    if (run.kind === "code") {
      return (
        <code key={index} className="rounded-[2px] bg-fill px-[3px] font-mono text-[.94em]">
          {run.text}
        </code>
      );
    }
    if (run.kind === "strong") {
      return (
        <strong key={index} className="font-semibold">
          {run.text}
        </strong>
      );
    }
    if (run.kind === "italic") {
      return (
        <em key={index} className="italic">
          {run.text}
        </em>
      );
    }
    if (run.kind === "link") {
      return run.href ? (
        <a
          key={index}
          href={run.href}
          rel="noreferrer noopener"
          className="text-accent-text hover:text-ink"
        >
          {run.text}
        </a>
      ) : (
        <span key={index}>{run.text}</span>
      );
    }
    return <span key={index}>{run.text}</span>;
  });
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
