/**
 * edges.tsx — the canvas edge bodies. `insertable` (depends / guarded) edges
 * carry a midpoint "+" that opens the step picker; choosing an item calls the
 * canvas's `onInsert(kind)`, which rewrites `A→B` into `A→NEW→B`. `error`
 * edges are dashed, labelled "on error", and never split (design doc §4 rule
 * 4 is a hard rejection, so they show no "+").
 *
 * On a read-only canvas (`readOnly`, the Run Workbench's Graph tab) the "+" is
 * not drawn at all — a run projects a pinned revision and cannot take the
 * insert. The edge and its route label stay.
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

/**
 * The "+" is a 44px button wearing a 22px circle. The app-shell phone band
 * (`styles/tokens.css`, `main button { min-height: 44px }`) and the emulator's
 * own touch-target check (`e2e/emulator/reflow.ts`'s `findSmallTargets`, which
 * measures the REAL box of every control) both want a 44px target; drawing the
 * circle at 44px is what stretched it into the tall pill the pass-7 review
 * caught at 390. So the target and the ink are separate elements: the button is
 * the invisible 44px square, the circle inside it is the 22px the design draws
 * at every width, and the hover ring moves to the circle.
 */
const addHit =
  "pointer-events-auto absolute grid h-[44px] w-[44px] place-items-center rounded-full bg-transparent text-sm leading-none outline-none focus-visible:ring-2 focus-visible:ring-accent";
const addCircle =
  "grid h-[22px] w-[22px] place-items-center rounded-full border border-line-strong bg-surface text-ink-2 shadow-sm group-hover:border-accent group-hover:text-accent group-focus-within:border-accent group-focus-within:text-accent";

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
          strokeWidth: preview ? 2 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <div
          // While the picker is open this group must paint above EVERY other
          // edge's group (each group is a transform stacking context, so they
          // compete by z-index inside the edge-label renderer). A 44px "+"
          // hit square from a neighbouring edge used to land on the open
          // picker's kind cards — the click hit the "+" instead of the item
          // (the shell acceptance's timed-out click). One z-bump on the open
          // edge lifts its whole picker over all the "+" squares.
          className={
            pickerOpen
              ? "pointer-events-auto absolute group z-50"
              : "pointer-events-auto absolute group"
          }
          style={{ left: midX, top: midY, transform: "translate(-50%, -50%)" }}
        >
          {/* A read-only canvas (the Run Workbench's Graph tab projects a pinned
              revision) has NO insert affordance: the "+" and its picker are the
              editor's verbs, and drawing them on a screen that cannot take the
              edit is a lie about the page. The route label below still prints —
              it is a fact of the definition, not a verb. */}
          {interactive && (
            <button
              type="button"
              className={addHit}
              style={{
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
              }}
              data-testid={`edge-add-${data.edge.from}-${data.edge.to}`}
              aria-label={`Insert a step between ${data.edge.from} and ${data.edge.to}`}
              // The "+" opens the picker and NOTHING else: without the
              // pointerdown guard the gesture bubbles to the node/pane and
              // the hosting step gets selected on the same click.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                // With its own picker already open the "+" is inert: the click
                // neither reopens it nor fires a second insert gesture — the
                // one picker on screen owns the next click.
                if (pickerOpen) return;
                setPickerOpen(true);
              }}
            >
              <span aria-hidden className={addCircle}>
                +
              </span>
            </button>
          )}
          {/* Rendered AFTER the button and z-raised inside the (already
              z-raised) group, so the open picker always wins the hit test
              over its own "+" square as well as every neighbour's. */}
          {interactive && pickerOpen && (
            <div
              className="pointer-events-auto absolute z-50"
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
