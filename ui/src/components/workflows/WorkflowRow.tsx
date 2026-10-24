/**
 * One row of the Workflows index (design 1b): a `220px 1fr 180px 120px`
 * desktop grid that stacks at phone width (name+chip, chain, used-in, actions).
 *
 * Honesty rules (gaps/library.md § 5 + the Workflows Review handoff):
 * - The revision chip is the server's own `latest` summary — `✓ r{n}`
 *   (the digest moved to the workflow page) or `· draft · not published`
 *   once the definition read has arrived with zero revisions.
 * - The step chain is the TOP-LEVEL nodes of the latest revision's canonical
 *   document in definition order; a scope node (`until` / `for_each` /
 *   `parallel`) collapses to one shaded chip `loop: <child> · <child>…` using
 *   the document's own child ids — nothing is named by the client.
 * - Where used is the caller's own membership's assignments: `project ·
 *   repo` when ADR-0060 pins a repository, `project` alone for a
 *   whole-project assignment, or `Not used yet`. A project whose read failed
 *   never reads as "unassigned" — the cell shows `…` until the read settles.
 * - The trigger is the owning project's enabled schedule's `cron <expr>`,
 *   or `manual`; GitHub-issue triggers do not exist yet and are never
 *   rendered.
 * - The open-draft line is the newest un-published draft with the real
 *   editor name — no "by assistant": the wire carries no assistant identity.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { StatusChip } from "../ds/Row";
import { Button } from "../ds/Button";
import { Field, Input } from "../ds/Field";
import { FormError } from "../Feedback";
import { RowMenu } from "./RowMenu";
import { UNFILED_FOLDER, useMovePipelineFolder } from "../../api/pipelines";
import { toBlockYaml } from "../../lib/pipeline/blockYaml";

import type { Assignment, DraftSummary, PipelineRevisionSummary, Project } from "../../api/types";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { SCOPE_KINDS, kindWord, scopeBody } from "../../lib/pipeline/definition";
import { routes } from "../../lib/routes";

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

/** `Export YAML`: the bytes the browser downloads. The text is re-flowed
 * through `toBlockYaml` (design 2d) and the file is named `<slug>.yaml`. */
export function workflowExportYaml(documentText: string, slug: string) {
  return { name: `${slug}.yaml`, text: toBlockYaml(documentText) };
}

/** Triggers the download; a no-op the tests can replace. */
export function downloadWorkflowYaml(documentText: string, slug: string): string {
  const { name, text } = workflowExportYaml(documentText, slug);
  const blob = new Blob([text], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
  return name;
}

export interface WorkflowRowAssignment {
  project: Project;
  assignment: Assignment;
  cron: string | null;
}

export interface WorkflowRowProps {
  pipeline: { id: string; slug: string; display_name: string; folder?: string | null };
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
  /** Row menu `Use in a repo…` → the workflow page's use-in-a-repo dialog. */
  onUseInRepo: () => void;
  /** Row menu `Move to folder…` (ADR-0049 § 8); absent for readers. */
  onMoveToFolder?: () => void;
  /** The document `Export YAML` downloads (latest revision, else the open
   * draft) — null when nothing is readable, so the item is not offered. */
  exportDocument: string | null;
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
  onUseInRepo,
  onMoveToFolder,
  exportDocument,
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
  const usedIn = assigned.map(
    (row) =>
      row.assignment.repository_name
        ? `${row.project.name} · ${row.assignment.repository_name}`
        : row.project.name,
  );

  return (
    <li className="border-b border-line py-[8px]" data-testid={`workflow-row-${pipeline.slug}`}>
      <div className="grid grid-cols-1 gap-y-[6px] gap-x-4 min-[900px]:grid-cols-[220px_1fr_180px_120px] min-[900px]:items-center">
        {/* name + revision chip */}
        <div className="min-w-0 space-y-[4px]">
          <Link
            to={routes.workflow(pipeline.id)}
            className="block truncate text-[13.5px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid={`workflow-name-${pipeline.slug}`}
          >
            {pipeline.display_name || pipeline.slug}
          </Link>
          {latest ? (
            <StatusChip
              state="done"
              label={`r${latest.revision_number}`}
              labelProps={{ "data-testid": `workflow-revision-${pipeline.slug}` }}
            />
          ) : definitionReady ? (
            <StatusChip
              state="queued"
              label="draft · not published"
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

        {/* where it is used + trigger */}
        <div className="min-w-0 space-y-[3px]">
          {assignmentsResolved && assigned.length === 0 ? (
            <p
              className="text-[11.5px] text-muted"
              data-testid={`workflow-assignments-${pipeline.slug}`}
            >
              Not used yet
            </p>
          ) : (
            <p
              className="truncate text-[11.5px]"
              title={usedIn.join(" · ")}
              data-testid={`workflow-assignments-${pipeline.slug}`}
            >
              {usedIn.join(" · ") || "…"}
            </p>
          )}
          {trigger === null && assignmentsResolved ? null : (
            <p
              className="font-mono text-[10.5px] text-muted"
              data-testid={`workflow-trigger-${pipeline.slug}`}
            >
              {trigger === null ? "…" : trigger === "manual" ? "manual" : `cron ${trigger}`}
            </p>
          )}
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
          <div className="flex items-center gap-[6px]">
            <Button
              variant="secondary"
              compact
              onClick={onOpen}
              data-testid={`workflow-open-${pipeline.slug}`}
            >
              Edit
            </Button>
            <RowMenu
              slug={pipeline.slug}
              duplicating={duplicating}
              onUseInRepo={onUseInRepo}
              onDuplicate={onDuplicate}
              onMoveToFolder={canAuthor ? onMoveToFolder : undefined}
              onExportYaml={
                exportDocument !== null
                  ? () => downloadWorkflowYaml(exportDocument, pipeline.slug)
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------- move to folder */

/** Testid-safe name for a folder label (the dialog's quick-pick chips). */
function folderSlug(folder: string): string {
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "folder";
}

const DIALOG_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * `Move to folder…` (ADR-0049 § 8): a small dialog that files the row under
 * an existing folder (the chips), types a new name, or leaves the input
 * empty to unfile. The only write is `PATCH /api/v1/pipelines/{id} { folder}`;
 * the dialog renders the server's problem on a failed move and stays open.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"`
 * + `aria-modal`, labelled by its own title, focus trapped while open,
 * Escape closes, focus returns to the opener.
 */
export interface MoveToFolderDialogProps {
  /** The row being moved; its current group starts the input. */
  pipeline: { id: string; slug: string; display_name: string; folder?: string | null };
  /** The index's distinct existing folder names (the quick-pick chips). */
  folders: string[];
  onClose: () => void;
}

export function MoveToFolderDialog({ pipeline, folders, onClose }: MoveToFolderDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [value, setValue] = useState(pipeline.folder ?? "");
  const move = useMovePipelineFolder(pipeline.id);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>("input, button");
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = value.trim();
    move.mutate(name === "" ? null : name, { onSuccess: onClose });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-folder-title"
        className="w-[360px] max-w-full rounded-[4px] border border-line bg-surface shadow-(--shadow-raised)"
        data-testid="move-folder-dialog"
      >
        <h2
          id="move-folder-title"
          className="border-b border-line px-[14px] py-[10px] text-[13px] font-bold"
        >
          {`Move “${pipeline.display_name || pipeline.slug}” to a folder`}
        </h2>
        <form
          className="space-y-[10px] px-[14px] py-[12px]"
          onSubmit={submit}
          data-testid="move-folder-form"
        >
          <div className="flex flex-wrap gap-[6px]">
            {folders.map((folder) => (
              <Button
                key={folder}
                type="button"
                variant="secondary"
                compact
                onClick={() => setValue(folder)}
                data-testid={`move-folder-option-${folderSlug(folder)}`}
              >
                {folder}
              </Button>
            ))}
            <Button
              type="button"
              variant="secondary"
              compact
              onClick={() => setValue("")}
              data-testid={`move-folder-option-${folderSlug(UNFILED_FOLDER)}`}
            >
              {UNFILED_FOLDER}
            </Button>
          </div>
          <Field
            id="move-folder-input"
            label="Folder"
            hint="pick an existing folder, type a new name, or leave it empty to unfile"
          >
            <Input
              id="move-folder-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={200}
              data-testid="move-folder-input"
            />
          </Field>
          {move.isError ? <FormError error={move.error} /> : null}
          <div className="flex justify-end gap-[8px]">
            <Button
              type="button"
              variant="secondary"
              compact
              onClick={onClose}
              data-testid="move-folder-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              compact
              disabled={move.isPending}
              data-testid="move-folder-submit"
            >
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
