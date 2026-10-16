/**
 * The branch grid — one square cell per `for_each` item (or `until` iteration),
 * coloured by that branch's state, with the selected branch's history as a chip
 * strip underneath (`10` run view 3b/4a: "25 branches · 15 ✓ · 5 ● · 1 ! · 2 × ·
 * 2 queued", then "task 14  impl ✓ → checks ✓ → review × missing test → impl #2 ●").
 *
 * The grid answers "which of my 25 items is the one to look at" without
 * scrolling a 25-row table, and the strip answers "what has that item already
 * been through", including the passes of a loop nested inside the branch.
 *
 * Data comes from run node executions (`GET /runs/{id}/nodes`); all grouping is
 * `lib/pipeline/branches.ts`, which is all `runView.ts`'s scope parsing. States,
 * glyphs and words are the shared `ds/states.ts` table (identity rule 06).
 *
 * Standalone by design: it takes rows and a callback, owns no fetch, and is not
 * wired into `RunInspector` yet.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import {
  branchCounts,
  branchesOf,
  findBranch,
  sortBranches,
  type Branch,
  type BranchSort,
} from "../../lib/pipeline/branches";
import type { NodeExecutionSummary } from "../../lib/pipeline/contract";
import { SHORT_WORD, STATES, type StateName } from "../ds/states";
import { Panel } from "../ds/Panel";

export interface BranchGridProps {
  /** The scope node's `node_instance_key` — `/verify_each`, not a row's id. */
  scope: string;
  /** The run's node executions (route 24); the grid filters them to `scope`. */
  nodes: readonly NodeExecutionSummary[];
  /** Selected 1-based branch index, or `null` for none. */
  selectedBranch: number | null;
  /** Cell click / Enter — the caller shows that branch's attempt panel. */
  onSelectBranch: (index: number) => void;
  /** Definition node ids in document order, so the chips read in run order. */
  definitionOrder?: readonly string[];
  headingId?: string;
  className?: string;
}

/** Header line: `25 branches  15 ✓ · 5 ● · 1 ! · 2 × · 2 queued`. */
function CountGlyph({ state, count }: { state: StateName; count: number }) {
  const spec = STATES[state];
  // Counts accompany every colour (rule 06): the glyph is always there, and
  // `queued` gets its word, because a pending branch and a skipped one share a
  // colour and only the word tells them apart.
  const label = state === "queued" ? SHORT_WORD.queued : spec.glyph;
  return (
    <span className="font-mono text-[11px] tabular-nums">
      <span className="text-ink-2">
        {count} <span aria-hidden>{label}</span>
      </span>
      <span className="sr-only">{`${count} ${spec.word}`}</span>
    </span>
  );
}

export function BranchGrid({
  scope,
  nodes,
  selectedBranch,
  onSelectBranch,
  definitionOrder,
  headingId = "branch-grid-heading",
  className = "",
}: BranchGridProps) {
  const [mode, setMode] = useState<BranchSort>("stuck");
  const gridRef = useRef<HTMLDivElement>(null);
  const branches = branchesOf(nodes, scope, definitionOrder);
  const cells = sortBranches(branches, mode);
  const selected = findBranch(branches, selectedBranch);
  const counts = branchCounts(branches);

  /**
   * Roving focus: one tab stop over 25 cells. Left/right walk the order,
   * up/down walk the wrapped rows (measured, because the grid reflows), Home and
   * End jump to the ends. Enter is a button's own click, so selection needs no
   * extra key handler.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const buttons = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const up = event.key === "ArrowUp";
      const from = buttons[current]?.getBoundingClientRect();
      const candidates = buttons
        .map((button, at) => ({ button, at, rect: button.getBoundingClientRect() }))
        .filter(
          ({ button, rect }) =>
            button !== buttons[current] && (up ? rect.bottom <= from.top : rect.top >= from.bottom),
        )
        .sort(
          (a, b) =>
            Math.abs(a.rect.left - (from?.left ?? 0)) - Math.abs(b.rect.left - (from?.left ?? 0)),
        );
      next = candidates[0]?.at ?? current;
    } else if (step !== undefined) {
      next = (current + step + buttons.length) % buttons.length;
    }
    buttons[next === -1 ? 0 : next]?.focus();
  }

  const focusIndex = Math.max(
    0,
    cells.findIndex((cell) => cell.index === selectedBranch),
  );

  return (
    <Panel
      title={`${branches.length} branches`}
      headingId={headingId}
      headingLevel={2}
      className={className}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-[10px] py-[7px]">
        <p
          className="flex flex-wrap items-center gap-x-[7px] font-mono text-[11px] text-muted"
          data-testid="branch-counts"
        >
          <strong className="text-[13px] font-semibold text-ink">
            {branches.length} {branches.length === 1 ? "branch" : "branches"}
          </strong>
          {counts.map((entry) => (
            <span key={entry.state} className="flex items-center gap-[7px]">
              <span aria-hidden>·</span>
              <CountGlyph state={entry.state} count={entry.count} />
            </span>
          ))}
        </p>
        <div
          role="group"
          aria-label="Branch order"
          className="flex shrink-0 overflow-hidden rounded-[3px] border border-line-strong"
          data-testid="branch-sort"
        >
          {(
            [
              ["stuck", "stuck first"],
              ["number", "by number"],
            ] as const
          ).map(([value, word]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`px-[8px] py-[3px] font-mono text-[10.5px] ${
                mode === value ? "bg-fill text-ink" : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {word}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={gridRef}
        role="group"
        aria-label={`Branches of ${scope}`}
        onKeyDown={onKeyDown}
        data-testid="branch-grid"
        className="flex flex-wrap gap-[3px] px-[10px] py-[9px]"
      >
        {cells.map((cell, position) => {
          const spec = STATES[cell.state];
          const isSelected = cell.index === selectedBranch;
          return (
            <button
              key={cell.key}
              type="button"
              data-testid={`branch-cell-${cell.index}`}
              data-branch-state={cell.state}
              aria-current={isSelected ? "true" : undefined}
              aria-label={`Branch ${cell.index}: ${spec.word}${cell.stuck ? ", needs attention" : ""}`}
              tabIndex={position === focusIndex ? 0 : -1}
              onClick={() => onSelectBranch(cell.index)}
              // Colour means state, and the state's tag pair is the one table
              // the rest of the app uses (rule 06); selection is an outline, so
              // a selected cell never has to change colour to say so.
              className={`h-[22px] w-[19px] rounded-[2px] border font-mono text-[10.5px] leading-none tabular-nums focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${spec.tagBg} ${spec.tagFg} ${
                isSelected
                  ? "border-ink outline-2 -outline-offset-2 outline-ink"
                  : "border-line-strong"
              }`}
            >
              {cell.index}
              <span className="sr-only">{` ${spec.word}`}</span>
            </button>
          );
        })}
      </div>
      <BranchHistory branch={selected} />
    </Panel>
  );
}

/**
 * The selected branch's history: one chip per node execution, in the order the
 * branch ran them, with a `→` between them (`10` run view 3b). A failed chip
 * carries its short reason; a loop inside the branch repeats a node, and the
 * second pass says so (`impl #2`) rather than pretending the first never
 * happened. Nothing selected, nothing drawn — an empty strip would claim the
 * branch has run nothing, which is a fact about a branch nobody picked.
 */
function BranchHistory({ branch }: { branch: Branch | null }) {
  if (!branch) {
    return (
      <p
        className="border-t border-line px-[10px] py-[8px] font-mono text-[10.5px] text-faint"
        data-testid="branch-history-empty"
      >
        select a branch to see what it has been through.
      </p>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-[6px] border-t border-line px-[10px] py-[8px]"
      data-testid="branch-history"
      aria-label={`History of branch ${branch.index}`}
    >
      <span className="font-mono text-[11px] text-muted">task {branch.index}</span>
      {branch.attempts > 1 ? (
        <span className="font-mono text-[10px] text-faint">att {branch.attempts}</span>
      ) : null}
      {branch.steps.length === 0 ? (
        <span className="font-mono text-[10.5px] text-faint" data-testid="branch-history-none">
          queued
        </span>
      ) : null}
      {branch.steps.map((step, at) => {
        const spec = STATES[step.state];
        return (
          <span key={step.key} className="flex items-center gap-[6px]">
            {at > 0 ? (
              <span aria-hidden className="text-faint">
                →
              </span>
            ) : null}
            <span
              data-testid={`branch-step-${step.key}`}
              data-branch-step-state={step.state}
              title={`${step.key}: ${spec.word}`}
              className={`rounded-[2px] border border-line-strong px-[6px] py-[2px] font-mono text-[10.5px] ${spec.tagBg} ${spec.tagFg}`}
            >
              {step.repeated ? `${step.nodeId} #${step.pass}` : step.nodeId}
              <span aria-hidden className="ml-[4px]">
                {spec.glyph}
              </span>
              {step.reason ? (
                <span className="ml-[4px] text-st-failed-tag-fg underline decoration-dotted">
                  {step.reason}
                </span>
              ) : null}
              <span className="sr-only">{`, ${spec.word}`}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}
