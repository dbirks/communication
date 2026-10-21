/**
 * The Steps page's accessible modal shell (the NewConversationDialog /
 * ImportYamlDialog pattern): `role="dialog"` + `aria-modal`, labelled by its
 * own title, focus trapped on the first focusable while open, Escape closes,
 * focus returns to the opener when it closes.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface StepDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional hint line under the title (what the action will do). */
  hint?: string;
  testid: string;
  /** CSS width for the panel, e.g. `"560px"`. */
  width?: string;
  children: ReactNode;
}

export function StepDialog({
  open,
  onClose,
  title,
  hint,
  testid,
  width = "560px",
  children,
}: StepDialogProps) {
  if (!open) return null;
  return (
    <StepDialogBody onClose={onClose} title={title} hint={hint} testid={testid} width={width}>
      {children}
    </StepDialogBody>
  );
}

function StepDialogBody({
  onClose,
  title,
  hint,
  testid,
  width,
  children,
}: {
  onClose: () => void;
  title: string;
  hint?: string;
  testid: string;
  width: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    const first = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
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
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const titleId = `${testid}-title`;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: "100%", width, boxSizing: "border-box" }}
        className="rounded-[4px] border border-line bg-surface shadow-(--shadow-raised)"
        data-testid={testid}
      >
        <div className="border-b border-line px-[14px] py-[10px]">
          <h2 id={titleId} className="text-[13px] font-bold">
            {title}
          </h2>
          {hint ? (
            <p className="mt-[3px] text-[11.5px] text-muted" data-testid={`${testid}-hint`}>
              {hint}
            </p>
          ) : null}
        </div>
        <div className="px-[14px] py-[12px]">{children}</div>
      </div>
    </div>
  );
}
