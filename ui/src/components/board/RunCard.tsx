/**
 * One board card (artboard 2d): the workflow line, the title, the segmented
 * per-step bar (one 7px segment per top-level step of the pinned revision,
 * colored from the same `bg-seg-*` tokens the design-system strip uses),
 * the project chip and the current step — plus the per-state actions:
 * NEEDS YOU cards open the run for the decision (the 440px drawer lands
 * with a later unit and does the Approve/Read-plan action), FAILED cards
 * link into the run workbench to retry or fix the workflow.
 *
 * Clicking anywhere on the card sets `?run=<id>` on the board URL; the
 * drawer unit later reads it. The action row sits *outside* the card
 * button so a card never nests one interactive in another.
 */
import { Link } from "react-router";
import { VARIANT_CLASS } from "../ds/Button";
import {
  columnOf,
  currentStep,
  formatAge,
  progressAriaLabel,
  runTitle,
  runTriggerBadge,
  shortId,
  STEP_SEGMENT_CLASS,
  stepGlyph,
  type CrossProjectRun,
} from "./columns";
import { RunTriggerBadge } from "./TriggerBadge";
import { routes } from "../../lib/routes";

export interface RunCardProps {
  run: CrossProjectRun;
  /** Card click (and the NEEDS YOU actions): open the run's drawer via `?run=`. */
  onOpenRun: (runId: string) => void;
  /** Age line; injected for deterministic tests. */
  now?: Date;
}

export function RunCard({ run, onOpenRun, now = new Date() }: RunCardProps) {
  const column = columnOf(run.status);
  const step = currentStep(run.steps);
  const needsYou = column === "needs-you";
  const failed = column === "failed";
  const title = runTitle(run);
  const triggerBadge = runTriggerBadge(run);

  return (
    <article
      data-testid={`board-card-${run.id}`}
      className="rounded-[6px] border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
    >
      <button
        type="button"
        data-testid={`board-card-open-${run.id}`}
        onClick={() => onOpenRun(run.id)}
        className="block w-full rounded-t-[6px] px-3 py-2 text-left"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">
            {run.pipeline_display_name}{" "}
            <span className="font-mono text-[11px] font-normal text-faint">#{shortId(run.id)}</span>
          </span>
          <span className="shrink-0 font-mono text-[10px] text-faint" title={run.created_at}>
            {formatAge(run.created_at, now)}
          </span>
        </span>

        <span className="mt-[2px] block truncate text-[12px] text-ink-2">{title}</span>

        {/* The segmented bar: one 7px segment per top-level step, colored by
            the step's state; the label spells the counts (never color alone). */}
        {run.steps.length > 0 ? (
          <span
            role="img"
            aria-label={progressAriaLabel(run.steps)}
            className="mt-2 flex h-[7px] w-full overflow-hidden rounded-[2px] border border-line"
          >
            {run.steps.map((item) => (
              <span
                key={item.node_id}
                className={STEP_SEGMENT_CLASS[item.state]}
                style={{ flexGrow: 1, flexBasis: 0 }}
              />
            ))}
          </span>
        ) : (
          <span
            className="mt-1 block font-mono text-[10px] text-faint"
            title="The stored plan snapshot did not decode"
          >
            step progress not available
          </span>
        )}

        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* The run list carries no per-run repo (a run can touch several),
              so the chip is the project the run belongs to. */}
          <span className="rounded-[3px] bg-st-queued-tag px-1.5 py-px font-mono text-[10px] text-st-queued-tag-fg">
            {run.project_name}
          </span>
          {step ? (
            <span
              className="font-mono text-[10px] text-ink-2"
              data-testid={`board-card-step-${run.id}`}
            >
              <span aria-hidden="true">{stepGlyph(step.state)}</span>
              <span className="sr-only">{step.state}</span> {step.node_id}
            </span>
          ) : null}
        </span>
      </button>

      {triggerBadge ? (
        <div className="px-3 pb-2 pt-1">
          <RunTriggerBadge badge={triggerBadge} testId={`board-trigger-badge-${run.id}`} />
        </div>
      ) : null}

      {needsYou ? (
        <div
          className="flex gap-1.5 border-t border-line px-3 py-2"
          data-testid={`board-card-actions-${run.id}`}
        >
          <button
            type="button"
            className={`ds-btn ${VARIANT_CLASS.primary} inline-flex h-[24px] items-center rounded-[4px] px-2 text-[11px]`}
            onClick={() => onOpenRun(run.id)}
          >
            Approve
          </button>
          <button
            type="button"
            className={`ds-btn ${VARIANT_CLASS.ghost} inline-flex h-[24px] items-center rounded-[4px] px-2 text-[11px]`}
            onClick={() => onOpenRun(run.id)}
          >
            Read plan
          </button>
        </div>
      ) : null}

      {failed ? (
        <div
          className="flex gap-1.5 border-t border-line px-3 py-2"
          data-testid={`board-card-actions-${run.id}`}
        >
          <Link
            className={`ds-btn ${VARIANT_CLASS.primary} inline-flex h-[24px] items-center rounded-[4px] px-2 text-[11px]`}
            to={routes.run(run.id)}
            data-testid={`board-card-retry-${run.id}`}
          >
            Retry from {step?.node_id ?? "the failed step"}
          </Link>
          <Link
            className={`ds-btn ${VARIANT_CLASS.ghost} inline-flex h-[24px] items-center rounded-[4px] px-2 text-[11px]`}
            to={routes.run(run.id)}
          >
            Fix the workflow
          </Link>
        </div>
      ) : null}
    </article>
  );
}
