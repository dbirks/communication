import type { ReactNode } from "react";
import { STATES, type StateName } from "./states";

/**
 * ALERT-K — pale alert: bar + body in the state's pale hue with a tonal
 * edge; any action button (the caller puts a compact BTN-I in `action`)
 * carries the emphasis.
 */

export interface AlertProps {
  state: StateName;
  /** Uppercase label after the glyph, e.g. "NEEDS YOUR DECISION". */
  label?: string;
  /**
   * Title-bar tone (handoff rule 05: a bar is gray unless the panel needs
   * action). `pale` is ALERT-K's default; `strong` is the state's strong color
   * for a panel that needs a decision now; `neutral` is the gray bar of a
   * closed record, which still shows its state as a chip.
   */
  barTone?: "pale" | "strong" | "neutral";
  /** Right slot of the bar (mono meta). */
  meta?: ReactNode;
  id?: string;
  testid?: string;
  role?: "status" | "alert";
  className?: string;
  children: ReactNode;
  action?: ReactNode;
}

export function Alert({
  state,
  label,
  barTone = "pale",
  meta,
  id,
  testid,
  role = "status",
  className = "",
  children,
  action,
}: AlertProps) {
  const spec = STATES[state];
  const bar =
    barTone === "strong"
      ? `${spec.strongBg} ${spec.strongFg}`
      : barTone === "neutral"
        ? "bg-fill text-ink-2"
        : `${spec.paleBarBg} ${spec.paleFg}`;
  const barEdge =
    barTone === "strong"
      ? spec.strongEdge
      : barTone === "neutral"
        ? "border-line-strong"
        : spec.paleEdge;
  return (
    <div
      id={id}
      data-testid={testid}
      role={role}
      className={`overflow-hidden rounded-[3px] border ${
        barTone === "strong" ? spec.strongEdge : spec.paleEdge
      } ${spec.paleBodyBg} ${className}`}
    >
      <div
        data-ds-bar=""
        data-tone={barTone}
        className={`flex items-center gap-2 border-b px-[10px] py-[3px] font-mono text-[10px] font-semibold tracking-[.04em] ${bar} ${barEdge}`}
      >
        <span aria-hidden="true">
          {barTone === "neutral" ? (label ?? spec.word) : `${spec.glyph} ${label ?? spec.bar}`}
        </span>
        {meta !== undefined ? <span className="ml-auto font-normal opacity-75">{meta}</span> : null}
      </div>
      <div className="flex items-center gap-[10px] px-[10px] py-[7px] text-body">
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
    </div>
  );
}
