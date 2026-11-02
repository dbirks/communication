/**
 * ASSISTANT NOTICED (design 3a, final decision): a small panel at the TOP of
 * the repo page's side panel. The bar is the accent wash with an accent edge
 * down the panel's left side — the design's "more prominent than the plain
 * section the mock draws", and the only thing here that says "the assistant
 * spoke". Up to three one-sentence notes, each with ONE action link and a
 * `dismiss`.
 *
 * The notes are model-written, per user (ADR-0071). This component renders
 * ONLY what the caller hands it — with no notes it renders nothing at all (no
 * placeholder, no hard-coded rule): there are no rules here to fall back to,
 * by the design's own refusal of them.
 */
export interface AssistantNote {
  /** Stable id — the dismiss/action keys on it. */
  id: string;
  /** One sentence, in the assistant's own words. */
  text: string;
  /** The one action this note offers; omit for a note with nothing to do. */
  action?: { label: string; onSelect: () => void };
}

export interface AssistantNotesProps {
  /** The notes as served — the panel shows at most three, in order. */
  notes: readonly AssistantNote[];
  /** Hide one note for this user. Omit only when dismissal is impossible. */
  onDismiss?: (note: AssistantNote) => void;
}

/** The notes the design draws per page: three, never more. */
const MAX_NOTES = 3;

export function AssistantNotes({ notes, onDismiss }: AssistantNotesProps) {
  if (notes.length === 0) return null;
  const shown = notes.slice(0, MAX_NOTES);
  return (
    <section
      aria-labelledby="repo-assistant-notes-heading"
      className="overflow-hidden rounded-[3px] border border-accent-ring border-l-2 border-l-accent bg-surface shadow-(--shadow-raised)"
      data-testid="repo-assistant-notes"
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-accent-ring bg-accent-wash px-[10px] py-[6px] font-mono text-[10.5px] font-bold tracking-[.06em] text-accent-edge">
        <h2 id="repo-assistant-notes-heading">ASSISTANT NOTICED</h2>
        {/* The count is what the store capped, not what this drew: three is the
            most one person is ever shown about one thing. */}
        <span data-testid="repo-assistant-notes-count" className="font-semibold text-accent-text">
          {shown.length}
        </span>
      </div>
      <ul>
        {shown.map((note) => (
          <li
            key={note.id}
            className="space-y-[6px] border-t border-line-soft px-3 py-[11px] first:border-t-0"
            data-testid={`repo-assistant-note-${note.id}`}
          >
            <p className="text-[13px] leading-[18px] text-ink">{note.text}</p>
            <p className="flex items-center gap-3">
              {note.action ? (
                <button
                  type="button"
                  onClick={note.action.onSelect}
                  className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`repo-assistant-note-${note.id}-action`}
                >
                  {note.action.label}
                </button>
              ) : null}
              {onDismiss ? (
                <button
                  type="button"
                  onClick={() => onDismiss(note)}
                  className="font-mono text-[10.5px] text-muted hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  data-testid={`repo-assistant-note-${note.id}-dismiss`}
                >
                  dismiss
                </button>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
