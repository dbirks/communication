import type { ReactNode } from "react";
import { Link } from "react-router";
import { STATES, type StateName } from "./states";

/**
 * STATUS-E — glyph + word chip on the state's tint. The word is always
 * present (statuses are never color-only); the glyph is visual sugar for
 * scanners, so it is aria-hidden and the word carries the accessible text.
 */

export interface StatusChipProps {
  state: StateName;
  /** The word shown next to the glyph (kept as-is, uppercased by CSS only). */
  label: string;
  className?: string;
  /** Extra props for the word span — for stable test hooks and live-region
   * roles that must track the word itself. */
  labelProps?: {
    "data-testid"?: string;
    role?: string;
    "aria-live"?: "polite" | "assertive";
    className?: string;
    id?: string;
  };
}

export function StatusChip({ state, label, className = "", labelProps }: StatusChipProps) {
  const spec = STATES[state];
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center gap-1.5 rounded-[3px] px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase ${spec.tagBg} ${spec.tagFg} ${className}`}
    >
      <span aria-hidden="true">{spec.glyph}</span>
      <span {...labelProps}>{label}</span>
    </span>
  );
}

/**
 * ROW-I — 34px list row, 4px gaps, raised selection (ink edge + ink shadow).
 * `to` renders it as a router link; otherwise a plain row (selection state is
 * visual only here — every current row navigates).
 */

const rowBase =
  "flex h-[34px] w-full items-center gap-[9px] rounded-[3px] border bg-surface px-[10px] text-left text-ink max-[560px]:min-h-[44px]";
const rowIdle = "border-line hover:border-line-strong";
const rowSelected = "border-ink shadow-(--shadow-raised)";

export interface RowProps {
  to?: string;
  selected?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function Row({ to, selected = false, className = "", children, ...rest }: RowProps) {
  const cls = `${rowBase} ${selected ? rowSelected : rowIdle} ${className}`;
  if (to) {
    return (
      <Link to={to} className={cls} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}
