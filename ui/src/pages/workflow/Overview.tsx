/**
 * Overview (design 1e): the graph first — a full-bleed dotted canvas of solid
 * white step cards laid out TOP-TO-BOTTOM — with the full-height right rail
 * (1px left border, design width 285px, 16px padding) that answers the four
 * questions of a library template: is there a draft, where is it used, what
 * inputs does it take, and how did recent runs go. Below 1024px the rail
 * stacks under the canvas.
 *
 * Everything here reads the same fan-out as the Used-in tab
 * (`useUsedIn`) and the one pipeline-scoped runs list
 * (`GET /api/v1/runs?pipeline_id=`, ADR-0047/0060) — no second source, and no
 * block pretends to know what a failed read did not return.
 */
import { Link } from "react-router";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { LastRunCell, TriggerSentences } from "../../components/workflows/UsedIn";
import type { UsedInGroup } from "./useUsedIn";
import type { CrossProjectRunList } from "../../api/board";
import type { PipelineRevision } from "../../api/types";
import type { PipelineDraftSummary } from "../../lib/pipeline/contract";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import type { UseQueryResult } from "@tanstack/react-query";
import { GraphCanvas } from "./GraphCanvas";

export interface OverviewProps {
  pipelineId: string;
  /** The newest revision (server order) — the one the graph and caption name. */
  revision: PipelineRevision | undefined;
  revisionLoading: boolean;
  revisionError: unknown;
  groups: UsedInGroup[];
  usedInLoading: boolean;
  /** The pipeline-scoped runs read (newest first, the server's own order). */
  runs: Pick<UseQueryResult<CrossProjectRunList>, "isPending" | "isError" | "data">;
  openDraft: PipelineDraftSummary | null;
  /** `edited_by` → a display name (actors directory), never a raw id. */
  actorName: (userId: string) => string;
  /** Opens the `Use in a repo…` dialog (the rail's assign shortcut). */
  onAssign: () => void;
}

/** The rail's INPUTS block: `spec.inputs` is a JSON Schema object (13
 * decisions table row 7) — name + description (or type) per property, in the
 * document's own declared order. `null` says the shape is not that object. */
export function describeInputs(
  canonicalDocument: unknown,
): { name: string; note: string }[] | null {
  const spec = (canonicalDocument as { spec?: unknown } | null)?.spec;
  const inputs = (spec as { inputs?: unknown } | null)?.inputs;
  const node = inputs as {
    properties?: Record<string, { description?: unknown; type?: unknown }>;
  } | null;
  if (!node || typeof node !== "object" || !node.properties) return null;
  return Object.entries(node.properties).map(([name, entry]) => {
    const description = typeof entry?.description === "string" ? entry.description : "";
    const type = typeof entry?.type === "string" ? entry.type : "";
    return { name, note: description || type };
  });
}

export function WorkflowOverview({
  pipelineId,
  revision,
  revisionLoading,
  revisionError,
  groups,
  usedInLoading,
  runs,
  openDraft,
  actorName,
  onAssign,
}: OverviewProps) {
  return (
    <div
      className="grid min-h-0 w-full flex-1 grid-cols-1 items-stretch lg:grid-cols-[minmax(0,1fr)_285px]"
      data-testid="workflow-overview"
    >
      {/* The dotted canvas runs edge to edge, left of the rail (design 1e):
          paper + a 16px dot grid, solid cards on top, caption bottom-left.
          It scrolls when a definition outgrows it. */}
      <div
        className="relative min-h-[360px] overflow-auto p-[20px] lg:min-h-[560px] lg:p-0"
        style={{
          backgroundColor: "var(--color-paper)",
          backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
        data-testid="overview-canvas"
      >
        {revisionLoading && !revision ? <Spinner label="Loading the revision document" /> : null}
        {revisionError ? (
          <ProblemBanner
            error={revisionError}
            fallback="The selected revision could not be read."
          />
        ) : null}
        {revision ? (
          <GraphCanvas
            document={revision.canonical_document as unknown as DefinitionDocument}
            label={`read-only · r${revision.revision_number} · Edit workflow opens the canvas on your draft`}
          />
        ) : null}
        {!revisionLoading && !revision && !revisionError ? (
          <p
            className="p-[10px] font-mono text-[11px] text-muted"
            data-testid="overview-graph-empty"
          >
            never published — there is no revision to draw; Edit workflow opens a draft canvas
          </p>
        ) : null}
      </div>
      {/* The rail is a full-height column, not a floating card: 1px left
          border, white surface, 16px padding (design 1e). */}
      <aside
        className="flex w-full min-w-0 flex-col gap-[18px] border-t border-line-strong bg-surface px-[16px] py-[16px] lg:w-[285px] lg:border-t-0 lg:border-l"
        data-testid="overview-rail"
      >
        {openDraft ? (
          <div
            className="flex flex-col gap-[6px] rounded-[3px] border border-line bg-accent-wash px-[12px] py-[10px]"
            data-testid="overview-draft-card"
          >
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-ink-2">
              OPEN DRAFT
            </span>
            <span className="text-[12.5px]" data-testid="overview-draft-line">
              {`v${openDraft.version} by ${actorName(openDraft.edited_by)} · ${formatAge(openDraft.updated_at)} · ${openDraft.status}`}
            </span>
            <Link
              to={routes.draft(pipelineId, openDraft.id)}
              className="text-[12.5px] font-semibold text-accent-text hover:text-ink"
              data-testid="overview-draft-continue"
            >
              Continue editing ›
            </Link>
          </div>
        ) : null}
        <div className="flex flex-col gap-[6px]" data-testid="overview-used-in">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
            USED IN
          </span>
          {usedInLoading && groups.length === 0 ? (
            <span className="font-mono text-[10.5px] text-faint">checking…</span>
          ) : null}
          {!usedInLoading && groups.length === 0 ? (
            <span className="text-[12.5px] text-muted" data-testid="overview-used-in-empty">
              Not used yet — pin it to a repo to run it.
            </span>
          ) : null}
          {groups.map((group) => (
            <div key={group.assignment.id} data-testid={`overview-used-in-${group.assignment.id}`}>
              <span className="block text-[12.5px]">
                {`${group.project.name} / ${group.assignment.repository_name ?? "whole project"}`}
              </span>
              <span className="block font-mono text-[10.5px] text-muted">
                <TriggerSentences group={group} />
              </span>
            </div>
          ))}
          <button
            type="button"
            onClick={onAssign}
            className="w-fit text-[12.5px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="used-in-rail-assign"
          >
            + Assign to a project
          </button>
        </div>
        <div className="flex flex-col gap-[6px]" data-testid="overview-inputs">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
            INPUTS
          </span>
          {revision ? (
            (() => {
              const inputs = describeInputs(revision.canonical_document);
              if (!inputs || inputs.length === 0) {
                return (
                  <span className="text-[12.5px] text-muted" data-testid="overview-inputs-none">
                    no inputs declared
                  </span>
                );
              }
              return inputs.map((input) => (
                <span
                  key={input.name}
                  className="text-[12.5px]"
                  data-testid={`overview-input-${input.name}`}
                >
                  <span className="font-mono text-[12px]">{input.name}</span>
                  {input.note ? ` — ${input.note}` : null}
                </span>
              ));
            })()
          ) : (
            <span className="font-mono text-[10.5px] text-faint">waiting on the revision…</span>
          )}
        </div>
        <div className="flex flex-col gap-[6px]" data-testid="overview-runs">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
            LAST RUNS
          </span>
          {runs.isPending ? (
            <span className="font-mono text-[10.5px] text-faint">checking…</span>
          ) : null}
          {runs.isError ? (
            <span
              className="font-mono text-[10.5px] text-st-failed-tag-fg"
              data-testid="overview-runs-error"
            >
              the runs could not be read
            </span>
          ) : null}
          {runs.data && runs.data.runs.length === 0 ? (
            <span className="text-[12.5px] text-muted" data-testid="overview-runs-empty">
              No runs yet
            </span>
          ) : null}
          {(runs.data?.runs ?? []).slice(0, 5).map((run) => (
            <span key={run.id} className="text-[12.5px]">
              <LastRunCell run={run} />
            </span>
          ))}
        </div>
      </aside>
    </div>
  );
}
