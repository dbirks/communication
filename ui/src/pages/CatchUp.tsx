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
import type { ReactNode } from "react";
import { Link } from "react-router";
import Page from "../components/ds/Page";
import { ProblemBanner } from "../components/Feedback";
import { ProjectChips, WindowChips } from "../components/catchup/Chips";
import { BacklogBanner } from "../components/catchup/BacklogBanner";
import { BriefHeadline } from "../components/catchup/BriefHeadline";
import { BriefNeedsYou } from "../components/catchup/BriefNeedsYou";
import { BriefNumbers, numberTerms } from "../components/catchup/BriefNumbers";
import {
  BriefBrokeRow,
  BriefChangeRow,
  BriefHeadsUpRow,
  BriefRunningRow,
  BriefSection,
  BriefShippedRow,
} from "../components/catchup/BriefSection";
import { RecapBlock } from "../components/catchup/RecapBlock";
import { TourCards } from "../components/catchup/TourCards";
import { RestList } from "../components/catchup/RestList";
import { clockOf, daysSince, type ProjectChip } from "../components/catchup/importance";
import {
  useCatchUpItems,
  useCatchUpTour,
  useCatchUpBrief,
  useCatchUpRecap,
  useRegenerateRecap,
  recapFailureMessage,
  useVisitSuggestion,
  useMarkItemSeen,
  useMarkAllSeen,
  useRecordVisit,
  CATCH_UP_TOUR_LIMIT,
  type CatchUpBrief,
  type CatchUpFilters,
  type CatchUpTourEntry,
  type CatchUpWindow,
} from "../api/catchup";
import { useProjects } from "../api/queries";
import { useSidebarFlags } from "../lib/sidebarFlags";

/**
 * The catch-up BRIEF (ADR-0081): the deterministic answer to "what did I miss",
 * assembled by the server and rendered without waiting on a model.
 *
 * The order is the ADR's, top to bottom: the model's headline (which cites
 * these rows rather than choosing them), what waits on this reader, the five
 * lists, and the arithmetic beside them. Every block draws its own absence —
 * an empty section is no section — and when all of them are absent the page
 * says the one true sentence left to it: `Quiet stretch…`.
 */
export function BriefBlock({ brief, now }: { brief: CatchUpBrief | null; now?: Date }) {
  if (!brief) {
    // No brief yet — still reading, or a server with no such route. The block
    // renders NOTHING: "nothing changed" is the quiet line's sentence, and
    // only a brief that actually looked may say it.
    return null;
  }
  /* One entry per section, with its rows already rendered: the five lists carry
   * five different row shapes, and a `render` callback over a union of them is
   * a type error waiting to happen. Each row renders itself (BriefSection.tsx);
   * this table only says which section it belongs to and what the head reads. */
  const sections: { key: string; title: string; head: number; rows: ReactNode }[] = [
    {
      key: "running_now",
      title: "RUNNING NOW",
      head: brief.running_now.length,
      rows: brief.running_now.map((row) => (
        <BriefRunningRow key={row.run_id} row={row} now={now} />
      )),
    },
    {
      key: "shipped",
      title: "SHIPPED",
      head: brief.shipped.length,
      rows: brief.shipped.map((row) => (
        <BriefShippedRow key={`${row.kind}:${row.link}`} row={row} now={now} />
      )),
    },
    {
      key: "broke",
      title: "BROKE & FIXED",
      head: brief.broke.length,
      rows: brief.broke.map((row) => (
        <BriefBrokeRow key={`${row.project.id}:${row.title}`} row={row} now={now} />
      )),
    },
    {
      key: "heads_up",
      title: "HEADS-UP",
      head: brief.heads_up.length,
      rows: brief.heads_up.map((row) => (
        <BriefHeadsUpRow key={`${row.signal}:${row.link}`} row={row} />
      )),
    },
    {
      key: "changes",
      title: "CHANGES",
      head: brief.changes.length,
      rows: brief.changes.map((row) => (
        <BriefChangeRow key={`${row.kind}:${row.link}`} row={row} now={now} />
      )),
    },
  ];
  const shown = sections.filter((section) => section.head > 0);
  const numbers = numberTerms(brief.numbers);
  const quiet =
    brief.needs_you.length === 0 &&
    shown.length === 0 &&
    numbers.length === 0 &&
    /* A pending headline is the model still deciding what it would say about
     * these rows; "quiet stretch" is a conclusion the page may not reach while
     * that is in flight. */
    brief.headline.state !== "pending";
  return (
    <div className="flex flex-col gap-[14px]" data-testid="catchup-brief">
      <BriefHeadline headline={brief.headline} byProject={brief.by_project} />
      <BriefNeedsYou needs={brief.needs_you} now={now} />
      {shown.length > 0 ? (
        <div className="grid grid-cols-1 gap-[12px] min-[1100px]:grid-cols-2">
          {shown.map((section) => {
            // `omitted` is keyed by the section's API name (`running_now`,
            // `heads_up`, …) — the same key the head counts against.
            const cut = brief.omitted[section.key] ?? 0;
            return (
              <BriefSection
                key={section.key}
                testid={`catchup-brief-${section.key}`}
                title={section.title}
                count={section.head + cut}
                omitted={cut}
              >
                {section.rows}
              </BriefSection>
            );
          })}
        </div>
      ) : null}
      {numbers.length > 0 ? <BriefNumbers numbers={brief.numbers} /> : null}
      {quiet ? (
        <p
          data-testid="catchup-brief-quiet"
          className="py-[8px] text-center text-[13px] text-muted"
        >
          Quiet stretch: nothing changed in the projects you follow.
        </p>
      ) : null}
    </div>
  );
}

/** The mono label the stories keep under the brief (ADR-0081 § UI): the tour
 * and the rest list are still the page's long form, and now they say so. */
export function StoriesLabel() {
  return (
    <h2
      data-testid="catchup-stories-label"
      className="font-mono text-[10.5px] font-semibold tracking-[.06em] whitespace-nowrap text-faint uppercase"
    >
      Stories
    </h2>
  );
}

export default function CatchUp() {
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [windowChip, setWindowChip] = useState<CatchUpWindow>("unseen");
  const [showSeen, setShowSeen] = useState(false);
  const [keepAll, setKeepAll] = useState(false);
  const [offset, setOffset] = useState(0);
  const [stops, setStops] = useState<CatchUpTourEntry[]>([]);

  const baseFilters: CatchUpFilters = useMemo(
    () => ({ projects: selectedProjects, window: windowChip }),
    [selectedProjects, windowChip],
  );
  const items = useCatchUpItems(baseFilters);
  const restItems = useCatchUpItems({ ...baseFilters, includeSeen: showSeen });
  // The filter row shows the reader's PROJECTS, not the projects one page of
  // items happens to mention: an engineer with three projects and unseen work
  // in one of them still filters by the other two.
  const projectsQuery = useProjects();
  const allProjects = useMemo<ProjectChip[]>(
    () =>
      (projectsQuery.data?.items ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        color: project.color,
      })),
    [projectsQuery.data],
  );
  const allProjectIds = allProjects.map((project) => project.id);
  // Empty selection is the API's "every project I belong to", so the chips draw
  // it as everything selected — the row never shows a filter nobody chose.
  const selectedIds =
    selectedProjects.length === 0 ? allProjectIds : selectedProjects.filter((id) => id.length > 0);
  const totalUnseen = items.data?.total_unseen ?? 0;
  const tour = useCatchUpTour(baseFilters, offset, totalUnseen > 0);
  const recap = useCatchUpRecap(baseFilters);
  // The brief is the page's OWN read (ADR-0081): a different route, a different
  // window vocabulary (the server resolves `unseen` itself), and its own
  // poll — it refetches while the headline is `pending`, never after.
  const brief = useCatchUpBrief(windowChip, selectedProjects);
  const regenerateRecap = useRegenerateRecap();
  const suggestion = useVisitSuggestion();
  // "Waiting on you" is the SIDEBAR'S number, from the same hook that draws
  // the Today flag: two counts of the same fact would disagree on one screen.
  const flags = useSidebarFlags();
  // The rest-list checkbox is an explicit "mark this whole piece seen" —
  // stop navigation uses useMarkStopsSeen, never this.
  const markItemSeen = useMarkItemSeen();
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

  /* The chip list is the reader's own project list; a filter must never erase
   * the chip that set it, and a project with nothing unseen is still a project
   * they can ask about. */

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
    setSelectedProjects((prev) => {
      // "Nothing chosen" already means "everything": the first click leaves it
      // by naming every project EXCEPT the one the reader turned off, so the
      // chip they clicked is the only visible change.
      if (prev.length === 0) return allProjectIds.filter((known) => known !== id);
      const next = prev.includes(id) ? prev.filter((known) => known !== id) : [...prev, id];
      // Everything chosen again is the same answer as nothing chosen.
      return next.length === allProjectIds.length ? [] : next;
    });

  /* The rest excludes what the cards already show (mock 8a): a piece with
   * ANY stop in the shown tour cards is not repeated below — its remaining
   * stops are reachable through "See more" and on its piece page. */
  const tourStopsByItem = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of stops) counts[entry.work_item_id] = (counts[entry.work_item_id] ?? 0) + 1;
    return counts;
  }, [stops]);

  /* Pieces the list read flags `updated` (this reader saw an older version of
   * their story). UPDATED marks a changed piece WHEREVER it appears, so the
   * cards wear the same badge the rest rows print (TourCards.tsx). */
  const updatedWorkItemIds = useMemo(
    () => (items.data?.items ?? []).filter((item) => item.updated).map((item) => item.id),
    [items.data],
  );

  const subline = (
    <>
      {totalUnseen} unseen
      {items.data?.oldest_unseen_at
        ? ` · oldest from ${clockOf(items.data.oldest_unseen_at) ?? "—"}`
        : ""}{" "}
      · {flags.inbox.needsYou} waiting on you on{" "}
      <Link to="/" className="text-st-waiting-tag-fg underline">
        Today
      </Link>
    </>
  );

  const suggestedWindow = suggestion.data?.window ?? "24h";
  // The chip's dot is the suggestion ITSELF: `null` (fewer than two visits) is
  // "no window was inferred", and dotting the page's fallback would claim a
  // measurement the server refused to make.
  const suggestedChip = (suggestion.data?.window ?? undefined) as CatchUpWindow | undefined;
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
      {/* ADR-0081: the page's content column stops at 1040px — the brief reads
       * as two ~500px columns there, and wider only makes its rows sentences
       * you chase across the desk. */}
      <div className="flex w-full max-w-[1040px] flex-col">
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
                projects={allProjects}
                selected={selectedIds}
                onToggle={toggleProject}
              />
              {allProjects.length > 0 ? (
                <span className="h-[20px] w-px bg-line-strong" aria-hidden />
              ) : null}
              <WindowChips value={windowChip} onChange={setWindowChip} suggested={suggestedChip} />
            </div>
            {items.isPending ? (
              <p className="text-[13px] text-faint">Reading your catch-up list…</p>
            ) : null}
            {/* ADR-0081: the brief reads its OWN route and sits above the
             * stories — it is the answer to "what did I miss", and the tour's
             * stories are the long way into the same facts. It renders whether or
             * not the pile below it has, and never waits on the model. */}
            {brief.data ? (
              <div className="pt-[14px]">
                <BriefBlock brief={brief.data} />
              </div>
            ) : null}
            {caughtUp && !showSeen ? (
              <div data-testid="catchup-caught-up" className="flex flex-col gap-[4px] pt-[14px]">
                <p className="text-[15px] font-semibold text-st-done-tag-fg">
                  ✓ You&apos;re caught up
                </p>
                <p className="text-[13px] text-faint">
                  Nothing new since your last visit. Items land here as the assistant groups code
                  into stories.
                </p>
              </div>
            ) : null}
            {caughtUp && showSeen ? (
              <div className="flex flex-col gap-[10px] pt-[14px]">
                <StoriesLabel />
                <RestList
                  items={restItems.data?.items ?? []}
                  showSeen={showSeen}
                  tourStopsByItem={tourStopsByItem}
                  onToggleShowSeen={() => setShowSeen(false)}
                  onMarkAllSeen={() => markAllSeen.mutate(selectedProjects)}
                  onMarkSeen={(item) => markItemSeen.mutate({ itemId: item.id })}
                  markingIds={markItemSeen.variables ? [markItemSeen.variables.itemId] : []}
                />
              </div>
            ) : null}
            {!caughtUp && !items.isPending ? (
              <div className="flex flex-col gap-[14px] pt-[14px]">
                <StoriesLabel />
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
                  onRegenerate={() =>
                    regenerateRecap.mutate({ projects: selectedProjects, window: windowChip })
                  }
                  writing={regenerateRecap.isPending}
                  error={
                    regenerateRecap.isError ? recapFailureMessage(regenerateRecap.error) : null
                  }
                />
                {stops.length > 0 ? (
                  <TourCards
                    stops={stops}
                    remaining={remaining}
                    moreAvailable={Boolean(tour.data?.more_available)}
                    loadingMore={tour.isFetching && offset > 0}
                    updatedWorkItemIds={updatedWorkItemIds}
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
                  tourStopsByItem={tourStopsByItem}
                  onToggleShowSeen={() => setShowSeen((prev) => !prev)}
                  onMarkAllSeen={() => markAllSeen.mutate(selectedProjects)}
                  onMarkSeen={(item) => markItemSeen.mutate({ itemId: item.id })}
                  markingIds={markItemSeen.variables ? [markItemSeen.variables.itemId] : []}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}
