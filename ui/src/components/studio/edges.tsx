/**
 * edges.tsx — the canvas edge bodies. `insertable` (depends / guarded) edges
 * carry a midpoint "+" that opens the step picker; choosing an item calls the
 * canvas's `onInsert(kind)`, which rewrites `A→B` into `A→NEW→B`. `error`
 * edges are dashed, labelled "on error", and never split (design doc §4 rule
 * 4 is a hard rejection, so they show no "+").
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { GraphEdge } from "../../lib/pipeline/graphDoc";
import { useState } from "react";
import { StepPicker } from "./StepPicker";

export type InsertableEdgeRender = {
  edge: GraphEdge;
  readOnly: boolean;
  stale: boolean;
  /** The short route value for a guarded edge (null for plain depends). */
  label: string | null;
  /** The full `when` expression for the label's title tooltip. */
  labelTitle: string | null;
  /** Label of the kind being dragged over this edge ("Insert … here"). */
  preview: string | null;
  /** The collision-checked label anchor in absolute flow coordinates; null
   * keeps the raw path midpoint (flowModel only shifts a label that would
   * otherwise sit on a neighbour node/scope box). */
  labelAnchor: { x: number; y: number } | null;
  /** The picked kind — present only when the canvas can insert here. */
  onInsert: (kind: string) => void;
};

export type ErrorEdgeRender = {
  edge: GraphEdge;
  label: string | null;
  /** The collision-checked label anchor (see `InsertableEdgeRender`). */
  labelAnchor: { x: number; y: number } | null;
};

const addButton =
  "pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-surface text-xs leading-none text-ink-2 shadow-sm hover:border-accent hover:text-accent";

function smoothPath(props: {
  sourceX: number;
  sourceY: number;
  sourcePosition: unknown;
  targetX: number;
  targetY: number;
  targetPosition: unknown;
}) {
  return getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition as never,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition as never,
    borderRadius: 6,
  });
}

export function InsertableEdge(props: EdgeProps<Edge<InsertableEdgeRender>>) {
  const { id, data } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [path, pathLabelX, pathLabelY] = smoothPath(props);
  // The collision-checked anchor overrides the raw path midpoint: in the dense
  // top-to-bottom cut the midpoint can sit on a neighbour scope's box.
  const labelX = data?.labelAnchor?.x ?? pathLabelX;
  const labelY = data?.labelAnchor?.y ?? pathLabelY;
  if (!data) return null;
  const interactive = !data.readOnly && !data.stale;
  const preview = data.preview;
  const label = preview ? `Insert ${preview} here` : data.label;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: preview ? "var(--color-accent)" : "var(--color-ink-2)",
          strokeWidth: preview ? 2 : 1.25,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="pointer-events-none absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <div className="flex flex-col items-center gap-1">
            {interactive && !preview && (
              <button
                type="button"
                className={addButton}
                data-testid={`edge-add-${data.edge.from}-${data.edge.to}`}
                aria-label={`Insert a step between ${data.edge.from} and ${data.edge.to}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPickerOpen(true);
                }}
              >
                +
              </button>
            )}
            {label && (
              <span
                data-testid={preview ? "insert-preview" : undefined}
                title={preview ? undefined : (data.labelTitle ?? label)}
                className={
                  preview
                    ? "pointer-events-none rounded-full border border-accent bg-surface px-2 py-0.5 text-[10px] font-semibold text-accent"
                    : "pointer-events-none max-w-[76px] overflow-hidden rounded-full border border-line bg-surface px-1.5 py-0.5 text-ellipsis text-[10px] text-ink-2"
                }
              >
                {label}
              </span>
            )}
            {pickerOpen && (
              <div className="pointer-events-auto absolute left-1/2 top-full mt-1">
                <StepPicker
                  title={`Insert a step between ${data.edge.from} and ${data.edge.to}`}
                  onPick={(kind) => {
                    setPickerOpen(false);
                    data.onInsert(kind);
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              </div>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export function ErrorEdge(props: EdgeProps<Edge<ErrorEdgeRender>>) {
  const { id, data } = props;
  const [path, pathLabelX, pathLabelY] = smoothPath(props);
  const labelX = data?.labelAnchor?.x ?? pathLabelX;
  const labelY = data?.labelAnchor?.y ?? pathLabelY;
  if (!data) return null;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: "var(--color-st-failed-strong)",
          strokeWidth: 1.25,
          strokeDasharray: "5 4",
        }}
      />
      <EdgeLabelRenderer>
        <span
          className="pointer-events-none absolute rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-st-failed-pale-fg"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          aria-label={`Error route from ${data.edge.from} to ${data.edge.to}`}
        >
          {data.label ?? "on error"}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
