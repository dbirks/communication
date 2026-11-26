/**
 * The one section label the redesigned Home pages use (CONTRACT.md
 * "Section label style"): mono 10.5px semibold uppercase, .06em tracking,
 * muted, 10px under it. It is an `<h3>` — a Home page's blocks are sections of
 * the page, and the greeting above them is the page's own heading.
 */
import type { ReactNode } from "react";

/** The label's classes, in one place so every section reads the same. */
export const SECTION_LABEL_CLASS =
  "mb-[10px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted";

export interface SectionLabelProps {
  children: ReactNode;
  /** Root test handle. */
  testid?: string;
  className?: string;
}

export function SectionLabel({ children, testid, className = "" }: SectionLabelProps) {
  return (
    <h3 data-testid={testid} className={`${SECTION_LABEL_CLASS} ${className}`.trim()}>
      {children}
    </h3>
  );
}

export default SectionLabel;
