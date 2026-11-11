/**
 * The ops page's status mark: an 8px square that carries a state, never a word.
 *
 * It is `aria-hidden` by construction — a dot is the second channel, not the
 * message. Every call site that draws one also writes the word next to it
 * (design rule 06: colour/state is never the only carrier), and the tile's
 * accessible name is spelled out in full on the button itself.
 *
 * The four states here are the ops page's own vocabulary, mapped onto the
 * design system's segment colours: `ok` = the done segment, `warn` = waiting,
 * `bad` = failed, `off` = the open (white) segment — a fact this build does not
 * have, which must not read as either a pass or a finding. `off` is white on a
 * white surface, so it keeps the one thing that makes white visible anywhere
 * else in this system: a gray edge.
 */

export type OpsStatus = "ok" | "warn" | "bad" | "off";

const DOT_CLASS: Record<OpsStatus, string> = {
  ok: "bg-st-done-strong",
  warn: "bg-seg-waiting",
  bad: "bg-seg-failed",
  off: "bg-seg-open border border-line-strong",
};

/** The word a state reads as in an accessible name (never colour alone). */
export const OPS_STATUS_WORD: Record<OpsStatus, string> = {
  ok: "ok",
  warn: "warning",
  bad: "problem",
  off: "no data",
};

export interface StatusDotProps {
  status: OpsStatus;
  className?: string;
}

export function StatusDot({ status, className = "" }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      data-status={status}
      className={`inline-block h-[8px] w-[8px] shrink-0 rounded-[2px] ${DOT_CLASS[status]} ${className}`}
      data-testid="status-dot"
    />
  );
}
