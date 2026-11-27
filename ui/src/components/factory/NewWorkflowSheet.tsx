/**
 * NewWorkflowSheet — the one way to start a workflow in the Factory
 * (redesign R4; the prototype's `sheet`).
 *
 * Five ways in, all real, in the order README § 4 lists them:
 * 1. **Describe it** — a sentence, then `Sketch it`. This creates the workflow
 *    and its first draft exactly as `NewWorkflowDialog` does (the pipeline
 *    first, then its first draft — ADR-0002's logical create), and lands on the
 *    editor carrying `?draft=&describe=1`. The description travels through
 *    `sessionStorage` under `communication.factory.describe.<pipelineId>`,
 *    where the editor's assistant box picks it up in a later brief. **No model
 *    is called here**: sketching is the editor's job.
 * 2. **From something you keep doing in chats** — no API serves detected
 *    chains yet, so this section carries its label and one honest sentence
 *    (CONTRACT: real data only, never fake rows).
 * 3. **Copy** — the chips are the org's real workflows; a click runs the same
 *    `useDuplicatePipeline` the Workflows index's `Duplicate` runs.
 * 4. **Blank canvas / Import YAML** — the skeleton create and the existing
 *    import dialog.
 * 5. **From a vetted template** — the samples that shipped with the old
 *    dialog's `START FROM` picker (`PIPELINE_TEMPLATES`). Starting from one is
 *    existing behaviour the sheet replaced, so it is offered — but inside a
 *    collapsed "Start from a template (N)" disclosure row BELOW the copy
 *    section, not as an open section: the README's contents (Describe it, the
 *    chats line, OR COPY, and the two links) have to answer at once in a
 *    1280x800 window with nothing scrolled (review 08-1280-1). Every template
 *    row and every test id inside it is unchanged.
 *
 * Accessible-modal contract (the `NewWorkflowDialog` pattern): `role="dialog"`
 * + `aria-modal`, labelled by its own title, focus trapped while open, Escape
 * and the backdrop close, focus returns to the opener. The scrim stops at the
 * shell — the rail and the top bar stay undimmed and the sheet starts 40px
 * under the bar, where the prototype puts it (review 08-1280-4); a phone keeps
 * the contract's full-width bottom sheet.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconChevronDown,
  IconMicrophone,
  IconPlus,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useCreatePipeline, useDuplicatePipeline } from "../../api/pipelines";
import type { Draft, Pipeline, PipelineSummary } from "../../api/types";
import { apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import { generateSlug } from "../workflows/NewWorkflowDialog";
import { ImportYamlDialog } from "../workflows/ImportYamlDialog";
import {
  BLANK_SKELETON_YAML,
  PIPELINE_TEMPLATES,
  firstSentence,
  withMetadataName,
  type PipelineTemplate,
} from "../../lib/pipeline/templates";
import { parseGraph } from "../../lib/pipeline/graphDoc";
import { routes } from "../../lib/routes";
import { FormError } from "../Feedback";
import { useSpeechToText } from "../../lib/speech";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The editor's assistant box reads the description back from here (a later
 * brief); the key is per pipeline, so two sketches never mix. */
export function describeKey(pipelineId: string): string {
  return `communication.factory.describe.${pipelineId}`;
}

export function writeDescription(pipelineId: string, text: string): void {
  try {
    window.sessionStorage.setItem(describeKey(pipelineId), text);
  } catch {
    /* storage may be blocked; the editor then starts with an empty box */
  }
}

/** A name for a workflow nobody named: the first five words of the sentence
 * the person typed. The slug comes from it through the same helper
 * `NewWorkflowDialog` uses, so the id is never a surprise. */
export function nameFromDescription(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .replace(/[.,;:!?]+$/g, "");
}

/** The section label style the whole redesign shares (CONTRACT). */
function SectionLabel({ children, id, testid }: { children: string; id: string; testid: string }) {
  return (
    <span
      id={id}
      data-testid={testid}
      className="font-mono text-[10.5px] font-semibold tracking-[.06em] text-muted uppercase"
    >
      {children}
    </span>
  );
}

/** How many step chips a template row shows before it says `+N`. */
const MAX_STEP_CHIPS = 5;

/**
 * The template's steps, in the order the document defines them: the top-level
 * nodes the canvas draws, picked the way `templateChain` picks them — a scope
 * node is one chip for its own id, not one per child. An empty list means the
 * document does not parse: the row then shows no chips rather than steps nobody
 * observed.
 */
export function templateSteps(template: PipelineTemplate): string[] {
  const parsed = parseGraph(template.documentYaml);
  if (!parsed.ok) return [];
  return parsed.model.nodes.filter((node) => node.scope.length === 0).map((node) => node.id);
}

/**
 * The row's one-line description: the template's own metadata sentence cut to
 * its first. Blank has no document to describe, and its metadata line is a note
 * to whoever maintains the skeleton, so it keeps the words the old dialog and
 * the Workflows index cards use for it (`starterHint`, copied here because that
 * file goes away with the old library page).
 */
export function templateBlurb(template: PipelineTemplate): string {
  if (template.id === "blank")
    return "One agent step to start from. Add and edit steps on the canvas.";
  return firstSentence(template.description);
}

interface TemplateRowProps {
  template: PipelineTemplate;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
}

/** A quiet card row: the starter's name, its line, its steps as chips joined by
 * arrows, and the verb at the right. On phone the row stacks — the verb under
 * the text — and grows to the contract's 44px touch target. */
function TemplateRow({ template, busy, disabled, onUse }: TemplateRowProps) {
  const steps = templateSteps(template);
  const shown = steps.slice(0, MAX_STEP_CHIPS);
  const hidden = steps.length - shown.length;
  const chip =
    "rounded-[6px] border border-line px-[6px] py-[1px] font-mono text-[10.5px] text-muted";
  return (
    <div className="flex items-center gap-[12px] rounded-[10px] border border-line bg-surface p-[10px_12px] transition-colors hover:border-line-strong max-md:flex-col max-md:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
        <span className="text-[13.5px] font-semibold">{template.label}</span>
        <span className="text-[12.5px] text-muted">{templateBlurb(template)}</span>
        {shown.length > 0 ? (
          <span
            className="flex flex-wrap items-center gap-[4px]"
            data-testid={`new-workflow-template-steps-${template.id}`}
          >
            <span className="sr-only">Steps: </span>
            {shown.map((step, index) => (
              <Fragment key={step}>
                {index > 0 ? (
                  <span aria-hidden="true" className="text-[10.5px] text-faint">
                    →
                  </span>
                ) : null}
                <span className={chip}>{step}</span>
              </Fragment>
            ))}
            {hidden > 0 ? (
              <span className={`${chip} text-faint`}>
                <span aria-hidden="true">+{hidden}</span>
                <span className="sr-only">{` ${hidden} more ${hidden === 1 ? "step" : "steps"}`}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onUse}
        disabled={disabled}
        data-testid={`new-workflow-template-${template.id}`}
        className="flex h-[28px] shrink-0 items-center rounded-[8px] border border-line bg-surface px-[12px] text-[12.5px] font-semibold hover:border-line-strong disabled:cursor-not-allowed disabled:border-line disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-md:min-h-[44px] max-md:px-[16px]"
      >
        {busy ? "Creating…" : "Use this"}
        <span className="sr-only">{` the ${template.label} template`}</span>
      </button>
    </div>
  );
}

export interface NewWorkflowSheetProps {
  /** The page's scope: a project id, or null for All projects. */
  scope: string | null;
  /** What that scope is called — "All projects", or the project's own name.
   * The sheet creates the workflow IN the scope, and at All scope nothing on it
   * said which workflow would own the result (review 08-1280-3). Empty or null
   * while the scope's read has not landed: the title then stays bare. */
  scopeName?: string | null;
  /** The org's real workflows, for the `OR COPY` chips (up to 8 are shown). */
  workflows: PipelineSummary[];
  onClose: () => void;
}

export function NewWorkflowSheet({
  scope,
  scopeName = null,
  workflows,
  onClose,
}: NewWorkflowSheetProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [description, setDescription] = useState("");
  /** Which of the sheet's create buttons is in flight: `sketch`, `blank`, or
   * `template:<id>` — the row that must say `Creating…` while its two writes
   * run. Anything non-empty keeps every create inert. */
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  /** The sentence held nothing a slug could be made from — the server would
   * answer `400`, and its words are about JSON, not about what to type. */
  const [nameError, setNameError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** The template disclosure, closed by default: one click opens the rows in
   * place, under the copy section (review 08-1280-1). */
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  const speech = useSpeechToText();
  const create = useCreatePipeline();
  const queryClient = useQueryClient();
  const duplicate = useDuplicatePipeline(workflows.map((workflow) => workflow.slug));

  /** `POST /pipelines/{id}/drafts` for a pipeline that exists only as the
   * answer of the write before it — the reason `useCreateDraft(pipelineId)`
   * cannot be used here (its id has to be known when the hook opens). Same
   * two writes, same cache rolls, as `ImportYamlDialog` performs. */
  async function createFirstDraft(pipelineId: string, documentYaml: string): Promise<Draft> {
    const draft = await apiFetch<Draft>(`/api/v1/pipelines/${pipelineId}/drafts`, {
      method: "POST",
      json: { document_yaml: documentYaml },
    });
    queryClient.setQueryData(queryKeys.draft(draft.id), draft);
    await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineDrafts(pipelineId) });
    return draft;
  }

  // The dictated words land in the box; the person still presses Sketch it.
  useEffect(() => {
    const words = [speech.final, speech.interim].filter((part) => part && part.trim()).join(" ");
    if (words === "") return;
    setDescription((current) => (current.trim() === "" ? words : `${current.trim()} ${words}`));
    speech.reset();
    // `speech.reset` is stable; the effect reads the two transcript fields only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.final, speech.interim]);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    // The description box opens the sheet's one job, so it — not the × that
    // precedes it in the DOM — takes the caret.
    containerRef.current?.querySelector<HTMLTextAreaElement>("#new-workflow-description")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        // The import dialog owns the screen while it is open; Esc closes it,
        // not the sheet behind it.
        if (importOpen) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.closest('[data-testid="import-yaml-dialog"]') === null,
      );
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
  }, [onClose, importOpen]);

  /** The two writes every create on this sheet makes: the logical pipeline,
   * then its first draft (ADR-0002 — never a draft against an id the server
   * has not accepted). */
  async function createWorkflow(
    name: string,
    documentYaml: string,
  ): Promise<{
    pipeline: Pipeline;
    draft: Draft;
  }> {
    const slug = generateSlug(name);
    const pipeline = await create.mutateAsync({
      slug,
      display_name: name || undefined,
    });
    const draft = await createFirstDraft(pipeline.id, withMetadataName(documentYaml, slug));
    return { pipeline, draft };
  }

  function sketch() {
    const text = description.trim();
    if (text === "" || busy) return;
    if (generateSlug(nameFromDescription(text)) === "") {
      setNameError("That holds no words to name a workflow — type a few.");
      return;
    }
    setNameError(null);
    setBusy("sketch");
    setFailure(null);
    void (async () => {
      try {
        const { pipeline, draft } = await createWorkflow(
          nameFromDescription(text),
          BLANK_SKELETON_YAML,
        );
        writeDescription(pipeline.id, text);
        onClose();
        navigate(routes.factoryWorkflow(pipeline.id, scope, { draft: draft.id, describe: "1" }));
      } catch (error) {
        setFailure(error);
        setBusy("");
      }
    })();
  }

  /** `Use this` on a template row: the old dialog's create for that starter,
   * unchanged — the name it suggested (its label) is the name the workflow
   * gets, the id follows it through the same `generateSlug`, the document is
   * the sample's own bytes with `metadata.name` rewritten to that id, and the
   * two writes are the sheet's `createWorkflow`. Blank is the exception the
   * dialog also made (a starter nobody names): it takes `Untitled workflow`,
   * the same name the sheet's own `Blank canvas` link gives. */
  function useTemplate(template: PipelineTemplate) {
    if (busy) return;
    setBusy(`template:${template.id}`);
    setFailure(null);
    void (async () => {
      try {
        const name = template.id === "blank" ? "Untitled workflow" : template.label;
        const { pipeline, draft } = await createWorkflow(name, template.documentYaml);
        onClose();
        navigate(routes.factoryWorkflow(pipeline.id, scope, { draft: draft.id }));
      } catch (error) {
        setFailure(error);
        setBusy("");
      }
    })();
  }

  function blankCanvas() {
    if (busy) return;
    setBusy("blank");
    setFailure(null);
    void (async () => {
      try {
        // Exactly the dialog's Blank path: the skeleton draft, named Untitled
        // workflow — the person renames it on the canvas, not in a form here.
        const { pipeline, draft } = await createWorkflow("Untitled workflow", BLANK_SKELETON_YAML);
        onClose();
        navigate(routes.factoryWorkflow(pipeline.id, scope, { draft: draft.id }));
      } catch (error) {
        setFailure(error);
        setBusy("");
      }
    })();
  }

  function copy(workflow: PipelineSummary) {
    if (duplicate.isPending) return;
    setFailure(null);
    duplicate.mutate(workflow.id, {
      onSuccess: ({ pipeline, draft }) => {
        onClose();
        navigate(routes.factoryWorkflow(pipeline.id, scope, { draft: draft.id }));
      },
      onError: (error) => setFailure(error),
    });
  }

  const primaryButton =
    "flex h-[34px] items-center gap-[6px] rounded-[9px] bg-accent px-[14px] text-[13px] font-semibold text-white no-underline hover:bg-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg";

  const sheetTitle = scopeName ? `New workflow in ${scopeName}` : "New workflow";

  return (
    <div
      // The scrim is the content area, not the window: the rail (64px) and the
      // top bar (60px / 52px on phone) stay undimmed and clickable, and the
      // sheet starts 40px under the bar — the prototype's placement
      // (review 08-1280-4). A phone keeps the contract's full-width bottom sheet.
      className="fixed top-[52px] right-0 bottom-0 left-0 z-50 flex items-start justify-center bg-ink/25 p-4 max-md:items-end max-md:p-0 md:top-[60px] md:left-16 md:pt-[40px]"
      data-testid="new-workflow-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workflow-sheet-title"
        data-testid="new-workflow-sheet"
        className="flex max-h-full w-[720px] max-w-full flex-col gap-[20px] overflow-y-auto rounded-[14px] bg-surface p-[24px] shadow-(--shadow-modal) max-md:max-h-[85dvh] max-md:w-full max-md:rounded-b-none max-md:p-[16px]"
      >
        <div className="flex items-center gap-[10px]">
          <h2 id="new-workflow-sheet-title" className="m-0 text-[18px] font-bold">
            {sheetTitle}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            data-testid="new-workflow-close"
            className="ml-auto flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconX size={18} stroke={1.5} aria-hidden />
          </button>
        </div>

        {/* 1. Describe it */}
        <div className="flex flex-col gap-[12px]">
          <label htmlFor="new-workflow-description" className="sr-only">
            Describe the workflow
          </label>
          <div className="flex flex-col gap-[10px] rounded-[14px] border-[1.5px] border-accent p-[14px_16px] ring-4 ring-accent-ring">
            <textarea
              id="new-workflow-description"
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe what should happen, e.g. “When an issue gets the 'ready' label, plan it, implement it, run the tests, and ask me before merging.”"
              data-testid="new-workflow-description"
              className="w-full resize-none border-0 bg-transparent text-[15px] leading-[22px] text-ink outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-[8px]">
              {speech.supported ? (
                <button
                  type="button"
                  onClick={() => (speech.listening ? speech.stop() : speech.start())}
                  aria-pressed={speech.listening}
                  data-testid="new-workflow-say-it"
                  className={`flex h-[30px] shrink-0 items-center gap-[6px] rounded-full border border-line px-[11px] text-[12.5px] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                    speech.listening ? "bg-accent text-white" : "bg-surface"
                  }`}
                >
                  <IconMicrophone size={14} stroke={1.5} aria-hidden />
                  {speech.listening ? "Listening…" : "Say it"}
                </button>
              ) : null}
              {/* The promise rides the box's own bottom row, between the two
                  buttons the prototype has it beside (review 08-1280-2) — it is
                  what `Sketch it` does, so it belongs with `Sketch it`. */}
              <p className="m-0 min-w-0 flex-1 text-[12px] text-muted">
                Steps get sketched on the canvas. Nothing runs until you make it live.
              </p>
              <button
                type="button"
                onClick={sketch}
                disabled={description.trim() === "" || Boolean(busy)}
                data-testid="new-workflow-sketch"
                className={`${primaryButton} ml-auto shrink-0`}
              >
                <IconSparkles size={15} stroke={1.5} aria-hidden />
                {busy === "sketch" ? "Sketching…" : "Sketch it"}
              </button>
            </div>
          </div>
          {speech.error ? (
            <p className="m-0 text-[12px] text-st-failed-tag-fg">{speech.error}</p>
          ) : null}
        </div>

        {/* 2. From a repeated chat chain: no API serves detected chains yet,
            so this section carries its label and the one sentence that is
            true — never a row of invented "you keep doing this". */}
        <div className="flex flex-col gap-[8px]">
          <SectionLabel id="new-workflow-chats-label" testid="new-workflow-chats-label">
            Or from something you keep doing in chats
          </SectionLabel>
          <p className="m-0 text-[12.5px] text-muted" data-testid="new-workflow-chats-empty">
            Nothing spotted yet. When the same steps keep happening in chats, they show up here.
          </p>
        </div>

        {/* 3. Copy something that already exists */}
        <div className="flex flex-wrap items-center gap-[8px]">
          <SectionLabel id="new-workflow-copy-label" testid="new-workflow-copy-label">
            Or copy
          </SectionLabel>
          {workflows.slice(0, 8).map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => copy(workflow)}
              disabled={duplicate.isPending}
              data-testid={`new-workflow-copy-${workflow.id}`}
              className="rounded-full border border-line px-[11px] py-[5px] text-[12.5px] hover:border-line-strong disabled:cursor-not-allowed disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {workflow.display_name || workflow.slug}
            </button>
          ))}
        </div>

        {/* 4. The two ways that skip both */}
        <div className="flex flex-wrap items-center gap-[14px]">
          <button
            type="button"
            onClick={blankCanvas}
            disabled={Boolean(busy)}
            data-testid="new-workflow-blank"
            className="flex items-center gap-[5px] text-[12.5px] font-semibold text-accent-text no-underline hover:underline disabled:cursor-not-allowed disabled:text-disabled-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            <IconPlus size={13} stroke={1.5} aria-hidden />
            Blank canvas
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            data-testid="new-workflow-import"
            className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Import YAML
          </button>
        </div>

        {/* 5. The vetted samples the old New workflow dialog offered, BELOW the
            README's three parts and folded away until asked: an open section of
            four template rows pushed `OR COPY` and the two links past the fold
            of a 1280x800 window (review 08-1280-1). One row per template, in the
            library's own order — the Blank template is dropped: the sheet already
            offers "Blank canvas" two rows above, and the same thing twice is not a
            choice. The disclosure is absent when no template is left. */}
        {templates.length > 0 ? (
          <div className="flex flex-col gap-[8px]">
            <button
              type="button"
              onClick={() => setTemplatesOpen((open) => !open)}
              aria-expanded={templatesOpen}
              data-testid="new-workflow-templates-toggle"
              className="flex w-fit items-center gap-[8px] rounded-[8px] px-[2px] py-[3px] text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <SectionLabel id="new-workflow-templates-label" testid="new-workflow-templates-label">
                {`Start from a template (${templates.length})`}
              </SectionLabel>
              <IconChevronDown
                size={14}
                stroke={1.5}
                aria-hidden
                className={`shrink-0 text-muted transition-transform ${
                  templatesOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {templatesOpen ? (
              <div className="flex flex-col gap-[8px]">
                {templates.map((template) => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    busy={busy === `template:${template.id}`}
                    disabled={Boolean(busy)}
                    onUse={() => useTemplate(template)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {nameError ? (
          <p
            className="m-0 text-[12.5px] text-st-failed-tag-fg"
            data-testid="new-workflow-name-error"
            role="alert"
          >
            {nameError}
          </p>
        ) : null}
        {failure ? <FormError error={failure} testid="new-workflow-sheet-error" /> : null}
        <ImportYamlDialog open={importOpen} onClose={() => setImportOpen(false)} />
      </div>
    </div>
  );
}
