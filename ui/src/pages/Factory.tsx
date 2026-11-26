/**
 * Factory — the index of the org's (or one project's) workflows, redesign R4.
 *
 * The Factory replaces the Workflows index at `/factory` and
 * `/p/:projectId/factory` (docs/design/redesign/CONTRACT.md "Routes and
 * scope"). It is a glance, not a library: what is running, what is waiting on
 * you, how each workflow starts, and one button that opens the New workflow
 * sheet. The filtering the old index carries (search, folders, chips) lives
 * nowhere here by design; the editor owns the detail.
 *
 * The header's summary is a count of the same reads the cards are built from
 * (`useFactoryWorkflows` → `useBoardRuns`), so a card and the headline can
 * never disagree: a zero part is left out, and a quiet Factory says so.
 */
import { useState } from "react";
import { useParams } from "react-router";
import { IconPlus } from "@tabler/icons-react";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { WorkflowCard } from "../components/factory/WorkflowCard";
import { NewWorkflowSheet } from "../components/factory/NewWorkflowSheet";
import { useFactoryWorkflows } from "../components/factory/factoryData";
import type { FactoryWorkflowItem } from "../components/factory/factoryData";
import { useScope } from "../lib/scope";

/** One clause of the headline: an optional state glyph and its words. */
export interface SummaryPart {
  /** The state glyph (`●` / `!`), or "" for the workflow count. */
  glyph: string;
  text: string;
  /** Token class for the glyph; status is never colour alone, so the glyph and
   * the word always travel together. */
  glyphClass?: string;
}

/**
 * The headline sentence from real counts: `● 2 running · ! 1 waiting on you ·
 * 5 workflows`. A zero clause is dropped; with nothing live the line reads
 * `{k} workflows · nothing running`.
 */
export function factorySummaryParts(
  items: FactoryWorkflowItem[],
  liveRuns: { status: string }[],
): SummaryPart[] {
  const running = liveRuns.filter(
    (run) => run.status !== "waiting_human" && run.status !== "paused",
  );
  const waiting = liveRuns.filter(
    (run) => run.status === "waiting_human" || run.status === "paused",
  );
  const parts: SummaryPart[] = [];
  const workflowClause = `${items.length} ${items.length === 1 ? "workflow" : "workflows"}`;
  if (running.length > 0) {
    parts.push({
      glyph: "●",
      text: `${running.length} running`,
      glyphClass: "text-st-running-tag-fg",
    });
  }
  if (waiting.length > 0) {
    parts.push({
      glyph: "!",
      text: `${waiting.length} waiting on you`,
      glyphClass: "text-st-waiting-tag-fg",
    });
  }
  if (parts.length === 0) {
    parts.push({ glyph: "", text: `${workflowClause} · nothing running` });
    return parts;
  }
  parts.push({ glyph: "", text: workflowClause });
  return parts;
}

/** The same sentence as plain text (tests, and anything that needs one string). */
export function factorySummaryText(
  items: FactoryWorkflowItem[],
  liveRuns: { status: string }[],
): string {
  return factorySummaryParts(items, liveRuns)
    .map((part) => `${part.glyph === "" ? "" : `${part.glyph} `}${part.text}`)
    .join(" · ");
}

export default function Factory() {
  // The scope is the URL prefix: `/p/:projectId/factory`, or All projects.
  // `useScope` is a hook and so runs on every render, whatever the params say.
  const { projectId } = useParams<{ projectId?: string }>();
  const scopeFromPath = useScope();
  const scope = projectId ?? scopeFromPath;
  const { items, liveRuns, isPending, error, rowsIncomplete } = useFactoryWorkflows(scope);
  const [sheetOpen, setSheetOpen] = useState(false);

  const loading = items.length === 0 && isPending;
  const empty = !loading && error === null && items.length === 0;

  return (
    <div data-testid="factory-index" className="min-h-full bg-surface">
      <div className="mx-auto flex max-w-[1180px] flex-col px-[36px] pt-[28px] pb-[48px] max-md:px-[16px] max-md:pt-[20px]">
        <div className="flex flex-wrap items-center gap-[14px]">
          <div className="flex min-w-0 flex-col gap-[4px]">
            <h2 className="m-0 text-[24px] leading-[28px] font-bold">Factory</h2>
            <p
              className="m-0 text-[13.5px] text-muted"
              data-testid="factory-summary"
              aria-live="polite"
            >
              {loading ? "reading the factory floor…" : factorySummaryText(items, liveRuns)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            data-testid="factory-new"
            className="ml-auto flex h-[34px] shrink-0 items-center gap-[6px] rounded-[8px] bg-accent px-[14px] text-[13px] font-semibold text-white hover:bg-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <IconPlus size={15} stroke={1.5} aria-hidden />
            New workflow
          </button>
        </div>

        {error ? (
          <div className="mt-[22px]">
            <ProblemBanner
              error={error}
              fallback="The workflows could not be read."
              subject="the factory floor"
              hint="Nothing is listed, because the reads did not come back."
              testid="factory-load-error"
            />
          </div>
        ) : null}
        {loading ? (
          <div className="mt-[22px]">
            <Spinner label="Reading the workflows" />
          </div>
        ) : null}
        {/* A row whose own read failed keeps its card and loses its detail, so
            the page says that in one line rather than presenting a thinner
            strip as the whole workflow. Only a failed LIST read is the banner. */}
        {rowsIncomplete && !error ? (
          <p
            className="mt-[10px] mb-0 text-[12.5px] text-st-waiting-tag-fg"
            data-testid="factory-rows-incomplete"
          >
            Some cards could not be read in full, so those strips show less than the workflow does.
          </p>
        ) : null}

        {empty ? (
          <p className="mt-[22px] mb-0 text-[13.5px] text-muted" data-testid="factory-empty">
            No workflows yet. Describe one and it gets sketched on the canvas.
          </p>
        ) : null}

        <div className="mt-[22px] grid grid-cols-1 gap-[20px] min-[900px]:grid-cols-2">
          {items.map((item) => (
            <WorkflowCard key={item.pipeline.id} item={item} scope={scope} />
          ))}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            data-testid="factory-new-card"
            className="flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-[8px] rounded-[12px] border-[1.5px] border-dashed border-line-strong text-[13.5px] font-semibold text-muted hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <IconPlus size={20} stroke={1.5} aria-hidden />
            New workflow
          </button>
        </div>
      </div>

      {sheetOpen ? (
        <NewWorkflowSheet
          scope={scope}
          workflows={items.map((item) => item.pipeline)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}
