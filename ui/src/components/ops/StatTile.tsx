/**
 * STAT-tile — the ops page's six at-a-glance answers.
 *
 * A tile is a button, not a decoration: its one job is to move the reader to
 * the panel that explains it, so it scrolls to its section and is named in full
 * (`"Workers: 1 online, ok"`) because the dot carries state visually only. The
 * value line is the number an operator scans for; the sub line is the qualifier
 * that makes the number mean something, and it truncates rather than wrapping —
 * three rows of different heights across six tiles is what makes a strip unreadable.
 *
 * "Loading" and "couldn't load" are the served answer's shape, not a spinner:
 * a tile that cannot answer shows `—` / `loading…` (or `couldn't load` on a
 * failed read with a `bad` dot), never a stale number presented as current.
 */
import type { ReactNode } from "react";
import { OPS_STATUS_WORD, StatusDot, type OpsStatus } from "./StatusDot";

export interface StatTileProps {
  /** The mono label, e.g. `Workers`. Rendered uppercased. */
  label: string;
  /** The big number line. `—` while the read is in flight. */
  value: ReactNode;
  /** The qualifier line, e.g. `2 slots · 0 busy`. */
  sub: string;
  status: OpsStatus;
  /** The `<section id>` this tile scrolls to. */
  targetId: string;
  /** Loading and failed reads state themselves in the value/sub lines; the
   * accessible name stays the same sentence the eye reads. */
  ariaValue: string;
}

/** Scroll an in-page target into view. jsdom has no scrollIntoView at all. */
function scrollToSection(id: string): void {
  const target = document.getElementById(id);
  if (!target || typeof target.scrollIntoView !== "function") return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function StatTile({ label, value, sub, status, targetId, ariaValue }: StatTileProps) {
  return (
    <button
      type="button"
      onClick={() => scrollToSection(targetId)}
      aria-label={`${label}: ${ariaValue}, ${OPS_STATUS_WORD[status]}`}
      data-target={targetId}
      data-status={status}
      data-testid={`stat-tile-${label.toLowerCase()}`}
      className="flex min-h-[84px] cursor-pointer flex-col gap-[4px] rounded-[4px] border border-line bg-surface p-[12px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <span className="flex items-center gap-[6px]">
        <StatusDot status={status} />
        <span className="truncate font-mono text-[10.5px] tracking-[.06em] text-faint uppercase">
          {label}
        </span>
      </span>
      <span className="truncate text-[20px] leading-[26px] font-semibold text-ink">{value}</span>
      <span className="truncate text-[11.5px] text-muted">{sub}</span>
    </button>
  );
}
