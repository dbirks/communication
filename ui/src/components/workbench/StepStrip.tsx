/**
 * The full-screen workbench's step strip (design 5c): when the reader folds
 * the graph away (`?full=1`), the pinned revision's TOP-LEVEL steps become
 * one row of cells across the top of the page — the graph collapsed to its
 * spine. One cell per step: its name, the shared state glyph and word
 * (identity rule 06 — state is always glyph + word, never colour alone)
 * and, on an `until` loop, the iteration counter (`● 2/4`). The
 * selected/current step is raised with the tokens' hard `2px 2px 0` ink
 * shadow. Clicking a cell is exactly clicking the node on the graph — the
 * page selects that step's transcript.
 *
 * The cells carry the graph boxes' own overlays (one per definition node
 * id), so the strip can never disagree with the graph about a step's state;
 * a step the journal has not touched yet reads `queued`, "not started".
 * The strip scrolls horizontally inside itself — the page never scrolls
 * sideways (the `<ol>` keeps the overflow, `min-w-0` on the strip).
 */
import { SHORT_WORD, STATES } from "../ds/states";
import type { Overlay } from "../../lib/pipeline/workbench";

/** One top-level step of the pinned definition (or a journal stand-in). */
export interface StepStripStep {
  id: string;
  kind: string;
}

/** One strip cell: the step, the overlay its graph box wears, its counter. */
export interface StepCellData {
  id: string;
  /** The step's name — the definition's node id, the run's own label. */
  name: string;
  overlay: Overlay;
  /** An `until` step's compact `i/N` iteration counter, or null. */
  loopCounter: string | null;
}

/** The overlay's `iteration 2 of 4` → the strip's compact `2/4`. */
export function loopCounterOf(label: string): string | null {
  const match = /^iteration (\d+) of (\d+)$/.exec(label);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The strip's cells: one per top-level step, in definition order. */
export function buildStepCells(
  steps: readonly StepStripStep[],
  overlays: Record<string, Overlay>,
): StepCellData[] {
  return steps.map((step) => {
    const overlay = overlays[step.id] ?? {
      state: "queued" as const,
      label: "not started",
      executionId: null,
    };
    return {
      id: step.id,
      name: step.id,
      overlay,
      loopCounter: step.kind === "until" ? loopCounterOf(overlay.label) : null,
    };
  });
}

/**
 * The strip: a horizontally scrollable row of step cells. Each cell keeps
 * its state's tag colours and, when it is the selected step, the raised
 * `2px 2px 0` ink shadow (the tokens' `--shadow-raised`) — the same raise
 * the graph's selected box wears.
 */
export function StepStrip({
  cells,
  selectedId,
  onSelect,
}: {
  cells: readonly StepCellData[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Run steps"
      className="min-w-0 overflow-x-auto"
      data-testid="workbench-step-strip"
    >
      <ol className="flex min-w-max items-stretch gap-[6px]">
        {cells.map((cell) => {
          const spec = STATES[cell.overlay.state];
          const selected = cell.id === selectedId;
          const word = cell.loopCounter ?? SHORT_WORD[cell.overlay.state];
          return (
            <li key={cell.id}>
              <button
                type="button"
                aria-pressed={selected}
                data-testid={`workbench-step-cell-${cell.id}`}
                onClick={() => onSelect(cell.id)}
                className={`shrink-0 whitespace-nowrap rounded-[3px] border px-2.5 py-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${spec.tagBg} ${spec.tagFg} ${
                  selected ? "border-ink shadow-(--shadow-raised)" : "border-line"
                }`}
              >
                <span className="text-[12px] font-semibold">{cell.name}</span>{" "}
                <span aria-hidden="true" className="text-[12px] font-bold">
                  {spec.glyph}
                </span>{" "}
                <span className="font-mono text-[11px]">{word}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
