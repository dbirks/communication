/**
 * The chat details sheet (design 2e, rcn-chat-rail-390): below `lg` the
 * context rail is not a visible column, and the header's Details toggle
 * opens the SAME `ConversationSidePanel` content the page draws at `lg+`
 * (beside the thread) or below `lg` (stacked) — here as a right-side sheet.
 *
 * This draws the sheet chrome only — backdrop, panel, close — and the
 * caller hands it the content, so the page's one `sidePanel` element is
 * what renders at every width. The chrome keeps the shell's own mobile
 * drawer contract (see `components/Shell.tsx`): the sheet floats above the
 * page (`role="dialog"` — the emulator's overlap check treats everything
 * outside an open dialog as background), the backdrop closes it, Esc
 * closes it, focus moves into the sheet on open, and the caller's close
 * path returns it to the button that opened the sheet.
 */
import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

export interface ChatDetailsSheetProps {
  /** Whether the sheet stands over the page. */
  open: boolean;
  /** Close on any of the three ways (close button, backdrop, Esc). The
   * caller owns the state and the focus return to its toggle. */
  onClose: () => void;
  /** The panel's content — the caller's side panel, unchanged. */
  children: ReactNode;
}

export function ChatDetailsSheet({ open, onClose, children }: ChatDetailsSheetProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus moves INTO the sheet when it opens — the close button is its
  // first control, so it is where the keyboard lands.
  useLayoutEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  // Esc closes — the shell drawer's listener shape, but registered inside
  // a LAYOUT effect, not a passive one. A responsive
  // remount (the emulator's 1280→390 round-trip: `open` is gated on the
  // viewport, so the sheet's DOM is unmounted at `lg+` and remounts below
  // it) must be closable by the very next keypress, with focus wherever it
  // happens to be (body, a select inside the panel). A `useEffect`
  // listener attaches only after paint, so a key that lands in between is
  // swallowed; a layout effect runs synchronously in the mount commit,
  // so from the first painted frame the sheet is Esc-closable. The
  // window-level listener sees the keydown from ANY focused element —
  // real keydowns bubble focus-target → document → window — so the open
  // sheet closes on Escape regardless of where the keyboard sits.
  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" data-testid="chat-details-overlay">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="chat-details-backdrop"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
      />
      <section
        role="dialog"
        aria-labelledby="chat-details-sheet-heading"
        data-testid="chat-details-sheet"
        className="absolute inset-y-0 right-0 max-w-[22rem] w-[min(22rem,100vw)] overflow-y-auto border-l border-line-strong bg-surface shadow-(--shadow-raised)"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line-strong bg-surface px-3 py-2">
          <h2
            id="chat-details-sheet-heading"
            className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Thread details
          </h2>
          <button
            ref={closeRef}
            type="button"
            data-testid="chat-details-close"
            aria-label="Close thread details"
            onClick={onClose}
            className="inline-flex min-h-[24px] items-center gap-[4px] rounded-[3px] px-2 font-mono text-[11px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <IconX className="h-[13px] w-[13px]" aria-hidden="true" />
            Close
          </button>
        </div>
        <div className="min-w-0">{children}</div>
      </section>
    </div>
  );
}
