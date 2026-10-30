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
 *   a nested list item (indented 2+ spaces) stays a bullet, one level in;
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
import type { ReactNode } from "react";

/** One block of a markdown document. */
export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; depth: number; items: string[] }
  | { kind: "rule" };

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

/**
 * Split markdown into blocks. Consecutive list items of the same kind and
 * indent become one list; a paragraph is one block per source line-group, so
 * the author's line breaks survive (a plan's step-per-line shape is content).
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  /** Lines of the paragraph being collected; flushed by a blank line. */
  let paragraph: string[] = [];
  /** The open ``` fence, null while outside one. */
  let fence: { marker: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const pushList = (ordered: boolean, depth: number, items: string[]) => {
    const last = blocks.at(-1);
    if (last && last.kind === "list" && last.ordered === ordered && last.depth === depth) {
      last.items.push(...items);
      return;
    }
    blocks.push({ kind: "list", ordered, depth, items });
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      // Inside a fence everything is bytes: a `#` there is not a heading.
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0]) {
        blocks.push({ kind: "code", text: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      fence = { marker: fenceMatch[1], lines: [] };
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (RULE.test(line) && !/\w/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      pushList(false, indentDepth(bullet[1]), [listItemMarker(bullet[3])]);
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      flushParagraph();
      pushList(true, indentDepth(ordered[1]), [listItemMarker(ordered[4])]);
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", text: quote[1] });
      continue;
    }
    paragraph.push(line.trim());
  }
  // An unterminated fence (a truncated plan) still shows what it had.
  if (fence) blocks.push({ kind: "code", text: fence.lines.join("\n") });
  flushParagraph();
  return blocks;
}

/** Two spaces of list indent is one level; the scanner keeps two depths. */
function indentDepth(indent: string): number {
  return indent.replace(/\t/g, "  ").length >= 2 ? 1 : 0;
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
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const size = block.level <= 1 ? "text-[13.5px]" : "text-[12.5px]";
          return (
            <p
              key={index}
              data-testid="markdown-heading"
              className={`${size} mt-[6px] font-bold first:mt-0`}
            >
              {renderInline(block.text)}
            </p>
          );
        }
        if (block.kind === "code") {
          return (
            <pre
              key={index}
              tabIndex={0}
              data-testid="markdown-code"
              className="overflow-x-auto rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px]"
            >
              {block.text}
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <p
              key={index}
              data-testid="markdown-quote"
              className={`border-l-2 border-line pl-[8px] text-ink-2 ${paragraphClassName}`}
            >
              {renderInline(block.text)}
            </p>
          );
        }
        if (block.kind === "rule") {
          return <hr key={index} data-testid="markdown-rule" className="border-t border-line" />;
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={index}
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
                    {block.ordered ? `${itemIndex + 1}.` : "\u00b7"}
                  </span>
                  <span className="min-w-0">{renderInline(item)}</span>
                </li>
              ))}
            </List>
          );
        }
        return (
          <p
            key={index}
            data-testid="markdown-paragraph"
            className={`break-words whitespace-pre-line ${paragraphClassName}`}
          >
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
