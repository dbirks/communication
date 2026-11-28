/**
 * RunFormDialog — the modal chrome of the run-by-hand screen (design 1k).
 *
 * 520–540px wide, ink border, the `2px 2px 0` raised shadow, a mono `esc`
 * hint at the top right, and a footer band with the helper line, `Cancel`
 * (ghost) and `Start run` (primary). The form inside is NewRunForm's — this
 * shell owns only the dialog chrome and the Esc key (which asks the owner to
 * cancel; it never unmounts anything itself).
 *
 * The shell also owns the page's scroll: while the form is up the document is
 * locked (`lib/scrollLock`), because a page that still scrolls behind a
 * `fixed inset-0` dim leaves whatever sits below the fold painting bright and
 * undimmed — which is exactly how round-20's `rcn-1k-run-form-390` read.
 */
import type { ReactNode } from "react";
import { Sheet } from "../../ds/Sheet";

export interface RunFormDialogProps {
  title: string;
  /** The mono subtitle line — `<repo> · pinned r<N>` in the design. */
  subtitle: ReactNode;
  /** The footer's left helper line; muted copy, never a promise. */
  helper: ReactNode;
  onCancel?: () => void;
  /** The footer's primary action. */
  submit: ReactNode;
  children: ReactNode;
}

export function RunFormDialog({
  title,
  subtitle,
  helper,
  onCancel,
  submit,
  children,
}: RunFormDialogProps) {
  return (
    <Sheet
      onClose={onCancel}
      labelledBy="run-form-heading"
      backdropProps={{ "data-testid": "run-form-dialog" }}
      widthClassName="w-[530px]"
      panelClassName="p-0"
      manageFocus={false}
      trapFocus={false}
    >
      <header className="flex items-start gap-[10px] border-b border-line px-[20px] pt-[16px] pb-[12px] max-md:px-[16px]">
        <div className="min-w-0 flex-1">
          <h2
            id="run-form-heading"
            className="truncate text-[16px] font-bold text-ink"
            data-testid="run-form-title"
          >
            {title}
          </h2>
          <p
            className="mt-[2px] truncate font-mono text-[11px] text-muted"
            data-testid="run-form-subtitle"
          >
            {subtitle}
          </p>
        </div>
        <span aria-hidden="true" className="shrink-0 font-mono text-[10px] text-faint">
          esc
        </span>
      </header>
      <div className="px-[20px] py-[16px] max-md:px-[16px]">{children}</div>
      <footer className="flex flex-wrap items-center gap-[10px] border-t border-line px-[20px] py-[12px] max-md:px-[16px]">
        <p className="min-w-0 flex-1 text-[12px] text-muted" data-testid="run-form-helper">
          {helper}
        </p>
        <div className="flex shrink-0 items-center gap-[8px]">
          {onCancel ? (
            <button
              className="ds-btn ds-btn--ghost"
              type="button"
              onClick={onCancel}
              data-testid="new-run-cancel"
            >
              Cancel
            </button>
          ) : null}
          {submit}
        </div>
      </footer>
    </Sheet>
  );
}
