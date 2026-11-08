/**
 * Catch up (design 8a, ADR-0078): the reader's own pile of pieces of work.
 *
 * The page is a stack of four honest blocks over one read: the filter row
 * (project chips + the window chips, "unseen" by default so the page empties
 * as you go), the big-backlog banner (only when the pile is large and the
 * window is wide), the assistant recap with the tour's primary action, and
 * the tour cards. Below sits "the rest" — every piece still owed, how its
 * code landed, and what the assistant thinks became of it.
 *
 * The tour player (`/catch-up/tour`) and the piece page (`/catch-up/:id`)
 * are built later; every link here already points at them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import Page from "../components/ds/Page";
import { ProblemBanner } from "../components/Feedback";
import { ProjectChips, WindowChips } from "../components/catchup/Chips";
import { BacklogBanner } from "../components/catchup/BacklogBanner";
import { RecapBlock } from "../components/catchup/RecapBlock";
import { TourCards } from "../components/catchup/TourCards";
import { RestList } from "../components/catchup/RestList";
import { clockOf, daysSince, type ProjectChip } from "../components/catchup/importance";
import {
  useCatchUpItems,
  useCatchUpTour,
  useCatchUpRecap,
  useVisitSuggestion,
  useMarkSeen,
  useMarkAllSeen,
  useRecordVisit,
  CATCH_UP_TOUR_LIMIT,
  type CatchUpFilters,
  type CatchUpTourEntry,
  type CatchUpWindow,
} from "../api/catchup";
import { useHomeApprovals } from "../api/home";

export default function CatchUp() {
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [windowChip, setWindowChip] = useState<CatchUpWindow>("unseen");
  const [showSeen, setShowSeen] = useState(false);
  const [keepAll, setKeepAll] = useState(false);
  const [offset, setOffset] = useState(0);
  const [knownProjects, setKnownProjects] = useState<Record<string, ProjectChip>>({});
  const [stops, setStops] = useState<CatchUpTourEntry[]>([]);

  const baseFilters: CatchUpFilters = useMemo(
    () => ({ projects: selectedProjects, window: windowChip }),
    [selectedProjects, windowChip],
  );
  const items = useCatchUpItems(baseFilters);
  const restItems = useCatchUpItems({ ...baseFilters, includeSeen: showSeen });
  const totalUnseen = items.data?.total_unseen ?? 0;
  const tour = useCatchUpTour(baseFilters, offset, totalUnseen > 0);
  const recap = useCatchUpRecap(baseFilters);
  const suggestion = useVisitSuggestion();
  const approvals = useHomeApprovals();
  const markSeen = useMarkSeen();
  const markAllSeen = useMarkAllSeen();
  const recordVisit = useRecordVisit();

  /* The visit stamp drives the banner's suggested window; record it once,
   * and never let a failed stamp break the page. */
  const visitRecorded = useRef(false);
  useEffect(() => {
    if (visitRecorded.current) return;
    visitRecorded.current = true;
    recordVisit.mutateAsync().catch(() => undefined);
  }, [recordVisit]);

  /* The chip list accumulates the projects this reader's items carry: the
   * API's project chips (id, name, colour) are the only place the colours
   * live, and a filter must never erase the chip that set it. */
  useEffect(() => {
    const rows = [...(items.data?.items ?? []), ...(restItems.data?.items ?? [])];
    if (rows.length === 0) return;
    setKnownProjects((prev) => {
      let next = prev;
      for (const row of rows) {
        if (!next[row.project.id]) {
          if (next === prev) next = { ...prev };
          next[row.project.id] = row.project;
        }
      }
      return next;
    });
  }, [items.data, restItems.data]);

  /* Filter changes restart the tour paging from the top. */
  useEffect(() => {
    setOffset(0);
    setStops([]);
  }, [selectedProjects, windowChip]);

  /* "See more" pages append to the stops already shown, never replace them. */
  useEffect(() => {
    const page = tour.data;
    if (!page) return;
    setStops((prev) => {
      if (offset === 0) return page.stops;
      const merged = [...prev];
      for (const entry of page.stops) {
        const known = merged.some(
          (candidate) =>
            candidate.work_item_id === entry.work_item_id && candidate.stop.id === entry.stop.id,
        );
        if (!known) merged.push(entry);
      }
      return merged;
    });
  }, [tour.data, offset]);

  const toggleProject = (id: string) =>
    setSelectedProjects((prev) =>
      prev.includes(id) ? prev.filter((candidate) => candidate !== id) : [...prev, id],
    );

  const subline = (
    <>
      {totalUnseen} unseen
      {items.data?.oldest_unseen_at
        ? ` · oldest from ${clockOf(items.data.oldest_unseen_at) ?? "—"}`
        : ""}{" "}
      · {approvals.data?.approvals.length ?? 0} waiting on you on{" "}
      <Link to="/" className="text-st-waiting-tag-fg underline">
        Today
      </Link>
    </>
  );

  const suggestedWindow = suggestion.data?.window ?? "24h";
  const showBanner =
    !keepAll &&
    windowChip === "unseen" &&
    totalUnseen > 12 &&
    items.data?.oldest_unseen_at != null &&
    stops.length > 0;
  const caughtUp = !items.isPending && !items.isError && totalUnseen === 0;
  const remaining = Math.max((tour.data?.total_unseen_stops ?? 0) - stops.length, 0);

  return (
    <Page layout="wide" testid="catchup-page" title="Catch up" subtitle={subline}>
      {items.isError ? (
        <ProblemBanner
          error={items.error}
          subject="your catch-up list"
          fallback="Your catch-up list did not load."
          testid="catchup-error"
          retry={{ onClick: () => void items.refetch(), pending: items.isFetching }}
          hint="Retry below."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[12px] border-b border-line-strong pb-[12px]">
            <ProjectChips
              projects={Object.values(knownProjects)}
              selected={selectedProjects}
              onToggle={toggleProject}
            />
            {Object.keys(knownProjects).length > 0 ? (
              <span className="h-[20px] w-px bg-line-strong" aria-hidden />
            ) : null}
            <WindowChips value={windowChip} onChange={setWindowChip} />
          </div>
          {items.isPending ? (
            <p className="text-[13px] text-faint">Reading your catch-up list…</p>
          ) : null}
          {caughtUp && !showSeen ? (
            <div data-testid="catchup-caught-up" className="flex flex-col gap-[4px] pt-[8px]">
              <p className="text-[15px] font-semibold text-st-done-tag-fg">
                ✓ You&apos;re caught up
              </p>
              <p className="text-[13px] text-faint">
                Nothing new since your last visit. Items land here as the assistant groups code into
                stories.
              </p>
            </div>
          ) : null}
          {caughtUp && showSeen ? (
            <RestList
              items={restItems.data?.items ?? []}
              showSeen={showSeen}
              onToggleShowSeen={() => setShowSeen(false)}
              onMarkAllSeen={() => markAllSeen.mutate(selectedProjects)}
              onMarkSeen={(item) => markSeen.mutate({ itemId: item.id })}
              markingIds={markSeen.variables ? [markSeen.variables.itemId] : []}
            />
          ) : null}
          {!caughtUp && !items.isPending ? (
            <div className="flex flex-col gap-[14px] pt-[14px]">
              {showBanner && items.data?.oldest_unseen_at ? (
                <BacklogBanner
                  unseen={totalUnseen}
                  days={daysSince(items.data.oldest_unseen_at)}
                  tourStops={stops.length}
                  suggestedWindow={suggestedWindow}
                  onNarrow={() => setWindowChip(suggestedWindow as CatchUpWindow)}
                  onKeepAll={() => setKeepAll(true)}
                />
              ) : null}
              <RecapBlock
                recap={recap.data}
                loading={recap.isPending}
                stops={stops.length}
                minutes={tour.data?.minutes_total ?? 0}
                builtFrom={tour.data?.built_from ?? 0}
              />
              {stops.length > 0 ? (
                <TourCards
                  stops={stops}
                  remaining={remaining}
                  moreAvailable={Boolean(tour.data?.more_available)}
                  loadingMore={tour.isFetching && offset > 0}
                  onSeeMore={() => setOffset((prev) => prev + CATCH_UP_TOUR_LIMIT)}
                />
              ) : tour.isError ? (
                <p className="text-[13px] text-faint">
                  The tour could not be built right now — the list below still stands.
                </p>
              ) : null}
              <RestList
                items={restItems.data?.items ?? []}
                showSeen={showSeen}
                onToggleShowSeen={() => setShowSeen((prev) => !prev)}
                onMarkAllSeen={() => markAllSeen.mutate(selectedProjects)}
                onMarkSeen={(item) => markSeen.mutate({ itemId: item.id })}
                markingIds={markSeen.variables ? [markSeen.variables.itemId] : []}
              />
            </div>
          ) : null}
        </>
      )}
    </Page>
  );
}
