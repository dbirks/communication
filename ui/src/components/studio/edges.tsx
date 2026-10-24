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
import { routeEdge, type EdgeAxis, type EdgeBox } from "./flowModel";
import { useState } from "react";
import { StepPicker } from "./StepPicker";

/** The endpoint geometry a routed edge is drawn from (see `routeEdge`). */
type RoutedGeometry = {
  sourceBox: EdgeBox | null;
  targetBox: EdgeBox | null;
  axis: EdgeAxis;
};

export type InsertableEdgeRender = RoutedGeometry & {
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

export type ErrorEdgeRender = RoutedGeometry & {
  edge: GraphEdge;
  label: string | null;
  /** The collision-checked label anchor (see `InsertableEdgeRender`). */
  labelAnchor: { x: number; y: number } | null;
};

const addButton =
  "pointer-events-auto absolute flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line-strong bg-surface text-sm leading-none text-ink-2 shadow-sm hover:border-accent hover:text-accent hover:shadow-[0_0_0_2px_var(--color-accent-ring)]";

/**
 * The path and its label point for one edge. When `toFlow` carried the
 * endpoint boxes, route from them with `routeEdge` (the same geometry the
 * label anchor was checked against — siblings get a short side-to-side
 * connector, scope entries/exits attach at the scope's top/bottom); only
 * when the geometry is missing (the jsdom-free fallback) does the edge fall
 * back to React Flow's own handle-based smooth-step.
 */
function edgePath(
  data: RoutedGeometry | undefined,
  props: EdgeProps<Edge<Record<string, unknown>>>,
): [string, number, number] {
  if (data?.sourceBox && data?.targetBox) {
    const r = routeEdge(data.sourceBox, data.targetBox, data.axis);
    return [r.path, r.x, r.y];
  }
  const [path, x, y] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: (props.sourcePosition ?? "right") as never,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: (props.targetPosition ?? "left") as never,
    borderRadius: 6,
  });
  return [path, x, y];
}

export function InsertableEdge(props: EdgeProps<Edge<InsertableEdgeRender>>) {
  const { id, data } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [path, midX, midY] = edgePath(data, props);
  // The collision-checked anchor overrides the raw path midpoint: in the dense
  // top-to-bottom cut the midpoint can sit on a neighbour scope's box.
  const labelX = data?.labelAnchor?.x ?? midX;
  const labelY = data?.labelAnchor?.y ?? midY;
  if (!data) return null;
  const interactive = !data.readOnly && !data.stale;
  const preview = data.preview;
  const pillText = preview ? `Insert ${preview} here` : data.label;

  // The "+" is centred ON the line at its midpoint; an edge label sits beside
  // the line and never over the "+" — when the checked anchor landed on the
  // line midpoint the button owns that spot, so the pill moves beside it.
  const pillAtLine = Math.abs(labelX - midX) < 1 && Math.abs(labelY - midY) < 1;
  const pillPos = pillAtLine ? { x: midX + 24, y: midY } : { x: labelX, y: labelY };

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
          className="pointer-events-auto absolute group"
          style={{ left: midX, top: midY, transform: "translate(-50%, -50%)" }}
        >
          {pickerOpen && (
            <div
              className="pointer-events-auto absolute"
              style={{ left: 0, top: 24, transform: "translate(-50%, -50%)" }}
            >
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
          <button
            type="button"
            className={addButton}
            style={{
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: 22,
              height: 22,
            }}
            data-testid={`edge-add-${data.edge.from}-${data.edge.to}`}
            aria-label={`Insert a step between ${data.edge.from} and ${data.edge.to}`}
            // The "+" opens the picker and NOTHING else: without the
            // pointerdown guard the gesture bubbles to the node/pane and
            // the hosting step gets selected on the same click.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen(true);
            }}
          >
            +
          </button>
          {/* Design 1g: the "insert step" word sits immediately right of the
              "+" — single-line mono, no bubble, no wrap — and is hidden
              until the "+" is hovered or focused. */}
          {pillText === null && interactive && (
            <span
              className="pointer-events-none absolute whitespace-nowrap font-mono text-[10.5px] text-accent opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
              style={{ left: 16, top: 0, transform: "translateY(-50%)" }}
            >
              insert step
            </span>
          )}
          {pillText !== null && (
            <span
              className={
                "pointer-events-none absolute rounded-full border bg-surface px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-ink-2 " +
                (preview ? "border-accent text-accent" : "border-line")
              }
              style={{ left: pillPos.x, top: pillPos.y, transform: "translate(-50%, -50%)" }}
              data-testid={preview ? "insert-preview" : undefined}
              title={preview ? undefined : (data.labelTitle ?? pillText)}
            >
              {pillText}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export function ErrorEdge(props: EdgeProps<Edge<ErrorEdgeRender>>) {
  const { id, data } = props;
  const [path, pathLabelX, pathLabelY] = edgePath(data, props);
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
