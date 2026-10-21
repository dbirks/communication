/**
 * One row of the Workflows index (design 3a): a `220px 1fr 200px 150px`
 * desktop grid that stacks at phone width (name+chip, chain, meta, actions).
 *
 * Honesty rules (gaps/library.md § 5):
 * - The revision chip is the server's own `latest` summary — `✓ PUBLISHED
 *   r{n} {digest6}` (first six hex of the `sha256:` digest) or `· DRAFT ONLY`
 *   once the definition read has arrived with zero revisions. No channels:
 *   BETA/STABLE is M6 vocabulary the wire does not carry, and no amber dual
 *   chip is rendered.
 * - The step chain is the TOP-LEVEL nodes of the latest revision's canonical
 *   document in definition order; a scope node (`until` / `for_each` /
 *   `parallel`) collapses to one shaded chip `loop: <child> · <child>…` using
 *   the document's own child ids — nothing is named by the client.
 * - Assigned projects are the caller's own membership's assignments (the
 *   page's shared fan); a project whose read failed never reads as
 *   "unassigned" — the cell shows `—` until the read settles.
 * - The trigger is `cron <expr>` from the owning project's enabled schedule,
 *   or `manual`; GitHub-issue triggers do not exist yet (gaps § 5) and are
 *   never rendered.
 * - The open-draft line is the newest un-published draft with the real
 *   editor name — no "by assistant": the wire carries no assistant identity.
 */
import { Link } from "react-router";
import { StatusChip } from "../ds/Row";
import { Button } from "../ds/Button";
import type { Assignment, DraftSummary, PipelineRevisionSummary, Project } from "../../api/types";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { SCOPE_KINDS, kindWord, scopeBody } from "../../lib/pipeline/definition";
import { routes } from "../../lib/routes";

/** The first six hex of a `sha256:`-prefixed digest (`8f2c1a`). */
function digest6(revisionDigest: string): string {
  return revisionDigest.startsWith("sha256:")
    ? revisionDigest.slice(7, 13)
    : revisionDigest.slice(0, 6);
}

/** A chain cell: a plain step id, or a shaded `loop: …` scope chip. */
export interface StepChainCell {
  label: string;
  loop: boolean;
}

/** Top-level chain in definition order; scope nodes fold to one loop chip. */
export function stepChain(doc: DefinitionDocument | null): StepChainCell[] {
  if (!doc) return [];
  const cells: StepChainCell[] = [];
  for (const node of doc.spec.nodes) {
    if ((SCOPE_KINDS as readonly string[]).includes(node.kind)) {
      const children = scopeBody(node)
        .map((child) => child.id)
        .join(" · ");
      cells.push({ label: children ? `loop: ${children}` : kindWord(node.kind), loop: true });
    } else {
      cells.push({ label: node.id, loop: false });
    }
  }
  return cells;
}

export interface WorkflowRowAssignment {
  project: Project;
  assignment: Assignment;
  cron: string | null;
}

export interface WorkflowRowProps {
  pipeline: { id: string; slug: string; display_name: string };
  /** The definition read has arrived (rows never claim DRAFT ONLY while it is still in flight). */
  definitionReady: boolean;
  /** The pipeline's revision summaries, newest first (may be empty). */
  revisions: PipelineRevisionSummary[];
  /** The latest revision's canonical document, parsed — null until it arrives. */
  document: DefinitionDocument | null;
  /** The pipeline's drafts (statuses the server owns). */
  drafts: DraftSummary[];
  /** Actor id → display name (the draft editor line). */
  nameOf: (actorId: string) => string | null;
  assigned: WorkflowRowAssignment[];
  /** The shared assignment fan has settled (see `workflowRowFacts`). */
  assignmentsResolved: boolean;
  canAuthor: boolean;
  duplicating: boolean;
  onDuplicate: () => void;
  onOpen: () => void;
}

export function WorkflowRow({
  pipeline,
  definitionReady,
  revisions,
  document,
  drafts,
  nameOf,
  assigned,
  assignmentsResolved,
  canAuthor,
  duplicating,
  onDuplicate,
  onOpen,
}: WorkflowRowProps) {
  const latest = revisions[0] ?? null;
  const cells = stepChain(document);
  const openDraft = [...drafts]
    .filter((draft) => draft.status !== "published")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const trigger =
    assigned.length === 0
      ? null
      : (assigned.map((row) => row.cron).find((cron) => cron !== null) ?? "manual");

  return (
    <li className="border-b border-line py-[8px]" data-testid={`workflow-row-${pipeline.slug}`}>
      <div className="grid grid-cols-1 gap-y-[6px] gap-x-4 min-[900px]:grid-cols-[220px_1fr_200px_150px] min-[900px]:items-center">
        {/* name + revision chip */}
        <div className="min-w-0 space-y-[4px]">
          <Link
            to={routes.workflow(pipeline.id)}
            className="block truncate text-[13px] font-bold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid={`workflow-name-${pipeline.slug}`}
          >
            {pipeline.display_name || pipeline.slug}
          </Link>
          {latest ? (
            <StatusChip
              state="done"
              label={`PUBLISHED r${latest.revision_number} ${digest6(latest.revision_digest)}`}
              labelProps={{ "data-testid": `workflow-revision-${pipeline.slug}` }}
            />
          ) : definitionReady ? (
            <StatusChip
              state="queued"
              label="DRAFT ONLY"
              labelProps={{ "data-testid": `workflow-revision-${pipeline.slug}` }}
            />
          ) : (
            <span
              className="font-mono text-[10px] text-muted"
              data-testid={`workflow-revision-${pipeline.slug}`}
            >
              · loading
            </span>
          )}
        </div>

        {/* step chain */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[4px]">
          {cells.length === 0 ? (
            <span className="font-mono text-[10.5px] text-muted">—</span>
          ) : (
            cells.map((cell, index) => (
              <span key={index} className="flex items-center gap-[6px]">
                {index > 0 ? (
                  <span aria-hidden="true" className="font-mono text-[10px] text-muted">
                    ›
                  </span>
                ) : null}
                <span
                  className={
                    cell.loop
                      ? "rounded-[3px] border border-line bg-paper px-[6px] py-[1px] font-mono text-[10.5px]"
                      : "font-mono text-[10.5px]"
                  }
                  data-testid={`workflow-chain-${pipeline.slug}-${index}`}
                >
                  {cell.label}
                </span>
              </span>
            ))
          )}
        </div>

        {/* assigned projects + trigger */}
        <div className="min-w-0 space-y-[3px]">
          {assignmentsResolved && assigned.length === 0 ? (
            <p
              className="text-[11.5px] text-muted"
              data-testid={`workflow-assignments-${pipeline.slug}`}
            >
              not assigned to a project you can see
            </p>
          ) : (
            <p
              className="truncate text-[11.5px]"
              title={assigned.map((row) => row.project.name).join(" · ")}
              data-testid={`workflow-assignments-${pipeline.slug}`}
            >
              {assigned.map((row) => row.project.name).join(" · ") || "…"}
            </p>
          )}
          <p
            className="font-mono text-[10.5px] text-muted"
            data-testid={`workflow-trigger-${pipeline.slug}`}
          >
            {trigger === null
              ? assignmentsResolved
                ? "—"
                : "…"
              : trigger === "manual"
                ? "manual"
                : `cron ${trigger}`}
          </p>
        </div>

        {/* open draft + actions */}
        <div className="flex min-w-0 flex-col items-start gap-[5px] min-[900px]:items-end min-[900px]:text-right">
          {openDraft ? (
            <Link
              to={routes.draft(pipeline.id, openDraft.id)}
              className="font-mono text-[10.5px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid={`workflow-draft-${pipeline.slug}`}
            >
              {`draft v${openDraft.version} · by ${nameOf(openDraft.edited_by) ?? "unknown"}`}
            </Link>
          ) : (
            <span
              className="font-mono text-[10.5px] text-muted"
              data-testid={`workflow-draft-${pipeline.slug}`}
            >
              no open draft
            </span>
          )}
          <div className="flex gap-[6px]">
            {canAuthor ? (
              <Button
                variant="secondary"
                compact
                disabled={duplicating}
                onClick={onDuplicate}
                data-testid={`workflow-duplicate-${pipeline.slug}`}
              >
                {duplicating ? "Duplicating…" : "Duplicate"}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              compact
              onClick={onOpen}
              data-testid={`workflow-open-${pipeline.slug}`}
            >
              Open
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
