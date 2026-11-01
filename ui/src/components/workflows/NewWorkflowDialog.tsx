/**
 * `New workflow` (design 1c) — the one creation surface on the Workflows
 * index: a name, the id derived from it, a starter choice, and a folder.
 *
 * Replaces the inline `NewPipelineForm` panel and the bottom `STARTER
 * WORKFLOWS` list: their create logic lives here, and the starter cards the
 * index renders above the list are the same three starting points the dialog
 * offers, so a card click preselects and a create runs the same two writes
 * (pipeline first, draft second — ADR-0002's logical create, then its first
 * draft). A failed draft post keeps the pipeline: only the draft is retried.
 *
 * Accessible-modal contract (the ImportYamlDialog pattern): `role="dialog"`,
 * `aria-modal`, labelled by its own title, focus trapped while open, Escape
 * closes, focus returns to the opener when it closes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { problemOf } from "../../api/client";
import { useCreateDraft, useCreatePipeline, useUpdatePipeline } from "../../api/pipelines";
import { routes } from "../../lib/routes";
import { Button } from "../ds/Button";
import { Field, Input, Select } from "../ds/Field";
import { ProblemBanner } from "../Feedback";
import {
  PIPELINE_TEMPLATES,
  firstSentence,
  templateById,
  withMetadataName,
  type PipelineTemplate,
  type TemplateId,
} from "../../lib/pipeline/templates";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SLUG_MAX = 63;

/** The id a workflow gets from its name: lowercase, non-alphanumeric runs →
 * `-`, trimmed, at most 63 characters (the server's slug ceiling). */
export function generateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

export interface NewWorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  /** The library role — only holders may create (authoring is the library's
   * own gate, `hasLibraryRole`). An unread identity is not authoring. */
  canCreate: boolean;
  /** The starter the card click (or the header button) preselected; the
   * header's own button opens Blank. */
  presetTemplateId?: TemplateId | null;
  /** The index's distinct existing folder names (the dialog adds "No folder"). */
  folders?: readonly string[];
  /** The workflow-list read's failure, when the index could not read it. The
   * dialog owns the screen while it is open, so it carries that FAILED banner
   * itself (design 1c review): a banner behind the overlay is a failure the
   * author cannot read. The starter documents are bundled with the app, so a
   * failed read costs the folder pick its folders, not the create. */
  listError?: unknown;
}

/**
 * A START FROM tile's second line (design 1c): how many steps the starter puts
 * on the canvas — `One agent step` for Blank, `4 steps` for a template. The
 * number is the document's own node count, parsed by the same `parseGraph` the
 * canvas draws with (`stepCount`), so a tile cannot promise a step the Studio
 * will not draw; a document that does not parse shows nothing rather than a
 * count nobody observed. (The step CHAIN stays on the index's starter cards,
 * where there is room for it.)
 */
export function tileSubtitle(template: PipelineTemplate): string {
  if (template.stepCount === null) return "";
  // The design's words for the one-node skeleton; any other size is named by
  // its own count rather than by a caption that could go stale.
  if (template.id === "blank" && template.stepCount === 1) return "One agent step";
  return `${template.stepCount} ${template.stepCount === 1 ? "step" : "steps"}`;
}

/**
 * The selected starter's one-line description under the cards.
 *
 * A template quotes its own document metadata, trimmed to the first sentence —
 * those words describe a workflow the author is about to copy. Blank has no
 * document to describe: its metadata line says how the starter FILE is built
 * ("skeleton draft — the top-level shape and one node, then write the YAML
 * yourself"), which is a note to whoever maintains the library, not a sentence
 * for the person choosing a start (2026-10-30 copy review, 1c item 1). Blank is
 * picked because it opens an empty canvas, so the line says that, in the same
 * words the Workflows index card uses for it (`One agent step to start from.`).
 */
export function starterHint(template: PipelineTemplate | null | undefined): string {
  if (!template) return "";
  if (template.id === "blank")
    return "One agent step to start from. Add and edit steps on the canvas.";
  return firstSentence(template.description);
}

export function NewWorkflowDialog({
  open,
  onClose,
  canCreate,
  presetTemplateId,
  folders = [],
  listError,
}: NewWorkflowDialogProps) {
  if (!open) return null;
  return (
    <DialogBody
      onClose={onClose}
      canCreate={canCreate}
      presetTemplateId={presetTemplateId ?? null}
      folders={folders}
      listError={listError}
    />
  );
}

interface DialogBodyProps {
  onClose: () => void;
  canCreate: boolean;
  presetTemplateId: TemplateId | null;
  folders: readonly string[];
  listError?: unknown;
}

function DialogBody({ onClose, canCreate, presetTemplateId, folders, listError }: DialogBodyProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLFormElement>(null);
  const openerRef = useRef<Element | null>(null);
  const preset = templateById(presetTemplateId ?? "");
  // The template cards hand the dialog their own name: the id follows it, so
  // a card click is the one-verb "clone this starter" path. Blank starts
  // blank: the name is what the author types, not the word "Blank".
  const presetName = preset && preset.id !== "blank" ? preset.label : "";
  const [name, setName] = useState(presetName);
  const [id, setId] = useState(presetName ? generateSlug(presetName) : "");
  const [idEdited, setIdEdited] = useState(false);
  const [templateId, setTemplateId] = useState<TemplateId>(presetTemplateId ?? "blank");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  /** The id line's error: the server's own words — a `409` (duplicate slug)
   * or whatever the create POST said. */
  const [idError, setIdError] = useState<string | null>(null);
  const [seed, setSeed] = useState<{
    pipelineId: string;
    documentYaml: string;
    /** The FOLDER pick: `POST /pipelines` has no folder member, so a pick
     * becomes one `PATCH /pipelines/{id}` between the two writes. */
    folder: string;
    /** Where a failed run stops: the file-it PATCH or the draft POST. */
    fromStage: "folder" | "draft";
    run: number;
  } | null>(null);
  const [seedFailure, setSeedFailure] = useState<unknown>(null);
  const create = useCreatePipeline();
  const update = useUpdatePipeline();
  const createDraft = useCreateDraft(seed?.pipelineId ?? "");
  const startedRun = useRef(0);
  const template = templateById(templateId);

  const effectiveSlug = idEdited ? generateSlug(id) : generateSlug(name);
  const documentYaml = template?.documentYaml ?? "";

  useEffect(() => {
    if (!seed || startedRun.current === seed.run) return;
    startedRun.current = seed.run;
    setBusy(true);
    let failedStage: "folder" | "draft" = "draft";
    (async () => {
      try {
        if (seed.fromStage === "folder" && seed.folder) {
          try {
            await update.mutateAsync({
              pipelineId: seed.pipelineId,
              body: { folder: seed.folder },
            });
          } catch (error) {
            failedStage = "folder";
            throw error;
          }
        }
        const draft = await createDraft.mutateAsync({ document_yaml: seed.documentYaml });
        navigate(routes.draft(seed.pipelineId, draft.id));
      } catch (error: unknown) {
        // The pipeline exists: keep it, name the failed step, and retry from
        // there — the retry never re-posts the pipeline (that would be a
        // `409` on a slug the server already accepted).
        setSeed((current) => (current ? { ...current, fromStage: failedStage } : current));
        setSeedFailure(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [seed, createDraft, update, navigate]);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("input, button, textarea")?.focus();
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
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || busy || seed || !effectiveSlug) return;
    if (!documentYaml) return;
    setIdError(null);
    setSeedFailure(null);
    try {
      const pipeline = await create.mutateAsync({
        slug: effectiveSlug,
        display_name: name.trim() || undefined,
      });
      setSeed({
        pipelineId: pipeline.id,
        documentYaml: withMetadataName(documentYaml, effectiveSlug),
        folder: folder,
        fromStage: folder ? "folder" : "draft",
        run: startedRun.current + 1,
      });
    } catch (error: unknown) {
      // The server's own words on the id line and the dialog stays open —
      // the name is what changes, not the starter. A `409` says so in the
      // page's vocabulary.
      const problem = problemOf(error);
      setIdError(
        problem?.status === 409
          ? `that id is taken — change it${problem.detail ? `: ${problem.detail}` : ""}`
          : problem?.detail || problem?.title || "the pipeline could not be created",
      );
    }
  }

  /* The dialog is a flex column: header (fixed), body (the ONLY scroll
     region — `flex-1 min-h-0 overflow-y-auto`) and footer (a sibling OUTSIDE
     the scroll region). The 1c review first made the footer `sticky bottom-0`
     INSIDE the scrolling form so Create stayed reachable at 390; at rest that
     strip painted over the folder select (`span.font-mono FOLDER ×
     new-workflow-cancel` in the pass-1 overlap record, shot
     1c-server-error-390). A sticky overlay trades one defect for another —
     the footer now lives in its own row of the column, so nothing paints
     over the body, the last field is reachable by scrolling the body, and
     Create/Cancel are always in view at 390 and 1280. The form IS the dialog
     box, so the footer's submit button still submits it. */
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <form
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workflow-title"
        onSubmit={submit}
        className="flex max-h-[calc(100vh-8rem)] w-[520px] max-w-full flex-col rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="new-workflow-dialog"
      >
        <div
          className="flex shrink-0 items-baseline justify-between border-b border-line px-[14px] py-[10px]"
          role="heading"
          aria-level={2}
        >
          <span id="new-workflow-title" className="text-[13px] font-bold">
            New workflow
          </span>
          <span aria-hidden="true" className="font-mono text-[10px] text-faint">
            esc
          </span>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-[16px] py-[16px]"
          data-testid="new-workflow-form"
        >
          {/* The list read's failure belongs INSIDE the dialog: this
              overlay covers the page, so the page's banner would sit behind it
              (design 1c review). It is the app's ONE load-failure treatment —
              the shared `Couldn't load …` block (pass-1 review, item 2): a
              plain sentence about what this page could not read, a plain
              status sentence, and the server's own words collapsed behind
              `Details` (error-details-r6). `shrink-0` because the dialog form
              is a flex column and the alert box's `overflow-hidden` drops the
              flex auto-min-size: without it the callout was squeezed to a
              fixed height at 390, its body line cut in half (pass-1 shot
              1c-server-error-390). With it the callout grows to fit and the
              body's own `overflow-y-auto` scrolls it with the rest. The starter
              itself still works — its document ships with the app — so the
              hint says what IS missing. */}
          {listError ? (
            <ProblemBanner
              error={listError}
              fallback="The workflow library could not be read."
              subject="the workflow library"
              hint="Its folders cannot be listed here, so a new workflow lands under No folder."
              testid="new-workflow-list-failure"
              className="shrink-0"
            />
          ) : null}
          <Field id="new-workflow-name" label="NAME">
            {/* The NAME field is a human sentence, not a machine value: the
                important markers beat `fieldClass`'s font-mono/text-[12.5px],
                which plain utilities lose to in stylesheet order (measured
                live in the browser). */}
            <Input
              id="new-workflow-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!idEdited) setId(generateSlug(event.target.value));
              }}
              placeholder="Name this workflow"
              className="font-ui! text-[14px]!"
              data-testid="library-new-name-input"
            />
          </Field>
          <div className="flex flex-col gap-1" data-testid="new-workflow-id-line">
            <span className="flex flex-wrap items-baseline gap-x-[8px] font-mono text-[11px] text-muted">
              <span data-testid="new-workflow-id">{`id: ${effectiveSlug || "…"}`}</span>
              {!idEdited && !idError ? (
                <button
                  type="button"
                  onClick={() => setIdEdited(true)}
                  className="text-[11px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid="new-workflow-id-change"
                >
                  change
                </button>
              ) : null}
            </span>
            {idEdited ? (
              <Input
                id="new-workflow-id-input"
                value={id}
                onChange={(event) => setId(event.target.value)}
                className="max-w-[240px] font-mono"
                data-testid="library-new-slug-input"
              />
            ) : null}
            {idError ? (
              <p
                className="font-mono text-[11px] text-st-failed-tag-fg"
                data-testid="template-use-pipeline-failure"
              >
                {idError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              START FROM
            </span>
            <div
              className="grid grid-cols-1 gap-[8px] min-[520px]:grid-cols-[repeat(3,minmax(0,1fr))]"
              role="radiogroup"
              aria-label="start from"
              data-testid="library-new-template-select"
            >
              {PIPELINE_TEMPLATES.map((option) => {
                const selectedCard = templateId === option.id;
                return (
                  <label
                    key={option.id}
                    className={`flex cursor-pointer flex-col gap-1 rounded-[3px] border p-[10px] text-left max-[559px]:items-start! ${
                      selectedCard
                        ? "border-ink bg-accent-wash shadow-[2px_2px_0_0_var(--color-ink)]"
                        : "border-line bg-surface"
                    }`}
                    data-testid={`new-workflow-template-${option.id}`}
                  >
                    <input
                      type="radio"
                      name="new-workflow-template"
                      className="sr-only"
                      checked={selectedCard}
                      onChange={() => setTemplateId(option.id)}
                    />
                    <span className="text-[12.5px] font-semibold">{option.label}</span>
                    {/* Second line (design 1c): how many steps the starter puts
                        on the canvas — `One agent step` for Blank, `N steps`
                        for a template, counted from the document itself (see
                        `tileSubtitle`). */}
                    {tileSubtitle(option) ? (
                      <span className="text-[11px] text-muted">{tileSubtitle(option)}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {/* The selected starter's one-line description (`starterHint`: a
                template's own metadata sentence, Blank's plain starting line). */}
            <p
              className="text-[12px] leading-[17px] text-muted"
              data-testid="library-new-template-hint"
            >
              {starterHint(template)}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              FOLDER
            </span>
            <Select
              id="new-workflow-folder"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className="max-w-[240px] font-mono text-[10.5px]"
              data-testid="new-workflow-folder"
            >
              <option value="">No folder</option>
              {folders.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          {seedFailure ? (
            <div className="flex flex-wrap items-center gap-[8px]">
              <p
                className="min-w-0 font-mono text-[11px] text-st-failed-tag-fg"
                data-testid={
                  seed?.fromStage === "folder"
                    ? "new-workflow-folder-failure"
                    : "template-use-draft-failure"
                }
              >
                {seed?.fromStage === "folder"
                  ? `the workflow was created, but it could not be filed under ${seed.folder}: ${String(
                      (seedFailure as { detail?: string; title?: string })?.detail ??
                        (seedFailure as { title?: string })?.title ??
                        "",
                    )}`
                  : `the workflow was created, but its starter draft was not: ${String(
                      (seedFailure as { detail?: string; title?: string })?.detail ??
                        (seedFailure as { title?: string })?.title ??
                        "",
                    )}`}
              </p>
              <Button
                type="button"
                variant="secondary"
                compact
                onClick={() => {
                  setSeedFailure(null);
                  setSeed((current) => (current ? { ...current, run: current.run + 1 } : current));
                }}
                data-testid="template-use-draft-retry"
              >
                Retry the starter draft
              </Button>
            </div>
          ) : null}
          {/* The footer is the column's LAST row, a SIBLING of the scroll
              body above (1c review, index-row-r7 item 4: at 390 the
              Cancel/Create pair sat below the fold inside the scrolling form
              — the create verb was unreachable until the author scrolled;
              pass-1 overlap review: sticky INSIDE the scroll area then
              painted over the folder field at rest). `shrink-0` keeps its row
              whole, `bg-surface` matches the card and the top border marks
              the seam. */}
        </div>
        <div className="flex shrink-0 justify-end gap-[8px] rounded-b-[4px] border-t border-line bg-surface px-[16px] pb-[16px] pt-[10px]">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            data-testid="new-workflow-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canCreate || busy || create.isPending || Boolean(seed) || !effectiveSlug}
            data-testid="library-new-submit"
          >
            {busy || create.isPending || seed ? "Creating…" : "Create and open canvas"}
          </Button>
        </div>
      </form>
    </div>
  );
}
