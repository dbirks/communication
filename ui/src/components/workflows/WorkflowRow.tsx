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
 *   the document's own child ids — nothing is named by the client. A
 *   draft-only row (no revision) derives the same chain from its newest
 *   open draft's own document text.
 * - Where used is the caller's own membership's assignments, in the design's
 *   `project · repo` shape (1b, and the same words the Used-in tab uses for
 *   the same fact): `M4 Exit · app` when ADR-0060 pins a repository,
 *   `M4 Exit · whole project` when the assignment carries no repo pin, one
 *   line per assignment — or `Not used yet` once the fan has settled with
 *   nothing. The client never names a repository the assignment does not.
 *   A project whose read failed never reads as "unassigned" — the cell shows
 *   `…` until the read settles.
 * - The trigger is the owning project's enabled schedule's `cron <expr>`,
 *   or `manual`; GitHub-issue triggers do not exist yet and are never
 *   rendered. A row never prints a draft line: `Edit` opens the workflow
 *   page, whose OPEN DRAFT card carries the editor and status.
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

import type { Assignment, PipelineRevisionSummary, Project } from "../../api/types";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { SCOPE_KINDS, kindWord, scopeBody } from "../../lib/pipeline/definition";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { routes } from "../../lib/routes";

/**
 * The row's desktop grid. Design 1b writes `220px 1fr 180px 120px`, but its
 * own names are two words; the lab's are long slugs, and a fixed 220px name
 * column truncated them mid-word while the chain column had room to spare.
 * The name column therefore takes the free width with the design's 220px as
 * its floor (`minmax(220px,1fr)`), the chain keeps the LARGER share of what is
 * left and wraps over it (pass-1 review, item 1: a 1.2fr share left the chain
 * ~330px of a ~980px row, so the whole loop chip never fitted), and the
 * used-in/actions columns stay the design's 180px/120px.
 */
export const WORKFLOW_ROW_GRID =
  "min-[900px]:grid-cols-[minmax(220px,1fr)_minmax(0,1.6fr)_180px_120px]";

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

/** The same chain from a YAML text (the draft document's own bytes, the
 * graph parser's view): top-level nodes in definition order, a scope node
 * folded to one `loop: …` chip. `[]` while the text is absent or does not
 * parse — the row then prints the honest `—`, never an invented step. */
export function graphChain(documentText: string | null): StepChainCell[] {
  if (!documentText) return [];
  const parsed = parseGraph(documentText);
  if (!parsed.ok) return [];
  const { nodes } = parsed.model;
  const cells: StepChainCell[] = [];
  for (const node of nodes.filter((candidate) => candidate.scope.length === 0)) {
    if (!node.isScope) {
      cells.push({ label: node.id, loop: false });
      continue;
    }
    const children = nodes
      .filter((child) => child.scope.length > 0 && child.scope[0] === node.id)
      .map((child) => child.id)
      .join(" · ");
    cells.push({ label: children ? `loop: ${children}` : node.id, loop: true });
  }
  return cells;
}

/**
 * The shared step-chain row (index 1b `WorkflowRow`, repo page 2e
 * `RepoWorkflows`): the chain is a flex-wrap line of non-breaking UNITS, each
 * one step plus the `›` that precedes it (`flex` never breaks between flex
 * items, so the arrow rides with its step across a wrap — bb8b7c7's fix to
 * the project Workflows panel, applied to every wrapped chain: no line may
 * start or end with a bare `›`). The unit is `items-baseline`, so when a
 * `loop:` chip wraps its own words the arrow sits on the chip's FIRST line,
 * never parked mid-chip where the continuation reads as starting with an
 * orphan `›`. The chain wraps at EVERY width (index-row-r7 item 2: the phone
 * used to keep one ellipsized line, which collapsed `plan › approve ›
 * loop: …` to `plan › approve …` at 390 — reflow must keep content, the same
 * full wrap the desktop already has).
 */
export function StepChain({
  cells,
  /** Shared testid prefix: the container carries `testid`, each step
   * `testid-{index}` (named `testid` so the template literal stays visible to
   * `scripts/check-testids.mjs`, which only knows `data-testid=`/`testid=`). */
  testid,
  /** Extra container classes (the repo row's indent and ink). */
  className,
  /** Hover text carrying the whole chain (the index row offers it). */
  title,
  /** Honest placeholder while the chain's own read is absent or empty. */
  placeholder,
}: {
  cells: StepChainCell[];
  testid: string;
  className?: string;
  title?: string;
  placeholder?: string;
}) {
  return (
    <div
      className={`flex min-w-0 flex-wrap items-baseline gap-x-[6px] gap-y-[4px] font-mono text-[10.5px] ${className ?? ""}`}
      title={title}
      data-testid={testid}
    >
      {cells.length === 0 ? (
        <span className="text-muted">{placeholder ?? "—"}</span>
      ) : (
        cells.map((cell, index) => (
          <span key={index} className="flex min-w-0 items-baseline gap-[5px]">
            {index > 0 ? (
              <span aria-hidden="true" className="shrink-0 text-[10px] text-muted">
                ›
              </span>
            ) : null}
            <span
              className={
                cell.loop
                  ? "min-w-0 break-words rounded-[3px] border border-line bg-paper px-[5px] py-[1px]"
                  : "min-w-0 break-words"
              }
              data-testid={`${testid}-${index}`}
            >
              {cell.label}
            </span>
          </span>
        ))
      )}
    </div>
  );
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
  /** The newest un-published draft's own document YAML — read for a row that
   * has no revision, whose chain then comes from the draft, not from air.
   * Ignored while a revision exists. */
  openDraftDocument?: string | null;
  assigned: WorkflowRowAssignment[];
  /** The shared assignment fan has settled (see `workflowRowFacts`). */
  assignmentsResolved: boolean;
  canAuthor: boolean;
  duplicating: boolean;
  onDuplicate: () => void;
  onOpen: () => void;
  /** Row menu `Use in a repo…` → the workflow page's use-in-a-repo dialog;
   * absent while no such dialog exists, so the item is not offered. */
  onUseInRepo?: () => void;
  /** Row menu `Move to folder…` (ADR-0049 § 8); absent for readers. */
  onMoveToFolder?: () => void;
  /** The document `Export YAML` downloads: the latest revision's regenerated
   * `document_text`, or `null` when no revision exists, so the item is not
   * offered (the wire's draft list carries no document text). */
  exportDocument: string | null;
}

export function WorkflowRow({
  pipeline,
  definitionReady,
  revisions,
  document,
  openDraftDocument,
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
  // The chain reads the latest revision's canonical document; a draft-only
  // row (no revision yet) reads its newest open draft's own document.
  const cells = document ? stepChain(document) : graphChain(openDraftDocument ?? null);
  const trigger =
    assigned.length === 0
      ? null
      : (assigned.map((row) => row.cron).find((cron) => cron !== null) ?? "manual");
  // The design's `project · repo` line (1b). A whole-project assignment
  // (ADR-0060's null pin) says `whole project` — the Used-in tab's own words
  // for the same fact — rather than dropping the half that makes the line read
  // as a place the workflow runs.
  const usedIn = assigned.map(
    (row) => `${row.project.name} · ${row.assignment.repository_name ?? "whole project"}`,
  );

  return (
    <li className="border-b border-line py-[8px]" data-testid={`workflow-row-${pipeline.slug}`}>
      <div
        className={`grid grid-cols-1 gap-y-[6px] gap-x-4 ${WORKFLOW_ROW_GRID} min-[900px]:items-center`}
      >
        {/* name + revision chip: the name WRAPS (overflow-wrap:anywhere, up
            to two lines — `line-clamp-2`) at every width (index-row-r7 item
            1: at 1280 `feature-development-determini…` cut the row's main
            identifier mid-word). The full name also rides the `title`. */}
        <div className="min-w-0 space-y-[4px]">
          <Link
            to={routes.workflow(pipeline.id)}
            title={pipeline.display_name || pipeline.slug}
            className="line-clamp-2 wrap-anywhere text-[13.5px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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

        {/* The chain owns the free width and WRAPS onto further lines at EVERY
            width (pass-1 review item 1 took the ellipsis off the desk;
            index-row-r7 item 2 takes it off the phone too — `plan › approve …`
            at 390 collapsed the chain, and reflow must keep content, not cut
            it). The full chain also rides the `title`. Each step carries its
            own `›` in one non-breaking unit (`StepChain`), so no wrapped line
            starts or ends with a bare arrow (index-row-r7 item 3, the
            treatment bb8b7c7 gave the project Workflows panel). */}
        <StepChain
          cells={cells}
          testid={`workflow-chain-${pipeline.slug}`}
          title={cells.map((cell) => cell.label).join(" › ")}
        />

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
            <div
              className="min-w-0 space-y-[2px]"
              title={usedIn.join(" · ")}
              data-testid={`workflow-assignments-${pipeline.slug}`}
            >
              {usedIn.length === 0 ? (
                <p className="text-[11.5px]">…</p>
              ) : (
                usedIn.map((where, index) => (
                  <p
                    key={`${where}-${index}`}
                    className="break-words text-[11.5px]"
                    data-testid={`workflow-assignment-${pipeline.slug}-${index}`}
                  >
                    {where}
                  </p>
                ))
              )}
            </div>
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

        {/* actions: `Edit` opens the workflow page (which opens the open
            draft); the row itself no longer prints a draft line */}
        <div className="flex min-w-0 items-start gap-[5px] min-[900px]:items-end min-[900px]:justify-end min-[900px]:text-right">
          {/* the `⋯` trigger inside RowMenu shares the row's phone hit-area
              treatment; RowMenu owns its markup, so it is reached from here */}
          <div className={`flex items-center gap-[6px] ${PHONE_HIT_MENU_TRIGGER}`}>
            <Button
              variant="secondary"
              compact
              onClick={onOpen}
              className={PHONE_HIT}
              data-testid={`workflow-open-${pipeline.slug}`}
            >
              Edit
            </Button>
            <RowMenu
              slug={pipeline.slug}
              duplicating={duplicating}
              onUseInRepo={onUseInRepo}
              onDuplicate={canAuthor ? onDuplicate : undefined}
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

/* ------------------------------------------------------- phone hit area */

/**
 * Keep the desktop's 26px button DRAWN at 390 while it still answers to a
 * 44px target (1b review): the shell's phone floor (`APP-SHELL-PHONE` in
 * `styles/tokens.css`, unlayered) gives every `main button` a `min-height:
 * 44px` below 560px, which turned the row's `Edit` and `⋯` into heavy boxed
 * buttons. `min-h-0!` outranks the unlayered floor, the box stays the 1280
 * one, and the invisible `::after` extends the hit area above and below it.
 *
 * The extension is ±10px, not ±9px, because an absolutely positioned pseudo
 * is laid out against the element's PADDING box, not its border box: `.ds-btn
 * --compact` is 26px border-box with the 1px `.ds-btn` border on each side, so
 * the containing block is 24px tall and ±9px only reaches 24+9+9 = 42px
 * (measured on the lab's own 390 pass, and reproduced by
 * `e2e/emulator/reflow-target.spec.ts` case (a2)). ±10px is 24+10+10 = 44.
 */
const PHONE_HIT =
  "max-[559px]:relative max-[559px]:min-h-0! max-[559px]:after:absolute max-[559px]:after:inset-x-0 max-[559px]:after:-top-[10px] max-[559px]:after:-bottom-[10px] max-[559px]:after:content-['']";

/** The same treatment for the `⋯` trigger RowMenu owns (reached from the
 * row's own wrapper via the `[data-menu-trigger]` attribute it carries —
 * the pseudo-element lives inside one arbitrary selector because a stacked
 * `after:` variant under `[&…]` does not compose a quoted `content`). Same
 * ±10px arithmetic as `PHONE_HIT`: the trigger is the app's bordered 26px
 * compact button, so its padding box is 24px. */
const PHONE_HIT_MENU_TRIGGER =
  "[&_[data-menu-trigger]]:relative [&_[data-menu-trigger]]:max-[559px]:min-h-0! max-[559px]:[&_[data-menu-trigger]::after]:content-[''] max-[559px]:[&_[data-menu-trigger]::after]:absolute max-[559px]:[&_[data-menu-trigger]::after]:inset-x-0 max-[559px]:[&_[data-menu-trigger]::after]:-top-[10px] max-[559px]:[&_[data-menu-trigger]::after]:-bottom-[10px]";

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
  /** The index's distinct REAL folder names (the quick-pick chips). The
   * dialog owns the one `Unfiled` quick-pick, so a caller that hands over the
   * index's group labels gets the `Unfiled` sentinel dropped (#27) — a chip
   * for it would file the row in a folder NAMED Unfiled instead of unfileing. */
  folders: string[];
  onClose: () => void;
}

export function MoveToFolderDialog({ pipeline, folders, onClose }: MoveToFolderDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [value, setValue] = useState(pipeline.folder ?? "");
  const move = useMovePipelineFolder(pipeline.id);
  // `Unfiled` is the index's GROUP LABEL for a `null` folder, never a folder
  // the dialog offers (#27): the chip below is the one Unfiled quick-pick and
  // it writes `null`. Anything else in the list is a real folder name.
  const existingFolders = folders.filter((folder) => folder !== UNFILED_FOLDER);

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
            {existingFolders.map((folder) => (
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
