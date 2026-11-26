import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "../../lib/scrollLock";

/**
 * Redesign modal frame (docs/design/redesign/README.md + CONTRACT.md "Phone"):
 * radius 18, `--shadow-modal`, 1px line, Escape + optional backdrop dismiss,
 * focus management/trap, and a full-width bottom sheet below 768px.
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  onClose?: () => void;
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  ariaLabel?: string;
  /** Width utility classes for the modal surface, e.g. `w-[520px]`. */
  widthClassName?: string;
  /** Extra classes on the modal surface (padding, flex layout, etc.). */
  panelClassName?: string;
  backdropProps?: { "data-testid"?: string };
  testid?: string;
  closeOnBackdrop?: boolean;
  manageFocus?: boolean;
  trapFocus?: boolean;
  ignoreEsc?: boolean;
  children: ReactNode;
}

export function Sheet({
  onClose,
  role = "dialog",
  labelledBy,
  ariaLabel,
  widthClassName = "w-[520px]",
  panelClassName = "p-[24px] max-md:p-[16px]",
  backdropProps,
  testid,
  closeOnBackdrop = true,
  manageFocus = true,
  trapFocus = true,
  ignoreEsc = false,
  children,
}: SheetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useBodyScrollLock();

  useLayoutEffect(() => {
    if (!manageFocus) return;
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? containerRef.current)?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [manageFocus]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !ignoreEsc && onClose) {
        event.preventDefault();
        onClose();
        return;
      }
      if (!trapFocus || event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, ignoreEsc, trapFocus]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/25 p-4 max-md:items-end max-md:p-0"
      {...backdropProps}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={containerRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        data-testid={testid}
        className={`max-h-[calc(100dvh-2rem)] max-w-full overflow-y-auto rounded-[18px] border border-line bg-surface shadow-[var(--shadow-modal)] max-md:max-h-[85dvh] max-md:w-full max-md:max-w-none max-md:rounded-b-none ${widthClassName} ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
