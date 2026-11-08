/**
 * The recap block (mock 8a): the assistant's saved summary with its
 * "ASSISTANT RECAP · WRITTEN {HH:MM}" label and the reader's own way to ask
 * for a new one, and on the right the primary action that opens the catch-up
 * tour plus the honest note that the tour is assembled from the per-piece
 * ("shared") tours. A reader the generator has never written a recap for gets
 * "No recap yet." and a "Write one" button — the honest empty, never a
 * fabricated sentence.
 *
 * Asking is `POST /catch-up/recap` (ADR-0078 § Decision 1): the recap is this
 * reader's row, so the button may exist. It waits on a model, so it can fail —
 * and when it does the block keeps showing the recap that was there, because
 * a refusal stored nothing. The page owns the request (it knows the projects
 * and the window on screen); this component only draws its states.
 */
import { Link } from "react-router";
import { Play } from "lucide-react";
import { firstSentence, type CatchUpRecap } from "../../api/catchup";
import { clockOf } from "./importance";

export function RecapBlock({
  recap,
  loading,
  stops,
  minutes,
  builtFrom,
  onRegenerate,
  writing = false,
  error = null,
}: {
  /** null = the read answered 404 ("never written you one"). */
  recap: CatchUpRecap | null | undefined;
  loading: boolean;
  stops: number;
  minutes: number;
  builtFrom: number;
  /** Fire `POST /catch-up/recap` for the page's scope; omitted = no ask here. */
  onRegenerate?: () => void;
  /** The ask is in flight: the button reads "Writing…" and is disabled. */
  writing?: boolean;
  /** The refusal line (`recapFailureMessage`), or null while all is well. */
  error?: string | null;
}) {
  const written = recap ? clockOf(recap.written_at) : null;
  /* The mock sets the recap's first sentence in bold — it is the one line that
   * says how big the pile is — and the body stays at the reading size (15px),
   * never a display size. */
  const lead = recap ? firstSentence(recap.text) : "";
  const rest = recap ? recap.text.slice(lead.length).replace(/^\s+/, "") : "";
  const ask = onRegenerate ?? noop;
  const canAsk = Boolean(onRegenerate) && !writing;
  return (
    <div
      data-testid="catchup-recap"
      className="grid grid-cols-1 items-end gap-x-[24px] gap-y-[6px] md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="flex flex-wrap items-center gap-[8px] font-mono text-[10.5px] whitespace-nowrap text-muted">
          <span>ASSISTANT RECAP{written ? ` · WRITTEN ${written}` : ""}</span>
          {onRegenerate ? (
            <button
              type="button"
              onClick={ask}
              disabled={!canAsk}
              data-testid="catchup-recap-regenerate"
              className="rounded-[2px] font-mono text-[10.5px] font-semibold text-ink-2 underline decoration-line-strong underline-offset-2 disabled:cursor-default disabled:text-faint disabled:no-underline"
            >
              {writing ? "Writing…" : recap ? "Regenerate" : "Write one"}
            </button>
          ) : null}
        </span>
        {recap ? (
          <p className="max-w-[760px] text-[15px] leading-[1.55] text-ink">
            <span data-testid="catchup-recap-lead" className="font-semibold">
              {lead}
            </span>
            {rest.length > 0 ? ` ${rest}` : ""}
          </p>
        ) : (
          <p className="text-[13px] text-faint">
            {loading ? "Reading the recap…" : "No recap yet."}
          </p>
        )}
        {error ? (
          <p
            className="max-w-[760px] text-[12.5px] text-st-failed-tag-fg"
            data-testid="catchup-recap-error"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-[6px]">
        <Link
          to="/catch-up/tour"
          data-testid="catchup-start-tour"
          className="ds-btn ds-btn--primary inline-flex h-[32px] items-center gap-[6px] rounded-[4px]"
        >
          <Play size={13} aria-hidden />
          Start the tour · {stops} stops · {minutes} min
        </Link>
        <span className="font-mono text-[10.5px] whitespace-nowrap text-muted">
          built from {builtFrom} shared {builtFrom === 1 ? "tour" : "tours"}
        </span>
      </div>
    </div>
  );
}

/** The button's no-op when a caller draws the block with no ask wired to it. */
function noop() {}
