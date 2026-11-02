/**
 * RunFormDialog — the modal chrome of the run-by-hand screen (design 1k).
 *
 * 520–540px wide, ink border, the `2px 2px 0` raised shadow, a mono `esc`
 * hint at the top right, and a footer band with the helper line, `Cancel`
 * (ghost) and `Start run` (primary). The form inside is NewRunForm's — this
 * shell owns only the dialog chrome and the Esc key (which asks the owner to
 * cancel; it never unmounts anything itself).
 */
import { useEffect, useRef, type ReactNode } from "react";

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
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/35 px-[12px] py-[7dvh]"
      data-testid="run-form-dialog"
      onMouseDown={(event) => {
        // Backdrop click cancels — the box and everything in it stops here.
        if (event.target === event.currentTarget) onCancel?.();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-form-heading"
        tabIndex={-1}
        className="w-[530px] max-w-full overflow-hidden rounded-[4px] border border-ink bg-surface [box-shadow:2px_2px_0_var(--color-ink)]"
      >
        <header className="flex items-start gap-[10px] border-b border-line px-[16px] pt-[12px] pb-[10px]">
          <div className="min-w-0 flex-1">
            <h2
              id="run-form-heading"
              className="truncate text-[15px] font-semibold text-ink"
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
        <div className="px-[16px] py-[14px]">{children}</div>
        <footer className="flex flex-wrap items-center gap-[10px] border-t border-line px-[16px] py-[10px]">
          <p className="min-w-0 flex-1 text-[12px] text-muted" data-testid="run-form-helper">
            {helper}
          </p>
          <div className="flex shrink-0 items-center gap-[8px]">
            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                className="rounded-[3px] px-[10px] py-[5px] text-[12.5px] font-semibold text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                data-testid="new-run-cancel"
              >
                Cancel
              </button>
            ) : null}
            {submit}
          </div>
        </footer>
      </div>
    </div>
  );
}
