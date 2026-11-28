/**
 * BesideCard — the single anchored card pattern for whatever is selected on
 * the studio canvas (editor-interactions README "1a"). Owns the frame
 * (size, border, shadow, header, caret, Escape/× close) and the pure
 * placement rule that keeps it beside the selection box; each selection kind
 * (agent step, wrap panel, note, insert menu) supplies its own body.
 */
import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

/** Which edge of the card the caret points out of. */
export type BesideSide = "right" | "left" | "below";

export interface BesidePlacement {
  side: BesideSide;
  left: number;
  top: number;
  /** Caret offset from the card's top edge (right/left) or left edge (below), px. */
  caret: number;
}

const EDGE = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Place the beside card next to a selection box (all values in pane px).
 * Tries right, flips left when the right overflows, falls back to below when
 * neither side fits. The caret stays centred on the selection and is clamped
 * away from the card's corners.
 */
export function placeBesideCard(
  target: { x: number; y: number; width: number; height: number },
  card: { w: number; h: number },
  pane: { w: number; h: number },
  gap = 18,
  /** Smallest top for a right/left card: keeps it clear of the editor's
   * toolbar (status group, Try it, Make live) along the pane's top edge. */
  topInset = EDGE,
): BesidePlacement {
  const centerY = target.y + target.height / 2;
  const centerX = target.x + target.width / 2;

  // Unmeasured pane (first paint): keep the card at the raw right position.
  if (pane.w === 0 || pane.h === 0) {
    const top = centerY - card.h / 2;
    return {
      side: "right",
      left: target.x + target.width + gap,
      top,
      caret: clamp(centerY - top, 16, card.h - 16),
    };
  }

  const vertical = (top: number) => clamp(centerY - top, 16, card.h - 16);

  const rightLeft = target.x + target.width + gap;
  if (rightLeft + card.w <= pane.w - EDGE) {
    const top = clamp(centerY - card.h / 2, topInset, Math.max(topInset, pane.h - card.h - EDGE));
    return { side: "right", left: rightLeft, top, caret: vertical(top) };
  }

  const leftLeft = target.x - gap - card.w;
  if (leftLeft >= EDGE) {
    const top = clamp(centerY - card.h / 2, topInset, Math.max(topInset, pane.h - card.h - EDGE));
    return { side: "left", left: leftLeft, top, caret: vertical(top) };
  }

  const left = clamp(centerX - card.w / 2, EDGE, pane.w - card.w - EDGE);
  const top = target.y + target.height + gap;
  return { side: "below", left, top, caret: clamp(centerX - left, 16, card.w - 16) };
}

export interface BesideCardProps {
  /** Header text, e.g. "AGENT STEP", "WRAP 2 STEPS IN", "NOTE", "INSERT STEP". */
  title: string;
  /** Optional 11.5px muted text after the title (used by INSERT STEP). */
  subtitle?: string;
  /** When set the × button is shown and Escape closes the card. */
  onClose?: () => void;
  /** Caret side; omit for no caret. */
  side?: BesideSide;
  /** Caret offset in px, see `placeBesideCard`. */
  caret?: number;
  /** Card width in px (default 340; INSERT STEP uses 260). */
  width?: number;
  /** Phone bottom sheet: full width, rounded top only, no caret. */
  sheet?: boolean;
  /** data-testid on the card root (default "beside-card"). */
  testid?: string;
  /** data-testid on the × button (default "beside-card-close"). */
  closeTestid?: string;
  /** Extra classes on the card root. */
  className?: string;
  children: ReactNode;
}

const CARET_SIDE_CLASS: Record<BesideSide, string> = {
  right: "left-[-7px] border-b border-l",
  left: "right-[-7px] border-t border-r",
  below: "top-[-7px] border-t border-l",
};

export function BesideCard({
  title,
  subtitle,
  onClose,
  side,
  caret,
  width = 340,
  sheet = false,
  testid = "beside-card",
  closeTestid = "beside-card-close",
  className = "",
  children,
}: BesideCardProps) {
  const showCaret = !sheet && side !== undefined;
  const caretOffset = Math.max(-7, (caret ?? 0) - 6);

  return (
    <div
      role="dialog"
      aria-label={title}
      data-testid={testid}
      data-beside-card=""
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) {
          event.stopPropagation();
          onClose();
        }
      }}
      style={sheet ? undefined : { width: `${width}px` }}
      className={`relative flex flex-col gap-[12px] bg-surface pt-[12px] px-[14px] pb-[14px] ${
        sheet
          ? "w-full rounded-t-[14px] rounded-b-none border border-fill-edge shadow-none"
          : "rounded-[12px] border border-fill-edge shadow-[var(--shadow-pop)]"
      } ${className}`}
    >
      {showCaret ? (
        <span
          aria-hidden
          data-testid="beside-card-caret"
          style={side === "below" ? { left: `${caretOffset}px` } : { top: `${caretOffset}px` }}
          className={`absolute h-[12px] w-[12px] rotate-45 border-fill-edge bg-surface ${CARET_SIDE_CLASS[side!]}`}
        />
      ) : null}

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
          {title}
        </span>
        {subtitle ? <span className="text-[11.5px] text-muted">{subtitle}</span> : null}
        {onClose ? (
          <button
            type="button"
            aria-label="Close"
            data-testid={closeTestid}
            onClick={onClose}
            className="icon-hit ml-auto inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:min-w-[44px]"
          >
            <IconX size={15} stroke={1.5} aria-hidden />
          </button>
        ) : null}
      </div>

      {children}
    </div>
  );
}
