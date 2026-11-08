/**
 * InputsTab — the workflow page's Inputs tab (design 1j, ADR-0066).
 *
 * Everything here edits the OPEN DRAFT's document, and only the draft: the
 * three operations (add, edit, remove) are pure text→text writes through
 * `inputDoc` applied to `spec.inputs`, saved through the same
 * `PUT /api/v1/drafts/{id}` path the Studio saves through — the panel owns no
 * shadow copy of the inputs. With no draft open, the first save creates one
 * exactly the way `Edit workflow` does (clone the newest revision's document,
 * or the named blank skeleton when nothing published exists), applies the
 * edit to it, and saves. After each save the tab re-validates the draft —
 * that is what refreshes the server's `input_specs` reading and the
 * `input_unfillable_by_trigger` warnings the WHO FILLS rail shows.
 *
 * The row list reads the draft's live document when a draft exists (so the
 * tab never shows yesterday's plan behind today's edit) and the revision's
 * server-derived `input_specs` otherwise. The grid is the design's
 * `130px 120px 80px minmax(0,1fr)`, shrinking to fit at phone widths so the
 * page never scrolls sideways.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../ds/Button";
import { Panel } from "../../ds/Panel";
import { labelClass } from "../../ds/Field";
import { ProblemBanner, Spinner } from "../../Feedback";
import { ToggleSwitch } from "../ToggleSwitch";
import { useCreateDraft, useDraft, usePutDraft, useValidateDraft } from "../../../api/pipelines";
import { BLANK_SKELETON_YAML, withMetadataName } from "../../../lib/pipeline/templates";
import type { PipelineRevision } from "../../../api/types";
import type { PipelineDraftSummary } from "../../../lib/pipeline/contract";
import type { UsedInGroup } from "../../../pages/workflow/useUsedIn";
import {
  applyInputEdit,
  draftInputSpecs,
  draftTextParses,
  inputTypeLabel,
  inputsYamlPreview,
  suggestInputName,
  usedByStepNames,
  INPUT_NAME,
  INPUT_TYPES,
  type DraftInputSpec,
  type InputEdit,
} from "./inputDoc";
import { WhoFillsPanel } from "./WhoFillsPanel";

export interface InputsTabProps {
  pipelineId: string;
  slug: string;
  canAuthor: boolean;
  /** The newest revision read (the fallback the edits clone from). */
  revision: PipelineRevision | undefined;
  revisionLoading: boolean;
  revisionError: unknown;
  onRevisionRetry: () => void;
  openDraft: PipelineDraftSummary | null;
  groups: UsedInGroup[];
  groupsLoading: boolean;
  groupsError: boolean;
}

/** The row editor's working copy — plain strings, exactly what the fields
 * hold, so a Save can rebuild the property without parsing the DOM. */
interface EditorState {
  name: string;
  label: string;
  type: string;
  help: string;
  required: boolean;
  defaultText: string;
}

function editorOf(spec: DraftInputSpec): EditorState {
  return {
    name: spec.name,
    label: spec.label ?? "",
    type: spec.type,
    help: spec.help ?? "",
    required: spec.required,
    defaultText: typeof spec.default === "string" ? spec.default : "",
  };
}

export function InputsTab({
  pipelineId,
  slug,
  canAuthor,
  revision,
  revisionLoading,
  revisionError,
  onRevisionRetry,
  openDraft,
  groups,
  groupsLoading,
  groupsError,
}: InputsTabProps) {
  const draftId = openDraft?.id ?? "";
  const draftRead = useDraft(draftId);
  const putDraft = usePutDraft(draftId);
  const validateDraft = useValidateDraft(draftId, pipelineId);
  const createDraft = useCreateDraft(pipelineId);

  const [expanded, setExpanded] = useState<EditorState | null>(null);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<string>("text");
  const [saveError, setSaveError] = useState<unknown>(null);
  // The edit that waits for a draft to exist: with no draft, a save first
  // clones (POST /drafts, exactly `Edit workflow`'s move) and this state
  // carries the edit until the fresh draft has been read back.
  const [pending, setPending] = useState<{ edit: InputEdit; openAfter: string | null } | null>(
    null,
  );

  const draftText = draftRead.data?.document_yaml;
  const baseText = openDraft ? (draftText ?? "") : (revision?.document_text ?? "");
  const specs = useMemo<DraftInputSpec[]>(() => {
    if (openDraft) return draftText ? draftInputSpecs(draftText) : [];
    if (revision?.document_text && draftTextParses(revision.document_text))
      return draftInputSpecs(revision.document_text);
    // A revision whose text is absent or unreadable falls back to the server's
    // own derived reading — the same six fields, the same name sort.
    return (revision?.input_specs ?? []).map((spec) => ({
      name: spec.name,
      type: spec.type,
      label: spec.label,
      help: spec.help,
      required: spec.required,
      ...(spec.default === undefined ? {} : { default: spec.default }),
    }));
  }, [openDraft, draftText, revision]);

  const warnings = openDraft ? (draftRead.data?.validation?.warnings ?? []) : [];

  /** Write the new text to the draft and ask the server to judge it; returns
   * the saved text so the caller can open the editor on what it produced. */
  async function commit(documentYaml: string, version: number, edit: InputEdit) {
    const next = applyInputEdit(documentYaml, edit);
    await putDraft.mutateAsync({ document_yaml: next, version });
    await validateDraft.mutateAsync();
    return next;
  }

  // Flush a queued edit once the draft it belongs to has been created and
  // read back. The guard clears `pending` before awaiting so one queued edit
  // fires exactly one save.
  useEffect(() => {
    if (!pending || !draftRead.data || draftId === "") return;
    if (draftRead.data.id !== draftId) return;
    const { edit, openAfter } = pending;
    setPending(null);
    void (async () => {
      try {
        const saved = await commit(draftRead.data!.document_yaml, draftRead.data!.version, edit);
        setSaveError(null);
        if (openAfter !== null) openEditorOnText(saved, openAfter);
      } catch (error) {
        setSaveError(error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, draftRead.data, draftId]);

  /** Open the row editor on the property the text now holds. */
  function openEditorOnText(text: string, name: string) {
    const created = draftInputSpecs(text).find((spec) => spec.name === name);
    if (created) setExpanded(editorOf(created));
  }

  /** Run one edit: save straight to the open draft, or clone a draft first
   * and queue the edit for it. True = the edit was saved or queued. */
  async function saveEdit(edit: InputEdit, openAfter: string | null): Promise<boolean> {
    setSaveError(null);
    try {
      if (openDraft && draftRead.data) {
        const next = await commit(draftRead.data.document_yaml, draftRead.data.version, edit);
        if (openAfter !== null) openEditorOnText(next, openAfter);
        return true;
      }
      if (revisionLoading) return false;
      setPending({ edit, openAfter });
      const seed = revision?.document_text ?? withMetadataName(BLANK_SKELETON_YAML, slug);
      await createDraft.mutateAsync({ document_yaml: seed });
      return true;
    } catch (error) {
      setSaveError(error);
      setPending(null);
      return false;
    }
  }

  // Read states the tab owes an answer for, before any panel is drawn.
  if (revisionError) {
    return (
      <div className="max-w-[70ch]" data-testid="inputs-error-card">
        <ProblemBanner
          error={revisionError}
          fallback="The workflow's inputs could not be read."
          subject="the workflow's inputs"
          hint="Nothing can be edited until the workflow reads."
          retry={{
            onClick: onRevisionRetry,
            pending: revisionLoading,
            testid: "inputs-error-retry",
          }}
          testid="inputs-load-problem"
        />
      </div>
    );
  }
  if (openDraft && draftRead.isError) {
    return (
      <div className="max-w-[70ch]" data-testid="inputs-error-card">
        <ProblemBanner
          error={draftRead.error}
          fallback="The open draft could not be read."
          subject="the open draft"
          hint="Inputs edit the draft, so nothing shows until the draft reads."
          retry={{
            onClick: () => void draftRead.refetch(),
            pending: draftRead.isFetching,
            testid: "inputs-error-retry",
          }}
          testid="inputs-load-problem"
        />
      </div>
    );
  }
  if (openDraft && draftRead.isPending) return <Spinner label="Loading the draft's inputs" />;
  if (!revision && !openDraft && revisionLoading) return <Spinner label="Loading the workflow" />;
  if (openDraft && draftText !== undefined && !draftTextParses(draftText)) {
    return (
      <div className="max-w-[70ch]" data-testid="inputs-error-card">
        <div className="rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body p-[12px]">
          <p className="text-[12.5px] text-ink" data-testid="inputs-unparsable">
            The draft's YAML cannot be read — the Inputs tab edits the draft, so it shows nothing
            until the document parses. Fix it in the Studio.
          </p>
        </div>
      </div>
    );
  }

  const busy =
    putDraft.isPending || validateDraft.isPending || createDraft.isPending || pending !== null;
  const savingNote = busy ? "saving…" : null;
  const validateErrors = draftRead.data?.validation?.errors ?? [];

  return (
    <div
      className="grid min-w-0 grid-cols-1 items-start gap-[14px] lg:grid-cols-[minmax(0,1fr)_320px]"
      data-testid="inputs-tab"
    >
      {/* ---------------------------------------------------- INPUTS · n */}
      <Panel
        title={`INPUTS · ${specs.length}`}
        headingId="inputs-heading"
        headingLevel={2}
        titleWraps
        meta={
          canAuthor ? (
            <button
              type="button"
              className="font-mono text-[10.5px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              data-testid="input-add"
              onClick={() => {
                setAdding(true);
                setAddName(suggestInputName(specs.map((spec) => spec.name)));
                setAddType("text");
                setExpanded(null);
              }}
            >
              + add input
            </button>
          ) : null
        }
      >
        <div
          className="grid grid-cols-[minmax(0,104px)_minmax(0,96px)_minmax(0,60px)_minmax(0,1fr)] items-center gap-[6px] border-b border-line px-[12px] py-[6px] font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-faint lg:grid-cols-[130px_120px_80px_minmax(0,1fr)]"
          data-testid="inputs-header-row"
        >
          <span>name</span>
          <span>type</span>
          <span>required</span>
          <span>default</span>
        </div>
        {specs.length === 0 && !adding ? (
          <p className="px-[12px] py-[14px] text-[12.5px] text-muted" data-testid="inputs-empty">
            No inputs yet. Add one so runs can ask for what they need.
          </p>
        ) : null}
        {specs.map((spec) => {
          const open = expanded?.name === spec.name;
          return (
            <div key={spec.name} data-testid={`input-item-${spec.name}`}>
              <button
                type="button"
                className={`grid w-full grid-cols-[minmax(0,104px)_minmax(0,96px)_minmax(0,60px)_minmax(0,1fr)] items-center gap-[6px] px-[12px] py-[8px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent lg:grid-cols-[130px_120px_80px_minmax(0,1fr)] ${
                  open ? "bg-accent-wash" : "hover:bg-accent-wash/60"
                }`}
                aria-expanded={open}
                data-testid={`input-row-${spec.name}`}
                onClick={() => {
                  if (!open) setExpanded(editorOf(spec));
                  else setExpanded(null);
                }}
              >
                <span className="truncate font-mono text-[12.5px] font-semibold text-ink">
                  {spec.name}
                </span>
                <span className="truncate text-[12.5px] text-ink-2">
                  {inputTypeLabel(spec.type)}
                </span>
                <span
                  className={`font-mono text-[10.5px] ${
                    spec.required ? "text-st-failed-tag-fg" : "text-faint"
                  }`}
                >
                  {spec.required ? "required" : "optional"}
                </span>
                <span className="truncate font-mono text-[11.5px] text-ink-2">
                  {spec.default === undefined
                    ? "—"
                    : typeof spec.default === "string"
                      ? spec.default
                      : JSON.stringify(spec.default)}
                </span>
              </button>
              {open && expanded ? (
                <RowEditor
                  state={expanded}
                  steps={usedByStepNames(baseText, spec.name)}
                  canAuthor={canAuthor}
                  busy={busy}
                  onChange={setExpanded}
                  onSave={() => {
                    const edit: InputEdit = {
                      op: "edit",
                      name: expanded.name,
                      patch: {
                        type: expanded.type,
                        label: expanded.label,
                        help: expanded.help,
                        required: expanded.required,
                        ...(expanded.type === "github_issue"
                          ? {}
                          : { defaultText: expanded.defaultText }),
                      },
                    };
                    void saveEdit(edit, null).then((ok) => {
                      if (ok) setExpanded(null);
                    });
                  }}
                  onCancel={() => setExpanded(null)}
                  onRemove={() => {
                    void saveEdit({ op: "remove", name: expanded.name }, null).then(() =>
                      setExpanded(null),
                    );
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {adding ? (
          <div
            className="border-t border-line bg-accent-wash px-[12px] py-[10px]"
            data-testid="input-add-form"
          >
            <div className="grid gap-[8px] sm:grid-cols-[minmax(0,160px)_minmax(0,170px)_auto] sm:items-end">
              <label className="block">
                <span className={labelClass}>Name</span>
                <input
                  value={addName}
                  onChange={(event) => setAddName(event.target.value)}
                  className={`${"mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none"} ${
                    INPUT_NAME.test(addName) ? "" : "border-st-failed-strong"
                  }`}
                  data-testid="input-add-name"
                  aria-invalid={!INPUT_NAME.test(addName)}
                />
              </label>
              <label className="block">
                <span className={labelClass}>Type</span>
                <select
                  value={addType}
                  onChange={(event) => setAddType(event.target.value)}
                  className="mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none"
                  data-testid="input-add-type"
                >
                  {INPUT_TYPES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-[6px]">
                <Button
                  variant="primary"
                  compact
                  disabled={!INPUT_NAME.test(addName) || busy}
                  onClick={() => {
                    const name = addName;
                    const type = addType;
                    setAdding(false);
                    void saveEdit({ op: "add", name, type }, name);
                  }}
                  data-testid="input-add-save"
                >
                  Add input
                </Button>
                <Button
                  variant="ghost"
                  compact
                  onClick={() => setAdding(false)}
                  data-testid="input-add-cancel"
                >
                  Cancel
                </Button>
              </div>
            </div>
            {!INPUT_NAME.test(addName) ? (
              <p
                className="mt-[4px] font-mono text-[10.5px] text-st-failed-tag-fg"
                data-testid="input-add-name-error"
              >
                names are lowercase letters, digits and underscores, starting with a letter
              </p>
            ) : null}
          </div>
        ) : null}
        {savingNote ? (
          <p
            className="border-t border-line px-[12px] py-[6px] font-mono text-[10.5px] text-faint"
            data-testid="inputs-saving"
          >
            {savingNote}
          </p>
        ) : null}
      </Panel>

      {/* ------------------------------------------------- right column */}
      <div className="flex min-w-0 flex-col gap-[14px]">
        <WhoFillsPanel
          specs={specs}
          groups={groups}
          loading={groupsLoading}
          error={groupsError}
          warnings={warnings}
        />
        <Panel title="YAML" headingId="inputs-yaml-heading" headingLevel={2}>
          <pre
            className="overflow-x-auto px-[12px] py-[10px] font-mono text-[11px] leading-[1.5] text-ink-2"
            data-testid="inputs-yaml-preview"
          >
            {inputsYamlPreview(specs)}
          </pre>
        </Panel>
      </div>

      {/* A refused save or an invalid verdict speaks under the list, in the
          server's words — the document saved is still the author's to fix in
          the Studio. */}
      {saveError ? (
        <div className="col-span-full" data-testid="inputs-save-error">
          <ProblemBanner
            error={saveError}
            fallback="The draft could not be saved."
            subject="the draft"
            verb="save"
            testid="inputs-save-problem"
          />
        </div>
      ) : null}
      {!saveError &&
      openDraft &&
      draftRead.data?.status === "invalid" &&
      validateErrors.length > 0 ? (
        <div className="col-span-full" data-testid="inputs-validate-error">
          <p className="rounded-[4px] border border-st-waiting-pale-edge bg-st-waiting-pale-body px-[12px] py-[8px] text-[12px] text-st-waiting-pale-fg">
            {`the server marked the draft invalid — ${validateErrors[0].message}`}
            {validateErrors.length > 1 ? ` (+${validateErrors.length - 1} more)` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- row editor */

interface RowEditorProps {
  state: EditorState;
  steps: string[];
  canAuthor: boolean;
  busy: boolean;
  onChange(next: EditorState): void;
  onSave(): void;
  onCancel(): void;
  onRemove(): void;
}

/** The accent-wash expansion (design 1j): Label, Type, Help text, Required,
 * Default, and the reference line naming the steps that read the input. */
function RowEditor({
  state,
  steps,
  canAuthor,
  busy,
  onChange,
  onSave,
  onCancel,
  onRemove,
}: RowEditorProps) {
  const id = state.name;
  const set = (patch: Partial<EditorState>) => onChange({ ...state, ...patch });
  return (
    <div
      className="border-t border-accent-ring bg-accent-wash px-[12px] py-[10px]"
      data-testid={`input-editor-${id}`}
    >
      <div className="grid gap-[10px] sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
        <label className="block">
          <span className={labelClass}>Label</span>
          <input
            value={state.label}
            disabled={!canAuthor}
            onChange={(event) => set({ label: event.target.value })}
            className="mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none"
            data-testid={`input-label-${id}`}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Type</span>
          <select
            value={INPUT_TYPES.some((entry) => entry.value === state.type) ? state.type : "text"}
            disabled={!canAuthor}
            onChange={(event) => set({ type: event.target.value })}
            className="mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none"
            data-testid={`input-type-${id}`}
          >
            {INPUT_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="mt-[10px] block">
        <span className={labelClass}>Help text</span>
        <input
          value={state.help}
          disabled={!canAuthor}
          onChange={(event) => set({ help: event.target.value })}
          className="mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 text-[12.5px] text-ink focus-visible:border-ink focus-visible:outline-none"
          data-testid={`input-help-${id}`}
        />
      </label>
      <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
        {canAuthor ? (
          <ToggleSwitch
            checked={state.required}
            testid={`input-required-${id}`}
            label={`mark ${state.name} required`}
            stateWords={["required", "optional"]}
            onChange={(next) => set({ required: next })}
          />
        ) : (
          <span
            className={`font-mono text-[11px] ${
              state.required ? "text-st-failed-tag-fg" : "text-faint"
            }`}
            data-testid={`input-required-${id}-state`}
          >
            {state.required ? "required" : "optional"}
          </span>
        )}
        {state.type !== "github_issue" ? (
          <label className="block min-w-0 flex-1">
            <span className={labelClass}>Default</span>
            <input
              value={state.defaultText}
              disabled={!canAuthor}
              onChange={(event) => set({ defaultText: event.target.value })}
              className="mt-[3px] w-full rounded-[3px] border border-line-strong bg-surface px-[10px] py-1 font-mono text-[12px] text-ink placeholder:text-faint focus-visible:border-ink focus-visible:outline-none"
              data-testid={`input-default-${id}`}
              placeholder="no default"
            />
          </label>
        ) : null}
      </div>
      <p className="mt-[10px] font-mono text-[11px] text-muted" data-testid={`input-used-${id}`}>
        {steps.length === 0
          ? "not used by any step yet"
          : `used as \`\${{ inputs.${state.name} }}\` in ${steps.join(", ")}`}
      </p>
      {canAuthor ? (
        <div className="mt-[10px] flex items-center gap-[6px]">
          <Button
            variant="primary"
            compact
            disabled={busy}
            onClick={onSave}
            data-testid={`input-save-${id}`}
          >
            Save input
          </Button>
          <Button
            variant="ghost"
            compact
            onClick={onCancel}
            data-testid={`input-editor-cancel-${id}`}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            compact
            disabled={busy}
            className="ml-auto text-st-failed-tag-fg"
            onClick={onRemove}
            data-testid={`input-remove-${id}`}
            title="removes the input from the draft — validation then names any step still reading it"
          >
            Remove
          </Button>
        </div>
      ) : (
        <p
          className="mt-[10px] font-mono text-[10.5px] text-faint"
          data-testid={`input-readonly-${id}`}
        >
          You can view this workflow, not edit it.
        </p>
      )}
    </div>
  );
}
