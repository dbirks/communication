/**
 * WorkflowCard — one workflow on the Factory index (redesign R4).
 *
 * The card is the whole link (CONTRACT: a real `a` with an accessible name);
 * the accessible-card pattern makes the card's title the link and stretches it
 * over the card with `::after`, so the thumbnail, the name and the empty space
 * all answer to it — while the secondary `Open run` link sits above that
 * overlay and keeps its own target.
 *
 * Three lines of facts under the thumbnail:
 * - name + where the run is now (glyph + word, never colour alone);
 * - how it starts, in plain lower-case English (`factoryData.triggerSentence`);
 * - one muted line: drafts, and where the workflow is used (All projects) or
 *   when it last ran (a project scope).
 *
 * Nothing here is invented: the state text is the newest live run's own
 * `status`/`trigger`/`steps`, and a workflow with no live run says `idle`.
 */
import { Link } from "react-router";
import { runIssueNumber } from "../repo/RepoLanes";
import { currentStep } from "../board/columns";
import type { CrossProjectRunSummary } from "../../api/home";
import { shortId, formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import { WorkflowThumb } from "./WorkflowThumb";
import type { FactoryWorkflowItem } from "./factoryData";

/** The run's short name: the issue it started from when the wire names one
 * (`#318`), else its short id — the board cards' own rule. */
export function runLabel(run: CrossProjectRunSummary): string {
  const issue = runIssueNumber(run);
  return issue === null ? `#${shortId(run.id)}` : `#${issue}`;
}

/**
 * The card's state line: what a reader wants answered first. A live run →
 * `● #318 · test`; a run held by a gate → `! waiting on you`; nothing live →
 * the honest `idle`. The glyph and the word always travel together.
 */
export function cardState(run: CrossProjectRunSummary | null | undefined): {
  text: string;
  className: string;
} {
  if (!run) return { text: "idle", className: "text-muted" };
  if (run.status === "waiting_human" || run.status === "paused") {
    return { text: "! waiting on you", className: "text-st-waiting-tag-fg" };
  }
  const step = currentStep(run.steps);
  const where = step ? ` · ${step.node_id}` : "";
  return { text: `● ${runLabel(run)}${where}`, className: "text-st-running-tag-fg" };
}

/** The muted third line; the empty parts are left out rather than printed as
 * `0 drafts · used in `. In a project scope `last ran` is the useful fact. */
export function cardMetaLines(
  item: Pick<FactoryWorkflowItem, "draftCount" | "usedIn" | "lastRunAt">,
  scope: string | null,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (item.draftCount > 0) {
    parts.push(`${item.draftCount} ${item.draftCount === 1 ? "draft" : "drafts"}`);
  }
  if (scope === null) {
    if (item.usedIn.length > 0) parts.push(`used in ${item.usedIn.join(", ")}`);
  } else if (item.lastRunAt) {
    parts.push(`last ran ${formatAge(item.lastRunAt, now)}`);
  }
  return parts.join(" · ");
}

export interface WorkflowCardProps {
  item: FactoryWorkflowItem;
  /** The page's scope: a project id, or null for All projects. */
  scope: string | null;
}

export function WorkflowCard({ item, scope }: WorkflowCardProps) {
  const { pipeline } = item;
  const name = pipeline.display_name || pipeline.slug;
  const live = item.liveRuns[0] ?? null;
  const state = cardState(live);
  const meta = cardMetaLines(item, scope);

  return (
    <article
      data-testid={`workflow-card-${pipeline.id}`}
      className="group relative overflow-hidden rounded-[12px] border border-line bg-surface hover:border-line-strong hover:shadow-(--shadow-pop)"
    >
      <WorkflowThumb steps={item.steps} />
      <div className="flex flex-col gap-[6px] px-[14px] py-[12px]">
        <div className="flex items-baseline gap-[8px]">
          {/* The card's accessible name, and the link the whole card answers to. */}
          <Link
            to={routes.factoryWorkflow(pipeline.id, scope)}
            data-testid={`workflow-card-link-${pipeline.id}`}
            title={name}
            className="min-w-0 truncate text-[15px] font-bold text-ink no-underline group-hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
          >
            {name}
          </Link>
          <span
            data-testid={`workflow-card-state-${pipeline.id}`}
            className={`ml-auto shrink-0 text-[12.5px] whitespace-nowrap ${state.className}`}
          >
            {state.text}
          </span>
        </div>
        <p
          data-testid={`workflow-card-trigger-${pipeline.id}`}
          className="m-0 text-[13px] italic text-muted"
        >
          {item.triggerText}
        </p>
        {meta ? (
          <p
            data-testid={`workflow-card-meta-${pipeline.id}`}
            className="m-0 text-[12px] text-muted"
          >
            {meta}
          </p>
        ) : null}
        {live ? (
          <Link
            to={routes.run(live.id)}
            data-testid="workflow-card-run"
            className="relative z-10 w-fit text-[12px] font-semibold text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Open run
          </Link>
        ) : null}
      </div>
    </article>
  );
}
