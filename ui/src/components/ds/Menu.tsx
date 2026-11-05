/**
 * ds Menu / Popover — the ONE anchored-surface primitive (handoff 2c/3c:
 * "all popovers/menus get a pointer arrow"). Dependency-free.
 *
 * The box: white, 1px ink border, 4px radius, `2px 2px 0 ink` shadow
 * (`shadow-raised`). The arrow: a 9px square, white, 1px ink border on the
 * two sides facing out, rotated 45°, centered on the trigger — even when the
 * box itself is clamped away from the trigger by the viewport edge.
 *
 * Placement: anchored to a trigger ref below (`bottom`, default) or above
 * (`top`), or to the side (`left`/`right`, for the sidebar rail flyouts).
 * It auto-flips near the opposite viewport edge and stays inside the
 * viewport with an 8px margin. Clamp math runs on rects, not layout: pass
 * the box `width` (and, when flipping must be proven before paint, `height`)
 * in px — jsdom measures nothing, and every browser's first paint has the
 * same problem.
 *
 * Behavior (handoff "Interactions & behavior"): Esc closes and returns
 * focus to the trigger; clicking outside closes; ArrowUp/Down, Home and End
 * move between items (`Menu` only); opening a `Menu` parks focus on the
 * first enabled item. `role="menu"` + `menuitem`s + `role="separator"`.
 *
 * `Menu` takes an items list; `Popover` takes free content (flyouts, the
 * rail's project cards). Both are positioned `absolute`, so they render
 * inside the caller's `relative` wrapper, like the menus they replace.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type MenuSide = "bottom" | "top" | "right" | "left";
export type MenuAlign = "start" | "end";

/** Smallest gap the box keeps from any viewport edge. */
const VIEWPORT_MARGIN_PX = 8;

/** Gap between the trigger and the box. */
const TRIGGER_GAP_PX = 4;

/** The arrow: a 9px square, half over the border line. */
const ARROW_SIZE_PX = 9;

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** ✓ in a fixed gutter — for pickers like "NEXT TURN RUNS ON". Pass
   * `false` (not `undefined`) on the siblings so the labels stay aligned. */
  checked?: boolean;
  /** Stable test hook for the item's button. */
  testId?: string;
  title?: string;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

/** The `menuitem` button styling — shared by the `items` renderer and by
 * callers that draw their own item JSX as `Menu` children (the migrated
 * New/User/Row menus keep their literal `data-testid`s that way). */
export const MENU_ITEM_CLASS =
  "flex w-full items-center gap-[6px] px-3 py-[6px] text-left text-[12.5px] text-ink hover:bg-accent-wash focus-visible:bg-accent-wash focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

interface SurfaceProps {
  open: boolean;
  /** Called on Esc and on an outside pointerdown (the primitive has already
   * returned focus to the trigger by then, where that applies). */
  onClose: () => void;
  /** The trigger element: the anchor for placement, the arrow's center and
   * the Esc focus target. */
  triggerRef: RefObject<HTMLElement | null>;
  side?: MenuSide;
  /** Horizontal anchor for `bottom`/`top` (start = the trigger's left edge,
   * end = its right edge); ignored for `left`/`right`. */
  align?: MenuAlign;
  /** The box width in px, used by the clamp math before layout can measure
   * it. The style width is set from this too. */
  width?: number;
  /** The box height in px, used by the vertical clamp and the auto-flip
   * before layout; `offsetHeight` is trusted when it is non-zero. */
  height?: number;
  /** Close to the edge, flip to the opposite side instead of overflowing. */
  flip?: boolean;
  /** Uppercase mono caption above the content, e.g. "NEXT TURN RUNS ON". */
  caption?: string;
  /** The box's stable test hook, passed through to the panel element. It is
   * spelled `data-testid` so callers can hand the e2e ids over on the very
   * attribute the suites read: `scripts/check-testids.mjs` only recognises
   * literal `data-testid`/`testid` attributes and never follows a string
   * through a prop. */
  "data-testid"?: string;
  panelId?: string;
  /** `aria-label` for the `role="menu"` / popover box. */
  ariaLabel?: string;
  labelledBy?: string;
  className?: string;
}

const SURFACE_CLASS =
  "absolute left-0 top-0 z-40 rounded-[4px] border border-ink bg-surface shadow-raised";

/** Which two sides of the rotated square wear the ink border, and where the
 * square sits on the box edge, per placement side. */
const ARROW_EDGE_CLASS: Record<MenuSide, string> = {
  bottom: "-top-[5px] border-t border-l",
  top: "-bottom-[5px] border-b border-r",
  right: "-left-[5px] border-t border-r",
  left: "-right-[5px] border-b border-l",
};

const ARROW_TRANSFORM: Record<MenuSide, string> = {
  bottom: "translateX(-50%) rotate(45deg)",
  top: "translateX(-50%) rotate(45deg)",
  right: "translateY(-50%) rotate(-45deg)",
  left: "translateY(-50%) rotate(-45deg)",
};

interface AnchorOptions {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  side: MenuSide;
  align: MenuAlign;
  width?: number;
  height?: number;
  flip: boolean;
  /** `Menu` parks focus on the first enabled item when it opens; rail
   * `Popover` flyouts must not steal focus from the tile they hover over. */
  focusFirstOnOpen: boolean;
  /** `Menu` answers ArrowUp/Down/Home/End; free-content popovers do not. */
  menuNavigation: boolean;
}

/**
 * The shared choreography: placement + arrow centering, Esc, outside-click
 * and focus management. Returns the refs to hang on the box and the arrow,
 * plus the side the box actually landed on (the arrow's border pair follows
 * it).
 */
function useAnchoredSurface(options: AnchorOptions) {
  const panelRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const [landedSide, setLandedSide] = useState<MenuSide>(options.side);
  const latest = useRef(options);
  latest.current = options;

  useLayoutEffect(() => {
    if (!options.open) return;
    const position = () => {
      const panel = panelRef.current;
      const arrow = arrowRef.current;
      const trigger = latest.current.triggerRef.current;
      if (!panel || !arrow || !trigger) return false;
      const o = latest.current;
      const margin = VIEWPORT_MARGIN_PX;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const t = trigger.getBoundingClientRect();
      // The panel is absolutely positioned against its `relative` parent.
      const holder = panel.parentElement;
      const base = holder ? holder.getBoundingClientRect() : { left: 0, top: 0 };
      const w = o.width ?? panel.offsetWidth ?? 0;
      const h = panel.offsetHeight || (o.height ?? 0);
      const gap = TRIGGER_GAP_PX;

      let side = o.side;
      if (o.flip) {
        if (side === "bottom" && t.bottom + gap + h > vh - margin && t.top - gap - h > margin) {
          side = "top";
        } else if (side === "top" && t.top - gap - h < margin && t.bottom + gap + h < vh - margin) {
          side = "bottom";
        } else if (
          side === "right" &&
          t.right + gap + w > vw - margin &&
          t.left - gap - w > margin
        ) {
          side = "left";
        } else if (
          side === "left" &&
          t.left - gap - w < margin &&
          t.right + gap + w < vw - margin
        ) {
          side = "right";
        }
      }

      let left: number;
      let top: number;
      if (side === "bottom" || side === "top") {
        left = o.align === "end" ? t.right - w : t.left;
        left = Math.max(margin, Math.min(left, vw - margin - w));
        top = side === "bottom" ? t.bottom + gap : t.top - gap - h;
      } else {
        top = Math.max(margin, Math.min(t.top, vh - margin - h));
        left = side === "right" ? t.right + gap : t.left - gap - w;
      }

      panel.style.left = `${left - base.left}px`;
      panel.style.top = `${top - base.top}px`;
      panel.setAttribute("data-side", side);
      // The arrow rides the trigger's center, not the box's: the box clamps,
      // the arrow does not.
      if (side === "bottom" || side === "top") {
        arrow.style.left = `${t.left + t.width / 2 - left}px`;
        arrow.style.top = "";
        arrow.style.right = "";
      } else {
        arrow.style.top = `${t.top + t.height / 2 - top}px`;
        arrow.style.left = "";
        arrow.style.right = "";
      }
      // The reposition verification (below) stops when the geometry has
      // settled: report whether this pass applied anything new.
      const settled =
        side === last.side && panel.style.left === last.left && panel.style.top === last.top;
      last.left = panel.style.left;
      last.top = panel.style.top;
      last.side = side;
      setLandedSide(side);
      return !settled;
    };
    const last = { left: "", top: "", side: null as MenuSide | null };
    position();
    // A viewport resize fires BEFORE the app's layout has settled: the
    // breakpoint re-render (the Details sheet appearing below `lg`, the
    // composer row re-flowing) moves the trigger a frame or two later, so a
    // synchronous re-position clamps against the OLD geometry and leaves the
    // panel off-screen (round-15: the NEXT TURN RUNS ON menu at 390, its
    // body left of the viewport while its arrow still touched the chip).
    // Re-measure on the following frames instead, verifying a short, bounded
    // burst until the geometry stops changing; `position()` is idempotent.
    const MAX_VERIFY_FRAMES = 10;
    let verifyFrames = 0;
    let raf = 0;
    const verify = () => {
      raf = 0;
      if (++verifyFrames >= MAX_VERIFY_FRAMES) return;
      // `false` = geometry settled, stop verifying.
      if (!position()) return;
      raf = requestAnimationFrame(verify);
    };
    const onResize = () => {
      verifyFrames = 0;
      if (!raf) raf = requestAnimationFrame(verify);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [options.open]);

  useLayoutEffect(() => {
    if (!options.open || !options.focusFirstOnOpen) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [options.open]);

  // Esc (every surface) + arrow-key roving (menus only).
  useEffect(() => {
    if (!options.open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const o = latest.current;
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        o.triggerRef.current?.focus();
        o.onClose();
        return;
      }
      if (!o.menuNavigation) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
        (item) => !item.matches("[disabled], [aria-disabled='true']"),
      );
      const active = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(active + 1 + items.length) % items.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(active - 1 + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [options.open]);

  // Clicking anywhere outside — the page, another trigger — closes the
  // surface, like every menu in the app today (issue #62).
  useEffect(() => {
    if (!options.open) return;
    const onPointerDown = (event: PointerEvent) => {
      const o = latest.current;
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || o.triggerRef.current?.contains(target)) return;
      o.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [options.open]);

  return { panelRef, arrowRef, landedSide };
}

function Arrow({
  arrowRef,
  side,
}: {
  arrowRef: RefObject<HTMLSpanElement | null>;
  side: MenuSide;
}) {
  return (
    <span
      ref={arrowRef}
      aria-hidden="true"
      data-testid="menu-arrow"
      className={`pointer-events-none absolute z-10 block border-ink bg-surface ${ARROW_EDGE_CLASS[side]}`}
      style={{
        width: ARROW_SIZE_PX,
        height: ARROW_SIZE_PX,
        transform: ARROW_TRANSFORM[side],
      }}
    />
  );
}

function Caption({ caption }: { caption?: string }) {
  if (!caption) return null;
  return (
    <div className="px-3 pb-[4px] pt-[6px] font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
      {caption}
    </div>
  );
}

function anchorDefaults(props: SurfaceProps) {
  return {
    open: props.open,
    onClose: props.onClose,
    triggerRef: props.triggerRef,
    side: props.side ?? ("bottom" as MenuSide),
    align: props.align ?? ("start" as MenuAlign),
    width: props.width ?? 180,
    height: props.height,
    flip: props.flip ?? true,
  };
}

export interface MenuProps extends SurfaceProps {
  /** Declarative items… */
  items?: MenuEntry[];
  /** …or the menu's own content: draw `role="menuitem"` buttons (and
   * `role="separator"` rules) directly, using `MENU_ITEM_CLASS`. The
   * keyboard, focus return and closing choreography treat children exactly
   * like items. Callers whose items carry literal `data-testid`s (New,
   * User, Row menus — see `scripts/check-testids.mjs`) render children. */
  children?: ReactNode;
}

/** The anchored menu: `role="menu"`, `menuitem`s, separators, an optional
 * caption. Callers close it themselves from `onSelect` (activation and
 * dismissal are their decision — the dialog-opening New menu knows this
 * best); Esc and outside-clicks close it through `onClose`. */
export function Menu({ items, children, "data-testid": dataTestid, ...surface }: MenuProps) {
  const anchor = anchorDefaults(surface);
  const { panelRef, arrowRef, landedSide } = useAnchoredSurface({
    ...anchor,
    focusFirstOnOpen: true,
    menuNavigation: true,
  });
  if (!surface.open) return null;
  return (
    <div
      ref={panelRef}
      id={surface.panelId}
      role="menu"
      aria-label={surface.ariaLabel}
      aria-labelledby={surface.labelledBy}
      data-testid={dataTestid}
      className={`${SURFACE_CLASS} py-[4px] ${surface.className ?? ""}`}
      style={{ width: anchor.width }}
    >
      <Arrow arrowRef={arrowRef} side={landedSide} />
      <Caption caption={surface.caption} />
      {(items ?? []).map((entry, index) =>
        "separator" in entry ? (
          <div key={`separator-${index}`} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            title={entry.title}
            data-testid={entry.testId}
            onClick={() => entry.onSelect()}
            className={MENU_ITEM_CLASS}
          >
            {entry.checked === undefined ? null : (
              <span aria-hidden="true" className="w-[12px] shrink-0 font-mono">
                {entry.checked ? "✓" : ""}
              </span>
            )}
            {entry.label}
          </button>
        ),
      )}
      {children}
    </div>
  );
}

export interface PopoverProps extends SurfaceProps {
  children: ReactNode;
}

/** The anchored free-content surface — the sidebar rail's flyouts. Esc
 * closes and returns focus to the trigger; outside-clicks close; there is no
 * arrow-key roving (the content owns its own focus). */
export function Popover({ children, "data-testid": dataTestid, ...surface }: PopoverProps) {
  const anchor = anchorDefaults(surface);
  const { panelRef, arrowRef, landedSide } = useAnchoredSurface({
    ...anchor,
    focusFirstOnOpen: false,
    menuNavigation: false,
  });
  if (!surface.open) return null;
  return (
    <div
      ref={panelRef}
      id={surface.panelId}
      role="dialog"
      aria-label={surface.ariaLabel}
      aria-labelledby={surface.labelledBy}
      data-testid={dataTestid}
      className={`${SURFACE_CLASS} p-2 ${surface.className ?? ""}`}
      style={{ width: anchor.width }}
    >
      <Arrow arrowRef={arrowRef} side={landedSide} />
      <Caption caption={surface.caption} />
      {children}
    </div>
  );
}
