/**
 * ds Popover — the rail's click-surface (redesign 3a: "click = menu").
 *
 * The box the design draws beside a collapsed-rail icon: white, 1px ink
 * border, the `2px 2px 0 ink` offset shadow (`shadow-raised`), a 3px radius,
 * 8px padding, ~196px wide, and a 10px rotated-square arrow on the edge that
 * faces the trigger — the arrow rides the trigger's vertical centre, clamped
 * inside the box.
 *
 * It is the sibling of `ds/Menu`'s anchored surfaces, specialised for the
 * rail's rule (3a's caption: "Predictable, with no menus opening by accident
 * while you move the mouse across the rail. Takes one click to reach a
 * project. Keyboard-friendly"): opening is the CALLER's click, never hover.
 *
 * Behavior: positioned beside the trigger (right by default; it flips to the
 * left near the viewport edge) and clamped to the viewport. On open, focus
 * parks on the first focusable item; ↑/↓ move between items (roving, with
 * wrap); Enter activates the focused item (links in the content activate the
 * same way they do in a real browser, and jsdom proves the handler rather
 * than trusting one); Esc closes and returns focus to the trigger; a
 * pointerdown outside closes (and returns focus only when it had wandered
 * into the box, so a click on another control is not fought).
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/** Smallest gap the box keeps from any viewport edge. */
const VIEWPORT_MARGIN_PX = 8;

/** The design's box starts 10px past the rail's edge (the arrow lives in it). */
const TRIGGER_GAP_PX = 10;

/** The 3a popover's width: ~196px. */
export const POPOVER_WIDTH_PX = 196;

/** The arrow: a 10px square, half over the border line. */
const ARROW_SIZE_PX = 10;

export interface PopoverProps {
  open: boolean;
  /** Called on Esc and on an outside pointerdown (focus has already been
   * returned to the trigger where that applies). */
  onClose: () => void;
  /** The trigger element: the anchor for placement, the arrow's centre and
   * the Esc focus target. */
  triggerRef: RefObject<HTMLElement | null>;
  /** The box width in px, used by the clamp math before layout can measure
   * it (jsdom measures nothing); the style width is set from this too. */
  width?: number;
  /** Open to the trigger's right (`right`) or left (`left`). The rail always
   * asks for right; the box flips when the viewport says no. */
  side?: "right" | "left";
  children: ReactNode;
  /** `aria-label` for the popover box. */
  ariaLabel?: string;
  labelledBy?: string;
  panelId?: string;
  className?: string;
  /** Stable test hook on the panel element, spelled `data-testid` so
   * `scripts/check-testids.mjs` recognises the literal attribute. */
  "data-testid"?: string;
}

/** Roving candidates: the real focusable controls inside the box. */
function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.closest('[aria-disabled="true"]'));
}

/**
 * The anchored free-content surface. It renders inside the caller's
 * `relative` wrapper (like `ds/Menu`'s surfaces) so an escaping popover is
 * never cut off by a scrolling column.
 */
export function Popover({
  open,
  onClose,
  triggerRef,
  width = POPOVER_WIDTH_PX,
  side = "right",
  children,
  ariaLabel,
  labelledBy,
  panelId,
  className = "",
  "data-testid": dataTestid,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const [landedSide, setLandedSide] = useState<"right" | "left">(side);
  const latest = useRef({ open, onClose, triggerRef, width, side });
  latest.current = { open, onClose, triggerRef, width, side };

  // Placement + arrow centring, on open and on every viewport resize. All
  // math runs on rects: the caller passes the box width, the height is read
  // once painted (browsers and jsdom both settle to the same clamp rule).
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const panel = panelRef.current;
      const arrow = arrowRef.current;
      const trigger = latest.current.triggerRef.current;
      if (!panel || !arrow || !trigger) return;
      const o = latest.current;
      const margin = VIEWPORT_MARGIN_PX;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const t = trigger.getBoundingClientRect();
      const holder = panel.parentElement;
      const base = holder ? holder.getBoundingClientRect() : { left: 0, top: 0 };
      const w = o.width;
      const h = panel.offsetHeight || 0;

      let s = o.side;
      if (
        s === "right" &&
        t.right + TRIGGER_GAP_PX + w > vw - margin &&
        t.left - TRIGGER_GAP_PX - w > margin
      ) {
        s = "left";
      } else if (
        s === "left" &&
        t.left - TRIGGER_GAP_PX - w < margin &&
        t.right + TRIGGER_GAP_PX + w < vw - margin
      ) {
        s = "right";
      }

      const top = Math.max(margin, Math.min(t.top, vh - margin - h));
      const left = s === "right" ? t.right + TRIGGER_GAP_PX : t.left - TRIGGER_GAP_PX - w;
      panel.style.left = `${left - base.left}px`;
      panel.style.top = `${top - base.top}px`;
      panel.setAttribute("data-side", s);
      // The arrow rides the trigger's centre, not the box's; clamped so it
      // never slides past the box's own rounded corners.
      const centre = t.top + t.height / 2 - top;
      const clamped = Math.max(12, Math.min(centre - ARROW_SIZE_PX / 2, (h || centre) - 12));
      arrow.style.top = `${clamped}px`;
      arrow.style.left = s === "right" ? `${-ARROW_SIZE_PX / 2 - 1}px` : "";
      arrow.style.right = s === "left" ? `${-ARROW_SIZE_PX / 2 - 1}px` : "";
      setLandedSide(s);
    };
    position();
    // The column's rows re-flow a frame after a breakpoint change; re-measure
    // on the next frames until the geometry settles (idempotent).
    let raf = 0;
    let frames = 0;
    const verify = () => {
      raf = 0;
      position();
      if (++frames < 4) raf = requestAnimationFrame(verify);
    };
    const onResize = () => {
      frames = 0;
      if (!raf) raf = requestAnimationFrame(verify);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open]);

  // The click-surface promise: once open, the keyboard belongs to the box.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    focusables(panel)[0]?.focus();
  }, [open]);

  // Esc closes and returns focus; ↑/↓ rove; Enter activates the focused
  // item (real browsers do this for links natively — this makes jsdom, and
  // any element that is not an anchor, behave the same).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      const trigger = latest.current.triggerRef.current;
      // A surface unmounted while open (cleanup, a route swap) must not let a
      // stray keydown close or navigate through a detached box.
      if (!panel || !panel.isConnected || !trigger?.isConnected) return;
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current.triggerRef.current?.focus();
        latest.current.onClose();
        return;
      }
      const items = focusables(panel);
      const active = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (items.length > 0)
          (items[(active + 1 + items.length) % items.length] ?? items[0])?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length > 0) (active <= 0 ? items[items.length - 1] : items[active - 1])?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        items[active]?.click();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // A pointerdown anywhere outside closes the box (3a/4a: Esc or a click
  // outside closes it). Focus returns to the trigger only when it had been
  // inside the box — a click that landed on another control belongs to it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const o = latest.current;
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || o.triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(document.activeElement)) o.triggerRef.current?.focus();
      o.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      data-testid={dataTestid}
      className={`absolute left-0 top-0 z-40 flex flex-col gap-[2px] rounded-[3px] border border-ink bg-surface p-2 shadow-raised ${className}`}
      style={{ width }}
    >
      <span
        ref={arrowRef}
        aria-hidden="true"
        data-testid="menu-arrow"
        className={`absolute z-10 block border-ink bg-surface ${
          landedSide === "right" ? "border-b border-l" : "border-r border-t"
        }`}
        style={{
          width: ARROW_SIZE_PX,
          height: ARROW_SIZE_PX,
          transform: "rotate(45deg)",
        }}
      />
      {children}
    </div>
  );
}

export default Popover;
