/**
 * SinceYouLeft — the redesigned Home's "SINCE YOU LEFT" section (handoff
 * README §2): the catch-up stories, now a section of Home instead of the
 * old `/catch-up` page.
 *
 * Same reads, same rules as `pages/CatchUp.tsx`: the item list is
 * `useCatchUpItems` on the default "unseen" window (filtered to one project
 * when `projectId` is given), the brief headline (ADR-0081) prints above the
 * rows when the model wrote one, and opening the section stamps the visit
 * exactly once, fire-and-forget — the moment and the arguments are
 * CatchUp's.
 *
 * The rows show the important items (the ones `components/catchup/
 * importance.ts` ranks above `routine`); the routine ones wait behind one
 * muted "+ N routine updates" line that expands them in place. Each row is
 * the same 3-column grid the prototype draws — 70px mono project name in
 * accent-text, the story (title + one-line summary), the age right-aligned
 * in mono — and links to the item's own catch-up page, the href CatchUp's
 * list rows build.
 *
 * When the window holds nothing the section is exactly ONE plain sentence
 * (CONTRACT.md "Home": data blocks print one sentence when empty): scoped to
 * the whole workspace it reads "Nothing new since you left.", scoped to one
 * project it names that project. A brief headline is never printed beside an
 * empty list — with zero items it only restates the quiet, so the sentence
 * below says all there is to say.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ColumnHeading } from "./SectionLabel";
import { useCatchUpBrief, useCatchUpItems, useRecordVisit } from "../../api/catchup";
import type { CatchUpListItem } from "../../api/catchup";
import { useProject } from "../../api/queries";
import { formatAge } from "../../lib/format";

export interface SinceYouLeftProps {
  /** Filter the stories to one project (the project home). Absent = all. */
  projectId?: string;
  /** The project's name for the empty sentence; the project home already has it. */
  projectName?: string;
}

/** The one sentence an empty window prints, named for its scope. */
export function emptySentence(projectId: string | undefined, projectName: string | undefined) {
  if (projectId && projectName) return `Nothing new in ${projectName} since you left.`;
  return "Nothing new since you left.";
}

function SinceRow({ item }: { item: CatchUpListItem }) {
  return (
    <Link
      to={`/catch-up/${item.id}`}
      data-testid={`since-row-${item.id}`}
      className="grid grid-cols-[70px_minmax(0,1fr)_auto] items-baseline gap-x-[12px] border-b border-line-soft py-[10px] focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="truncate font-mono text-[11.5px] text-accent-text" title={item.project.name}>
        {item.project.name}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-ink" title={item.title}>
          {item.title}
        </span>
        <span className="block truncate text-[13.5px] text-ink-2" title={item.summary}>
          {item.summary}
        </span>
      </span>
      <span className="text-right font-mono text-[11px] text-muted">
        {formatAge(item.updated_at)}
      </span>
    </Link>
  );
}

export function SinceYouLeft({ projectId, projectName }: SinceYouLeftProps) {
  const projectFilter = projectId ? [projectId] : [];
  /* The caller normally hands the name down (the project home has the read);
   * the query is the fallback for a caller that cannot, and stays disabled
   * in the all-projects scope. */
  const project = useProject(projectId && !projectName ? projectId : "");
  const items = useCatchUpItems({ projects: projectFilter, window: "unseen" });
  const brief = useCatchUpBrief("unseen", projectFilter);
  const recordVisit = useRecordVisit();
  const [showRoutine, setShowRoutine] = useState(false);

  /* The visit stamp drives the window the server resolves "unseen" against;
   * record it once on open and never let a failed stamp break the page
   * (CatchUp.tsx's behaviour, same moment, same arguments). */
  const visitRecorded = useRef(false);
  useEffect(() => {
    if (visitRecorded.current) return;
    visitRecorded.current = true;
    recordVisit.mutateAsync().catch(() => undefined);
  }, [recordVisit]);

  const list = items.data?.items ?? [];
  const important = list.filter((item) => item.importance !== "routine");
  const routine = list.filter((item) => item.importance === "routine");
  const readyHeadline =
    brief.data?.headline && brief.data.headline.state === "ready" && brief.data.headline.text
      ? brief.data.headline.text
      : null;
  // Zero items: the headline would only repeat "it was quiet", so the single
  // empty sentence below is all the section prints.
  const headline = list.length > 0 ? readyHeadline : null;

  return (
    <section data-testid="since-you-left" className="min-w-0">
      <ColumnHeading testid="since-you-left-label">Since you left</ColumnHeading>
      {headline ? (
        <p
          data-testid="since-you-left-headline"
          className="pb-[8px] text-[15px] leading-[22px] text-ink-2"
        >
          {headline}
        </p>
      ) : null}
      {items.isPending ? (
        <p className="py-[10px] text-[13px] text-faint">Reading your updates…</p>
      ) : null}
      {items.isSuccess && list.length === 0 ? (
        <p data-testid="since-you-left-empty" className="py-[10px] text-[13.5px] text-muted">
          {emptySentence(projectId, projectName ?? project.data?.name)}
        </p>
      ) : null}
      {important.map((item) => (
        <SinceRow key={item.id} item={item} />
      ))}
      {showRoutine ? (
        routine.map((item) => <SinceRow key={item.id} item={item} />)
      ) : routine.length > 0 ? (
        <button
          type="button"
          data-testid="since-you-left-routine"
          onClick={() => setShowRoutine(true)}
          className="block w-full py-[12px] text-left text-[12.5px] text-muted focus-visible:outline-2 focus-visible:outline-accent"
        >
          + {routine.length} routine update{routine.length === 1 ? "" : "s"}
        </button>
      ) : null}
    </section>
  );
}

export default SinceYouLeft;
