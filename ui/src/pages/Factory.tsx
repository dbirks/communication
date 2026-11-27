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
import { Fragment, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { IconPlus } from "@tabler/icons-react";
import { useDuplicatePipeline } from "../api/pipelines";
import { queryKeys, useMe, useProject, useProjects } from "../api/queries";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { RecentRuns } from "../components/factory/RecentRuns";
import { WorkflowCard } from "../components/factory/WorkflowCard";
import { NewWorkflowSheet } from "../components/factory/NewWorkflowSheet";
import { useFactoryWorkflows } from "../components/factory/factoryData";
import type { FactoryWorkflowItem } from "../components/factory/factoryData";
import { ProjectWorkflowsPanel } from "../components/project/workflows/ProjectWorkflowsPanel";
import { TriggersDialog } from "../components/workflows/TriggersDialog";
import { UseInRepoDialog } from "../components/workflows/UseInRepoDialog";
import { hasLibraryRole } from "../lib/pipeline/authoring";
import { routes } from "../lib/routes";
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

/**
 * The headline sentence as nodes, so a state glyph can carry its state colour
 * while the words stay the sentence `factorySummaryText` returns — the rendered
 * text and that string are the same thing, which is what the tests assert.
 */
export function factorySummaryNodes(items: FactoryWorkflowItem[], liveRuns: { status: string }[]) {
  return factorySummaryParts(items, liveRuns).map((part, index) => (
    <Fragment key={`${part.text}-${index}`}>
      {index > 0 ? " · " : ""}
      {part.glyph === "" ? null : (
        <span className={`font-mono ${part.glyphClass ?? ""}`}>{`${part.glyph} `}</span>
      )}
      {part.text}
    </Fragment>
  ));
}

export default function Factory() {
  // The scope is the URL prefix: `/p/:projectId/factory`, or All projects.
  // `useScope` is a hook and so runs on every render, whatever the params say.
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scopeFromPath = useScope();
  const scope = projectId ?? scopeFromPath;
  const me = useMe();
  const canAuthor = hasLibraryRole(me.data);
  const projectQuery = useProject(scope ?? "");
  const projects = useProjects();
  const { items, liveRuns, isPending, error, rowsIncomplete } = useFactoryWorkflows(scope);
  const duplicate = useDuplicatePipeline(items.map((item) => item.pipeline.slug));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [triggersItem, setTriggersItem] = useState<FactoryWorkflowItem | null>(null);
  const [useItem, setUseItem] = useState<FactoryWorkflowItem | null>(null);

  const scopedProject = scope
    ? (projectQuery.data ?? projects.data?.items.find((p) => p.id === scope) ?? null)
    : null;

  const loading = items.length === 0 && isPending;
  const empty = !loading && error === null && items.length === 0;

  return (
    <div data-testid="factory-index" className="min-h-full bg-surface">
      <div className="mx-auto flex max-w-[1180px] flex-col px-[36px] pt-[28px] pb-[48px] max-md:px-[16px] max-md:pt-[20px]">
        <div className="flex flex-wrap items-center gap-[14px]">
          {/* The live summary rides the heading's baseline, to its right — the
              prototype's header row, not a second line under it
              (review 07-1280-4). */}
          <h2 className="m-0 text-[24px] leading-[28px] font-bold">Factory</h2>
          <p
            className="self-center text-[13.5px] text-ink-2"
            data-testid="factory-summary"
            aria-live="polite"
          >
            {loading ? "reading the factory floor…" : factorySummaryNodes(items, liveRuns)}
          </p>
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
            <WorkflowCard
              key={item.pipeline.id}
              item={item}
              scope={scope}
              canAuthor={canAuthor}
              duplicating={duplicate.isPending && duplicate.variables === item.pipeline.id}
              onOpenTriggers={() => setTriggersItem(item)}
              onUseInProject={() => setUseItem(item)}
              onDuplicate={() =>
                duplicate.mutate(item.pipeline.id, {
                  onSuccess: ({ pipeline: created, draft }) =>
                    navigate(routes.factoryWorkflow(created.id, scope, { draft: draft.id })),
                })
              }
            />
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

        {duplicate.isError ? (
          <div className="mt-[12px]">
            <FormError error={duplicate.error} testid="factory-duplicate-error" />
          </div>
        ) : null}

        {scope && scopedProject ? (
          <section
            aria-labelledby="factory-schedules-heading"
            data-testid="project-pipelines"
            className="mt-[32px] space-y-[10px]"
          >
            <h3
              id="factory-schedules-heading"
              className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted"
            >
              SCHEDULES AND TRIGGERS HERE
            </h3>
            <div className="[&>section]:rounded-[12px] [&>section]:border-line [&>section>[data-ds-bar]]:border-line-soft [&>section>[data-ds-bar]]:bg-rail [&>section>[data-ds-bar]]:px-[14px] [&>section>[data-ds-bar]]:py-[8px]">
              <ProjectWorkflowsPanel projectId={scope} project={scopedProject} />
            </div>
          </section>
        ) : null}

        {/* There is no Runs tab any more, so the way back to a past run lives
            here: the scope's newest runs, under the cards (and under the
            project's schedules, when the page shows them). Same board read the
            cards are built from, so it costs no request. */}
        <RecentRuns scope={scope} />
      </div>

      <TriggersDialog
        open={triggersItem !== null}
        onClose={() => setTriggersItem(null)}
        assignments={(triggersItem?.triggerGroups ?? []).filter((g) => g.canManage)}
        editing={null}
      />

      <UseInRepoDialog
        open={useItem !== null}
        onClose={() => setUseItem(null)}
        pipelineId={useItem?.pipeline.id ?? ""}
        workflowName={useItem ? useItem.pipeline.display_name || useItem.pipeline.slug : ""}
        newestPublished={useItem?.newestPublished ?? null}
        revisions={useItem?.revisions ?? []}
        initialProjectId={scope ?? undefined}
        onAssigned={() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
          // The dialog may have assigned into any project (All scope has no
          // project of its own), so every project's assignment list is stale.
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey.includes("assignments"),
          });
        }}
      />

      {sheetOpen ? (
        <NewWorkflowSheet
          scope={scope}
          scopeName={scope === null ? "All projects" : (scopedProject?.name ?? "")}
          workflows={items.map((item) => item.pipeline)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}
