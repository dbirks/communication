/**
 * The two-step take-control confirm card (artboard 5c).
 *
 * The dock's `Take control` button used to fire the takeover mutation on the
 * first click. A takeover is NOT "pause before the next step": it interrupts
 * the current attempt and pauses the run (ADR-0043, ADR-0016 §5), and on
 * hand-back the SAME step runs again as a new attempt. The card is the moment
 * the user sees exactly that before they commit — so the copy says it
 * verbatim and never "pauses before its next step".
 *
 * Accessible-modal contract (same as NewConversationDialog): labelled
 * `role="dialog"` + `aria-modal`, focus moves to the primary action on open,
 * Tab/Shift+Tab stay inside, Escape = `Just watch`, and the card closes when
 * either button is pressed (the parent unmounts it).
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { Button, VARIANT_CLASS } from "../ds/Button";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface TakeControlCardProps {
  /** The step this takeover would interrupt (the workbench shows the node
   * instance key; honest "the current step" when the surface has no name). */
  step: string;
  /** Commit the takeover (the mutation the first click would have fired). */
  onConfirm: () => void;
  /** `Just watch` — or Escape. */
  onCancel: () => void;
}

export function TakeControlCard({ step, onConfirm, onCancel }: TakeControlCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focus the primary action on open; return focus to the opener on close so
  // the keyboard user is never stranded on a removed node.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Take control of ${step}?`}
      data-testid="take-control-card"
      className="space-y-[8px] rounded-[3px] border border-line-strong bg-surface p-3 shadow-[0_8px_24px_rgba(30,29,26,0.18)]"
    >
      <p
        className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        data-testid="take-control-card-heading"
      >
        Take control of {step}?
      </p>
      <p className="text-[12.5px] text-ink-2">
        The current attempt of <code className="font-mono">{step}</code> stops and the run pauses.
        You talk to this agent directly; when you hand back,{" "}
        <code className="font-mono">{step}</code> runs again as a new attempt with whatever you
        changed.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* A raw button: the card needs to focus it on open, and the locked
            Button takes no ref. Same ds-btn classes — the lock is on style. */}
        <button
          ref={confirmRef}
          type="button"
          className={`ds-btn ${VARIANT_CLASS.primary}`}
          data-testid="take-control-confirm"
          onClick={onConfirm}
        >
          Take control
        </button>
        <Button variant="secondary" data-testid="take-control-cancel" onClick={onCancel}>
          Just watch
        </Button>
      </div>
    </div>
  );
}
