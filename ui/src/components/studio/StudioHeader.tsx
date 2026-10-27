/**
 * StudioHeader — the top bar of the Workflow Studio (design 1g):
 * breadcrumb `Workflows / <folder> /`, the workflow name (15/600), the draft
 * chip, the Canvas | YAML segmented control, then the action row (undo/redo
 * icon buttons, Validate, Save, Publish — primary, disabled until publishable).
 *
 * The header is a single 52px row on desktop (≥768px). The publish reason and
 * the validation state live in the StudioStatusBar, and the diff affordance
 * moved there too (`diff vs r<N>`), so this bar keeps only the control and
 * the actions and the row never truncates. Below 768px the header gains two
 * drawer toggles (`Steps` / `Inspect`) that open the palette/inspector over
 * the canvas.
 *
 * At 390px the header reflows the SAME content into wrapped rows (the 390
 * reflow rule: the 1280 content and hierarchy in one column): the breadcrumb
 * stays (its folder truncates), undo/redo is ONE pair visible at every width,
 * and the `unsaved` mark is never display:none — the phone header hides no
 * desktop content.
 *
 * Presentation only — every state the header renders comes in as props; the
 * publish gate (saved + server-valid) is computed by the page and handed
 * down.
 */
import { Link } from "react-router";
import { Button } from "../ds/Button";
import { routes } from "../../lib/routes";
import { folderLabel } from "../../api/pipelines";

export type StudioView = "canvas" | "yaml";

export interface StudioHeaderProps {
  pipelineName: string;
  /** The pipeline's folder label (design 1g breadcrumb: `Workflows / <folder> /`). */
  pipelineFolder?: string | null;
  savedVersion: number | null;
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
  onPublish(): void;
  publishPending: boolean;
  /** null = publish is available; otherwise the reason (the status bar spells it). */
  publishReason: string | null;
  view: StudioView;
  onViewChange(view: StudioView): void;
  /**
   * <768px only: the header owns the `Steps` / `Inspect` drawer toggles
   * (the palette and the inspector open over the canvas). Absent = desktop.
   */
  phoneToggles?: {
    paletteOpen: boolean;
    inspectorOpen: boolean;
    onTogglePalette(): void;
    onToggleInspector(): void;
  } | null;
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
      className="flex shrink-0 rounded-[3px] border border-line p-[2px]"
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
  onPublish,
  publishPending,
  publishReason,
  view,
  onViewChange,
  phoneToggles,
}: StudioHeaderProps) {
  const versionText = savedVersion === null ? "" : ` V${savedVersion}`;
  const chipText = `· DRAFT${versionText}${dirty ? " · UNSAVED" : ""}`;
  // Pass 2 #6 at 390px the header is exactly two rows — row 1: title +
  // draft chip + undo/redo + the Steps/Inspect icon toggles; row 2: the
  // Canvas|YAML tabs + Validate/Save/Publish — and never wraps into three.
  // The breadcrumb (desktop design) hides below md; the icon-only toggles
  // shrink the phone row.
  const iconToggle =
    "inline-flex h-[26px] w-[30px] min-h-[44px] shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface text-[14px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0";
  const iconAction =
    "inline-flex h-[26px] w-[30px] items-center justify-center rounded-[4px] border border-line-strong bg-surface text-[14px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <header
      className="flex shrink-0 flex-row flex-wrap items-center gap-x-[8px] gap-y-[8px] border-b border-line bg-surface px-4 py-2 md:h-[52px] md:flex-nowrap md:items-center md:gap-[10px] md:overflow-x-auto md:py-0"
      data-testid="studio-header"
    >
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 max-w-full items-center gap-[6px]"
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
        <span
          className="min-w-0 truncate font-mono text-[12px] text-muted"
          data-testid="studio-breadcrumb-folder"
        >
          {folderLabel(pipelineFolder)}
        </span>
        <span aria-hidden="true" className="shrink-0 font-mono text-[12px] text-faint">
          /
        </span>
      </nav>
      <h1
        className="min-w-[80px] flex-1 truncate text-[15px] font-semibold md:max-w-[320px] md:min-w-[160px]"
        data-testid="studio-title"
        title={pipelineName}
      >
        {pipelineName}
      </h1>
      <div
        className="flex min-w-0 items-center gap-[6px] md:shrink-0 md:gap-[8px]"
        data-testid="studio-header-chips"
      >
        <span
          className="min-w-0 truncate rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[10px]"
          data-testid="studio-draft-version"
        >
          {chipText}
        </span>
        {dirty ? (
          <span className="font-mono text-[10px] text-muted" data-testid="studio-dirty">
            unsaved
          </span>
        ) : null}
      </div>
      {/* Row-1 tail (phone): the Steps/Inspect pane toggles only — undo/redo
          is one pair for every width (the 390 reflow: no duplicated desktop
          affordance, no hidden phone-only substitute). */}
      <div className="flex shrink-0 items-center gap-[4px] md:hidden">
        {phoneToggles ? (
          <>
            <button
              type="button"
              aria-label="Steps palette"
              aria-pressed={phoneToggles.paletteOpen}
              onClick={phoneToggles.onTogglePalette}
              data-testid="studio-phone-palette"
              className={iconToggle}
            >
              ☰
            </button>
            <button
              type="button"
              aria-label="Inspect"
              aria-pressed={phoneToggles.inspectorOpen}
              onClick={phoneToggles.onToggleInspector}
              data-testid="studio-phone-inspector"
              className={iconToggle}
            >
              ⇥
            </button>
          </>
        ) : null}
      </div>
      <SegmentedControl view={view} onViewChange={onViewChange} />
      <span className="hidden md:block md:flex-1" />
      <div
        className="ml-auto flex flex-nowrap items-center gap-[4px] md:ml-0 md:min-w-0 md:gap-[8px]"
        data-testid="studio-header-actions"
      >
        <span className="flex shrink-0 items-center gap-[4px]">
          <button
            type="button"
            aria-label="Undo"
            data-testid="studio-undo"
            disabled={!canUndo}
            onClick={onUndo}
            className={iconAction}
          >
            ↶
          </button>
          <button
            type="button"
            aria-label="Redo"
            data-testid="studio-redo"
            disabled={!canRedo}
            onClick={onRedo}
            className={iconAction}
          >
            ↷
          </button>
        </span>
        <Button
          variant="secondary"
          compact
          className="min-h-[44px] md:min-h-[26px]"
          disabled={validatePending}
          onClick={onValidate}
          data-testid="studio-validate"
        >
          {validatePending ? "Validating…" : "Validate"}
        </Button>
        {!readOnly ? (
          <Button
            variant="secondary"
            compact
            className="min-h-[44px] md:min-h-[26px]"
            disabled={saving}
            onClick={onSave}
            data-testid="studio-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        ) : (
          <span className="font-mono text-[11px] text-muted" data-testid="studio-read-only-note">
            Read-only — no library role to author this draft, or it is published; Save and Publish
            are hidden.
          </span>
        )}
        {!readOnly ? (
          <Button
            variant="primary"
            compact
            className="min-h-[44px] md:min-h-[26px]"
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
