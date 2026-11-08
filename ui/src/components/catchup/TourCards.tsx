/**
 * The catch-up tour cards (mock 8a): one card per stop of this reader's
 * tour, priority first. Each card wears a 3px top border in its importance
 * colour, a number square, the project square, its ref and minutes, the
 * model's kind label, the title, the first sentence of the narrative as the
 * "why", and a 124px evidence preview — only when the stop carries evidence;
 * an empty dashed box says nothing worth drawing. The first card is focused
 * (ink border + offset shadow). A 150px dashed "See more" card ends the row
 * and asks the tour for up to 4 more stops.
 *
 * Below 768px the row becomes a horizontal strip: the cards keep a 260px
 * minimum width (180px for "See more") and scroll-snap along the strip
 * instead of squashing into one-word columns.
 */
import { Link } from "react-router";
import { CircleDot, GitCommitHorizontal, GitPullRequest, Plus } from "lucide-react";
import type { CatchUpTourEntry } from "../../api/catchup";
import { firstSentence } from "../../api/catchup";
import { Evidence } from "./Evidence";
import { IMPORTANCE, projectColor, projectSquareClasses, refLabel } from "./importance";

/** The tour card's ref icon follows whichever ref the label was drawn from. */
function RefGlyph({ entry }: { entry: CatchUpTourEntry }) {
  const size = 12;
  if (entry.refs.issues?.length) return <CircleDot size={size} aria-hidden />;
  if (entry.refs.pull_requests?.length) return <GitPullRequest size={size} aria-hidden />;
  return <GitCommitHorizontal size={size} aria-hidden />;
}

export function TourCards({
  stops,
  remaining,
  moreAvailable,
  loadingMore,
  onSeeMore,
}: {
  stops: CatchUpTourEntry[];
  remaining: number;
  moreAvailable: boolean;
  loadingMore: boolean;
  onSeeMore: () => void;
}) {
  return (
    <div className="flex gap-[10px] max-md:snap-x max-md:snap-mandatory max-md:overflow-x-auto">
      {stops.map((entry, index) => {
        const importance = IMPORTANCE[entry.stop.importance] ?? IMPORTANCE.routine;
        const ref = refLabel(entry.refs);
        const focused = index === 0;
        return (
          <article
            key={`${entry.work_item_id}:${entry.stop.id}`}
            data-testid={`catchup-card-${index + 1}`}
            className={`flex min-w-0 flex-1 flex-col gap-[7px] rounded-panel border border-t-[3px] bg-surface p-[12px] max-md:snap-start max-md:w-[260px] max-md:min-w-[260px] max-md:flex-none ${importance.topBorder} ${
              focused ? "border-ink shadow-[2px_2px_0_var(--color-ink)]" : "border-line-strong"
            }`}
          >
            <div className="flex items-center gap-[6px]">
              <span
                className={`grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[2px] font-mono text-[10.5px] font-semibold ${importance.tagBg} ${importance.tagFg}`}
              >
                {index + 1}
              </span>
              <span
                className={projectSquareClasses()}
                style={{ background: projectColor(entry.project.color) }}
                aria-hidden
              />
              {ref ? (
                <span className="flex items-center gap-[4px] font-mono text-[11px] text-ink-2 whitespace-nowrap">
                  <RefGlyph entry={entry} />
                  {ref}
                </span>
              ) : null}
              <span className="ml-auto font-mono text-[10.5px] text-muted whitespace-nowrap">
                {entry.minutes} min
              </span>
            </div>
            {entry.stop.kind ? (
              <span className="inline-flex h-[18px] shrink-0 items-center self-start rounded-panel border border-ink px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase">
                {entry.stop.kind}
              </span>
            ) : null}
            <h3 className="text-[14.5px] leading-[1.3] font-semibold">{entry.stop.title}</h3>
            <p className="text-[12.5px] leading-[1.45] text-ink-2">
              {firstSentence(entry.stop.narrative)}
            </p>
            {/* The frame is the evidence's OWN height, capped at the mock's
             * 124px (README Part C): a fixed 124px box left a three-line file
             * list floating in empty paper. The footer keeps its place at the
             * card's bottom through `mt-auto`, not by stretching the frame. */}
            {entry.stop.evidence?.[0] ? (
              <div className="max-h-[124px] overflow-hidden">
                <Evidence evidence={entry.stop.evidence[0]} />
              </div>
            ) : null}
            <Link
              to={`/catch-up/${entry.work_item_id}?stop=${encodeURIComponent(entry.stop.id)}`}
              className="mt-auto font-ui text-[12px] font-semibold text-accent-text"
            >
              Start here ›
            </Link>
          </article>
        );
      })}
      {moreAvailable ? (
        <button
          type="button"
          onClick={onSeeMore}
          disabled={loadingMore}
          data-testid="catchup-see-more"
          className="flex w-[150px] shrink-0 flex-col items-start justify-center gap-[8px] rounded-panel border border-dashed border-project-quiet bg-st-queued-pale-body p-[12px] text-left disabled:opacity-60 max-md:w-[180px] max-md:min-w-[180px] max-md:snap-start"
        >
          <span className="grid h-[28px] w-[28px] place-items-center rounded-panel border border-ink bg-surface">
            <Plus size={14} aria-hidden />
          </span>
          <span className="text-[13.5px] font-semibold">See more</span>
          <span className="text-[12px] leading-[1.4] text-ink-2">
            {loadingMore
              ? "Asking the assistant…"
              : `The assistant picks up to 4 more from the remaining ${remaining}.`}
          </span>
        </button>
      ) : null}
    </div>
  );
}
