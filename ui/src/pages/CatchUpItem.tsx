/**
 * Piece of work (design 8b, ADR-0078) — one issue/PR/push, the shared tour
 * every project member sees, and this reader's debt against it.
 *
 * Three columns over one read: the tour's stops on the left (new beats the
 * story grew since THIS reader last looked lead the list, tagged ADDED, with
 * the carried-over beats under a collapsed "Earlier stops" group), the
 * current stop's narrative and evidence in the middle with Back / Next, and
 * the tour's version history on the right beside the slot this item holds in
 * the reader's own catch-up tour.
 *
 * Viewing a stop marks it seen when you move on — Next, Back or clicking
 * another beat. A stop's decision, if it carries one, is answered right here
 * (StopDecision), never through the workflow-gate DecisionBar.
 *
 * The route is `/catch-up/:workId`; wiring it into the router is a later
 * task. `?stop=` selects the opened beat.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Check, Copy, Play } from "lucide-react";
import Page, { PAGE_BAND_PAD } from "../components/ds/Page";
import { Panel } from "../components/ds/Panel";
import { Button } from "../components/ds/Button";
import { ProblemBanner } from "../components/Feedback";
import { Evidence } from "../components/catchup/Evidence";
import { RefChips } from "../components/catchup/RefChips";
import { StopDecision } from "../components/catchup/StopDecision";
import {
  IMPORTANCE,
  clockOf,
  projectColor,
  projectSquareClasses,
  type ImportanceStyle,
} from "../components/catchup/importance";
import {
  useCatchUpItem,
  useCatchUpTour,
  useMarkStopsSeen,
  type CatchUpImportance,
  type CatchUpStop,
} from "../api/catchup";

/** must_know outranks worth_a_look outranks routine; the tag shows the worst
 * importance any beat of the story carries. */
const IMPORTANCE_RANK: Record<CatchUpImportance, number> = {
  must_know: 0,
  worth_a_look: 1,
  routine: 2,
};

function worstImportance(stops: CatchUpStop[]): CatchUpImportance | null {
  let worst: CatchUpImportance | null = null;
  for (const stop of stops) {
    if (worst === null || IMPORTANCE_RANK[stop.importance] < IMPORTANCE_RANK[worst]) {
      worst = stop.importance;
    }
  }
  return worst;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** The seen-by roster: initials squares in the sidebar avatar's style. */
function SeenByAvatars({ names }: { names: string[] }) {
  return (
    <span className="flex items-center gap-[4px]" aria-hidden>
      {names.map((name) => (
        <span
          key={name}
          className="grid h-[20px] w-[20px] place-items-center rounded-[3px] border border-ink bg-surface font-mono text-[10px] text-ink"
        >
          {(
            name
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "?"
          ).slice(0, 2)}
        </span>
      ))}
    </span>
  );
}

function StopRow({
  stop,
  number,
  selected,
  addedAt,
  onSelect,
}: {
  stop: CatchUpStop;
  number: number;
  selected: boolean;
  /** Wall clock of the tour version that introduced this beat, when it is
   * newer than what the reader saw; null for a carried-over beat. */
  addedAt: string | null;
  onSelect: () => void;
}) {
  const importance = IMPORTANCE[stop.importance] ?? IMPORTANCE.routine;
  return (
    <button
      type="button"
      data-testid={`catchup-item-stop-${stop.id}`}
      onClick={onSelect}
      className={`flex w-full items-start gap-[7px] border-b border-line px-[10px] py-[8px] text-left last:border-b-0 ${
        selected ? "bg-fill" : "hover:bg-line-soft"
      }`}
    >
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[2px] border border-ink bg-surface font-mono text-[10px] font-semibold">
        {number}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-[1.35] font-semibold text-ink">
          {stop.title}
        </span>
        <span className="mt-[2px] flex flex-wrap items-center gap-[6px]">
          {stop.kind ? (
            <span className="font-mono text-[9.5px] font-semibold tracking-[.03em] text-muted uppercase">
              {stop.kind}
            </span>
          ) : null}
          {addedAt ? (
            <span className="rounded-tag bg-imp-look-tag-bg px-[5px] py-[1px] font-mono text-[9.5px] font-semibold text-imp-look-tag-fg">
              ADDED {addedAt}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-[5px] pt-[2px]">
        <span
          title={importance.label}
          aria-label={importance.label}
          className={`inline-block h-[8px] w-[8px] rounded-full border ${
            stop.importance === "must_know"
              ? "border-imp-must-border bg-imp-must-fill"
              : stop.importance === "worth_a_look"
                ? "border-imp-look-border bg-imp-look-fill"
                : "border-imp-routine-border bg-imp-routine-fill"
          }`}
        />
        {stop.seen ? <Check size={13} aria-label="seen" className="text-st-done-tag-fg" /> : null}
      </span>
    </button>
  );
}

export default function CatchUpItem() {
  const { workId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const item = useCatchUpItem(workId);
  const tour = useCatchUpTour();
  const markStopsSeen = useMarkStopsSeen();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [copied, setCopied] = useState(false);

  const data = item.data;
  const stops = useMemo(() => data?.latest?.stops ?? [], [data]);
  const latestVersion = data?.latest?.version ?? 0;
  const youSaw = data?.you_saw_version ?? null;
  const updated = youSaw != null && latestVersion > 0 && youSaw < latestVersion;

  /** The order the left list shows: beats newer than what this reader saw
   * first (the story moved), carried-over beats collapsed below. */
  const { newStops, earlierStops } = useMemo(() => {
    if (!updated) return { newStops: stops, earlierStops: [] as CatchUpStop[] };
    return {
      newStops: stops.filter((stop) => stop.added_in_version > (youSaw ?? 0)),
      earlierStops: stops.filter((stop) => stop.added_in_version <= (youSaw ?? 0)),
    };
  }, [updated, stops, youSaw]);
  const navStops = [...newStops, ...earlierStops];

  const stopParam = params.get("stop");
  const current =
    stops.find((stop) => stop.id === (pickedId ?? stopParam)) ??
    navStops.find((stop) => !stop.seen) ??
    navStops[0] ??
    null;
  const currentIndex = current ? navStops.indexOf(current) : -1;

  /** Created-clock of the version that first introduced a beat — the ADDED
   * stamp the mock shows as "ADDED 12:40". */
  const addedClock = (stop: CatchUpStop): string | null => {
    if (!updated || !data) return null;
    if (stop.added_in_version <= (youSaw ?? 0)) return null;
    const header = data.history.find((version) => version.version === stop.added_in_version);
    return clockOf(header?.created_at ?? data.latest?.created_at);
  };

  const openStop = (stop: CatchUpStop | null) => {
    if (!stop || !data || (current && stop.id === current.id)) return;
    // Moving off a stop pays THIS reader's debt for the stop left behind —
    // and only that stop (design: "viewing a stop marks it seen when you
    // move on"; the whole-item mark is the rest list's checkbox).
    if (current && !current.seen) {
      markStopsSeen.mutate({
        itemId: data.id,
        version: latestVersion,
        stopIds: [current.id],
      });
    }
    setPickedId(stop.id);
    setParams({ stop: stop.id }, { replace: true });
  };

  const earlierExpanded = showEarlier || (current != null && earlierStops.includes(current));

  const goPrev = () => openStop(navStops[Math.max(currentIndex - 1, 0)] ?? null);
  const goNext = () => openStop(navStops[Math.min(currentIndex + 1, navStops.length - 1)] ?? null);

  const copyLink = () => {
    const url = `${window.location.origin}/catch-up/${workId}`;
    void navigator.clipboard.writeText(url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const seenNames = (data?.seen_by ?? []).map((reader) => firstName(reader.name));
  const tourSlot = tour.data
    ? tour.data.stops.findIndex((entry) => entry.work_item_id === workId)
    : -1;

  if (item.isError) {
    return (
      <Page layout="wide" testid="catchup-item">
        <div className={PAGE_BAND_PAD}>
          <ProblemBanner
            error={item.error}
            subject="this piece of work"
            fallback="This piece of work did not load."
            testid="catchup-item-error"
            retry={{ onClick: () => void item.refetch(), pending: item.isFetching }}
          />
        </div>
      </Page>
    );
  }

  if (!data) {
    return (
      <Page layout="wide" testid="catchup-item">
        <p className={`${PAGE_BAND_PAD} text-[13px] text-faint`}>
          {item.isPending ? "Reading this piece of work…" : "Nothing to show yet."}
        </p>
      </Page>
    );
  }

  const importance: ImportanceStyle | null =
    stops.length > 0 && worstImportance(stops) ? IMPORTANCE[worstImportance(stops)!] : null;
  const firstKind = stops[0]?.kind;
  const updateClock = clockOf(data.latest?.created_at);
  const seenLine =
    data.seen_by.length === 0
      ? "nobody has seen this yet"
      : updated && updateClock
        ? `seen by ${seenNames.join(", ")} · you have not seen the ${updateClock} update`
        : `seen by ${seenNames.join(", ")} · you're up to date`;

  return (
    <Page layout="wide" testid="catchup-item">
      <div className="flex flex-col gap-[16px]">
        <header className={`${PAGE_BAND_PAD} pb-0`}>
          <div className="flex items-center gap-[6px] font-mono text-[11px] text-muted">
            <span
              className={projectSquareClasses()}
              style={{ background: projectColor(data.project.color) }}
              aria-hidden
            />
            <span className="text-ink-2">{data.project.name}</span>
            <span aria-hidden>/</span>
            <span>Catch up</span>
          </div>
          <div className="mt-[8px] flex flex-wrap items-center gap-[8px]">
            {importance ? (
              <span
                className={`inline-flex h-[18px] items-center rounded-panel px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase ${importance.tagBg} ${importance.tagFg}`}
              >
                {importance.label}
              </span>
            ) : null}
            {firstKind ? (
              <span className="inline-flex h-[18px] items-center rounded-panel border border-ink px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase">
                {firstKind}
              </span>
            ) : null}
            <RefChips refs={data.refs} />
          </div>
          <h1 className="mt-[6px] text-[22px] leading-[28px] font-semibold">{data.title}</h1>
          <div className="mt-[6px] flex flex-wrap items-center gap-[8px]">
            <SeenByAvatars names={(data.seen_by ?? []).map((reader) => reader.name)} />
            <span className="font-mono text-[11px] text-muted">{seenLine}</span>
          </div>
          <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
            <Button data-testid="catchup-item-copy" onClick={copyLink}>
              <Copy size={13} aria-hidden />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Link
              to={`/catch-up/tour?item=${encodeURIComponent(data.id)}`}
              data-testid="catchup-item-play"
              className="ds-btn ds-btn--primary"
            >
              <Play size={13} aria-hidden />
              Play tour · {stops.length} {stops.length === 1 ? "stop" : "stops"}
            </Link>
          </div>
        </header>

        <div className="flex flex-col gap-[14px] px-[22px] pb-[24px] md:grid md:grid-cols-[260px_minmax(0,1fr)_260px] md:items-start md:gap-[12px] md:px-[28px]">
          {/* Left: this work's shared tour. */}
          <div className="hidden min-w-0 md:block">
            <Panel title="THIS WORK'S TOUR" meta="shared with the project">
              {stops.length === 0 ? (
                <p className="px-[10px] py-[10px] text-[12.5px] text-faint">
                  This work has no tour yet — the assistant writes one when a run finishes.
                </p>
              ) : (
                <>
                  {updated ? (
                    <p className="border-b border-line px-[10px] py-[6px] font-mono text-[10px] font-semibold tracking-[.03em]">
                      <span className="rounded-tag bg-imp-look-tag-bg px-[5px] py-[1px] text-imp-look-tag-fg">
                        UPDATED
                      </span>{" "}
                      <span className="text-muted">
                        {newStops.length} new {newStops.length === 1 ? "stop" : "stops"} since v
                        {youSaw}
                      </span>
                    </p>
                  ) : null}
                  {newStops.map((stop) => (
                    <StopRow
                      key={stop.id}
                      stop={stop}
                      number={stops.indexOf(stop) + 1}
                      selected={current?.id === stop.id}
                      addedAt={addedClock(stop)}
                      onSelect={() => openStop(stop)}
                    />
                  ))}
                  {earlierStops.length > 0 ? (
                    <>
                      <button
                        type="button"
                        data-testid="catchup-item-earlier-toggle"
                        onClick={() => setShowEarlier((prev) => !prev)}
                        className="flex w-full items-center gap-[6px] border-b border-line bg-fill px-[10px] py-[5px] font-mono text-[9.5px] font-semibold tracking-[.04em] text-ink-2 uppercase"
                      >
                        {earlierExpanded ? "▾" : "▸"} Earlier stops ({earlierStops.length})
                      </button>
                      {earlierExpanded
                        ? earlierStops.map((stop) => (
                            <StopRow
                              key={stop.id}
                              stop={stop}
                              number={stops.indexOf(stop) + 1}
                              selected={current?.id === stop.id}
                              addedAt={addedClock(stop)}
                              onSelect={() => openStop(stop)}
                            />
                          ))
                        : null}
                    </>
                  ) : null}
                </>
              )}
            </Panel>
          </div>

          {/* Mobile: the same pick as a strip. */}
          <div className="md:hidden">
            <label className="mb-[4px] block font-mono text-[9.5px] font-semibold tracking-[.04em] text-muted uppercase">
              This work&apos;s tour
            </label>
            <select
              data-testid="catchup-item-stop-select"
              value={current?.id ?? ""}
              onChange={(event) => {
                const stop = stops.find((candidate) => candidate.id === event.target.value);
                openStop(stop ?? null);
              }}
              className="h-[30px] w-full rounded-panel border border-line-strong bg-surface px-[8px] font-ui text-[13px] text-ink"
            >
              {stops.map((stop, index) => (
                <option key={stop.id} value={stop.id}>
                  {index + 1}. {stop.title}
                </option>
              ))}
            </select>
          </div>

          {/* Center: the current stop. */}
          <div data-testid="catchup-item-current" className="min-w-0">
            {current ? (
              <article className="flex flex-col gap-[10px]">
                <p className="font-mono text-[10.5px] font-semibold tracking-[.04em] text-muted uppercase">
                  Stop {stops.indexOf(current) + 1} of {stops.length}
                </p>
                {current.kind ? (
                  <span className="inline-flex h-[18px] items-center self-start rounded-panel border border-ink px-[6px] font-mono text-[9.5px] font-semibold tracking-[.03em] uppercase">
                    {current.kind}
                  </span>
                ) : null}
                <h2 className="text-[17px] leading-[1.3] font-semibold">{current.title}</h2>
                <p className="text-[14px] leading-[1.55] text-ink-2">{current.narrative}</p>
                {(current.evidence ?? []).map((evidence, index) => (
                  <Evidence
                    key={index}
                    evidence={evidence}
                    className="max-h-[340px] overflow-y-auto"
                  />
                ))}
                {current.decision ? (
                  <StopDecision
                    key={current.id}
                    itemId={data.id}
                    stopId={current.id}
                    decision={current.decision}
                  />
                ) : null}
                <div className="flex items-center gap-[8px] pt-[4px]">
                  <Button
                    data-testid="catchup-item-back"
                    onClick={goPrev}
                    disabled={currentIndex <= 0}
                  >
                    ‹ Back
                  </Button>
                  <Button
                    data-testid="catchup-item-next"
                    variant="primary"
                    onClick={goNext}
                    disabled={currentIndex >= navStops.length - 1}
                  >
                    Next stop ›
                  </Button>
                  <span className="ml-auto font-mono text-[10.5px] text-faint">
                    Marked seen when you move on
                  </span>
                </div>
              </article>
            ) : (
              <p className="text-[13px] text-faint">
                This work has no tour yet — the assistant writes one when a run finishes.
              </p>
            )}
          </div>

          {/* Right: how the story was rewritten, and its slot in your tour. */}
          <div className="flex min-w-0 flex-col gap-[12px]">
            <div data-testid="catchup-item-history">
              <Panel title="TOUR HISTORY">
                <ul>
                  {[...(data.history ?? [])].reverse().map((header) => (
                    <li
                      key={header.version}
                      className="flex flex-col gap-[1px] border-b border-line px-[10px] py-[7px] last:border-b-0"
                    >
                      <span className="text-[12.5px] leading-[1.35] font-semibold text-ink">
                        {header.reason}
                      </span>
                      <span className="font-mono text-[10.5px] text-muted">
                        {clockOf(header.created_at) ?? "—"} · v{header.version} ·{" "}
                        {header.stop_count} {header.stop_count === 1 ? "stop" : "stops"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
            {tourSlot >= 0 && tour.data ? (
              <Panel title="IN YOUR CATCH-UP TOUR AS">
                <p className="px-[10px] py-[8px] text-[12.5px] leading-[1.45] text-ink-2">
                  Stop {tourSlot + 1} of {tour.data.stops.length}.
                </p>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </Page>
  );
}
