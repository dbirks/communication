/**
 * DragGhost.tsx — the two marks drawn while a canvas node is dragged
 * (redesign README section 8, “dragging (5b)”): a dashed **snap target**
 * showing where the node lands on the 20px grid, and a diagonal-hatch
 * **shadow card** 6px down-right behind the node it follows.
 *
 * Rendered inside React Flow's `<ViewportPortal>` so both marks share the
 * canvas coordinate system and pan/zoom with it; they are decoration, so
 * they are `aria-hidden` and never catch the pointer. The explicit
 * `zIndex: 0` keeps them under every node lane (goal frames 0 come first in
 * DOM order, notes 1, steps 2) — the hatch must read as a shadow *behind*
 * the dragged card.
 */

/** The drag grid: a dropped node lands on a multiple of this. */
export const DRAG_GRID_PX = 20;

/** Snap one flow coordinate to the 20px grid, never above the origin. */
export function snapToGrid20(v: number): number {
  return Math.max(0, Math.round(v / DRAG_GRID_PX) * DRAG_GRID_PX);
}

export interface DragGhostProps {
  /** The dragged node's CURRENT position in flow coordinates. */
  x: number;
  y: number;
  /** Its measured size (a step is 168×56). */
  width: number;
  height: number;
}

const GHOST_Z = 0;

export function DragGhost({ x, y, width, height }: DragGhostProps) {
  const snapX = snapToGrid20(x);
  const snapY = snapToGrid20(y);
  const shared = {
    position: "absolute" as const,
    width,
    height,
    pointerEvents: "none" as const,
    zIndex: GHOST_Z,
  };
  return (
    <>
      {/* The hatch is the offset shadow, so it is painted first: the dashed
       * target then sits over it where the two overlap. */}
      <div
        data-testid="drag-hatch"
        aria-hidden
        style={{
          ...shared,
          left: x + 6,
          top: y + 6,
          background: "repeating-linear-gradient(135deg, #b3ada2 0 1px, transparent 1px 4px)",
          borderRadius: 10,
        }}
      />
      <div
        data-testid="drag-snap-target"
        aria-hidden
        style={{
          ...shared,
          left: snapX,
          top: snapY,
          border: "1.5px dashed #b3ada2",
          borderRadius: 10,
          boxSizing: "border-box",
        }}
      />
    </>
  );
}
