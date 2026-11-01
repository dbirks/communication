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
import { EDGE_ADD_LABEL_OFFSET_PX, routeEdge, type EdgeAxis, type EdgeBox } from "./flowModel";
import { useState, useEffect, useRef, type CSSProperties } from "react";
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
 * Where the edge label copy sits: the "+" is a 44px target (`addHit`) centred on
 * the line's midpoint and its label starts `EDGE_ADD_LABEL_OFFSET_PX` out from
 * that midpoint. `flowModel` owns both numbers — the label seat it publishes is
 * what places a route label beside the "+" — and they are re-exported here for
 * the tests that read the rendered offsets back.
 *
 * The pass-1 overlap defect was the hover `insert step` word starting at +16,
 * i.e. 6px INSIDE the invisible 44px target, which the checker measures as text
 * painted over its own button (`1g inspector-edit` at 1280:
 * `edge-add-survey-plan × span "insert step"`, 6×16px). The design's 9px gap is
 * measured from the 22px CIRCLE (its ink stops at +11) while the hit box reaches
 * +22, so the gap comes off the box: the word still reads as the "+" it names.
 */
export { EDGE_ADD_LABEL_OFFSET_PX, EDGE_ADD_TARGET_PX } from "./flowModel";

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
  const groupRef = useRef<HTMLDivElement | null>(null);
  const [path, midX, midY] = edgePath(data, props);
  // The collision-checked anchor overrides the raw path midpoint: in the dense
  // top-to-bottom cut the midpoint can sit on a neighbour scope's box.
  const labelX = data?.labelAnchor?.x ?? midX;
  const labelY = data?.labelAnchor?.y ?? midY;
  if (!data) return null;
  const interactive = !data.readOnly && !data.stale;
  const preview = data.preview;
  const pillText = preview ? `Insert ${preview} here` : data.label;

  // The group's own origin IS the line midpoint (the group is drawn at
  // `left: midX, top: midY`), so every child positions itself relative to the
  // "+" and the collision-checked anchor arrives in absolute flow coordinates
  // with the midpoint taken off it. `toFlow` seats a route label BESIDE the
  // "+" (its own width and every other "+" square and node box cleared), so an
  // anchored pill simply draws centred there. Without an anchor the seat is
  // this file's own call: the "+" owns the midpoint on an editable canvas, so
  // the pill — and the drag preview, whose text is wider than any label the
  // seat was sized for — is anchored by its NEAR edge a full offset out; on a
  // read-only canvas (no "+", nothing owns the midpoint) it centres on the line.
  const anchorDx = labelX - midX;
  const anchorDy = labelY - midY;
  const pillOnLeft = anchorDx < -0.5;

  // Issue #67: the open picker owns the outside world. It used to close ONLY
  // through its own input's Escape (focus inside), so a click anywhere else on
  // the page left it hanging over the graph. A capture-phase pointerdown
  // OUTSIDE the edge's group closes it without swallowing the gesture (no
  // preventDefault/stopPropagation — the click reaches its real target, the
  // same contract as the canvas's node-menu click-away), and Escape closes it
  // whether or not focus is inside. INSIDE the group is deliberately still
  // inert: the edge's own “+” keeps b266061's one-click-one-step rule (the
  // re-click reads `pickerOpen === true` and returns; nothing toggles
  // close-then-reopen under it).
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest && groupRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    globalThis.document.addEventListener("pointerdown", onPointerDown, true);
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
      globalThis.document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);
  const nearEdge = (side: boolean, top: number): CSSProperties =>
    side
      ? { left: -EDGE_ADD_LABEL_OFFSET_PX, top, transform: "translate(-100%, -50%)" }
      : { left: EDGE_ADD_LABEL_OFFSET_PX, top, transform: "translate(0, -50%)" };
  const pillStyle: CSSProperties =
    preview !== null
      ? nearEdge(pillOnLeft, anchorDy)
      : data.labelAnchor
        ? { left: anchorDx, top: anchorDy, transform: "translate(-50%, -50%)" }
        : interactive
          ? nearEdge(false, anchorDy)
          : { left: anchorDx, top: anchorDy, transform: "translate(-50%, -50%)" };

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
          ref={groupRef}
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
              // Issue #67: React Flow's own classes — `nowheel` keeps the wheel
              // over the picker's scrollable list scrolling the LIST instead of
              // zooming the canvas, `nopan`/`nodrag` keep a pointer-down inside
              // the picker from panning or dragging the graph underneath.
              className="nowheel nopan nodrag pointer-events-auto absolute z-50"
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
              until the "+" is hovered or focused (the a11y name is always on
              the button). It starts a whole target width out from the line
              (`EDGE_ADD_LABEL_OFFSET_PX`), so the word
              never prints inside the "+"'s own 44px box: the design's 9px gap
              is measured from the 22px circle, and the circle's ink stops at
              +11 while its hit box reaches +22 — a real gap here would push the
              word 30px+ off the circle and read as unrelated page text. */}
          {pillText === null && interactive && (
            <span
              className="pointer-events-none absolute whitespace-nowrap font-mono text-[10.5px] text-accent opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
              style={{ left: EDGE_ADD_LABEL_OFFSET_PX, top: 0, transform: "translateY(-50%)" }}
              data-testid={`edge-add-label-${data.edge.from}-${data.edge.to}`}
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
              style={pillStyle}
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
