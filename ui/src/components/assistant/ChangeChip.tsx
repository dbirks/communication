import { useState } from "react";
import { changeKindGlyph, type AssistantChange } from "./types";

/**
 * The change chip (4d §3 "THE CHANGE LIST, AS A CHIP"; ADR-0050 Decision 5;
 * 2c decision: drop the "Changes in this conversation" side column and use
 * the chip instead).
 *
 * Collapsed: `N changes ▴ undo all`. Expanded: one row per change with a
 * kind glyph, the server-written summary, and `undo` where the row is
 * undoable — runs, approvals and navigations are logged but NOT undoable
 * ("Draft edits are reversible; runs and approvals are not (say so)"), so
 * their rows say so instead of offering a dead button. Presentational: the
 * undo calls and the server round-trip are the caller's job.
 */
export interface ChangeChipProps {
  changes: AssistantChange[];
  onUndo: (changeId: string) => void;
  onUndoAll: () => void;
  /** Start expanded (the expanded assistant view opens on the list). */
  defaultOpen?: boolean;
}

export function ChangeChip({ changes, onUndo, onUndoAll, defaultOpen = false }: ChangeChipProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (changes.length === 0) return null;

  const count = changes.length;
  const countText = `${count} change${count === 1 ? "" : "s"}`;

  return (
    <div
      data-testid="assistant-change-chip"
      style={{
        border: "1px solid var(--color-ink)",
        borderRadius: 4,
        background: "var(--color-surface)",
      }}
    >
      <div className="flex items-center gap-[8px] px-[8px] py-[4px] font-mono text-[10.5px] text-ink">
        <button
          type="button"
          data-testid="assistant-change-chip-toggle"
          aria-expanded={open}
          onClick={() => setOpen((next) => !next)}
          className="flex cursor-pointer items-center gap-[4px] border-none bg-transparent p-0 font-mono text-[10.5px] text-ink"
        >
          {countText}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
        <span aria-hidden="true" className="text-line-strong">
          ·
        </span>
        <button
          type="button"
          data-testid="assistant-change-undo-all"
          onClick={onUndoAll}
          className="cursor-pointer border-none bg-transparent p-0 font-mono text-[10.5px] text-ink"
        >
          undo all
        </button>
      </div>
      {open ? (
        <ul
          className="m-0 list-none p-0"
          data-testid="assistant-change-list"
          style={{ borderTop: "1px solid var(--color-line)" }}
        >
          {changes.map((change) => (
            <li
              key={change.id}
              data-testid="assistant-change-row"
              className="flex items-center gap-[6px] px-[8px] py-[4px] font-mono text-[10.5px] text-ink-2"
              style={{ borderTop: "1px solid var(--color-line-soft)" }}
            >
              <span aria-hidden="true" style={{ width: 10, flexShrink: 0 }}>
                {changeKindGlyph(change.kind)}
              </span>
              <span
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={change.summary || change.target_ref}
              >
                {change.summary || change.target_ref}
              </span>
              {change.undone_at ? (
                <span
                  data-testid="assistant-change-undone"
                  className="flex-shrink-0 text-[10px] text-faint"
                >
                  ✓ undone
                </span>
              ) : change.undoable ? (
                <button
                  type="button"
                  data-testid="assistant-change-undo"
                  aria-label={`undo: ${change.summary || change.target_ref}`}
                  onClick={() => onUndo(change.id)}
                  className="flex-shrink-0 cursor-pointer border-none bg-transparent p-0 font-mono text-[10.5px] text-accent-text"
                >
                  undo
                </button>
              ) : (
                <span
                  data-testid="assistant-change-not-undoable"
                  className="flex-shrink-0 text-[10px] text-faint"
                >
                  can't be undone
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default ChangeChip;
