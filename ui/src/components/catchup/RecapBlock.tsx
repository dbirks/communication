/**
 * The recap block (mock 8a): the assistant's saved summary with its
 * "ASSISTANT RECAP · WRITTEN {HH:MM}" label, and on the right the primary
 * action that opens the catch-up tour plus the honest note that the tour is
 * assembled from the per-piece ("shared") tours. A reader the generator has
 * never written a recap for gets a muted "No recap yet." — the honest empty,
 * never a fabricated sentence (the regenerate action arrives later).
 */
import { Link } from "react-router";
import { Play } from "lucide-react";
import type { CatchUpRecap } from "../../api/catchup";
import { clockOf } from "./importance";

export function RecapBlock({
  recap,
  loading,
  stops,
  minutes,
  builtFrom,
}: {
  /** null = the read answered 404 ("never written you one"). */
  recap: CatchUpRecap | null | undefined;
  loading: boolean;
  stops: number;
  minutes: number;
  builtFrom: number;
}) {
  const written = recap ? clockOf(recap.written_at) : null;
  return (
    <div
      data-testid="catchup-recap"
      className="grid grid-cols-1 items-end gap-x-[24px] gap-y-[6px] md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span className="font-mono text-[10.5px] whitespace-nowrap text-muted">
          ASSISTANT RECAP{written ? ` · WRITTEN ${written}` : ""}
        </span>
        {recap ? (
          <p className="max-w-[760px] text-[15px] leading-[1.55] text-ink">{recap.text}</p>
        ) : (
          <p className="text-[13px] text-faint">
            {loading ? "Reading the recap…" : "No recap yet."}
          </p>
        )}
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
          built from {builtFrom} shared tours
        </span>
      </div>
    </div>
  );
}
