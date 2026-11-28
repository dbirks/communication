/**
 * ProposalBar — the floating bar that sits over the canvas while an assistant
 * proposal is on screen (editor interactions 1d). Purely presentational: the
 * page owns the proposal, this bar shows what was asked, how much it changes,
 * and offers Review / Apply / Discard. Nothing is saved until Apply, and
 * making the draft live is still a separate step (README 1d).
 */
import { IconMessageCircle } from "@tabler/icons-react";

export interface ProposalBarProps {
  /** What the person asked, e.g. "Add a test step after Write the fix". */
  request: string;
  /** Proposed changes (steps added + edited + removed). */
  changeCount: number;
  /** The assistant is still working: "working on it…" instead of the meta line, no Apply. */
  pending?: boolean;
  /** The assistant failed: the error replaces the meta line, Apply hidden. */
  error?: string | null;
  /** The review panel is open (the link reads "Hide review"). */
  reviewOpen?: boolean;
  onReview(): void;
  onApply(): void;
  onDiscard(): void;
  /** Apply is in flight: reads "Applying…", both buttons disabled. */
  applying?: boolean;
  /** Phone band: full width minus 16px each side, the request wraps to two lines. */
  narrow?: boolean;
}

export function ProposalBar({
  request,
  changeCount,
  pending = false,
  error = null,
  reviewOpen = false,
  onReview,
  onApply,
  onDiscard,
  applying = false,
  narrow = false,
}: ProposalBarProps) {
  const meta = `from ⌘K · ${changeCount} change${changeCount === 1 ? "" : "s"} · nothing saved yet · `;
  const button = "max-md:min-h-[44px]";

  return (
    <div
      data-testid="proposal-bar"
      role="region"
      aria-label="Assistant proposal"
      className={`absolute left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-[12px] border border-fill-edge bg-surface px-[14px] py-[12px] shadow-[var(--shadow-pop)] ${
        narrow ? "top-[72px] w-[calc(100%-32px)]" : "top-[64px] w-[600px] max-w-[calc(100%-32px)]"
      }`}
    >
      <span
        aria-hidden="true"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-accent-tint text-accent-edge"
      >
        <IconMessageCircle size={16} stroke={2} />
      </span>

      <div className="min-w-0 flex-1">
        <div
          data-testid="proposal-bar-request"
          className={`text-[13.5px] font-semibold text-ink ${narrow ? "line-clamp-2" : "truncate"}`}
        >
          {request}
        </div>
        <div className="font-mono text-[10.5px] text-muted">
          {error ? (
            <span className="text-st-failed-tag-fg">{error}</span>
          ) : pending ? (
            <span>from ⌘K · working on it…</span>
          ) : (
            <>
              <span>{meta}</span>
              <button
                type="button"
                data-testid="proposal-bar-review"
                onClick={onReview}
                className="font-mono text-[10.5px] text-accent-text underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                {reviewOpen ? "Hide review" : "Review"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="proposal-bar-discard"
          onClick={onDiscard}
          disabled={applying}
          className={`ds-btn ds-btn--secondary-plain ds-btn--compact ${button}`}
        >
          Discard
        </button>
        {!pending && !error && (
          <button
            type="button"
            data-testid="proposal-bar-apply"
            onClick={onApply}
            disabled={applying}
            className={`ds-btn ds-btn--primary ds-btn--compact ${button}`}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        )}
      </div>
    </div>
  );
}
