/**
 * WorkflowThumb — the 120px sketch strip on a Factory card (redesign R4).
 *
 * The card's thumbnail is not a picture of a canvas and not fake data: it is
 * the workflow's own top-level steps in document order, drawn as the chips the
 * Studio would lay out in a row, joined by the short connectors. The states
 * come from a live run, so a running card literally shows where the run is.
 *
 * Design (docs/design/redesign/Prototype.dc.html, the Factory index): the rail
 * background with the 14px dot grid, chips 24px tall, radius 7, mono 10.5, the
 * trigger chip inked white-on-ink, the state chips the `st-*` token sets.
 *
 * The strip is NOT `aria-hidden`: a card whose only statement of "where is the
 * run" is a row of coloured chips would be a colour-only status (CONTRACT
 * "Status is always glyph + word"). The strip is one `role="img"` with an
 * `aria-label` that says the step count and the step that needs the eye.
 */
import { THUMB_STEP_LIMIT, thumbAriaLabel } from "./factoryData";
import type { ThumbStep, ThumbStepKind, ThumbStepState } from "./factoryData";

/** A chip's classes per state (`st-*` tokens only, no raw hex). The design's
 * pale bg/edge/fg triples are exactly the token sets, e.g. failed =
 * `st-failed-pale-body` `#fbefec` / `st-failed-pale-edge` `#e5b2a8` /
 * `st-failed-tag-fg` `#b0281a`. */
export const CHIP_CLASS: Record<ThumbStepState, string> = {
  idle: "border-line bg-surface text-ink",
  running: "border-st-running-strong bg-st-running-tag text-st-running-tag-fg",
  waiting: "border-st-waiting-strong bg-st-waiting-tag text-st-waiting-tag-fg",
  done: "border-st-done-pale-edge bg-st-done-pale-body text-st-done-tag-fg",
  failed: "border-st-failed-pale-edge bg-st-failed-pale-body text-st-failed-tag-fg",
};

/** The trigger chip is inked whatever the run is doing: it says how this
 * workflow starts, and that fact never changes mid-run. */
export const TRIGGER_CHIP_CLASS = "border-ink bg-ink text-surface";

/** A chip label the strip can keep: nine characters, then an ellipsis. The
 * full label rides the chip's `title`, so the cut is never a lost fact. */
export const CHIP_LABEL_MAX = 9;

/** A longer chain gives up characters per chip: at seven chips (the trigger,
 * five steps and the `+N` overflow) nine characters each do not fit a card,
 * and a pixel-crushed `p…` says less than an honest `plan…`. The cut is the
 * same rule, taken earlier — never past the nine-character ceiling. */
export const CHIP_LABEL_MAX_LONG = 6;

/** The label ceiling for a strip of this many chips. */
export function chipLabelMax(count: number): number {
  return count > 5 ? CHIP_LABEL_MAX_LONG : CHIP_LABEL_MAX;
}

export function chipLabel(label: string, max = CHIP_LABEL_MAX): string {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

/** The classes for one chip; the trigger family owns its own inked look. */
export function chipClasses(kind: ThumbStepKind, state: ThumbStepState): string {
  return kind === "trigger" ? TRIGGER_CHIP_CLASS : CHIP_CLASS[state];
}

const CHIP_BASE =
  "flex h-[24px] items-center rounded-[7px] border font-mono text-[10.5px] whitespace-nowrap";
/** A strip's own padding: the design's `0 8` while the row has room for it. */
const CHIP_PAD = "px-[8px]";
/** A long chain packs tighter — `0 6` on the chip and a 14px connector — so a
 * card at its 2-column width shows the trigger, five steps and the `+N`
 * without cutting any of them short. Measured on the lab's own
 * `feature-development` card (7 chips) at 1280 in the R4 browser pass. */
const CHIP_PAD_COMPACT = "px-[6px]";
/** The connector between two chips. */
const LINE_BASE = "h-[1.5px] w-[18px] shrink-0 bg-line-strong";
const LINE_COMPACT = "h-[1.5px] w-[14px] shrink-0 bg-line-strong";

/** The chips that never give up width: the trigger (how this workflow starts)
 * and the `+N` overflow (how many steps hide). A step id may lose characters
 * to fit — the whole label rides the chip's `title`. */
function isPinnedChip(step: ThumbStep): boolean {
  return step.kind === "trigger" || step.id.startsWith("+");
}

export interface WorkflowThumbProps {
  steps: ThumbStep[];
  /** Extra classes on the 120px strip (a caller that stacks it differently). */
  className?: string;
}

/** Cap non-trigger chips to at most 5 steps + `+N` when a caller passes an
 * uncapped list directly. */
function capThumbSteps(steps: ThumbStep[]): ThumbStep[] {
  const hasTrigger = steps[0]?.kind === "trigger";
  const body = hasTrigger ? steps.slice(1) : steps;
  if (body.length <= THUMB_STEP_LIMIT) return steps;
  const shown = body.slice(0, THUMB_STEP_LIMIT - 1);
  const overflow: ThumbStep = {
    id: `+${body.length - shown.length}`,
    label: `+${body.length - shown.length}`,
    kind: "other",
    state: "idle",
  };
  return hasTrigger ? [steps[0], ...shown, overflow] : [...shown, overflow];
}

export function WorkflowThumb({ steps, className = "" }: WorkflowThumbProps) {
  const displaySteps = capThumbSteps(steps);
  const labelMax = chipLabelMax(displaySteps.length);
  const compact = displaySteps.length > 5;
  const chipPad = compact ? CHIP_PAD_COMPACT : CHIP_PAD;
  const lineClass = compact ? LINE_COMPACT : LINE_BASE;
  // When the strip is narrower than the card, `mx-auto` centers it; when
  // wider, auto-margin collapses to 0 so the strip stays left-aligned and
  // clips only on the right behind the fade overlay, never clipping the
  // trigger chip on the left.
  return (
    <div
      role="img"
      aria-label={thumbAriaLabel(displaySteps)}
      data-testid="workflow-thumb"
      className={`relative flex h-[120px] items-center overflow-hidden border-b border-line bg-rail px-[20px] ${className}`}
      style={{
        backgroundImage: "radial-gradient(var(--color-line) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
      }}
    >
      {displaySteps.length === 0 ? (
        <span className="mx-auto font-mono text-[10.5px] text-muted">no steps yet</span>
      ) : (
        <div data-testid="workflow-thumb-strip" className="mx-auto flex shrink-0 items-center">
          {displaySteps.map((step, index) => {
            const pinned = isPinnedChip(step);
            return (
              <span key={step.id} className={`flex shrink-0 items-center gap-[6px]`}>
                {index > 0 ? <span aria-hidden className={lineClass} /> : null}
                <span
                  title={step.label}
                  data-testid={`workflow-thumb-chip-${step.id}`}
                  data-state={step.state}
                  className={`${CHIP_BASE} ${chipPad} shrink-0 ${chipClasses(step.kind, step.state)}`}
                >
                  <span className={pinned ? "" : "whitespace-nowrap"}>
                    {chipLabel(step.label, labelMax)}
                  </span>
                </span>
              </span>
            );
          })}
        </div>
      )}
      {displaySteps.length > 0 ? (
        <span
          aria-hidden="true"
          data-testid="workflow-thumb-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-[32px]"
          style={{ background: "linear-gradient(to left, var(--color-rail), transparent)" }}
        />
      ) : null}
    </div>
  );
}
