/**
 * The composer's page-context control (handoff §3 / §1; mock L341–380 and the
 * PAGE CONTEXT menu at L420–440).
 *
 * A 26px square in the composer's bottom row says what the server is being
 * told about the page; clicking it opens the menu that names the page, its
 * route, and the "Send with my messages" switch. The menu is `ComposerMenu`
 * (also exported here, because the trust pill needs the same sibling box):
 * handoff §1 requires menus that leave the panel to render as SIBLINGS of the
 * panel, or the popover's `overflow: hidden` clips them.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { IconCurrentLocation, IconCurrentLocationOff } from "@tabler/icons-react";
import { MenuArrow } from "../ds/Menu";
import type { PageContext } from "./pageContext";

/** The gap the design keeps between the composer row and the box above it. */
const TRIGGER_GAP_PX = 6;

/** Smallest gap the box keeps from any viewport edge. */
const VIEWPORT_MARGIN_PX = 8;

/** The box's size: the menu the design draws is 270px wide (ctx) / 290 (trust). */
export const COMPOSER_MENU_WIDTH_PX = 270;

export interface ComposerMenuProps {
  /** The trigger the box is anchored above and the arrow points at. */
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Esc and any pointerdown outside the box (returning focus is the caller's). */
  onClose: () => void;
  /** The box width in px (jsdom measures nothing, so the clamp needs it). */
  width: number;
  /** `aria-label` for the box. */
  ariaLabel: string;
  children: ReactNode;
  "data-testid": string;
}

interface Placement {
  left: number;
  bottom: number;
  arrowLeft: number;
}

function place(trigger: HTMLElement, width: number): Placement {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.min(
    Math.max(rect.left, VIEWPORT_MARGIN_PX),
    Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
  );
  // The box grows up from the trigger's top edge — the composer lives at the
  // bottom of the screen, so the room is above it, never below.
  const bottom = Math.min(
    viewportHeight - rect.top + TRIGGER_GAP_PX,
    viewportHeight - VIEWPORT_MARGIN_PX,
  );
  return { left, bottom, arrowLeft: rect.left + rect.width / 2 - left };
}

/**
 * The anchored sibling menu. It is the ds box (white, 1px ink border, radius
 * 4, the 2px offset ink shadow) and the ds `MenuArrow` (a 9px rotated square
 * centred on the trigger), mounted `position: fixed` into a `document.body`
 * portal so no `overflow: hidden` ancestor can clip it. Esc closes the menu
 * and stops the event, so the panel behind it stays open.
 */
export function ComposerMenu({
  triggerRef,
  open,
  onClose,
  width,
  ariaLabel,
  children,
  "data-testid": dataTestid,
}: ComposerMenuProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger) setPlacement(place(trigger, width));
  }, [triggerRef, width]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (boxRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose, triggerRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={boxRef}
      data-testid={dataTestid}
      role="dialog"
      aria-label={ariaLabel}
      className="fixed z-50 flex flex-col gap-[2px] rounded-[4px] border border-ink bg-surface p-2 shadow-raised"
      style={{
        left: placement?.left ?? VIEWPORT_MARGIN_PX,
        bottom: placement?.bottom ?? TRIGGER_GAP_PX,
        width,
        // Nothing to anchor to yet (a headless render): stay out of the way
        // rather than painting a box in a corner.
        visibility: placement ? "visible" : "hidden",
      }}
    >
      <MenuArrow side="top" style={{ left: placement?.arrowLeft ?? 0 }} />
      {children}
    </div>,
    document.body,
  );
}

export interface ContextButtonProps {
  /** What is on screen right now. */
  page: PageContext;
  /** The persisted per-tab choice (pageContext.ts). */
  on: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}

/**
 * The page-context button. On: the current-location glyph in accent ink on the
 * accent wash, because something IS attached; off: the slashed glyph in faint
 * on white. The menu it opens names the page, prints the route in mono, and
 * carries the "Send with my messages" checkbox.
 */
export function ContextButton({ page, on, onToggle, className = "" }: ContextButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  // Opening parks focus on the checkbox — the only control in the box.
  useLayoutEffect(() => {
    if (open) checkboxRef.current?.focus();
  }, [open]);

  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="assistant-context-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={on ? `Page context: ${page.label}` : "Page context off"}
        aria-label={on ? `Page context: ${page.label}` : "Page context off"}
        onClick={() => setOpen((next) => !next)}
        className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[4px] border focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring ${
          // The menu's pressed state is the INK border (prototype ctxBtnStyle:
          // border #1e1d1a while the ctx menu is open), over the on/off fill.
          open ? "border-ink" : "border-line"
        } ${on ? "bg-accent-wash text-accent-text" : "bg-surface text-faint"}`}
      >
        {on ? (
          <IconCurrentLocation size={14} stroke={2} aria-hidden className="shrink-0" />
        ) : (
          <IconCurrentLocationOff size={14} stroke={2} aria-hidden className="shrink-0" />
        )}
      </button>
      <ComposerMenu
        triggerRef={buttonRef}
        open={open}
        onClose={() => close(true)}
        width={COMPOSER_MENU_WIDTH_PX}
        ariaLabel="Page context"
        data-testid="assistant-context-menu"
      >
        <span className="px-[2px] py-[2px] font-mono text-[10px] tracking-[0.08em] text-muted">
          PAGE CONTEXT
        </span>
        <span className="flex items-center gap-[8px] rounded-[4px] bg-accent-wash px-2 py-[6px]">
          <IconCurrentLocation
            size={13}
            stroke={2}
            aria-hidden
            className="shrink-0 text-accent-text"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {page.label}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-faint">{page.route}</span>
        </span>
        <label className="flex cursor-pointer items-center gap-[8px] rounded-[4px] px-2 py-[6px] text-[12.5px] text-ink hover:bg-accent-wash">
          <input
            ref={checkboxRef}
            type="checkbox"
            data-testid="assistant-context-send"
            checked={on}
            onChange={(event) => onToggle(event.target.checked)}
            className="h-[14px] w-[14px] shrink-0 cursor-pointer accent-accent"
          />
          Send with my messages
        </label>
      </ComposerMenu>
    </span>
  );
}

export default ContextButton;
