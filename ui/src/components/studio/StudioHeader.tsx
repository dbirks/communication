/**
 * StudioHeader — the top bar of the Workflow Studio (design 1g):
 * breadcrumb `Workflows / <folder> /`, the workflow name (15/600), the draft
 * chip, the Canvas | YAML segmented control, then the action row (undo/redo
 * icon buttons, Validate, Save, Diff, Publish).
 *
 * The header is a single 52px row on desktop (≥768px). The publish reason
 * moved down into the StudioStatusBar — this bar keeps only the control and
 * the actions, so the row never truncates.
 *
 * Presentation only — every state the header renders comes in as props; the
 * publish gate (saved + server-valid, with the reason as visible text, not just
 * hover) is computed by the page and handed down.
 */
import { Link } from "react-router";
import { Button } from "../ds/Button";
import { routes } from "../../lib/routes";
import { folderLabel } from "../../api/pipelines";
import type { ValidateBody } from "../../lib/pipeline/contract";

export type StudioView = "canvas" | "yaml";

export interface StudioHeaderProps {
  pipelineName: string;
  /** The pipeline's folder label (design 1g breadcrumb: `Workflows / <folder> /`). */
  pipelineFolder?: string | null;
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
  /** null = publish is available; otherwise the reason (the status bar spells it). */
  publishReason: string | null;
  view: StudioView;
  onViewChange(view: StudioView): void;
}

function SegmentedControl({
  view,
  onViewChange,
}: {
  view: StudioView;
  onViewChange(view: StudioView): void;
}) {
  return (
    <div
      className="flex rounded-[3px] border border-line p-[2px]"
      data-testid="studio-header-tabs"
    >
      <div
        role="tablist"
        aria-label="Canvas and YAML views"
        className="flex items-center gap-[2px]"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "canvas"}
          onClick={() => onViewChange("canvas")}
          data-testid="studio-view-canvas"
          className={`rounded-[2px] px-[10px] py-[4px] text-[12.5px] font-semibold ${
            view === "canvas" ? "bg-ink text-surface" : "text-ink-2 hover:bg-fill"
          }`}
        >
          Canvas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "yaml"}
          onClick={() => onViewChange("yaml")}
          data-testid="studio-view-yaml"
          className={`rounded-[2px] px-[10px] py-[4px] text-[12.5px] font-semibold ${
            view === "yaml" ? "bg-ink text-surface" : "text-ink-2 hover:bg-fill"
          }`}
        >
          YAML
        </button>
      </div>
    </div>
  );
}

export function StudioHeader({
  pipelineName,
  pipelineFolder,
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
  const versionText = savedVersion === null ? "" : ` V${savedVersion}`;
  const chipText = `· DRAFT${versionText}${dirty ? " · UNSAVED" : ""}`;
  return (
    <header
      className="flex shrink-0 flex-col gap-[8px] border-b border-line bg-surface px-4 py-2 md:h-[52px] md:flex-row md:items-center md:overflow-x-auto md:py-0"
      data-testid="studio-header"
    >
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-[6px]"
        data-testid="studio-breadcrumb"
      >
        <Link
          to={routes.workflows()}
          className="shrink-0 font-mono text-[12px] text-muted underline decoration-line underline-offset-2 hover:text-ink"
          data-testid="studio-breadcrumb-workflows"
        >
          Workflows
        </Link>
        <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-faint">
          /
        </span>
        <span className="shrink-0 font-mono text-[12px] text-muted" data-testid="studio-breadcrumb-folder">
          {folderLabel(pipelineFolder)}
        </span>
        <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-faint">
          /
        </span>
      </nav>
      <h1
        className="min-w-[160px] truncate text-[15px] font-semibold md:max-w-[320px]"
        data-testid="studio-title"
        title={pipelineName}
      >
        {pipelineName}
      </h1>
      <div
        className="flex flex-wrap items-center gap-[8px] md:shrink-0"
        data-testid="studio-header-chips"
      >
        <span
          className="shrink-0 rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10px]"
          data-testid="studio-draft-version"
        >
          {chipText}
        </span>
        <span
          className="shrink-0 rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10px]"
          data-testid="studio-validation-chip"
        >
          {validation === null
            ? "not validated"
            : validation.valid
              ? `valid (${findings} findings)`
              : `invalid (${findings} findings)`}
        </span>
        {dirty ? (
          <span className="shrink-0 font-mono text-[10px] text-muted" data-testid="studio-dirty">
            unsaved
          </span>
        ) : null}
      </div>
      <SegmentedControl view={view} onViewChange={onViewChange} />
      <span className="hidden md:block md:flex-1" />
      <div
        className="flex flex-wrap items-center gap-[8px] md:min-w-0 md:flex-nowrap"
        data-testid="studio-header-actions"
      >
        <button
          type="button"
          aria-label="Undo"
          data-testid="studio-undo"
          disabled={!canUndo}
          onClick={onUndo}
          className="inline-flex h-[30px] w-[30px] min-h-[44px] items-center justify-center rounded-[3px] border border-line bg-surface text-[13px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0"
        >
          ↶
        </button>
        <button
          type="button"
          aria-label="Redo"
          data-testid="studio-redo"
          disabled={!canRedo}
          onClick={onRedo}
          className="inline-flex h-[30px] w-[30px] min-h-[44px] items-center justify-center rounded-[3px] border border-line bg-surface text-[13px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0"
        >
          ↷
        </button>
        {!readOnly ? (
          <Button
            variant="secondary"
            compact
            className="min-h-[44px]"
            disabled={saving}
            onClick={onSave}
            data-testid="studio-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        ) : (
          <span
            className="font-mono text-[11px] text-muted"
            data-testid="studio-read-only-note"
          >
            Read-only — no library role to author this draft, or it is published; Save and
            Publish are hidden.
          </span>
        )}
        <Button
          variant="secondary"
          compact
          className="min-h-[44px]"
          disabled={validatePending}
          onClick={onValidate}
          data-testid="studio-validate"
        >
          {validatePending ? "Validating…" : "Validate"}
        </Button>
        <Button
          variant="secondary"
          compact
          className="min-h-[44px]"
          aria-pressed={diffOpen}
          onClick={onDiff}
          data-testid="studio-diff"
        >
          Diff
        </Button>
        {!readOnly ? (
          <Button
            variant="primary"
            compact
            className="min-h-[44px]"
            disabled={publishReason !== null || publishPending}
            onClick={onPublish}
            data-testid="studio-publish"
          >
            {publishPending ? "Publishing…" : "Publish"}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
