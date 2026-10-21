/**
 * StudioHeader — the top bar of the Workflow Studio (phase 4, 4a):
 * breadcrumb `Workflows / {name}`, the `DRAFT vN` chip, the server's last
 * validation chip, the Canvas · YAML · Runs · Assigned tab strip (Canvas/YAML
 * are the view toggle as tabs with `aria-selected`; Runs/Assigned navigate
 * to the workflow page's revisions and assignment sections), then the
 * existing Save / Validate / Diff / Publish actions.
 *
 * Desktop (≥768px) is a single 52px row: the name never shrinks below 160px
 * and the publish reason truncates with an ellipsis, capped at 240px (full
 * text in `title` and an accessible label), so the row does not scroll
 * sideways at 1280px+. Below 768px it stacks into four
 * rows: (1) breadcrumb + name, truncated with an ellipsis, (2) the chips,
 * wrapping, (3) the tab strip — horizontally scrollable on the strip only —
 * and (4) the actions, wrapping, each at least 44px tall.
 *
 * Presentation only — every state the header renders comes in as props; the
 * publish gate (saved + server-valid, with the reason as visible text, not
 * just hover) is computed by the page and handed down.
 */
import { Link } from "react-router";
import { Button } from "../ds/Button";
import { routes } from "../../lib/routes";
import { LIBRARY_READ_ONLY_NOTE } from "../../lib/pipeline/authoring";
import type { ValidateBody } from "../../lib/pipeline/contract";

export type StudioView = "canvas" | "yaml";

/** One tab of the Canvas · YAML · Runs · Assigned strip. */
const TAB_CLASS = "ds-btn ds-btn--ghost ds-btn--compact";

/** Action buttons get a comfortable mobile tap target; desktop keeps 26px. */
const MOBILE_BTN = "min-h-[44px] md:min-h-0";

export interface StudioHeaderProps {
  pipelineName: string;
  /** The pipeline's id — the Runs / Assigned tabs navigate to its page. */
  pipelineId: string;
  /**
   * The assignment count, when the page already holds the data; absent the
   * tab renders as a plain `Assigned` link without a number.
   */
  assignedCount?: number | null;
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
  pipelineId,
  assignedCount,
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
  const workflowPage = routes.workflow(pipelineId);
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
        <h1
          className="min-w-[160px] truncate text-[15px] font-bold md:max-w-[320px]"
          data-testid="studio-title"
          title={pipelineName}
        >
          {pipelineName}
        </h1>
      </nav>
      <div
        className="flex flex-wrap items-center gap-[8px] md:shrink-0"
        data-testid="studio-header-chips"
      >
        <span
          className="shrink-0 rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10px]"
          data-testid="studio-draft-version"
        >
          DRAFT v{savedVersion ?? "…"}
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
      <nav
        aria-label="Studio views"
        className="flex w-full items-center gap-[2px] overflow-x-auto rounded-[3px] border border-line p-[2px] md:w-auto md:min-w-0"
        role="tablist"
        data-testid="studio-header-tabs"
      >
        <Button
          variant="ghost"
          compact
          role="tab"
          aria-selected={view === "canvas"}
          onClick={() => onViewChange("canvas")}
          data-testid="studio-view-canvas"
        >
          Canvas
        </Button>
        <Button
          variant="ghost"
          compact
          role="tab"
          aria-selected={view === "yaml"}
          onClick={() => onViewChange("yaml")}
          data-testid="studio-view-yaml"
        >
          YAML
        </Button>
        <Link to={workflowPage} className={TAB_CLASS} data-testid="studio-header-runs">
          Runs
        </Link>
        <Link to={workflowPage} className={TAB_CLASS} data-testid="studio-header-assigned">
          {assignedCount === null || assignedCount === undefined
            ? "Assigned"
            : `Assigned to ${assignedCount}`}
        </Link>
      </nav>
      <span className="hidden md:block md:flex-1" />
      <div
        className="flex flex-wrap items-center gap-[8px] md:min-w-0 md:flex-nowrap"
        data-testid="studio-header-actions"
      >
        <Button
          variant="secondary"
          compact
          disabled={!canUndo}
          onClick={onUndo}
          className={MOBILE_BTN}
          data-testid="studio-undo"
        >
          Undo
        </Button>
        <Button
          variant="secondary"
          compact
          disabled={!canRedo}
          onClick={onRedo}
          className={MOBILE_BTN}
          data-testid="studio-redo"
        >
          Redo
        </Button>
        {readOnly ? (
          <span
            className="shrink-0 font-mono text-[10.5px] text-faint"
            data-testid="studio-read-only-note"
          >
            {LIBRARY_READ_ONLY_NOTE}
          </span>
        ) : (
          <>
            <Button
              variant="primary"
              compact
              disabled={saving}
              onClick={onSave}
              className={MOBILE_BTN}
              data-testid="studio-save"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              compact
              disabled={validatePending}
              onClick={onValidate}
              className={MOBILE_BTN}
              data-testid="studio-validate"
            >
              {validatePending ? "Validating…" : "Validate"}
            </Button>
            <Button
              variant="secondary"
              compact
              aria-pressed={diffOpen}
              onClick={onDiff}
              className={MOBILE_BTN}
              data-testid="studio-diff"
            >
              Diff
            </Button>
            <Button
              variant="primary"
              compact
              disabled={publishReason !== null || publishPending}
              onClick={onPublish}
              className={MOBILE_BTN}
              data-testid="studio-publish"
            >
              {publishPending ? "Publishing…" : "Publish"}
            </Button>
            {publishReason !== null ? (
              <span
                className="min-w-0 max-w-full truncate font-mono text-[10.5px] text-muted md:max-w-[240px]"
                data-testid="studio-publish-reason"
                title={publishReason}
                aria-label={publishReason}
              >
                {publishReason}
              </span>
            ) : null}
          </>
        )}
      </div>
    </header>
  );
}
