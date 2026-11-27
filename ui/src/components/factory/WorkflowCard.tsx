/**
 * WorkflowCard — one workflow on the Factory index (redesign R4).
 *
 * The card is the whole link (CONTRACT: a real `a` with an accessible name);
 * the accessible-card pattern makes the card's title the link and stretches it
 * over the card with `::after`, so the thumbnail, the name and the empty space
 * all answer to it — while the secondary `Open run` link sits above that
 * overlay and keeps its own target.
 *
 * Two lines of facts under the thumbnail (review 07-1280-3 — the prototype's
 * own card footer, about 70px, not three stacked lines):
 * - name, then how it starts in plain lower-case English (`triggerSentence`) in
 *   regular muted type on the SAME line, with the state at the right: a live run
 *   is `● #318 · test`, a run a gate holds is `! waiting on you`, nothing live
 *   is `○ idle`. Glyph and word always travel together (CONTRACT).
 * - one muted line: drafts, and where the workflow is used (All projects) or
 *   when it last ran (a project scope).
 *
 * Nothing here is invented: the state text is the newest live run's own
 * `status`/`trigger`/`steps`, and a workflow with no live run says `idle`.
 */
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { IconDots } from "@tabler/icons-react";
import { runIssueNumber } from "../repo/RepoLanes";
import { currentStep } from "../board/columns";
import type { CrossProjectRunSummary } from "../../api/home";
import { shortId, formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import { Menu, type MenuEntry } from "../ds/Menu";
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
 * the honest `○ idle`. The glyph and the word always travel together — the bare
 * word `idle` was colour-free but glyph-free too (review 07-1280-2, CONTRACT
 * "Status is always glyph + word"). The state column is mono 11/600, the
 * prototype's own setting.
 */
export function cardState(run: CrossProjectRunSummary | null | undefined): {
  text: string;
  className: string;
} {
  if (!run) return { text: "○ idle", className: "text-muted" };
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
  canAuthor?: boolean;
  duplicating?: boolean;
  onOpenTriggers?: () => void;
  onUseInProject?: () => void;
  onDuplicate?: () => void;
}

export function WorkflowCard({
  item,
  scope,
  canAuthor = false,
  duplicating = false,
  onOpenTriggers,
  onUseInProject,
  onDuplicate,
}: WorkflowCardProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const { pipeline } = item;
  const name = pipeline.display_name || pipeline.slug;
  const live = item.liveRuns[0] ?? null;
  const state = cardState(live);
  const meta = cardMetaLines(item, scope);
  const isLive =
    item.newestPublished !== undefined
      ? item.newestPublished !== null
      : pipeline.revision_count > 0;
  const usedInResolved = item.assignmentsResolved ?? true;

  const menuItems: MenuEntry[] = [];
  if (onUseInProject) {
    menuItems.push({
      id: "use-in-project",
      label: "Use in a project…",
      testId: "workflow-card-use",
      disabled: !isLive,
      onSelect: () => {
        setMenuOpen(false);
        onUseInProject();
      },
    });
  }
  if (onOpenTriggers) {
    menuItems.push({
      id: "triggers",
      label: "Triggers…",
      testId: "workflow-card-triggers",
      onSelect: () => {
        setMenuOpen(false);
        onOpenTriggers();
      },
    });
  }
  if (canAuthor && onDuplicate) {
    menuItems.push({
      id: "duplicate",
      label: duplicating ? "Duplicating…" : "Duplicate",
      testId: "workflow-card-duplicate",
      disabled: duplicating,
      onSelect: () => {
        setMenuOpen(false);
        onDuplicate();
      },
    });
  }
  menuItems.push({
    id: "open-yaml",
    label: "Open YAML",
    testId: "workflow-card-yaml",
    onSelect: () => {
      setMenuOpen(false);
      navigate(routes.factoryWorkflow(pipeline.id, scope, { panel: "yaml" }));
    },
  });

  return (
    <article
      data-testid={`workflow-card-${pipeline.id}`}
      className={`group relative rounded-[12px] border border-line bg-surface shadow-(--shadow-card) hover:border-fill-edge hover:shadow-(--shadow-card-hover) ${
        menuOpen ? "z-30" : ""
      }`}
    >
      <div className="overflow-hidden rounded-t-[11px]">
        <WorkflowThumb steps={item.steps} />
      </div>
      <div className="flex flex-col gap-[6px] px-[14px] py-[12px]">
        <div className="flex items-baseline gap-[8px] max-md:flex-wrap max-md:items-center max-md:gap-y-[2px]">
          {/* The card's accessible name, and the link the whole card answers to. */}
          <Link
            to={routes.factoryWorkflow(pipeline.id, scope)}
            data-testid={`workflow-card-link-${pipeline.id}`}
            title={name}
            className="min-w-0 truncate text-[15px] font-bold text-ink no-underline group-hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent after:absolute after:inset-0 after:content-['']"
          >
            {name}
          </Link>
          {/* How the workflow starts, in regular muted type beside the name — the
              prototype's one-line footer; the italic second line it replaces was
              never in the design (review 07-1280-3). */}
          <span
            data-testid={`workflow-card-trigger-${pipeline.id}`}
            title={item.triggerText}
            className="min-w-0 flex-1 truncate text-[13px] text-muted max-md:order-last max-md:basis-full"
          >
            {item.triggerText}
          </span>
          <span
            data-testid={`workflow-card-state-${pipeline.id}`}
            className={`ml-auto shrink-0 font-mono text-[11px] font-semibold whitespace-nowrap ${state.className}`}
          >
            {state.text}
          </span>
          <span className="relative z-20 inline-flex shrink-0 self-center">
            <button
              ref={menuTriggerRef}
              type="button"
              data-testid="workflow-card-menu"
              aria-label={`Actions for ${name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="icon-hit inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border border-transparent text-muted hover:border-line hover:bg-rail hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:min-w-[44px]"
            >
              <IconDots size={15} stroke={1.5} aria-hidden="true" />
            </button>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              triggerRef={menuTriggerRef}
              side="bottom"
              align="end"
              width={180}
              className="rounded-[12px]! shadow-[var(--shadow-pop)]!"
              ariaLabel={`Actions for ${name}`}
              data-testid="workflow-card-menu-popover"
              items={menuItems}
            />
          </span>
        </div>
        {meta ? (
          <p
            data-testid={`workflow-card-meta-${pipeline.id}`}
            className="m-0 text-[12px] text-muted"
          >
            {meta}
          </p>
        ) : null}
        {isLive && usedInResolved && item.usedIn.length === 0 && onUseInProject ? (
          <p
            data-testid={`workflow-card-unused-${pipeline.id}`}
            className="m-0 text-[12px] text-muted"
          >
            {"Not used in any project yet · "}
            <button
              type="button"
              onClick={onUseInProject}
              data-testid={`workflow-card-unused-use-${pipeline.id}`}
              className="relative z-10 font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Use in a project
            </button>
          </p>
        ) : null}
        {live ? (
          <div className="flex items-center gap-[10px]">
            <Link
              to={routes.run(live.id)}
              data-testid="workflow-card-run"
              className="relative z-10 text-[12px] font-semibold text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Open run
            </Link>
            {/* The same run on the editor canvas: the definition with every step
                painted in its run state (`?run=` in the editor). Quiet, because
                `Open run` stays the primary way into a run. */}
            <Link
              to={routes.factoryWorkflow(pipeline.id, scope, { run: live.id })}
              data-testid="workflow-card-watch"
              className="relative z-10 text-[12px] font-semibold text-muted underline decoration-line underline-offset-2 hover:text-accent-text hover:decoration-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Watch on canvas
            </Link>
          </div>
        ) : null}
      </div>
    </article>
  );
}
