/**
 * The two labels a redesigned Home page uses for its blocks (CONTRACT.md
 * "Section label style", README §2 headings):
 *
 * - `SectionLabel` — the mono 10.5px semibold uppercase, .06em tracking
 *   label: muted by default, or carrying a status glyph and that status's own
 *   colour (`tone`) when the block is a live one. Both render even when the
 *   block's list is empty — the label is the column's word, not the data's.
 * - `ColumnHeading` — the 16px/700 sentence-case heading the left column and
 *   the project's right column are read by: an `<h3>` in ink with an optional
 *   mono 11px muted aside (`meta`) beside it and a 1px rule under it.
 *
 * Both are `<h3>` — a Home page's blocks are sections of the page, and the
 * greeting above them is the page's own heading.
 */
import type { ReactNode } from "react";

/** The mono label's classes minus its colour, in one place. */
const SECTION_LABEL_BASE =
  "mb-[10px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em]";

/** A live block's label: its glyph and its colour, never colour alone. */
export type SectionLabelTone = "waiting" | "running";

const SECTION_LABEL_TONE_CLASS: Record<SectionLabelTone, string> = {
  waiting: "text-st-waiting-tag-fg",
  running: "text-st-running-tag-fg",
};

/** The default (muted) label's classes, in one place so every section reads
 * the same. */
export const SECTION_LABEL_CLASS = `${SECTION_LABEL_BASE} text-muted`;

export interface SectionLabelProps {
  children: ReactNode;
  /** Status colour for the whole label; absent = muted. */
  tone?: SectionLabelTone;
  /** Decorative state glyph before the words ("!", "●"). */
  glyph?: string;
  /** Root test handle. */
  testid?: string;
  className?: string;
}

export function SectionLabel({ children, tone, glyph, testid, className = "" }: SectionLabelProps) {
  return (
    <h3
      data-testid={testid}
      className={`${SECTION_LABEL_BASE} ${tone ? SECTION_LABEL_TONE_CLASS[tone] : "text-muted"} ${className}`.trim()}
    >
      {glyph ? <span aria-hidden="true">{`${glyph} `}</span> : null}
      {children}
    </h3>
  );
}

export interface ColumnHeadingProps {
  children: ReactNode;
  /** Optional mono 11px muted aside beside the title (a count, an id). */
  meta?: ReactNode;
  /** Root test handle. */
  testid?: string;
  /** Test handle for the `meta` span; only present when `meta` is. */
  metaTestid?: string;
  className?: string;
}

/** The 16/700 sentence-case heading of a Home column's block. */
export function ColumnHeading({
  children,
  meta,
  testid,
  metaTestid,
  className = "",
}: ColumnHeadingProps) {
  return (
    <h3
      data-testid={testid}
      className={`mb-[10px] flex items-baseline gap-[8px] border-b border-line-soft pb-[8px] text-[16px] font-bold leading-[22px] text-ink ${className}`.trim()}
    >
      <span className="min-w-0">{children}</span>
      {meta ? (
        <span
          data-testid={metaTestid}
          className="shrink-0 font-mono text-[11px] font-normal text-muted"
        >
          {meta}
        </span>
      ) : null}
    </h3>
  );
}

export default SectionLabel;
