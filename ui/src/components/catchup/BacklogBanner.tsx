/**
 * The big-backlog banner (mock 8a "big-backlog state"): one 38px line that
 * appears only when the unseen pile is large (> 12) while the window is the
 * default "unseen". It proposes the window the reader's own visit rhythm
 * suggests; "Keep all" dismisses it for the session.
 *
 * Responsive contract (acceptance 42524332059, `cu-8a-backlog`): the one-line
 * 38px layout is the DESKTOP shape. Below 768px the nowrap text plus the
 * `shrink-0` buttons pushed the page's scrollWidth to 692px on a 390px phone,
 * so there the row wraps: the text keeps `min-w-0` and breaks on its own
 * lines, and the buttons ride `w-full` onto a row below.
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
      className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] rounded-panel border border-accent-ring bg-accent-wash px-[10px] py-[7px] md:h-[38px] md:flex-nowrap md:py-0"
      role="note"
    >
      <Info size={13} className="shrink-0 text-accent-edge" aria-hidden />
      <span className="min-w-0 flex-1 text-[13px] text-ink md:whitespace-nowrap">
        <b>
          {unseen} unseen over {days} {days === 1 ? "day" : "days"}.
        </b>{" "}
        The tour covers the {tourStops} that matter. Narrow to the last {suggestedWindow}?
      </span>
      <span className="flex w-full shrink-0 justify-end gap-[4px] md:ml-auto md:w-auto md:justify-start">
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
