/**
 * The ASSISTANT note slot (design 2e's quiet rail line, 1h's suggestion
 * card). It renders a note the assistant actually produced — the component
 * never generates one, so a page with no assistant-note source renders
 * nothing. Acting on a note (2f's "Make a workflow…") and dismissal are the
 * caller's: this only draws the text and the buttons it was handed.
 */
import type { ReactNode } from "react";

export interface AssistantNoteAction {
  /** Stable id — also the action button's testid suffix, and the value of
   * the button's `data-action-kind` marker (the 2e rail reads that marker
   * to tell whether one of its notes already offers an action before it
   * draws a standing one underneath). */
  id: string;
  label: string;
  onSelect: () => void;
  /** Rendered inline before the label (the design prints no glyph; omit
   * rather than invent one). */
  icon?: never;
  /** Extra classes for the button (the 2f card's primary variant). */
  className?: string;
}

export interface AssistantNoteProps {
  /** The note's own words, from a real assistant source. */
  text: ReactNode;
  /** What the note offers, already wired by the caller. */
  actions?: AssistantNoteAction[];
  /** Present a dismiss affordance only when dismissing is real behaviour. */
  onDismiss?: () => void;
  /** Distinguishes stacked notes (`dismiss` is per note, per user). */
  testId?: string;
}

/**
 * The action kind the assistant-notes backend names for design 2f
 * (`make_workflow`; the notes store's action shape, ADR-0071 pending).
 * Kept as one constant so the note, the side panel and the notes client
 * agree on the id while that ADR lands.
 */
export const MAKE_WORKFLOW_ACTION_ID = "make_workflow";

/**
 * The `Make a workflow…` action of a thread → workflow note (design 2f).
 * Plain button until ADR-0071 fixes the notes action payload — the id is
 * the part that will already match the notes backend.
 */
export function makeWorkflowNoteAction(onSelect: () => void): AssistantNoteAction {
  return { id: MAKE_WORKFLOW_ACTION_ID, label: "Make a workflow…", onSelect };
}

export function AssistantNote({
  text,
  actions = [],
  onDismiss,
  testId = "assistant-note",
}: AssistantNoteProps) {
  return (
    <div data-testid={testId} className="min-w-0 space-y-[6px]">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
        Assistant
      </p>
      <p className="text-[12.5px] leading-[1.5] text-ink">{text}</p>
      {actions.length > 0 || onDismiss ? (
        <span className="flex flex-wrap items-center gap-3">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              data-testid={`${testId}-action-${action.id}`}
              data-action-kind={action.id}
              onClick={action.onSelect}
              className={`font-mono text-[11.5px] text-accent-text hover:text-ink ${action.className ?? ""}`}
            >
              {action.label}
            </button>
          ))}
          {onDismiss ? (
            <button
              type="button"
              data-testid={`${testId}-dismiss`}
              onClick={onDismiss}
              className="font-mono text-[11.5px] text-muted hover:text-ink"
            >
              dismiss
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
