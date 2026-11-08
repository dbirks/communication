/**
 * The big-backlog banner (mock 8a "big-backlog state"): one 38px line that
 * appears only when the unseen pile is large (> 12) while the window is the
 * default "unseen". It proposes the window the reader's own visit rhythm
 * suggests; "Keep all" dismisses it for the session.
 */
import { Info } from "lucide-react";

export const BACKLOG_BANNER_THRESHOLD = 12;

export function BacklogBanner({
  unseen,
  days,
  tourStops,
  suggestedWindow,
  onNarrow,
  onKeepAll,
}: {
  unseen: number;
  days: number;
  tourStops: number;
  /** The suggestion's window label ("24h" / "2d" / "7d"); the visit reads may
   * not have an answer yet, and 24h is what the design defaults to. */
  suggestedWindow: string;
  onNarrow: () => void;
  onKeepAll: () => void;
}) {
  if (unseen <= BACKLOG_BANNER_THRESHOLD) return null;
  return (
    <div
      data-testid="catchup-banner"
      className="flex h-[38px] items-center gap-[10px] rounded-panel border border-accent-ring bg-accent-wash px-[10px]"
      role="note"
    >
      <Info size={13} className="shrink-0 text-accent-edge" aria-hidden />
      <span className="text-[13px] whitespace-nowrap text-ink">
        <b>
          {unseen} unseen over {days} {days === 1 ? "day" : "days"}.
        </b>{" "}
        The tour covers the {tourStops} that matter. Narrow to the last {suggestedWindow}?
      </span>
      <span className="ml-auto flex shrink-0 gap-[4px]">
        <button
          type="button"
          onClick={onNarrow}
          data-testid={`catchup-banner-narrow-${suggestedWindow}`}
          className="ds-btn ds-btn--secondary ds-btn--compact !h-[24px] !px-[9px] !text-[12px]"
        >
          Last {suggestedWindow}
        </button>
        <button
          type="button"
          onClick={onKeepAll}
          data-testid="catchup-banner-keep-all"
          className="ds-btn ds-btn--ghost !h-[24px] !px-[9px] !text-[12px]"
        >
          Keep all
        </button>
      </span>
    </div>
  );
}
