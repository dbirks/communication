/**
 * "The rest" panel (mock 8a): one list of every piece still owed (or all of
 * them, when "show seen" is on). Each 46px row says how the code landed
 * (Issue / PR only / Push to main), carries the project square and its ref,
 * the title with the UPDATED badge when the story moved after this reader
 * last saw it, a one-line summary, the resolution chip and a "Tour ›" link.
 * The row checkbox marks that item's beats seen; "mark all seen" clears the
 * whole filtered pile. Pieces whose unseen stops are ALL in the tour cards
 * above are excluded — the rest is what the cards do not show (mock 8a);
 * a piece with only some stops featured stays. Below 768px each row stacks
 * into two lines (landing + project + resolution + Tour ›, then title +
 * summary) and the checkbox grows a 44px hit area (coarse pointers too)
 * without shifting the desktop grid.
 */
import { CircleDot, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { Link } from "react-router";
import type { CatchUpListItem } from "../../api/catchup";
import {
  projectColor,
  projectSquareClasses,
  RESOLUTION_STATE,
  RESOLUTION_WORD,
  refLabel,
} from "./importance";
import { STATES } from "../ds/states";

function ShapeLabel({ item }: { item: CatchUpListItem }) {
  const size = 13;
  if (item.shape === "issue") {
    return (
      <span className="flex items-center gap-[5px] font-mono text-[10.5px] whitespace-nowrap text-muted">
        <CircleDot size={size} aria-hidden />
        Issue
      </span>
    );
  }
  if (item.shape === "pr") {
    return (
      <span className="flex items-center gap-[5px] font-mono text-[10.5px] whitespace-nowrap text-muted">
        <GitPullRequest size={size} aria-hidden />
        PR only
      </span>
    );
  }
  return (
    <span className="flex items-center gap-[5px] font-mono text-[10.5px] whitespace-nowrap text-muted">
      <GitCommitHorizontal size={size} aria-hidden />
      Push to main
    </span>
  );
}

export function RestList({
  items,
  showSeen,
  onToggleShowSeen,
  onMarkAllSeen,
  onMarkSeen,
  markingIds,
  tourStopsByItem = {},
}: {
  items: CatchUpListItem[];
  showSeen: boolean;
  onToggleShowSeen: () => void;
  onMarkAllSeen: () => void;
  onMarkSeen: (item: CatchUpListItem) => void;
  markingIds: string[];
  /** Unseen stops of each piece already shown in the tour cards above, by
   * work-item id. A piece fully covered there is not repeated in the rest. */
  tourStopsByItem?: Record<string, number>;
}) {
  const unseen = items.filter((item) => item.unseen_stops > 0);
  // A piece stays in the rest while any of its unseen stops is missing from
  // the cards; only a fully featured piece is excluded.
  const restUnseen = unseen.filter((item) => (tourStopsByItem[item.id] ?? 0) < item.unseen_stops);
  const rows = showSeen ? items : restUnseen;
  const allFeatured = unseen.length > 0 && restUnseen.length === 0;
  return (
    <section
      data-testid="catchup-rest"
      className="overflow-hidden rounded-panel border border-line-strong bg-surface"
    >
      <header className="flex items-center gap-[8px] border-b border-line-strong bg-fill px-[10px] py-[4px] font-mono text-[10px] leading-[1.4] font-semibold tracking-[.04em] whitespace-nowrap text-ink-2">
        THE REST · {restUnseen.length} UNSEEN
        <span className="ml-auto flex items-center gap-[10px] font-normal">
          <label className="flex items-center gap-[4px]">
            <input
              type="checkbox"
              checked={showSeen}
              onChange={onToggleShowSeen}
              data-testid="catchup-show-seen"
              className="h-[12px] w-[12px] accent-accent"
            />
            show seen
          </label>
          <button
            type="button"
            onClick={onMarkAllSeen}
            data-testid="catchup-mark-all-seen"
            className="font-mono text-[10px] font-semibold text-accent-text hover:text-ink"
          >
            mark all seen
          </button>
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="px-[12px] py-[10px] text-[12.5px] text-faint">
          {allFeatured && !showSeen ? "Everything unseen is in the tour above." : "Nothing here."}
        </p>
      ) : null}
      {rows.map((item) => {
        const state = STATES[RESOLUTION_STATE[item.resolution]];
        const ref = refLabel(item.refs);
        const marking = markingIds.includes(item.id);
        return (
          <div
            key={item.id}
            data-testid={`catchup-row-${item.id}`}
            className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] border-b border-line px-[12px] py-[8px] last:border-b-0 md:grid md:h-[46px] md:grid-cols-[16px_104px_minmax(0,160px)_minmax(0,1fr)_auto_64px] md:items-center md:py-0"
          >
            <label className="relative grid h-[15px] w-[15px] place-items-center md:col-start-1">
              <input
                type="checkbox"
                aria-label={`Mark ${item.title} seen`}
                checked={item.unseen_stops === 0}
                disabled={marking || item.unseen_stops === 0}
                onChange={() => onMarkSeen(item)}
                className="h-[15px] w-[15px] shrink-0 accent-accent"
              />
              {/* 44×44 hit area over the 15px box on phones and coarse
                  pointers; absolute, so no layout moves underneath it. */}
              <span
                aria-hidden
                className="absolute -inset-[14.5px] hidden max-md:block pointer-coarse:block"
              />
            </label>
            <span className="md:col-start-2">
              <ShapeLabel item={item} />
            </span>
            <span className="flex min-w-0 items-center gap-[6px] md:col-start-3">
              <span
                className={projectSquareClasses()}
                style={{ background: projectColor(item.project.color) }}
                aria-hidden
              />
              {ref ? (
                <span className="font-mono text-[11.5px] font-medium whitespace-nowrap">{ref}</span>
              ) : null}
              <span className="font-mono text-[10.5px] whitespace-nowrap text-muted">
                {item.project.name}
              </span>
            </span>
            <span
              className={`ml-auto inline-flex h-[18px] items-center rounded-panel border border-line-strong px-[6px] font-mono text-[10.5px] whitespace-nowrap md:ml-0 md:col-start-5 ${state.tagBg} ${state.tagFg}`}
            >
              {RESOLUTION_WORD[item.resolution]}
            </span>
            <Link
              to={`/catch-up/${item.id}`}
              className="text-right font-ui text-[12px] font-semibold text-accent-text whitespace-nowrap md:col-start-6"
            >
              Tour ›
            </Link>
            <span className="w-full min-w-0 md:w-auto md:col-start-4">
              <span className="block truncate text-[13px] font-semibold">
                {item.title}{" "}
                {item.updated ? (
                  <span className="inline-flex items-center rounded-tag bg-imp-look-tag-bg px-[5px] py-[1px] align-[1px] font-mono text-[9.5px] font-semibold text-imp-look-tag-fg">
                    UPDATED
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-[12px] text-muted">{item.summary}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}
