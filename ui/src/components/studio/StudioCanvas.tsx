/**
 * StudioCanvas.tsx — the interactive React Flow canvas of the Workflow
 * Studio: the step graph with its scope boxes, the "+" affordances (edge
 * midpoints, trailing terminal steps, empty scope bodies, empty canvas),
 * drag-to-insert with edge hit-testing, connect refusal reporting, and the
 * accessible steps list under the canvas.
 *
 * Presentational by contract: it owns no draft state and never applies a
 * graph op itself — every gesture is a callback into the Studio page
 * (`onSelect`, `onMove`, `onInsertOnEdge`, `onAddAfter`, `onConnect`,
 * `onDelete`). The YAML text in `graphDoc.ts` stays the source of truth.
 */
import "@xyflow/react/dist/style.css";
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import {
  findNode,
  scopeKey,
  type GraphEdge,
  type GraphModel,
  type ScopePath,
} from "../../lib/pipeline/graphDoc";
import { nearestEdge, stepLabel, toFlow, type FlowModel } from "./flowModel";
import {
  ErrorEdge,
  InsertableEdge,
  type ErrorEdgeRender,
  type InsertableEdgeRender,
} from "./edges";
import { ScopeNode, StepNode, type ScopeNodeRender, type StepNodeRender } from "./nodes";
import { NodeMenu } from "./NodeMenu";
import { StepPicker } from "./StepPicker";
import { PALETTE_DRAG_TYPE } from "./StudioPalette";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

export type UiLayout = { nodes?: Record<string, { x: number; y: number }> };

export interface StudioCanvasProps {
  model: GraphModel;
  /** The parsed JS document (for `layoutDefinition`). */
  document: unknown;
  /** Saved positions keyed by node id; override the dagre positions. */
  layout: UiLayout;
  selectedId: string | null;
  /** Multi-selection ids (Shift+click, Shift+drag box, the outline's
   * checkboxes). `[]`/absent = the single `selectedId` drives the ring. */
  selectedIds?: string[];
  /** Fired whenever React Flow's selection set changes. */
  onSelectionChange?(ids: string[]): void;
  /** No handles, no + buttons, no drag-to-insert, no delete. */
  readOnly: boolean;
  /** YAML currently invalid: render greyed with `staleMessage`. */
  stale: boolean;
  staleMessage?: string;
  /** Node ids to ring with `data-highlight="assistant-proposed"`. */
  highlight?: string[];
  /** Render a text+icon badge on the matching step. */
  statusOverlay?: Record<string, { state: string; label: string }>;
  onSelect(id: string | null): void;
  onMove?(id: string, pos: { x: number; y: number }): void;
  onInsertOnEdge?(edge: GraphEdge, kind: string): void;
  /** + after terminal step / empty canvas / empty scope body. */
  onAddAfter?(afterId: string | null, scope: ScopePath, kind: string): void;
  /** A definition node id to centre in view once it is on the canvas
   * (the Workbench deep link's `?node=`); the canvas honours it until the
   * reader pans/zooms, then the reader's viewport wins. */
  focusNodeId?: string | null;
  onConnect?(from: string, to: string): void;
  onDelete?(ids: string[]): void;
  /** Duplicate a step — the selected node's context/selection menu calls it
   * with the definition node id (the Studio page wires it to its undoable op). */
  onDuplicate?: (id: string) => void;
  canConnect?(from: string, to: string): { ok: true } | { ok: false; reason: string };
  /**
   * Design 1g pass 2 #8: the Studio drops the `steps list` strip under the
   * canvas (the status bar already counts the steps). The Run Workbench
   * keeps it — it is that page's accessible definition table.
   */
  hideStepList?: boolean;
}

// ---------------------------------------------------------------------------
// Palette → canvas drag registry.
//
// HTML5 drag events expose the dataTransfer *value* only on drop, so the
// dragged kind travels through this module state: the palette reports
// dragstart/dragend, the canvas mirrors it to render the drop preview.
// ---------------------------------------------------------------------------

type DragKindListener = (kind: string | null) => void;
const dragListeners = new Set<DragKindListener>();

export function setPaletteDragKind(kind: string | null): void {
  for (const listener of dragListeners) listener(kind);
}

function subscribeDragKind(listener: DragKindListener): () => void {
  dragListeners.add(listener);
  return () => {
    dragListeners.delete(listener);
  };
}

export function StudioCanvas(props: StudioCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/**
 * The connect decision, factored out so the refusal path is testable without
 * driving a handle drag in jsdom: refused reasons surface in the toast
 * (`connect-refused`) and `onConnect` is not called.
 */
export function evaluateConnect(
  canConnect: StudioCanvasProps["canConnect"],
  from: string,
  to: string,
): { refused: string | null; proceed: boolean } {
  if (canConnect) {
    const result = canConnect(from, to);
    if (!result.ok) return { refused: result.reason, proceed: false };
  }
  return { refused: null, proceed: true };
}

const nodeTypes = {
  step: StepNode,
  scope: ScopeNode,
};

const edgeTypes = {
  insertable: InsertableEdge,
  error: ErrorEdge,
};

/** The pointer must be within this many px of the segment to count as an
 * "insert here" drop (design doc §3.2). The smooth-step path bows well off the
 * straight segment in a tight top-to-bottom layout (a short hop with a rank
 * offset bows ~30px at its midpoint), and the drop preview is drawn AT the
 * path midpoint — so the radius must comfortably clear the bow, not just the
 * 24px the doc names for a straight edge. */
const DROP_EDGE_RADIUS_PX = 48;

/** Width the node menu is measured at for the fits-on-the-right check
 * (design 1g: a two-item menu). Measured on the live canvas at 1280: the two
 * labels, their 8px padding each side and the 3px pad + border around them.
 * The drawn box is reported back through `onMeasure` and re-placed with its
 * real size, so this number only has to be honest BEFORE the first paint. */
const MENU_WIDTH_PX = 78;

/** The same menu's height (two 24px rows + the 3px pad + the 2px gap). On the
 * phone band the 44px control floor grows it; `onMeasure` corrects that. */
const MENU_HEIGHT_PX = 64;

/** The design's gap between a step and its menu (1g: 8px). */
const MENU_GAP_PX = 8;

/** The same two actions as ONE row (`Duplicate` · `Delete ⌫`) — the shape the
 * menu takes when nothing else clears. Width and height are the box the phone
 * actually draws: the two labels, their 8px padding each side and the 6px
 * between them, over the 44px touch floor the app-shell band gives every
 * button (`styles/tokens.css`) plus the menu's own 3px pad and border — so the
 * box the placement math reserves is the box that gets painted. */
export const MENU_COMPACT_W_PX = 153;
export const MENU_COMPACT_H_PX = 52;

/** A box in PANE pixels. */
export interface MenuBoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the selected step's menu goes (design 1g: right of the node,
 * VERTICALLY CENTRED on the step — the issue #66 place pass moved the popover
 * off the old top-aligned anchor so it reads as a popover centred on its
 * step). A menu that lands on ANOTHER step or on the pane's own edge is the
 * defect — `Duplicate`/`Delete` painted over `approve` and the chain read as a
 * mess (pass-2), and at 390 the row dropped under its node, printed across the
 * connector edge and the next card, and hugged the canvas' right border
 * (pass-8, defect 1). So the candidates run in this order:
 *
 *  1. right of the node (the design's slot), centred on the step's mid-line
 *     and clamped into a measured pane,
 *  2. below the node,
 *  3. ABOVE the node — the menu opens upward when there is no room below,
 *  4. right of the node again, but slid back into the pane: it is still
 *     anchored to its own step's right edge (and stays centred on its row),
 *     and the only card it can cover there is the one it belongs to,
 *  5. ONE ROW centred in the clear air between its step and its neighbour
 *     (below, then above) — the gap is measured, not assumed, because the
 *     canvas is zoomed to fit and a constant would be wrong at every width,
 *  6. ONE ROW directly under its step, clamped into the pane, even though it
 *     paints over a neighbour: the menu belongs to the selected step, and a
 *     reader who cannot see which step it speaks to has lost more than a few
 *     pixels of overlap. The pass-2 answer, a strip docked to the pane's own
 *     bottom edge, detached the actions from the node they act on entirely
 *     (the pass-7 review read `1g inspector-edit` at 390 as a menu bar
 *     belonging to the canvas), so it survives only for a pane too short to
 *     hold even the one-row menu.
 *
 * An unmeasured pane (0×0 — jsdom, or a canvas that has not laid out yet)
 * keeps the plain right-hand position rather than clamping everything.
 */
export function chooseNodeMenuPlacement(input: {
  /** The selected node (or the right-click point) in pane px. */
  node: MenuBoxPx;
  /** Every OTHER rendered node in pane px. */
  others: MenuBoxPx[];
  /** The menu's own size in px (it never scales with the zoom). */
  menu: { w: number; h: number };
  /** The one-row fallback's size; defaults to {@link MENU_COMPACT_W_PX}. */
  compact?: { w: number; h: number };
  pane: { w: number; h: number };
  gap?: number;
}): MenuBoxPx & { docked: boolean; compact: boolean } {
  const gap = input.gap ?? MENU_GAP_PX;
  const { node, others, pane } = input;
  const overlaps = (a: MenuBoxPx, b: MenuBoxPx) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const inside = (box: MenuBoxPx) => {
    if (box.x < 0 || box.y < 0) return false;
    if (pane.w > 0 && box.x + box.w > pane.w - gap) return false;
    if (pane.h > 0 && box.y + box.h > pane.h - gap) return false;
    return true;
  };
  const clear = (box: MenuBoxPx) => inside(box) && !others.some((other) => overlaps(box, other));
  const placed = (
    box: MenuBoxPx,
    compact: boolean,
  ): MenuBoxPx & { compact: boolean; docked: boolean } => ({ ...box, compact, docked: false });
  const cw = input.compact?.w ?? MENU_COMPACT_W_PX;
  const ch = input.compact?.h ?? MENU_COMPACT_H_PX;
  // The menu's y in the design's right-hand slot: CENTRED on the step's mid-
  // line. With a measured pane it is clamped inside — the menu is taller than
  // a 52px step, so beside a step near the pane's top or bottom edge the
  // centre is nudged until the whole popover fits, and it stays beside its
  // own step either way.
  const centerY = node.y + node.h / 2 - input.menu.h / 2;
  const sideY = pane.h > 0 ? Math.max(0, Math.min(centerY, pane.h - input.menu.h - gap)) : centerY;

  for (const box of [
    { x: node.x + node.w + gap, y: sideY, w: input.menu.w, h: input.menu.h },
    { x: node.x, y: node.y + node.h + gap, w: input.menu.w, h: input.menu.h },
    // Opens upward instead of covering the step below (the phone chain, and any
    // step whose next sibling is crowded).
    { x: node.x, y: node.y - gap - input.menu.h, w: input.menu.w, h: input.menu.h },
  ] satisfies MenuBoxPx[]) {
    if (clear(box)) return placed(box, false);
  }

  // 4. To the side, clamped back into the pane.
  if (pane.w > 0 && pane.h > 0) {
    const side: MenuBoxPx = {
      x: Math.max(gap, Math.min(node.x + node.w + gap, pane.w - input.menu.w - gap)),
      y: Math.max(gap, Math.min(sideY, pane.h - input.menu.h - gap)),
      w: input.menu.w,
      h: input.menu.h,
    };
    if (clear(side)) return placed(side, false);

    // 5. One row, centred in the free air on the side with room. `sameColumn`
    // is the neighbour the row would actually paint over: a step offset to the
    // side (a branch) leaves the space under the node clear.
    const sameColumn = (other: MenuBoxPx) =>
      other.x < node.x + node.w && other.x + other.w > node.x;
    const rowX = Math.min(Math.max(node.x, gap), Math.max(gap, pane.w - cw - gap));
    const belowCeil = others
      .filter((other) => sameColumn(other) && other.y >= node.y + node.h)
      .reduce((ceil, other) => Math.min(ceil, other.y), pane.h - gap);
    const aboveFloor = others
      .filter((other) => sameColumn(other) && other.y + other.h <= node.y)
      .reduce((floor, other) => Math.max(floor, other.y + other.h), gap);
    for (const box of [
      {
        x: rowX,
        y: node.y + node.h + Math.min(gap, Math.max(0, (belowCeil - (node.y + node.h) - ch) / 2)),
        w: cw,
        h: ch,
      },
      {
        x: rowX,
        y: node.y - ch - Math.min(gap, Math.max(0, (node.y - aboveFloor - ch) / 2)),
        w: cw,
        h: ch,
      },
    ] satisfies MenuBoxPx[]) {
      if (clear(box)) return placed(box, true);
    }
  }

  // Directly under the node, one row, clamped sideways and down so none of it
  // leaves the pane.
  if (pane.h >= ch + gap * 2) {
    const maxLeft = Math.max(gap, pane.w - cw - gap);
    return placed(
      {
        x: Math.min(Math.max(node.x, gap), maxLeft),
        y: Math.min(node.y + node.h + gap, Math.max(gap, pane.h - ch - gap)),
        w: cw,
        h: ch,
      },
      true,
    );
  }
  // Nothing fits over the graph at all: the actions leave the pane and take a
  // flow row of their own under the viewport.
  return {
    ...placed(
      { x: 0, y: Math.max(0, pane.h - input.menu.h), w: input.menu.w, h: input.menu.h },
      false,
    ),
    docked: true,
  };
}

/* ------------------------------------------------------------------ the
 * viewport-fit guards.
 *
 * The live Workbench went blank mid-run (issue #2): nodes sat in the DOM
 * while the pane showed nothing. Two failure modes were proven from the
 * acceptance trace:
 *   1. a fit ran while nodes were still unmeasured / the pane was
 *      transiently 0×0 — React Flow's `getViewportForBounds` divides by
 *      zero bounds and the resulting wrong (or NaN) transform sticks, and
 *      nothing refits afterwards;
 *   2. React Flow's internal diff machinery (the fitView queue flush, the
 *      "Fit View" control) reports `add`/`remove` changes through
 *      onNodesChange/onEdgesChange; applying them shrank the canvas's
 *      controlled mirror until 16 of 17 nodes were gone.
 * The helpers below make both safe and are unit-tested directly. */

/** Smallest pane (CSS px) a fit or centre will run against. */
export const MIN_FIT_PANE_PX = 48;

function isPositiveFinite(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Fit the graph's boxes into the pane. Returns the viewport to apply,
 * or null when the fit must NOT run: a zero/transient pane, degenerate
 * boxes, or any non-finite result (a fit against unmeasured/zero-size
 * inputs is exactly what blanked the canvas). */
export function computeFitViewport(
  boxes: { x: number; y: number; width: number; height: number }[],
  paneWidth: number,
  paneHeight: number,
  minZoom = 0.4,
  // Design 1g pass 2 #1: the fit never magnifies past 100% — a 200×52 step
  // fits at its designed size, not the 250×65 a 1.25 cap rendered (the
  // "nodes are too big, name ~16px" observation was this cap).
  maxZoom = 1,
  padding = 0.08,
): { x: number; y: number; zoom: number } | null {
  if (!isPositiveFinite(paneWidth) || !isPositiveFinite(paneHeight)) return null;
  if (paneWidth < MIN_FIT_PANE_PX || paneHeight < MIN_FIT_PANE_PX) return null;
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !isPositiveFinite(box.width) ||
      !isPositiveFinite(box.height)
    ) {
      return null; // an unmeasured/degenerate box: refuse rather than fit wrong
    }
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const p = padding;
  const xZoom = (paneWidth - p * 2 * paneWidth) / bounds.width;
  const yZoom = (paneHeight - p * 2 * paneHeight) / bounds.height;
  const zoom = Math.min(xZoom, yZoom);
  const clampedZoom = Number.isFinite(zoom) ? Math.min(Math.max(zoom, minZoom), maxZoom) : NaN;
  const x = paneWidth / 2 - (bounds.x + bounds.width / 2) * clampedZoom;
  const y = paneHeight / 2 - (bounds.y + bounds.height / 2) * clampedZoom;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(clampedZoom)) return null;
  return { x, y, zoom: clampedZoom };
}

/** CSS px between the pane's top edge and the graph's first box when the
 * canvas fits itself (design 1g: the chain starts ~50px below the top and
 * rides top-aligned, it is NOT vertically centred). */
export const FIT_TOP_PAD_PX = 50;

/** The app-shell phone breakpoint — the same `width < 560px` split the
 * APP-SHELL-PHONE rule in styles/tokens.css uses to give every control in
 * `main` `min-height: 44px`. */
export const PHONE_VIEWPORT_PX = 560;

/**
 * The zoom floor the canvas' own fit may use for this VIEWPORT width.
 *
 * The 44px phone floor is declared in CSS px and the fit transform SCALES it:
 * a 0.86 fit renders those boxes at 38px — the exact defect the 390 reflow
 * check caught on the edge “+”s (`edge-add-*`) and the terminal “Add a step
 * after …”. Inside the phone band the fit therefore never shrinks below 1:1:
 * the graph keeps its designed size and the reader pans it, which is already
 * the 1g rule for a tall chain (top-aligned, overflows downward, never
 * magnified) and keeps EVERY canvas control — both “+”s, the node menu, the
 * step picker — at its 44px touch size rather than just the two measured.
 *
 * It keys off the viewport, not the pane, for exactly one reason: that is what
 * the CSS media query measures. The 1280 Studio pane is only ~530px wide, so a
 * pane-width test would have shrunk the desktop graph too.
 *
 * The reader's own gestures stay free (pinch, browser zoom, the “−” control):
 * those are deliberate, they are the reader's call, and the same is true of
 * every other page. This bound applies only to what the canvas does by itself.
 */
export function fitMinZoom(viewportWidth: number): number {
  return Number.isFinite(viewportWidth) && viewportWidth < PHONE_VIEWPORT_PX ? 1 : 0.4;
}

/** The viewport width the phone rule sees (no window during server render /
 * jsdom: never the phone band). */
function currentViewportWidth(): number {
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

/**
 * The design-1g fit: same guards and zoom as `computeFitViewport` (whose
 * cap is 1.0 here — never magnify), but the result is TOP-aligned
 * (`FIT_TOP_PAD_PX` under the pane's top edge) and horizontally centred:
 * a tall chain overflows downward and pans, rather than the whole graph
 * shrinking into the middle.
 */
export function computeTopFitViewport(
  boxes: { x: number; y: number; width: number; height: number }[],
  paneWidth: number,
  paneHeight: number,
  topPad = FIT_TOP_PAD_PX,
  minZoom = 0.4,
  maxZoom = 1,
): { x: number; y: number; zoom: number } | null {
  const fit = computeFitViewport(boxes, paneWidth, paneHeight, minZoom, maxZoom);
  if (fit === null) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const box of boxes) {
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !isPositiveFinite(box.width) ||
      !isPositiveFinite(box.height)
    ) {
      return null;
    }
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
  }
  const zoom = fit.zoom;
  const x = paneWidth / 2 - (minX + (maxX - minX) / 2) * zoom;
  const y = topPad - minY * zoom;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom };
}

/** CSS px of clear pane the clamps keep around the drawing on every edge
 * (the pane's own padding when the canvas cannot re-fit). */
export const FIT_EDGE_PAD_PX = 16;

/**
 * Move an EXISTING viewport as little as possible so the drawing is never
 * stranded outside the pane. The zoom is never touched — this is the clamp
 * for a view the READER owns, where re-fitting would throw their pan/zoom away.
 *
 * X is held hard: a graph narrower than the pane is kept fully inside it with
 * `pad` clear on each side (that is the “cards never clipped by the pane”
 * rule), a wider one is kept covering the pane so the reader never sees an
 * empty gutter at an edge. Both are the same interval: `t` between
 * `pane - pad - max*z` and `pad - min*z`, in whichever order they come.
 *
 * Y is only held REACHABLE. `computeTopFitViewport` rides the chain
 * top-aligned under `FIT_TOP_PAD_PX` and lets it overflow downward — the 1g
 * rule, and the phone's 1:1 fit depends on it — so applying X's both-edges
 * rule vertically would fight the design (it dragged a chain taller than the
 * pane up from its 50px pad to 16px). The Y clamp only stops the drawing
 * being resized or panned out of the pane altogether.
 */
export function clampViewportToGraph(
  vp: { x: number; y: number; zoom: number } | null,
  boxes: { x: number; y: number; width: number; height: number }[],
  paneWidth: number,
  paneHeight: number,
  pad = FIT_EDGE_PAD_PX,
): { x: number; y: number; zoom: number } | null {
  if (vp === null || !isPositiveFinite(vp.zoom)) return null;
  if (!isPositiveFinite(paneWidth) || !isPositiveFinite(paneHeight)) return null;
  if (paneWidth < MIN_FIT_PANE_PX || paneHeight < MIN_FIT_PANE_PX) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !isPositiveFinite(box.width) ||
      !isPositiveFinite(box.height)
    ) {
      return null;
    }
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const clampX = (t: number, min: number, max: number, pane: number): number => {
    const a = pane - pad - max * vp.zoom;
    const b = pad - min * vp.zoom;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.min(Math.max(t, lo), hi);
  };
  // Y: at least `pad` of the drawing stays on screen, in either direction.
  const clampY = (t: number, min: number, max: number, pane: number): number => {
    const lo = pad - max * vp.zoom;
    const hi = pane - pad - min * vp.zoom;
    return Math.min(Math.max(t, Math.min(lo, hi)), Math.max(lo, hi));
  };
  const x = clampX(vp.x, minX, maxX, paneWidth);
  const y = clampY(vp.y, minY, maxY, paneHeight);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, zoom: vp.zoom };
}

/** Centre `box` in the pane at `zoom` (the user's current zoom, clamped
 * into the 0.4→1.25 band). Null when inputs are degenerate. */
export function centerOnBox(
  box: { x: number; y: number; width: number; height: number },
  paneWidth: number,
  paneHeight: number,
  zoom: number,
  minZoom = 0.4,
  maxZoom = 1.25,
): { x: number; y: number; zoom: number } | null {
  if (!isPositiveFinite(paneWidth) || !isPositiveFinite(paneHeight)) return null;
  if (paneWidth < MIN_FIT_PANE_PX || paneHeight < MIN_FIT_PANE_PX) return null;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  if (!isPositiveFinite(box.width) || !isPositiveFinite(box.height)) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? Math.min(Math.max(zoom, minZoom), maxZoom) : 1;
  const x = paneWidth / 2 - (box.x + box.width / 2) * z;
  const y = paneHeight / 2 - (box.y + box.height / 2) * z;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, zoom: z };
}

/** Parse a rendered `.react-flow__viewport` transform. Null when absent or
 * non-finite — React Flow writes NaN straight into the style when a fit
 * ran against a zero-size pane, and a corrupt store leaves interaction
 * dead even when the browser kept a stale style value. */
export function parseViewportTransform(
  style: string | null | undefined,
): { x: number; y: number; zoom: number } | null {
  if (!style) return null;
  const m = /translate\(([-\d.]+)px,\s*([\d.-]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const zoom = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom };
}

/** The canvas OWNS the element set: the structural rebuild (the page's
 * model changed) is the only thing that may add or remove nodes/edges.
 * React Flow's internal diff machinery reports `add`/`remove` changes
 * through onNodesChange/onEdgesChange (its fitView queue flush, the
 * "Fit View" control) — applying them is how nodes silently vanished from
 * the live Workbench. Deletions the page intends arrive through the model
 * (`onDelete` → structural rebuild), so the mirror swallows add/remove and
 * keeps every other change (position, dimensions, select, replace). */
export function mirrorOwnedChanges<T extends { type: string }>(changes: readonly T[]): T[] {
  return changes.filter((change) => change.type !== "add" && change.type !== "remove");
}

function isMeasuredBox(box: { width: number | undefined; height: number | undefined }): boolean {
  return isPositiveFinite(box.width) && isPositiveFinite(box.height);
}

/** The node's own config object from the parsed document, for the canvas
 * node's one key fact (design 1g) — the kind's model / command / approver /
 * artifact. Empty when the id is unknown or the doc has no such node. */
function nodeConfigOf(
  document: unknown,
  model: GraphModel,
  nodeId: string,
): Record<string, unknown> {
  const node = findNode(model, nodeId);
  if (!node) return {};
  let cur: unknown = document;
  for (const part of node.pointer.split("/")) {
    if (part === "") continue;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown> | null)?.[part];
    if (cur === null || cur === undefined) return {};
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return {};
  const cfg = (cur as Record<string, unknown>).config;
  return cfg && typeof cfg === "object" && !Array.isArray(cfg)
    ? (cfg as Record<string, unknown>)
    : {};
}

function CanvasInner({
  model,
  document,
  layout,
  selectedId,
  selectedIds,
  onSelectionChange,
  readOnly,
  stale,
  staleMessage,
  highlight,
  statusOverlay,
  onSelect,
  onMove,
  onInsertOnEdge,
  onAddAfter,
  onConnect,
  onDelete,
  onDuplicate,
  canConnect,
  focusNodeId,
  hideStepList = false,
}: StudioCanvasProps) {
  const { setViewport, zoomIn, zoomOut } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** The pane the graph fills — observed so a dock drag/collapse refits. */
  const paneRef = useRef<HTMLDivElement | null>(null);
  // `toFlow` also places every route label, and where it may put one depends on
  // the "+" squares this canvas draws: an editor draws them (so a label seats
  // beside its own "+"), a read-only or stale canvas draws none (the label keeps
  // its seat centred on the line).
  const base: FlowModel = useMemo(
    () => toFlow(model, document, layout, { addButtons: !readOnly && !stale }),
    [model, document, layout, readOnly, stale],
  );
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [dragKind, setDragKind] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ edgeId: string; label: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  // The page's callbacks are NOT stable (the page re-creates `handleAddAfter`
  // and the inline `onInsertOnEdge` arrow on every render). The rebuild effect
  // must not depend on their identity, or it re-runs on every page render and
  // re-pushes a fresh node array into the store on every selection change —
  // which is what ping-ponged the selection into "Maximum update depth
  // exceeded". Read them through refs so the rebuild's dependency array stays
  // structural (model/layout/presentation) only.
  const onSelectRef = useRef(onSelect);
  const onAddAfterRef = useRef(onAddAfter);
  const onInsertOnEdgeRef = useRef(onInsertOnEdge);
  const onDuplicateRef = useRef(onDuplicate);
  onSelectRef.current = onSelect;
  onAddAfterRef.current = onAddAfter;
  onInsertOnEdgeRef.current = onInsertOnEdge;
  onDuplicateRef.current = onDuplicate;

  // The node content's click handler calls `onSelect` unconditionally (it has
  // no access to the event). While Shift is held, React Flow's own click
  // handling already adds the node to the multi-selection and reports it via
  // `onSelectionChange` — the page's single-select must stay out of the way,
  // or every Shift+click collapses the multi-selection back to one.
  const shiftHeld = useRef(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeld.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const flowIdToNode = useMemo(() => new Map(base.nodes.map((n) => [n.id, n.data.nodeId])), [base]);

  // Palette dragstart/dragend live in another component tree (the Studio
  // page owns the palette), so mirror the module registry into state.
  useEffect(
    () =>
      subscribeDragKind((kind) => {
        setDragKind(kind);
        if (kind === null) setPreview(null);
      }),
    [],
  );

  // Escape cancels an in-flight drag-to-insert (clears the preview).
  useEffect(() => {
    if (!dragKind) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        setDragKind(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragKind]);

  const edgeQuery = useMemo(
    () =>
      base.edges
        .filter((e) => e.type === "insertable")
        .map((e) => ({ id: e.id, from: e.source, to: e.target })),
    [base],
  );
  const nodeBoxes = useMemo(() => {
    // Hit-testing runs in ABSOLUTE flow coordinates (screenToFlowPosition),
    // while a scope child's `position` is relative to its group — add the
    // parent's offset back, or every drop inside a scope misses by the
    // group's whole displacement.
    const absolute = new Map<string, { x: number; y: number }>();
    for (const node of base.nodes) {
      const parent = node.parentId ? absolute.get(node.parentId) : null;
      absolute.set(node.id, {
        x: node.position.x + (parent?.x ?? 0),
        y: node.position.y + (parent?.y ?? 0),
      });
    }
    return Object.fromEntries(
      base.nodes.map((n) => [
        n.id,
        { x: absolute.get(n.id)!.x, y: absolute.get(n.id)!.y, width: n.width, height: n.height },
      ]),
    );
  }, [base]);

  // The step Duplicate/Delete menu (issue #66): it answers an explicit ask
  // ONLY — right-click on a step (menu at the pointer), the ⋯ button on the
  // selected step, or Shift+F10 / the ContextMenu key — and never on a plain
  // left click, which just selects the step and opens the inspector. The menu
  // is kept in FLOW coordinates: it must track its step through any pan/zoom,
  // so its screen position is re-derived from the rendered viewport transform
  // every time that transform changes.
  const [menu, setMenu] = useState<{
    fx: number;
    fy: number;
    /** The node's left/bottom edges in flow coords — below-node fallback. */
    fLeft: number;
    fBottom: number;
    nodeId: string;
  } | null>(null);
  const [menuScreen, setMenuScreen] = useState<{ x: number; y: number } | null>(null);
  /** The menu sits in the pane's bottom strip instead of over the graph. */
  const [menuDocked, setMenuDocked] = useState(false);
  /** The menu drew itself as one row anchored under its own node. */
  const [menuCompact, setMenuCompact] = useState(false);
  /**
   * The menu's drawn box, per shape, as the DOM reports it. Placement starts
   * from the constants (MENU_WIDTH_PX / MENU_COMPACT_W_PX) and re-derives once
   * the real box is known: an estimate that is 30px too wide is exactly what
   * drove the 390 menu off the design's slot and onto the next step's card
   * (pass-8 review, defect 1).
   */
  const [menuSizes, setMenuSizes] = useState<{
    menu?: { w: number; h: number };
    compact?: { w: number; h: number };
  }>({});
  const measureMenu = useCallback(
    (shape: "menu" | "compact") => (size: { w: number; h: number }) => {
      setMenuSizes((current) => {
        const known = current[shape];
        if (known && known.w === size.w && known.h === size.h) return current;
        return { ...current, [shape]: size };
      });
    },
    [],
  );
  const menuFocusRef = useRef<HTMLElement | null>(null);

  // The selected step's Duplicate/Delete menu (issue #66 contract): it opens
  // ONLY on an explicit ask — right-click at the pointer, the ⋯ button on the
  // selected step, or the keyboard (Shift+F10 / ContextMenu key). A plain left
  // click just selects (the page opens the inspector); the menu no longer
  // follows the selection. When the SELECTION ITSELF moves (the page's prop
  // changes) anywhere but onto the menu's own step, the menu retires — but a
  // menu opened for a FOCUSED step with an unchanged selection is not orphaned
  // (that is the keyboard path above), and a right-click selects its step
  // first, which must not close what it just opened.
  const selectionKey = `${selectedId ?? ""}\u0000${JSON.stringify(selectedIds ?? null)}`;
  const lastSelectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const changed =
      lastSelectionKeyRef.current !== null && lastSelectionKeyRef.current !== selectionKey;
    lastSelectionKeyRef.current = selectionKey;
    if (!changed || menu === null) return;
    const stillSelected =
      menu.nodeId === selectedId ||
      (selectedIds !== undefined && selectedIds.includes(menu.nodeId));
    if (stillSelected) return;
    setMenu(null);
    setMenuScreen(null);
    setMenuDocked(false);
    setMenuCompact(false);
    menuFocusRef.current = null;
  }, [menu, selectionKey, selectedId, selectedIds]);

  // Where the menu of `nodeId` opens from the node itself (⋯ button,
  // keyboard): the design-1g slot at the step's RIGHT EDGE, vertically
  // centred by `chooseNodeMenuPlacement` — the same anchor the plain-click
  // menu used before #66 moved the verbs off the selection. `updateMenuScreen`
  // re-derives the pane position (and falls back
  // below/upward/one-row through `chooseNodeMenuPlacement`) from this box.
  const openMenuForNode = useCallback(
    (nodeId: string) => {
      if (readOnly || stale) return;
      const node = base.nodes.find((n) => n.data.nodeId === nodeId);
      const box = node ? nodeBoxes[node.id] : null;
      if (!box) return;
      const active = globalThis.document.activeElement;
      menuFocusRef.current = active instanceof HTMLElement ? active : null;
      setMenu({
        fx: box.x + box.width,
        fy: box.y,
        fLeft: box.x,
        fBottom: box.y + box.height,
        nodeId,
      });
    },
    [readOnly, stale, base, nodeBoxes],
  );
  const openMenuForNodeRef = useRef(openMenuForNode);
  openMenuForNodeRef.current = openMenuForNode;

  const closeMenu = useCallback(() => {
    setMenu(null);
    const el = menuFocusRef.current;
    menuFocusRef.current = null;
    if (el instanceof HTMLElement) el.focus();
  }, []);

  const openMenuAt = useCallback((x: number, y: number, nodeId: string) => {
    const active = globalThis.document.activeElement;
    menuFocusRef.current = active instanceof HTMLElement ? active : null;
    // A pointer menu opens AT the pointer; it has no node box, so the
    // below-fallback (if the pointer hugs the right edge) drops it under the
    // click point, left-aligned there.
    setMenu({ fx: x, fy: y, fLeft: x, fBottom: y, nodeId });
  }, []);

  // Issue #66's keyboard path: Shift+F10 (the platform context-menu chord)
  // and the ContextMenu key open the same menu for the step the reader is on
  // — the FOCUSED step if there is one (React Flow makes every step card a
  // tab stop), else the single selected step. `Delete`/`Backspace` already
  // removes the selection through the window handler below.
  useEffect(() => {
    if (readOnly || stale) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const focused = globalThis.document.activeElement;
      const focusedStep =
        focused?.closest?.("[data-step-node-id]")?.getAttribute("data-step-node-id") ?? null;
      const ids =
        selectedIds !== undefined && selectedIds.length > 0
          ? selectedIds
          : selectedId !== null
            ? [selectedId]
            : [];
      const nodeId = focusedStep ?? (ids.length === 1 ? ids[0] : null);
      if (nodeId === null) return;
      event.preventDefault();
      openMenuForNodeRef.current(nodeId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, stale, selectedId, selectedIds]);

  // Standard controlled pattern: apply every change (position, dimensions,
  // select, …) so the `nodes` state tracks React Flow's internal store —
  // including the `selected` flag, which the rebuild carries forward so a
  // structural rebuild never wipes the current selection. Selection itself is
  // owned by React Flow's internal store; the page's `selectedIds` is a mirror
  // (kept in sync in `onSelectionChange` below) and programmatic changes are
  // pushed once through the apply effect — not re-derived here, which is what
  // used to ping-pong the store into "Maximum update depth exceeded".
  // Apply every change React Flow reports (position, dimensions, and
  // `select`) so the local `nodes` array mirrors the store exactly —
  // EXCEPT `add`/`remove`: the canvas owns the element set (see
  // mirrorOwnedChanges), and the store's diff machinery reporting removals
  // is what emptied the live Workbench's canvas mid-run.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((current) => applyNodeChanges(mirrorOwnedChanges(changes), current)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((current) => applyEdgeChanges(mirrorOwnedChanges(changes), current)),
    [],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      // The rebuild effect's data carries the pipeline node id as `id`
      // (not `nodeId`): a dropped drag used to store its position under the
      // key "undefined", so the layout never matched a real node and the
      // next rebuild snapped it back to its dagre place.
      const data = node.data as unknown as { id: string };
      onMove?.(data.id, node.position);
    },
    [onMove],
  );

  // The hit test needs the pointer in FLOW coordinates. React Flow's
  // `screenToFlowPosition` reads the store transform, which lags the DOM
  // viewport transform (observed: it returned a stale offset while the pane
  // was already panned). The DOM transform is the source of truth for what
  // is on screen, so derive the mapping from the rendered `.react-flow__viewport`.
  const clientToFlow = useCallback((clientX: number, clientY: number) => {
    const pane = canvasRef.current?.querySelector<HTMLElement>(".react-flow__pane");
    const viewport = canvasRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!pane || !viewport) return { x: clientX, y: clientY };
    const rect = pane.getBoundingClientRect();
    const m = /translate\(([-\d.]+)px,\s*([\d.-]+)px\)\s*scale\(([-\d.]+)\)/.exec(
      viewport.style.transform,
    );
    if (!m) return { x: clientX - rect.left, y: clientY - rect.top };
    const tx = Number(m[1]);
    const ty = Number(m[2]);
    const zoom = Number(m[3]) || 1;
    return {
      x: (clientX - rect.left - tx) / zoom,
      y: (clientY - rect.top - ty) / zoom,
    };
  }, []);

  const hitAt = useCallback(
    (clientX: number, clientY: number) =>
      nearestEdge(nodeBoxes, edgeQuery, clientToFlow(clientX, clientY), DROP_EDGE_RADIUS_PX),
    [nodeBoxes, edgeQuery, clientToFlow],
  );

  const onNodeContextMenu: NodeMouseHandler<Node> = useCallback(
    (event, node) => {
      if (readOnly || stale) return;
      const id = (node.data as { id?: string }).id;
      if (typeof id !== "string") return;
      // Right-click selects its step (the inspector follows the menu's
      // subject, like every other editor) BEFORE the menu opens, so the
      // orphan-close effect knows the selection belongs to this menu.
      onSelectRef.current?.(id);
      const flow = clientToFlow(event.clientX, event.clientY);
      openMenuAt(flow.x, flow.y, id);
    },
    [readOnly, stale, clientToFlow, openMenuAt],
  );

  const onDragOver = useCallback(
    (event: DragEvent) => {
      const types = event.dataTransfer?.types ?? [];
      if (!types.includes(PALETTE_DRAG_TYPE) || !dragKind) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const hit = hitAt(event.clientX, event.clientY);
      setPreview(hit ? { edgeId: hit.edgeId, label: stepLabel(dragKind) } : null);
    },
    [dragKind, hitAt],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      const kind = event.dataTransfer?.getData(PALETTE_DRAG_TYPE);
      event.preventDefault();
      setPreview(null);
      setDragKind(null);
      setPaletteDragKind(null);
      if (!kind) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit) {
        const hitEdge = base.edges.find((e) => e.id === hit.edgeId);
        if (hitEdge) {
          onInsertOnEdge?.(hitEdge.data.edge, kind);
          return;
        }
      }
      onAddAfter?.(selectedId ?? null, [], kind);
    },
    [base.edges, hitAt, onAddAfter, onInsertOnEdge, selectedId],
  );

  // Store-originated selection (clicks, Shift+click, the Shift+drag box)
  // mirrored to the page. One-way: the page reads the selection, it does not
  // push it back (see the rebuild + onNodesChange comments). The callback
  // identity must be STABLE — an inline arrow makes React Flow's
  // SelectionListener re-run its report effect on every canvas render,
  // re-reporting a selection that lags the store's last push by one round
  // trip, which is how the mirror used to feed stale values back into the
  // page. With a stable callback the effect only re-fires when the store's
  // selection genuinely changed, and the page's functional equality guard
  // (`selectMany`) bails out when it already holds that selection.
  const handleSelectionChange = useCallback(
    (selection: { nodes: Node[] } | undefined) => {
      if (!selection) return;
      const ids = selection.nodes.map((n) => (n.data as { id?: string }).id ?? "").filter(Boolean);
      onSelectionChange?.(ids);
    },
    [onSelectionChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const from = flowIdToNode.get(connection.source);
      const to = flowIdToNode.get(connection.target);
      if (!from || !to) return;
      const verdict = evaluateConnect(canConnect, from, to);
      if (!verdict.proceed) {
        setRefused(verdict.refused);
        return;
      }
      setRefused(null);
      onConnect?.(from, to);
    },
    [canConnect, flowIdToNode, onConnect],
  );

  const deleteGuarded = useCallback(
    (ids: string[]) => {
      const active = globalThis.document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      onDelete?.(ids);
    },
    [onDelete],
  );

  // The page's current selection, read (through a ref) only by the
  // structural-rebuild path below — deliberately NOT an effect dependency:
  // making the rebuild depend on the selection would re-push the node array
  // on every selection change, the page→store path that used to ping-pong
  // the store into "Maximum update depth exceeded".
  const pageSelRef = useRef<string[]>([]);
  pageSelRef.current =
    selectedIds !== undefined && selectedIds.length > 0
      ? selectedIds
      : selectedId !== null
        ? [selectedId]
        : [];
  const lastBaseRef = useRef(base);

  // Rebuild the React Flow graph when the model, the layout, or a
  // presentation input changes — the canvas owns no other node state.
  // Two rebuild flavors, two selection rules:
  //  • structural (the `base` graph changed — an op or a YAML edit): the old
  //    flow ids are stale (a wrap re-qualifies its children as
  //    until/process, …), so carry-forward would silently DROP the
  //    selection; the cleared store selection would then echo back through
  //    the mirror and clobber the page's post-op selection (e.g. the new
  //    scope after a wrap). A structural rebuild therefore adopts the
  //    page's current selection (the post-op state), filtered to ids that
  //    still exist in the new graph.
  //  • non-structural (preview/highlight/stale churn): carry the local
  //    nodes' current `selected` flags forward — they mirror the store's own
  //    gesture selection — so a rebuild never wipes or changes it.
  // A THIRD flavor covers a remount, not a rebuild: the Studio page swaps its
  // whole layout branch at the 767px phone rule, and the canvas (React Flow's
  // store with it) remounts empty while the PAGE keeps its selection. Passing
  // through with `selected` false on every node is what hid the selected
  // step's ⋯ (issue #66) on the 390 reflow capture — and a phone has no
  // right-click or Shift+F10, so the verbs became unreachable. A canvas that
  // mounts with no local nodes therefore adopts the page's selection exactly
  // like a structural rebuild does, filtered to ids the graph still holds.
  useEffect(() => {
    const firstMount = nodes.length === 0;
    const structural = lastBaseRef.current !== base || firstMount;
    lastBaseRef.current = base;
    const aliveSelection = structural
      ? new Set(pageSelRef.current.filter((id) => base.nodes.some((n) => n.data.nodeId === id)))
      : null;
    const prevSelected = new Map(nodes.map((n) => [n.id, n.selected === true]));
    // Carry each node's measured size across the rebuild. A rebuilt node
    // object without `measured` makes React Flow's adoptUserNodes reset the
    // store's measurement, and React Flow renders unmeasured nodes with
    // `visibility: hidden` — the node elements keep their size, so their
    // ResizeObserver never re-fires and the canvas would go BLANK for the
    // rest of the run (observed live: mid-run rebuilds left 17/17 nodes
    // hidden; a fresh open re-measured and recovered). Fresh nodes (not in
    // `prevMeasured`) start unmeasured and get measured on first paint.
    const prevMeasured = new Map(nodes.map((n) => [n.id, n.measured]));
    const rfNodes: Node[] = base.nodes.map((b) => {
      const scope = b.data;
      const data: StepNodeRender & Partial<ScopeNodeRender> = {
        id: scope.nodeId,
        kind: scope.kind,
        label: scope.label,
        kindWord: scope.kindWord,
        deferred: scope.deferred,
        when: scope.when,
        terminal: scope.terminal,
        readOnly,
        stale,
        highlight: highlight?.includes(scope.nodeId) ?? false,
        status: statusOverlay?.[scope.nodeId] ?? null,
        onSelect: () => {
          // Shift+click: React Flow multi-selects and reports via
          // onSelectionChange; the page's single-select would clobber it.
          if (shiftHeld.current) return;
          // Issue #66: a plain click SELECTS — and nothing else. The
          // Duplicate/Delete menu no longer follows the click; it answers
          // right-click, the ⋯ on the selected step, and the keyboard only.
          onSelectRef.current?.(scope.nodeId);
        },
        onMenu:
          readOnly || stale
            ? null
            : () => {
                openMenuForNodeRef.current(scope.nodeId);
              },
        onAddAfter: b.data.terminal
          ? (kind: string) => onAddAfterRef.current?.(scope.nodeId, scope.scope, kind)
          : null,
        emptyBody: scope.emptyBody,
        headerText: scope.headerText ?? `${scope.label} · ${scope.nodeId}`,
        loopNote: scope.loopNote,
        config: nodeConfigOf(document, model, scope.nodeId),
        onAddInside: scope.emptyBody
          ? (kind: string) => onAddAfterRef.current?.(scope.nodeId, scope.scope, kind)
          : null,
      };
      const node: Node = {
        id: b.id,
        type: b.type,
        position: b.position,
        data,
        style: { width: b.width, height: b.height },
        measured: prevMeasured.get(b.id),
        // Structural: the page's (post-op) selection; otherwise the store's
        // own current selection, carried across unchanged.
        selected: aliveSelection
          ? aliveSelection.has(scope.nodeId)
          : (prevSelected.get(b.id) ?? false),
      };
      if (b.type === "scope") {
        node.zIndex = 0;
      } else if (b.parentId) {
        node.parentId = b.parentId;
        node.extent = "parent";
      }
      return node;
    });
    const rfEdges: Edge[] = base.edges.map((b) => {
      const data: InsertableEdgeRender & ErrorEdgeRender = {
        edge: b.data.edge,
        readOnly,
        stale,
        label: b.label,
        labelTitle: b.labelTitle,
        // Collision-checked label anchor (flowModel pre-computes it in absolute
        // flow coords); null lets the edge fall back to the path midpoint.
        labelAnchor: b.labelX !== null && b.labelY !== null ? { x: b.labelX, y: b.labelY } : null,
        preview: preview?.edgeId === b.id ? preview.label : null,
        onInsert: (kind: string) => onInsertOnEdgeRef.current?.(b.data.edge, kind),
        // The routing geometry: the edge draws `routeEdge(sourceBox, targetBox,
        // axis)` — the same path the label anchor was checked against.
        sourceBox: b.sourceBox,
        targetBox: b.targetBox,
        axis: b.axis,
      };
      return { id: b.id, source: b.source, target: b.target, type: b.type, data };
    });
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [base, readOnly, stale, highlight, statusOverlay, preview]);

  /* --------------------------------------------- viewport fitting & repair
   * The canvas owns its own fit — React Flow's mount-time `fitView` prop is
   * gone: it resolves while nodes are still unmeasured and the pane may be
   * transiently 0×0, and the resulting wrong (or NaN) transform then
   * sticks (this is how the live Workbench went blank mid-run). Instead
   * the fit is computed from the layout's absolute boxes into the pane's
   * REAL current size, refused outright when either is degenerate
   * (computeFitViewport), and applied only when finite.
   *
   * Refit triggers (nothing else — a manual user pan/zoom is never
   * clobbered afterwards):
   *   • the graph's node set changes (structural rebuild, first fit),
   *   • the pane transitions from zero to a real size.
   * A MutationObserver sentinel repairs anything that still ends up blank
   * or non-finite: restore the last good transform, or re-fit when every
   * node sits outside the pane and the reader has not moved the view. */
  const nodeSetKey = useMemo(() => base.nodes.map((n) => n.id).join("\u0000"), [base]);
  const baseRef = useRef(base);
  baseRef.current = base;
  const nodeSetKeyRef = useRef(nodeSetKey);
  nodeSetKeyRef.current = nodeSetKey;
  const nodeBoxesRef = useRef(nodeBoxes);
  nodeBoxesRef.current = nodeBoxes;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const allMeasured =
    base.nodes.length > 0 &&
    nodes.length === base.nodes.length &&
    nodes.every(
      (n) =>
        n.measured !== undefined &&
        isMeasuredBox({ width: n.measured.width, height: n.measured.height }),
    );
  const allMeasuredRef = useRef(allMeasured);
  allMeasuredRef.current = allMeasured;
  const userMovedRef = useRef(false);
  const lastGoodRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const lastFittedSetRef = useRef<string | null>(null);
  const paneSizeRef = useRef({ w: 0, h: 0 });
  const pendingRealSizeRef = useRef(false);
  const focusedRef = useRef<string | null>(null);
  const [paneReal, setPaneReal] = useState(0); // tick: zero → real size

  const viewportEl = useCallback(
    () => canvasRef.current?.querySelector<HTMLElement>(".react-flow__viewport") ?? null,
    [],
  );

  // The menu's pane-absolute position, re-derived from the rendered viewport
  // transform (flow → screen). While the menu is open, a MutationObserver on
  // the viewport re-derives it on every pan/zoom, so the menu never drifts
  // from its node.
  const updateMenuScreen = useCallback(() => {
    if (menu === null) return;
    const t = parseViewportTransform(viewportEl()?.style.transform ?? null);
    const zoom = t?.zoom ?? 1;
    const tx = t?.x ?? 0;
    const ty = t?.y ?? 0;
    const paneWidth = paneRef.current?.clientWidth ?? 0;
    const paneHeight = paneRef.current?.clientHeight ?? 0;
    // The selected node's box in pane px (a pointer menu has a zero-size box
    // at the pointer, which is exactly what the placement wants).
    const node: MenuBoxPx = {
      x: menu.fLeft * zoom + tx,
      y: menu.fy * zoom + ty,
      w: Math.max(0, (menu.fx - menu.fLeft) * zoom),
      h: Math.max(0, (menu.fBottom - menu.fy) * zoom),
    };
    // Every other STEP the reader can see, in the same px space — the boxes
    // the menu may not paint over. Scope groups are excluded on purpose: a
    // menu inside a scope's own body is the design, a menu over another
    // step's card is the defect.
    const selectedFlowId = baseRef.current.nodes.find(
      (candidate) => (candidate.data as { nodeId?: string }).nodeId === menu.nodeId,
    )?.id;
    const others: MenuBoxPx[] = baseRef.current.nodes
      .filter((candidate) => candidate.type === "step" && candidate.id !== selectedFlowId)
      .map((candidate) => {
        const box = nodeBoxesRef.current[candidate.id];
        if (!box) return null;
        const measured = nodesRef.current.find((entry) => entry.id === candidate.id)?.measured;
        const w = measured?.width && measured.width > 0 ? measured.width : box.width;
        const h = measured?.height && measured.height > 0 ? measured.height : box.height;
        return {
          x: box.x * zoom + tx,
          y: box.y * zoom + ty,
          w: w * zoom,
          h: h * zoom,
        };
      })
      .filter((box): box is MenuBoxPx => box !== null);
    const place = chooseNodeMenuPlacement({
      node,
      others,
      menu: menuSizes.menu ?? { w: MENU_WIDTH_PX, h: MENU_HEIGHT_PX },
      compact: menuSizes.compact ?? { w: MENU_COMPACT_W_PX, h: MENU_COMPACT_H_PX },
      pane: { w: paneWidth, h: paneHeight },
    });
    setMenuDocked(place.docked);
    setMenuCompact(place.compact);
    setMenuScreen({ x: place.x, y: place.y });
  }, [menu, viewportEl, menuSizes]);

  useEffect(() => {
    if (menu === null) return;
    updateMenuScreen();
    const el = viewportEl();
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(updateMenuScreen);
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [menu, updateMenuScreen, viewportEl]);

  // Click-away closes the menu WITHOUT swallowing the gesture: an invisible
  // overlay over the whole pane used to make the canvas inert whenever a
  // step was selected (the menu is open by selection) — edge "+"s, nodes and
  // drags all hit the overlay first. A capture-phase pointerdown outside the
  // menu closes it and lets the click through to its real target.
  useEffect(() => {
    if (menu === null) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-testid='studio-node-menu']")) return;
      // The dismissing click owns focus from here on; do not steal it back.
      menuFocusRef.current = null;
      setMenu(null);
      setMenuScreen(null);
    };
    globalThis.document.addEventListener("pointerdown", onPointerDown, true);
    return () => globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menu]);

  /** The graph's boxes with React Flow's MEASURED sizes when known (the same
   * inputs React Flow's own fit uses), falling back to the layout's estimates.
   * Both `nodeBoxes` and the local `nodes` state are keyed by the same flow
   * id. Empty (or a missing box) when nothing is on the canvas yet. */
  const graphBoxes = useCallback(() => {
    const measuredById = new Map(nodesRef.current.map((n) => [n.id, n.measured]));
    return Object.entries(nodeBoxesRef.current).map(([id, box]) => {
      const mw = measuredById.get(id)?.width;
      const mh = measuredById.get(id)?.height;
      const w = mw !== undefined && Number.isFinite(mw) && mw > 0 ? mw : box.width;
      const h = mh !== undefined && Number.isFinite(mh) && mh > 0 ? mh : box.height;
      return { x: box.x, y: box.y, width: w, height: h };
    });
  }, []);

  /** The viewport as rendered right now (React Flow writes the transform on
   * the viewport element; a corrupt/absent one reads back as null). */
  const currentViewport = useCallback(
    () => parseViewportTransform(viewportEl()?.style.transform ?? null),
    [viewportEl],
  );

  /** Fit the graph into the pane. Returns false when the guard refused
   * (zero-size pane, unmeasured boxes) — the caller retries on the next
   * trigger; a non-finite viewport is never applied. */
  const safeFit = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return false;
    const rect = pane.getBoundingClientRect();
    const boxes = graphBoxes();
    const vp = computeTopFitViewport(
      boxes,
      rect.width,
      rect.height,
      FIT_TOP_PAD_PX,
      fitMinZoom(currentViewportWidth()),
    );
    if (vp === null) return false;
    setViewport(vp, { duration: 0 });
    lastGoodRef.current = vp;
    return true;
  }, [graphBoxes, setViewport]);
  const safeFitRef = useRef(safeFit);
  safeFitRef.current = safeFit;

  // Structural (first) fit + the pane's zero→real transition.
  useEffect(() => {
    if (base.nodes.length === 0) return;
    if (!allMeasured) return; // unmeasured nodes: fit later, never wrong
    const structural = lastFittedSetRef.current !== nodeSetKey;
    const realSizeJustArrived = pendingRealSizeRef.current;
    if (!structural && !realSizeJustArrived) return;
    pendingRealSizeRef.current = false;
    if (safeFit()) lastFittedSetRef.current = nodeSetKey;
  }, [nodeSetKey, allMeasured, paneReal, base.nodes.length, safeFit]);

  /** The pane changed size while nobody was looking at a hand-built view:
   * re-fit the graph into the new pane. When the reader HAS taken the view,
   * keep their zoom/pan and only clamp it back into the pane. Either way the
   * drawing stays inside; nothing is ever applied unless it is finite. */
  const refitAfterResize = useCallback(
    (next: { w: number; h: number }) => {
      if (!allMeasuredRef.current || baseRef.current.nodes.length === 0) return;
      if (userMovedRef.current) {
        const vp = currentViewport();
        if (vp === null) return;
        const clamped = clampViewportToGraph(vp, graphBoxes(), next.w, next.h, FIT_EDGE_PAD_PX);
        if (clamped === null) return;
        setViewport(clamped, { duration: 0 });
        lastGoodRef.current = clamped;
        return;
      }
      // Only re-fit a graph the canvas actually fitted once — an unmeasured or
      // transiently degenerate pane is still refused inside `safeFit`.
      if (lastFittedSetRef.current !== nodeSetKeyRef.current) return;
      safeFitRef.current();
    },
    [currentViewport, graphBoxes, setViewport],
  );
  const refitAfterResizeRef = useRef(refitAfterResize);
  refitAfterResizeRef.current = refitAfterResize;

  // The pane's size: the zero→real transition triggers the structural fit,
  // and an ordinary resize re-fits (or clamps) the graph into the new pane.
  //
  // Not re-fitting on resize was the Run Workbench's 390 defect (pass 6): the
  // 1280 fit's transform stayed applied to a pane that had become ~354px
  // wide, so the node column started 102px right of centre and its cards ran
  // 25px past the pane's right edge. Crossing the 560px phone band also
  // changes the fit's own zoom floor (`fitMinZoom(window.innerWidth)`), so a
  // resize that is not the reader's pan/zoom has to re-run the fit. When they
  // do own the view, `clampViewportToGraph` keeps the zoom they chose and
  // just stops the drawing being stranded off-pane.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const r = pane.getBoundingClientRect();
      const prev = paneSizeRef.current;
      const wasZero = prev.w < MIN_FIT_PANE_PX || prev.h < MIN_FIT_PANE_PX;
      paneSizeRef.current = { w: r.width, h: r.height };
      if (wasZero && r.width >= MIN_FIT_PANE_PX && r.height >= MIN_FIT_PANE_PX) {
        pendingRealSizeRef.current = true;
        setPaneReal((tick) => tick + 1);
        return;
      }
      if (wasZero) return;
      if (Math.abs(prev.w - r.width) < 2 && Math.abs(prev.h - r.height) < 2) return;
      refitAfterResizeRef.current({ w: r.width, h: r.height });
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A wheel over the canvas is a manual zoom (zoomOnScroll) — mark the view
  // reader-owned so the sentinel never refits over it.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = () => {
      userMovedRef.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // The sentinel: watch the rendered transform. A non-finite one (a NaN
  // fit) is repaired to the last good transform; a finite one that leaves
  // every node outside the pane — while the reader has not moved the view
  // and everything is measured — is re-fit.
  useEffect(() => {
    const el = viewportEl();
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const t = parseViewportTransform(el.style.transform);
      if (t === null) {
        if (lastGoodRef.current) setViewport(lastGoodRef.current, { duration: 0 });
        return;
      }
      lastGoodRef.current = t;
      if (userMovedRef.current) return;
      if (baseRef.current.nodes.length === 0 || !allMeasuredRef.current) return;
      const pane = paneRef.current?.getBoundingClientRect();
      if (!pane || pane.width < MIN_FIT_PANE_PX || pane.height < MIN_FIT_PANE_PX) return;
      const anyInside = [...el.querySelectorAll<HTMLElement>(".react-flow__node")].some((n) => {
        const r = n.getBoundingClientRect();
        return (
          r.left < pane.left + pane.width &&
          r.right > pane.left &&
          r.top < pane.top + pane.height &&
          r.bottom > pane.top
        );
      });
      if (anyInside) return;
      // Blank canvas: re-fit one frame later (the transform may still be
      // mid-update), but only if it is still blank and nothing moved.
      requestAnimationFrame(() => {
        if (userMovedRef.current) return;
        const still = parseViewportTransform(viewportEl()?.style.transform ?? null);
        if (still === null) return;
        const paneNow = paneRef.current?.getBoundingClientRect();
        if (!paneNow || paneNow.width < MIN_FIT_PANE_PX) return;
        const stillBlank = [
          ...(viewportEl()?.querySelectorAll<HTMLElement>(".react-flow__node") ?? []),
        ].every((n) => {
          const r = n.getBoundingClientRect();
          return !(
            r.left < paneNow.left + paneNow.width &&
            r.right > paneNow.left &&
            r.top < paneNow.top + paneNow.height &&
            r.bottom > paneNow.top
          );
        });
        if (stillBlank) safeFitRef.current();
      });
    });
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
    };
  }, [setViewport, viewportEl]);

  // The deep link's node: centre it once it is on the canvas and measured —
  // until the reader pans/zooms (userMovedRef), after which their viewport
  // wins and the canvas never moves it again.
  useEffect(() => {
    const defNode = base.nodes.find((n) => n.data.nodeId === focusNodeId);
    const box = defNode ? nodeBoxes[defNode.id] : null;
    const pane = paneRef.current?.getBoundingClientRect();
    if (!focusNodeId || userMovedRef.current) return;
    if (focusedRef.current === focusNodeId) return;
    if (!allMeasured) return;
    if (!box) return;
    if (!pane || pane.width < MIN_FIT_PANE_PX || pane.height < MIN_FIT_PANE_PX) return;
    focusedRef.current = focusNodeId;
    const current = parseViewportTransform(viewportEl()?.style.transform ?? null) ?? {
      x: 0,
      y: 0,
      zoom: 1,
    };
    const vp = centerOnBox(box, pane.width, pane.height, current.zoom);
    if (vp) {
      setViewport(vp, { duration: 0 });
      lastGoodRef.current = vp;
    }
  }, [focusNodeId, allMeasured, nodeSetKey, base, nodeBoxes, paneReal, setViewport, viewportEl]);

  // Backspace/Delete removes the selected steps (design 1g: the ⌫ action).
  // One window handler is the canvas's only key-delete path — React Flow's
  // own deleteKeyCode would double-delete through onNodesDelete.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const ids = pageSelRef.current;
      if (ids.length === 0) return;
      event.preventDefault();
      deleteGuarded(ids);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, deleteGuarded]);

  return (
    <div
      ref={canvasRef}
      className="studio-canvas flex h-full min-h-0 flex-col border border-line bg-paper"
      data-testid="studio-canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* The React Flow edge layer paints under the node layer (DOM order in
       * the viewport), so scope group backgrounds would swallow the edges.
       * Lift the edges above the nodes and the labels above the edges — the
       * edge "+" buttons must stay clickable. */}
      <style>
        {
          ".studio-canvas .react-flow__edges{z-index:1}.studio-canvas .react-flow__edgelabel-renderer{z-index:2}"
        }
      </style>
      <div
        ref={paneRef}
        className="relative min-h-0 flex-1"
        style={stale ? { opacity: 0.55, filter: "grayscale(1)" } : undefined}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          // The “React Flow” badge is a library watermark, not information: the
          // run page (RunWorkbench mounts this canvas) and the Studio are the
          // app's own surfaces, and the round-2 review (item 3) asked for it out
          // of the user's view. The shipped package is MIT-licensed and its
          // LICENSE carries no attribution condition
          // (`ui/node_modules/@xyflow/react/LICENSE`), so hiding it is what the
          // library's own `proOptions` flag exists for.
          proOptions={{ hideAttribution: true }}
          minZoom={0.4}
          maxZoom={1.25}
          onlyRenderVisibleElements={false}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={handleConnect}
          onMoveStart={(event) => {
            // Only a GESTURE makes the view reader-owned. React Flow also
            // fires this for the canvas' own `setViewport` (the fit, the
            // focus centring, the −/+ controls) with a null source event, and
            // taking that as “the reader moved it” is what left the 1280 fit
            // applied to the 390 pane: the graph off-centre and its cards
            // clipped. The −/+ buttons mark it themselves.
            if (event) userMovedRef.current = true;
          }}
          // Multi-selection: Shift+click adds a step to the selection (the
          // store's default multiSelectionKeyCode is Control — without this a
          // Shift+click just replaces the selection). The Shift+drag selection
          // box comes from the default selectionKeyCode=Shift.
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          onSelectionChange={handleSelectionChange}
          onNodesDelete={(deleted) =>
            deleteGuarded(deleted.map((n) => (n.data as { id?: string }).id ?? "").filter(Boolean))
          }
          onEdgesDelete={(deleted) => deleteGuarded(deleted.map((e) => e.id))}
          onNodeContextMenu={onNodeContextMenu}
          nodesDraggable={!readOnly && !stale}
          nodesConnectable={!readOnly && !stale}
        >
          <Background />
        </ReactFlow>
        {stale && (
          <div
            role="alert"
            data-testid="canvas-stale-banner"
            className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-st-waiting-pale-edge bg-st-waiting-pale-body px-3 py-1.5 text-[12px] text-st-waiting-pale-fg"
          >
            {staleMessage ??
              "YAML has errors — the canvas shows the last valid version; graph editing is paused."}
          </div>
        )}
        {base.nodes.length === 0 && !stale && !readOnly && (
          <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <button
              type="button"
              data-testid="canvas-add-first"
              className="rounded-md border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:border-accent hover:text-accent"
              onClick={() => setCanvasPickerOpen(true)}
            >
              + Add first step
            </button>
            {canvasPickerOpen && (
              <div className="absolute left-0 top-full mt-1">
                <StepPicker
                  title="Add the first step"
                  onPick={(kind) => {
                    setCanvasPickerOpen(false);
                    onAddAfter?.(null, [], kind);
                  }}
                  onClose={() => setCanvasPickerOpen(false)}
                />
              </div>
            )}
          </div>
        )}
        {refused && (
          <div
            role="status"
            data-testid="connect-refused"
            className="absolute bottom-[44px] left-3 z-10 max-w-sm rounded-md border border-st-failed-pale-edge bg-st-failed-pale-body px-3 py-1.5 text-[12px] text-st-failed-pale-fg"
          >
            {refused}
          </div>
        )}
        {menu && !menuDocked && menuScreen !== null && (
          <NodeMenu
            x={menuScreen.x}
            y={menuScreen.y}
            compact={menuCompact}
            onMeasure={measureMenu(menuCompact ? "compact" : "menu")}
            nodeId={menu.nodeId}
            onDuplicate={onDuplicate}
            onDelete={(ids) => onDelete?.(ids)}
            onClose={closeMenu}
          />
        )}
      </div>

      {/* The pane is too short to hold even the one-row menu (a canvas the
       * dock has squeezed to a strip): only then do the actions leave the
       * graph and take a flow row of their own under the viewport. */}
      {menu && menuDocked ? (
        <NodeMenu
          x={0}
          y={0}
          docked
          nodeId={menu.nodeId}
          onDuplicate={onDuplicate}
          onDelete={(ids) => onDelete?.(ids)}
          onClose={closeMenu}
        />
      ) : null}

      {/* One reserved band under the canvas holds the design's bottom row: the
          caption (1g, bottom-left) and the − + fit group (1g canvas chrome,
          bottom-right). Nothing of it is pinned OVER the pane any more: the
          390 pane is barely taller than a four-step chain, so the bottom-pinned
          caption printed straight across `publish_plan` and the floating
          controls sat on top of that card too (pass 6, both canvases). As a
          FLOW band they take their own height and React Flow clips its own
          viewport at the pane's edge — so no node, “+” or edge can reach them
          at any width. `fit` still runs the canvas' own guarded fit, never
          React Flow's unguarded one.

          The caption never uses `whitespace-nowrap`: nowrap text PAINTS past
          its own box, which is exactly how it ran under the − + group at 1280
          while its box looked clean. It wraps instead, and the band is a
          column at desk width (one caption line under the controls, the
          design's row) and a wrapping row on the phone (the caption beside the
          44px controls) so the short canvas keeps its height. The
          "React Flow" attribution stays in the pane — hiding it needs a Pro
          licence we do not hold. */}
      <div
        className="flex shrink-0 flex-col-reverse items-stretch gap-y-[2px] px-[10px] pb-[6px] pt-[2px] max-[560px]:flex-row max-[560px]:flex-wrap max-[560px]:items-end max-[560px]:justify-between max-[560px]:gap-x-1"
        data-testid="canvas-chrome"
      >
        {/* The caption is the EDITOR's rule for wiring a graph, so it belongs
            to an editable canvas only: the Run Workbench's Graph tab (readOnly,
            a pinned revision projected from a run) has no handles to leave the
            bottom of, and a run reader who follows that advice would be trying
            for a verb this page does not have. A read-only canvas gets the
            honest one-liner instead, in the same band, same type. */}
        <span
          className="min-w-0 font-mono text-[10.5px] leading-[14px] text-faint max-[560px]:flex-1"
          data-testid="canvas-caption"
        >
          {readOnly
            ? "read-only · the definition this run is pinned to"
            : "always top to bottom · lines leave the bottom and enter the top"}
        </span>
        <div
          className="flex shrink-0 self-end overflow-hidden rounded-[3px] border border-line-strong bg-surface max-[560px]:self-auto"
          data-testid="canvas-controls"
        >
          <button
            type="button"
            aria-label="Zoom out"
            data-testid="canvas-zoom-out"
            onClick={() => {
              userMovedRef.current = true;
              zoomOut({ duration: 200 });
            }}
            // Issue #68: the hit box is 30×30 (was 28×26 — measured 29×27 at
            // 1280); the painted − glyph stays 13px. `icon-hit` keeps the
            // shared 30px floor for anyone who re-sizes the box later.
            className="icon-hit h-[30px] w-[30px] border-r border-line text-[13px] leading-none text-ink hover:bg-fill"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            data-testid="canvas-zoom-in"
            onClick={() => {
              userMovedRef.current = true;
              zoomIn({ duration: 200 });
            }}
            // Issue #68: 30×30 hit box, painted + glyph unchanged.
            className="icon-hit h-[30px] w-[30px] border-r border-line text-[13px] leading-none text-ink hover:bg-fill"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Fit the graph to the pane"
            data-testid="canvas-fit"
            onClick={() => {
              userMovedRef.current = false;
              safeFit();
            }}
            className="icon-hit h-[30px] px-[8px] font-mono text-[10.5px] leading-none text-ink hover:bg-fill"
          >
            fit
          </button>
        </div>
      </div>

      {/* Design 1g: the accessible steps list is a collapsed one-line mono
          disclosure (`steps list · N`), never a panel eating canvas height.
          Pass 2 #8 drops it entirely from the Studio — the status bar counts
          the steps there; the Run Workbench keeps the definition table. */}
      {hideStepList ? null : (
        <section className="border-t border-line bg-surface" data-testid="canvas-step-list">
          <button
            type="button"
            aria-expanded={stepsOpen}
            aria-controls="studio-canvas-steps"
            onClick={() => setStepsOpen((open) => !open)}
            className="w-full px-3 py-1 text-left font-mono text-[10.5px] text-muted hover:bg-fill"
          >
            {stepsOpen ? "▾" : "▸"} steps list · {model.nodes.length}
          </button>
          {/* The rows stay in the DOM behind the disclosure (they are the
            accessible name list the Workbench reads); the disclosure just
            hides them visually, so they never eat canvas height. */}
          <ol
            id="studio-canvas-steps"
            className={`max-h-48 overflow-y-auto px-3 pb-2 ${stepsOpen ? "" : "hidden"}`}
          >
            {model.nodes.map((node) => (
              <li key={`${scopeKey(node.scope)}\u0000${node.id}`}>
                <button
                  type="button"
                  data-testid={`canvas-step-row-${node.id}`}
                  onClick={() => onSelect(node.id)}
                  className={[
                    "w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-fill",
                    selectedId === node.id ||
                    (selectedIds !== undefined && selectedIds.includes(node.id))
                      ? "bg-accent-wash text-accent"
                      : "text-ink",
                  ].join(" ")}
                >
                  <span className="font-medium">{node.label}</span>{" "}
                  <span className="font-mono text-[11px] text-muted">{node.id}</span>
                  {node.dependsOn.length > 0 && (
                    <span className="text-faint"> after {node.dependsOn.join(", ")}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
