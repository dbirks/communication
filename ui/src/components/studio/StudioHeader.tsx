/**
 * StudioHeader — the draft header row of the Workflow Studio
 * (`docs/design/studio-workbench.md` §3.1): the pipeline name, `draft vN`,
 * the server's last validation chip, Undo/Redo, Save / Validate / Diff /
 * Publish, and the Canvas | YAML segmented toggle.
 *
 * Presentation only — every state the header renders comes in as props; the
 * publish gate (saved + server-valid, with the reason as visible text, not
 * just hover) is computed by the page and handed down.
 */
import { Button } from "../ds/Button";
import { LIBRARY_READ_ONLY_NOTE } from "../../lib/pipeline/authoring";
import type { ValidateBody } from "../../lib/pipeline/contract";

export type StudioView = "canvas" | "yaml";

export interface StudioHeaderProps {
  pipelineName: string;
  /** The version last written or read from the server. */
  savedVersion: number | null;
  /** The draft's last server validation (`viewValidate` over its body). */
  validation: ValidateBody | null;
  /** No library role, or the draft is published: Save/Publish are hidden. */
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  saving: boolean;
  dirty: boolean;
  onValidate(): void;
  validatePending: boolean;
  onDiff(): void;
  diffOpen: boolean;
  onPublish(): void;
  publishPending: boolean;
  /** null = publish is available; otherwise the reason, shown as visible text. */
  publishReason: string | null;
  view: StudioView;
  onViewChange(view: StudioView): void;
}

export function StudioHeader({
  pipelineName,
  savedVersion,
  validation,
  readOnly,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  saving,
  dirty,
  onValidate,
  validatePending,
  onDiff,
  diffOpen,
  onPublish,
  publishPending,
  publishReason,
  view,
  onViewChange,
}: StudioHeaderProps) {
  const findings = validation?.errors.length ?? 0;
  return (
    <header
      className="flex flex-wrap items-center gap-[8px] border-b border-line bg-surface px-4 py-2"
      data-testid="studio-header"
    >
      <h1 className="text-[15px] font-bold" data-testid="studio-title">
        {pipelineName}
      </h1>
      <span className="font-mono text-[11px] text-muted" data-testid="studio-draft-version">
        draft v{savedVersion ?? "…"}
      </span>
      <span
        className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10px]"
        data-testid="studio-validation-chip"
      >
        {validation === null
          ? "not validated"
          : validation.valid
            ? `valid (${findings} findings)`
            : `invalid (${findings} findings)`}
      </span>
      {dirty ? (
        <span className="font-mono text-[10px] text-muted" data-testid="studio-dirty">
          unsaved
        </span>
      ) : null}
      <span className="flex-1" />
      <Button
        variant="secondary"
        compact
        disabled={!canUndo}
        onClick={onUndo}
        data-testid="studio-undo"
      >
        Undo
      </Button>
      <Button
        variant="secondary"
        compact
        disabled={!canRedo}
        onClick={onRedo}
        data-testid="studio-redo"
      >
        Redo
      </Button>
      {readOnly ? (
        <span className="font-mono text-[10.5px] text-faint" data-testid="studio-read-only-note">
          {LIBRARY_READ_ONLY_NOTE}
        </span>
      ) : (
        <>
          <Button
            variant="primary"
            compact
            disabled={saving}
            onClick={onSave}
            data-testid="studio-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="secondary"
            compact
            disabled={validatePending}
            onClick={onValidate}
            data-testid="studio-validate"
          >
            {validatePending ? "Validating…" : "Validate"}
          </Button>
          <Button
            variant="secondary"
            compact
            aria-pressed={diffOpen}
            onClick={onDiff}
            data-testid="studio-diff"
          >
            Diff
          </Button>
          <Button
            variant="primary"
            compact
            disabled={publishReason !== null || publishPending}
            onClick={onPublish}
            data-testid="studio-publish"
          >
            {publishPending ? "Publishing…" : "Publish"}
          </Button>
          {publishReason !== null ? (
            <span
              className="font-mono text-[10.5px] text-muted"
              data-testid="studio-publish-reason"
            >
              {publishReason}
            </span>
          ) : null}
        </>
      )}
      <span className="flex items-center gap-[2px] rounded-[3px] border border-line p-[2px]">
        <Button
          variant={view === "canvas" ? "primary" : "ghost"}
          compact
          aria-pressed={view === "canvas"}
          onClick={() => onViewChange("canvas")}
          data-testid="studio-view-canvas"
        >
          Canvas
        </Button>
        <Button
          variant={view === "yaml" ? "primary" : "ghost"}
          compact
          aria-pressed={view === "yaml"}
          onClick={() => onViewChange("yaml")}
          data-testid="studio-view-yaml"
        >
          YAML
        </Button>
      </span>
    </header>
  );
}
