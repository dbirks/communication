/**
 * Tour player (design 7b, ADR-0078) — full screen, NO sidebar. One stop at
 * a time, with the assistant's story of what happened.
 *
 * Two modes on one component:
 * - The reader's catch-up tour: `useCatchUpTour(filters, offset)`, page size
 *   4; "See more" appends the next 4. Project/window filters arrive on the
 *   query string the 8a page passes (`?projects=…&window=…`).
 * - One piece's whole tour: `?item={workId}` reads that item and plays every
 *   beat of its newest version.
 *
 * Seen is per stop: moving off a stop (→, ←, a click on another beat) pays
 * ONLY that stop's debt (`useMarkStopsSeen`); `S` marks the current stop seen
 * right now. In tour mode the version posted is the beat's own
 * `added_in_version` — the tour page serves beats of each item's newest
 * version, and the store reads the ids out of the named version, so naming
 * the version a beat was born in marks exactly that beat and nothing else.
 *
 * Bug stories render the FOUND → CAUSE → FIXED → FOLLOW-UP rows in the state
 * TAG colors those beats mean (failed / waiting / done / queued — `states.ts`),
 * so the label reads as a state, not as a pale band — but only when the sibling stops of
 * the same work item actually carry those kinds/titles. Nothing is invented:
 * without sibling support the stop is plain narrative paragraphs.
 *
 * Keys: ←/→ move, S marks seen now, Esc closes, ⌘J asks about this stop.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams, Link } from "react-router";
import { Check, Plus, X } from "lucide-react";
import { Button } from "../components/ds/Button";
import { ProblemBanner } from "../components/Feedback";
import { Evidence } from "../components/catchup/Evidence";
import { RefChips } from "../components/catchup/RefChips";
import { StopDecision } from "../components/catchup/StopDecision";
import {
  IMPORTANCE,
  primaryRefUrl,
  projectColor,
  projectSquareClasses,
} from "../components/catchup/importance";
import { STATES, type StateName } from "../components/ds/states";
import { routes } from "../lib/routes";
import {
  CATCH_UP_TOUR_LIMIT,
  CATCH_UP_WINDOWS,
  firstSentence,
  useCatchUpItem,
  useCatchUpTour,
  useMarkStopsSeen,
  type CatchUpFilters,
  type CatchUpTourEntry,
  type CatchUpStop,
  type CatchUpWindow,
} from "../api/catchup";

/**
 * TODO(T-tour): switch to the explicit `openAsk(context)` from
 * `ui/src/components/assistant/askControl.ts` when it lands, carrying this
 * stop as structured context. Until then this dispatches the same open event
 * `openAssistantPopover` does (`ASSISTANT_OPEN_EVENT` in
 * `components/assistant/AssistantPopover.tsx`) — the event name is repeated
 * as a literal on purpose so this full-screen page does not import the
 * Shell/panel module just to knock on its door.
 */
const ASSISTANT_OPEN_EVENT = "communication:assistant-open";

function openAskAbout(stopTitle: string): void {
  window.dispatchEvent(
    new CustomEvent(ASSISTANT_OPEN_EVENT, {
      detail: `About the catch-up stop “${stopTitle}” — what should I look at first?`,
    }),
  );
}

/** The lead paragraph: everything up to the first blank line. */
function paragraphs(narrative: string): string[] {
  return narrative
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The narrative body after the lead sentence: the remainder of the first
 * paragraph, then every following paragraph (the lead must not swallow it). */
function bodyAfterLead(paras: string[], lead: string): string[] {
  const [first, ...rest] = paras;
  if (!first) return rest;
  const remainder = first.startsWith(lead) ? first.slice(lead.length).trim() : first;
  return remainder.length > 0 ? [remainder, ...rest] : rest;
}

/* ------------------------------------------------------ bug-story steps
 * The four beats of a bug story, in reading order. A step shows only when a
 * stop of THIS work item (the current beat or one of its siblings) carries
 * the word in its kind or title — we never invent the chain (ADR-0078 §
 * Decision 3: `kind` is a free model label). */
interface StepDef {
  key: string;
  label: string;
  state: StateName;
  pattern: RegExp;
}

const STEP_DEFS: StepDef[] = [
  { key: "found", label: "FOUND", state: "failed", pattern: /\bfound\b/i },
  { key: "cause", label: "CAUSE", state: "waiting", pattern: /\bcaus(?:e|es|ed)\b/i },
  { key: "fixed", label: "FIXED", state: "done", pattern: /\bfix(?:es|ed|ing)?\b/i },
  { key: "follow-up", label: "FOLLOW-UP", state: "queued", pattern: /\bfollow[\s-]?up\b/i },
];

function stepText(stop: CatchUpStop): string {
  return `${stop.kind ?? ""} ${stop.title}`;
}

/** Matched steps, or null when this stop is not a bug story or nothing in
 * the item's tour backs the chain up (render plainly instead). */
function deriveSteps(
  current: CatchUpStop,
  siblings: CatchUpStop[],
): { def: StepDef; stop: CatchUpStop }[] | null {
  const isBug = /\bbug\b/i.test(stepText(current));
  if (!isBug) return null;
  const all = [current, ...siblings.filter((stop) => stop.id !== current.id)];
  const used = new Set<string>();
  const steps: { def: StepDef; stop: CatchUpStop }[] = [];
  for (const def of STEP_DEFS) {
    const match = all.find(
      (stop) =>
        !used.has(stop.id) &&
        def.pattern.test(stepText(stop)) &&
        // A "follow-up fix" stop is the follow-up beat, not the fixed beat.
        !(def.key === "fixed" && /\bfollow[\s-]?up\b/i.test(stepText(stop))),
    );
    if (match) {
      used.add(match.id);
      steps.push({ def, stop: match });
    }
  }
  // Sibling support is what makes it a STORY — a lone "BUG · FIXED" beat
  // gets its narrative paragraphs, not a one-row chain.
  const backedBySibling = steps.some((step) => step.stop.id !== current.id);
  return steps.length > 0 && backedBySibling ? steps : null;
}

function StepLabel({ def }: { def: StepDef }) {
  const state = STATES[def.state];
  return (
    <span
      className={`inline-flex items-center self-start rounded-[2px] px-[7px] py-[3px] font-mono text-[10.5px] font-semibold whitespace-nowrap ${state.tagBg} ${state.tagFg}`}
    >
      {def.label}
    </span>
  );
}

/** Read-time estimate for a beat of an item's own tour — the same rule the
 * tour page's `minutes` carries: one minute, plus one for log/diff evidence. */
function stopMinutes(stop: CatchUpStop): number {
  const heavy = (stop.evidence ?? []).some((item) => item.type === "log" || item.type === "diff");
  return heavy ? 2 : 1;
}

function windowFromParam(value: string | null): CatchUpWindow {
  return value && (CATCH_UP_WINDOWS as readonly string[]).includes(value)
    ? (value as CatchUpWindow)
    : "unseen";
}

export default function TourPlayer() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const itemIdParam = params.get("item") ?? "";
  const filters = useMemo<CatchUpFilters>(
    () => ({
      projects: (params.get("projects") ?? "").split(",").filter(Boolean),
      window: windowFromParam(params.get("window")),
    }),
    [params],
  );

  /* --- the stops on screen: tour pages, or one item's whole tour. ------ */
  const [offset, setOffset] = useState(0);
  const [tourEntries, setTourEntries] = useState<CatchUpTourEntry[]>([]);
  const [moreAvailable, setMoreAvailable] = useState(false);
  const tour = useCatchUpTour(filters, offset, itemIdParam.length === 0);

  useEffect(() => {
    const page = tour.data;
    if (!page || itemIdParam.length > 0) return;
    setMoreAvailable(Boolean(page.more_available));
    setTourEntries((prev) => {
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
  }, [tour.data, offset, itemIdParam]);

  /* The current stop's work item, read in BOTH modes: tour mode needs its
   * sibling stops (bug-story steps) and its `source_run_id` ("Open the fix"
   * links the run — the refs are labels with no url of their own, ADR-0078
   * § Decision 6, so this layer never fabricates a GitHub link); item mode
   * entries come straight from this same read. */
  const [index, setIndex] = useState(0);
  const fallbackEntry: CatchUpTourEntry | undefined = tourEntries[index];
  const readItemId =
    itemIdParam.length > 0
      ? itemIdParam
      : (fallbackEntry?.work_item_id ?? tourEntries[0]?.work_item_id ?? "");
  const piece = useCatchUpItem(readItemId);

  const entries = useMemo<CatchUpTourEntry[]>(() => {
    if (itemIdParam.length === 0) return tourEntries;
    const data = piece.data;
    if (!data) return [];
    return (data.latest?.stops ?? []).map((stop) => ({
      work_item_id: data.id,
      stop,
      project: data.project,
      refs: data.refs,
      minutes: stopMinutes(stop),
    }));
  }, [itemIdParam, tourEntries, piece.data]);

  const currentIndex = Math.min(index, entries.length);
  const current = entries[currentIndex];
  const failed = itemIdParam.length > 0 ? piece.isError : tour.isError;
  const busy = itemIdParam.length > 0 ? piece.isPending : tour.isPending;
  const done = current == null && !busy && !failed;
  const minutesTotal = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  /* --- seen, one stop at a time. --------------------------------------- */
  const markStopsSeen = useMarkStopsSeen();
  const [seenExtra, setSeenExtra] = useState<string[]>([]);
  const isSeen = useCallback(
    (stop: CatchUpStop) => stop.seen || seenExtra.includes(stop.id),
    [seenExtra],
  );

  const payStop = useCallback(
    (entry: CatchUpTourEntry) => {
      if (isSeen(entry.stop)) return;
      // Item mode has the newest version in hand; tour mode names the beat's
      // own birth version, which contains the beat and only the beat.
      const version =
        itemIdParam.length > 0
          ? (piece.data?.latest?.version ?? entry.stop.added_in_version)
          : entry.stop.added_in_version;
      markStopsSeen.mutate({
        itemId: entry.work_item_id,
        version,
        stopIds: [entry.stop.id],
      });
      setSeenExtra((prev) => (prev.includes(entry.stop.id) ? prev : [...prev, entry.stop.id]));
    },
    [isSeen, itemIdParam, markStopsSeen, piece.data],
  );

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, entries.length));
      if (clamped === currentIndex) return;
      if (current) payStop(current);
      setIndex(clamped);
    },
    [currentIndex, current, entries.length, payStop],
  );

  const loadMore = useCallback(() => setOffset((prev) => prev + CATCH_UP_TOUR_LIMIT), []);

  const goNext = useCallback(() => {
    if (currentIndex >= entries.length - 1 && moreAvailable) {
      // Past the last stop LOADED, not the last stop there IS.
      loadMore();
      return;
    }
    goTo(currentIndex + 1);
  }, [currentIndex, entries.length, goTo, loadMore, moreAvailable]);

  /* --- ask, close, keys. ----------------------------------------------- */
  const close = useCallback(() => {
    // Back to where you came from; a tour opened directly (fresh tab, shared
    // link) lands on the Catch up page.
    if (location.key && location.key !== "default") navigate(-1);
    else navigate("/catch-up");
  }, [location.key, navigate]);

  const ask = useCallback(() => {
    if (!current) return;
    openAskAbout(current.stop.title);
  }, [current]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const withMeta = event.metaKey || event.ctrlKey;
      if (withMeta && (event.key === "j" || event.key === "J")) {
        event.preventDefault();
        ask();
        return;
      }
      if (withMeta || event.altKey) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(currentIndex - 1);
      } else if (event.key === "Escape") {
        close();
      } else if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        if (current) payStop(current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ask, close, current, goNext, goTo, payStop]);

  /* --- center content: bug-story steps or plain paragraphs. ------------ */
  const siblingStops = useMemo<CatchUpStop[]>(() => {
    const stops = piece.data?.latest?.stops ?? [];
    if (!current) return stops;
    return stops.filter((stop) => stop.id !== current.stop.id);
  }, [piece.data, current]);

  const steps = current ? deriveSteps(current.stop, siblingStops) : null;
  /* The lead is the stop's FIRST SENTENCE (mock 7b). When the FOUND/CAUSE/
   * FIXED/FOLLOW-UP rows render the current stop's own narrative, that
   * sentence appears inside the step — repeating it above would print the
   * same text twice, so the lead stands down. */
  const paras = current ? paragraphs(current.stop.narrative) : [];
  const lead = paras[0] ? firstSentence(paras[0]) : "";
  const leadDuplicated =
    steps?.some(
      ({ stop }) => stop.id === current?.stop.id && paragraphs(stop.narrative)[0]?.startsWith(lead),
    ) ?? false;
  const leadShown = lead.length > 0 && !leadDuplicated;
  // The item read names refs the tour page's copy may omit; either set's
  // pr/commit claims license "Open the fix". Where the server could name a
  // repository, the PR url is the fix and the commit url is next; only when
  // neither exists does the link fall back to this platform's own run page
  // (ADR-0078 § Decision 6 — a ref url is the server's computation from
  // `repositories.git_url`, never the model's prose).
  const currentRefs =
    current && piece.data?.id === current.work_item_id
      ? (piece.data.refs ?? current.refs)
      : current?.refs;
  const hasCodeRef =
    (currentRefs?.pull_requests?.length ?? 0) + (currentRefs?.commits?.length ?? 0) > 0;
  const fixHref =
    primaryRefUrl(currentRefs) ??
    (hasCodeRef && piece.data?.source_run_id ? routes.run(piece.data.source_run_id) : null);
  const fixIsRemote = Boolean(fixHref && /^https?:\/\//.test(fixHref));
  // "Open {follow-up}" stays absent: an issue ref may now be a LINK, but the
  // refs model carries no role that would tell this stop's follow-up issue from
  // the one it fixed. The player names the follow-up inside its step and never
  // guesses which number to open.

  /* --- render ----------------------------------------------------------- */
  const segCount = entries.length + (moreAvailable ? 1 : 0);
  /* Stops there ARE beyond the ones loaded — the honest count behind the
   * "+ See more" entry, never a promise about what the assistant will pick. */
  const remainingStops = Math.max((tour.data?.total_unseen_stops ?? 0) - entries.length, 0);
  const meta =
    entries.length === 0
      ? "about 0 min"
      : done
        ? `all ${entries.length} ${entries.length === 1 ? "stop" : "stops"} seen · about ${minutesTotal} min`
        : `stop ${currentIndex + 1} of ${entries.length} · about ${minutesTotal} min`;

  const heading = itemIdParam.length > 0 ? (piece.data?.title ?? "Catch-up tour") : "Catch-up tour";

  const stopList = (
    <div
      data-testid="tour-stop-column"
      className="flex min-h-0 flex-1 flex-col border-r border-line-strong bg-surface"
    >
      <div className="flex items-center gap-[8px] border-b border-line-strong bg-fill px-[10px] py-[4px] font-mono text-[10px] font-semibold tracking-[.04em] text-ink-2 uppercase">
        Stops
        <span className="ml-auto font-normal text-muted">highest priority first</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.map((entry, position) => {
          const importance = IMPORTANCE[entry.stop.importance] ?? IMPORTANCE.routine;
          const selected = position === currentIndex;
          return (
            <button
              key={`${entry.work_item_id}:${entry.stop.id}`}
              type="button"
              data-testid={`tour-stop-${position + 1}`}
              onClick={() => goTo(position)}
              className={`flex w-full items-start gap-[8px] border-b border-line px-[12px] py-[9px] text-left ${
                selected
                  ? "ds-texture-accent shadow-[inset_3px_0_0_var(--color-ink)]"
                  : "hover:bg-line-soft"
              }`}
            >
              <span
                className={`grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[2px] border font-mono text-[10.5px] font-semibold ${importance.border} ${importance.tagBg} ${importance.tagFg}`}
              >
                {position + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-[1.3] font-semibold text-ink">
                  {entry.stop.title}
                </span>
                <span className="mt-[2px] flex flex-wrap items-center gap-[5px]">
                  <span
                    className={projectSquareClasses()}
                    style={{ background: projectColor(entry.project.color) }}
                    aria-hidden
                  />
                  <span className="font-mono text-[10.5px] text-muted">{entry.project.name}</span>
                  {entry.stop.kind ? (
                    <span className="font-mono text-[9.5px] font-semibold tracking-[.03em] text-muted uppercase">
                      {entry.stop.kind}
                    </span>
                  ) : null}
                </span>
              </span>
              {isSeen(entry.stop) ? (
                <Check
                  size={13}
                  aria-label="seen"
                  className="mt-[2px] shrink-0 text-st-done-tag-fg"
                />
              ) : null}
            </button>
          );
        })}
        {itemIdParam.length === 0 && moreAvailable ? (
          <div className="flex flex-col gap-[6px] border-b border-line px-[12px] py-[12px]">
            <button
              type="button"
              data-testid="tour-see-more"
              onClick={loadMore}
              disabled={tour.isFetching}
              className="inline-flex items-center gap-[6px] self-start text-[13px] font-semibold text-accent disabled:text-muted"
            >
              <Plus size={13} aria-hidden />
              See more
            </button>
            <span className="text-[12px] leading-[1.4] text-muted">
              {remainingStops > 0 ? `${remainingStops} more ` : "More "}
              {remainingStops === 1 ? "piece" : "pieces"} of work. The assistant adds the ones worth
              your time.
            </span>
          </div>
        ) : null}
      </div>
      {/* The hint sits at the BOTTOM of the column (mock 7b), not under the
       * last stop. */}
      <div
        data-testid="tour-keyboard-hint"
        className="shrink-0 border-t border-line-strong px-[12px] py-[12px] font-mono text-[10.5px] whitespace-nowrap text-muted"
      >
        ← → move · S seen · ⌘J ask about this stop
      </div>
    </div>
  );

  const currentBody = current ? (
    <article className="flex flex-col gap-[16px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        <span
          className={`inline-flex h-[18px] items-center rounded-panel px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase ${
            (IMPORTANCE[current.stop.importance] ?? IMPORTANCE.routine).tagBg
          } ${(IMPORTANCE[current.stop.importance] ?? IMPORTANCE.routine).tagFg}`}
        >
          {(IMPORTANCE[current.stop.importance] ?? IMPORTANCE.routine).label}
        </span>
        {current.stop.kind ? (
          <span className="inline-flex h-[18px] items-center rounded-panel border border-ink px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase">
            {current.stop.kind}
          </span>
        ) : null}
        <span
          className={projectSquareClasses()}
          style={{ background: projectColor(current.project.color) }}
          aria-hidden
        />
        <span className="font-mono text-[10.5px] text-muted">{current.project.name}</span>
        <RefChips refs={current.refs} />
      </div>
      <h2 className="max-w-[760px] text-[24px] leading-[1.25] font-semibold">
        {current.stop.title}
      </h2>
      {leadShown ? (
        <p className="max-w-[760px] text-[15px] leading-[1.55]" data-testid="tour-lead">
          {lead}
        </p>
      ) : null}
      {steps
        ? steps.map(({ def, stop }) => (
            <div
              key={`${def.key}:${stop.id}`}
              data-testid={`tour-step-${def.key}`}
              className="grid grid-cols-[110px_minmax(0,1fr)] gap-[14px]"
            >
              <StepLabel def={def} />
              <div className="flex min-w-0 flex-col gap-[8px]">
                {paragraphs(stop.narrative).map((paragraph, position) => (
                  <p key={position} className="text-[14px] leading-[1.55]">
                    {paragraph}
                  </p>
                ))}
                {(stop.evidence ?? []).map((evidence, position) => (
                  <Evidence
                    key={position}
                    evidence={evidence}
                    className="max-h-[340px] overflow-y-auto"
                  />
                ))}
                {stop.decision ? (
                  <StopDecision
                    key={stop.id}
                    itemId={current.work_item_id}
                    stopId={stop.id}
                    decision={stop.decision}
                  />
                ) : null}
              </div>
            </div>
          ))
        : bodyAfterLead(paras, lead).map((paragraph, position) => (
            <p key={position} className="max-w-[760px] text-[15px] leading-[1.55] text-ink-2">
              {paragraph}
            </p>
          ))}
      {!steps
        ? (current.stop.evidence ?? []).map((evidence, position) => (
            <Evidence
              key={position}
              evidence={evidence}
              className="max-h-[340px] overflow-y-auto"
            />
          ))
        : null}
      {!steps && current.stop.decision ? (
        <StopDecision
          key={current.stop.id}
          itemId={current.work_item_id}
          stopId={current.stop.id}
          decision={current.stop.decision}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-[8px] border-t border-line pt-[14px]">
        {fixHref ? (
          fixIsRemote ? (
            <a
              href={fixHref}
              target="_blank"
              rel="noreferrer"
              data-testid="tour-open-fix"
              className="ds-btn ds-btn--secondary"
            >
              Open the fix
            </a>
          ) : (
            <Link to={fixHref} data-testid="tour-open-fix" className="ds-btn ds-btn--secondary">
              Open the fix
            </Link>
          )
        ) : null}
        <Button data-testid="tour-ask" onClick={ask}>
          Ask about this
        </Button>
        <span className="ml-auto flex items-center gap-[6px] text-[12.5px] text-st-done-tag-fg">
          <span className="grid h-[15px] w-[15px] place-items-center rounded-[2px] border border-ink bg-ink font-mono text-[10px] font-bold text-line">
            ✓
          </span>
          <span className="text-muted">Marked seen when you move on</span>
        </span>
      </div>
    </article>
  ) : done ? (
    <div data-testid="tour-caught-up" className="flex flex-col items-start gap-[10px] pt-[40px]">
      <p className="text-[18px] font-semibold text-st-done-tag-fg">✓ You&apos;re caught up</p>
      <p className="text-[13px] text-faint">
        That was the whole tour. The assistant adds stops as new work lands.
      </p>
      <Button variant="primary" onClick={close}>
        Back to Catch up
      </Button>
    </div>
  ) : (
    <>
      {!failed ? (
        <p className="text-[13px] text-faint">
          {busy ? "Reading your tour…" : "Nothing to show yet — you may already be caught up."}
        </p>
      ) : null}
    </>
  );

  return (
    <div data-testid="tour-player" className="flex h-screen flex-col overflow-hidden bg-paper">
      <header className="flex flex-wrap items-center gap-[10px] border-b border-line-strong bg-surface px-[16px] py-[10px] md:px-[24px]">
        <button
          type="button"
          data-testid="tour-close"
          onClick={close}
          aria-label="Close the tour"
          className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[3px] border border-fill-edge text-ink hover:bg-fill"
        >
          <X size={14} aria-hidden />
        </button>
        <div className="min-w-0">
          <p className="text-[15px] font-semibold md:truncate">{heading}</p>
          <p className="truncate font-mono text-[10.5px] text-muted">{meta}</p>
        </div>
        <div
          data-testid="tour-progress"
          className="ml-[14px] hidden flex-1 items-center gap-[4px] md:flex md:max-w-[420px]"
          aria-hidden
        >
          {Array.from({ length: segCount }, (_, position) => {
            const dashed = moreAvailable && position === entries.length;
            const fill =
              position < currentIndex
                ? "bg-ink"
                : position === currentIndex
                  ? "bg-imp-must-fill"
                  : "bg-line";
            return (
              <span
                key={position}
                data-testid={`tour-progress-seg-${position}`}
                className={`h-[6px] flex-1 rounded-[1px] ${dashed ? "border border-dashed border-imp-routine-border" : fill}`}
              />
            );
          })}
        </div>
        <span className="ml-auto flex items-center gap-[8px]">
          <Button
            data-testid="tour-back"
            onClick={() => goTo(currentIndex - 1)}
            disabled={currentIndex <= 0}
          >
            ‹ Back
          </Button>
          <Button
            data-testid="tour-next"
            variant="primary"
            onClick={goNext}
            disabled={entries.length === 0}
          >
            Next stop ›
          </Button>
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[260px_minmax(0,1fr)]">
        <div className="hidden min-h-0 md:flex md:flex-col">{stopList}</div>
        <main className="min-h-0 min-w-0 overflow-y-auto">
          {segCount > 0 ? (
            <div className="flex items-center gap-[4px] px-[12px] pt-[8px] md:hidden" aria-hidden>
              {Array.from({ length: segCount }, (_, position) => (
                <span
                  key={position}
                  className={`h-[6px] flex-1 rounded-[1px] ${
                    moreAvailable && position === entries.length
                      ? "border border-dashed border-imp-routine-border"
                      : position < currentIndex
                        ? "bg-ink"
                        : position === currentIndex
                          ? "bg-imp-must-fill"
                          : "bg-line"
                  }`}
                />
              ))}
            </div>
          ) : null}
          {entries.length > 0 ? (
            /* Own container, own scrollbar: the strip slides, the PAGE never
             * gets a sideways scrollbar at 390. Titles wrap inside their chip. */
            <nav
              aria-label="Tour stops"
              className="min-w-0 overflow-x-auto overscroll-x-contain border-b border-line bg-surface md:hidden"
            >
              <div className="flex w-max items-stretch gap-[4px] px-[12px] py-[8px]">
                {entries.map((entry, position) => (
                  <button
                    key={`strip:${entry.work_item_id}:${entry.stop.id}`}
                    type="button"
                    data-testid={`tour-stop-strip-${position + 1}`}
                    onClick={() => goTo(position)}
                    className={`w-[168px] shrink-0 rounded-[2px] border px-[8px] py-[3px] text-left font-mono text-[10.5px] leading-[1.35] whitespace-normal break-words ${
                      position === currentIndex
                        ? "border-imp-look-border bg-imp-look-tag-bg"
                        : "border-line-strong bg-surface"
                    }`}
                  >
                    <span
                      className={
                        position === currentIndex
                          ? "font-semibold text-imp-look-tag-fg"
                          : "text-ink-2"
                      }
                    >
                      {position + 1}. {entry.stop.title}
                    </span>
                  </button>
                ))}
                {moreAvailable ? (
                  <button
                    type="button"
                    data-testid="tour-see-more-strip"
                    onClick={loadMore}
                    disabled={tour.isFetching}
                    className="w-[120px] shrink-0 rounded-[2px] border border-dashed border-imp-routine-border px-[8px] py-[3px] text-left font-mono text-[10.5px] leading-[1.35] text-accent disabled:text-muted"
                  >
                    + See more
                  </button>
                ) : null}
              </div>
            </nav>
          ) : null}
          <div
            data-testid="tour-current"
            className="mx-auto flex w-full max-w-[980px] flex-col gap-[16px] px-[20px] py-[20px] md:px-[34px]"
          >
            {tour.isError && itemIdParam.length === 0 ? (
              <ProblemBanner
                error={tour.error}
                subject="your catch-up tour"
                fallback="Your catch-up tour did not load."
                testid="tour-error"
                retry={{ onClick: () => void tour.refetch(), pending: tour.isFetching }}
              />
            ) : null}
            {piece.isError && itemIdParam.length > 0 ? (
              <ProblemBanner
                error={piece.error}
                subject="this piece of work"
                fallback="This piece of work did not load."
                testid="tour-error"
                retry={{ onClick: () => void piece.refetch(), pending: piece.isFetching }}
              />
            ) : null}
            {currentBody}
          </div>
        </main>
      </div>
    </div>
  );
}
