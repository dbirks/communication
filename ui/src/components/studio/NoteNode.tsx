/**
 * NoteNode.tsx — the sticky note of the tool island's “Note N” row
 * (README “Tool island”: Select V, Move around H, Box select B, Connect C,
 * **Note N**; review-1 09-1280-1 — the design review's one remaining blocker).
 *
 * A note is authoring surface, not graph: it lives in `ui_layout.notes` beside
 * the node positions, is never a definition node, never reaches the semantic
 * document, and has NO connection handles — a sticky note cannot be wired into
 * a run. It drags (grid-snapped, like a step), edits in place, and deletes; a
 * read-only canvas (a published revision, a run on the graph) shows the same
 * box with nothing to click.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { type Node, type NodeProps } from "@xyflow/react";
import { NOTE_MIN_HEIGHT, type CanvasNote } from "./flowModel";

export type NoteNodeRender = {
  note: CanvasNote;
  readOnly: boolean;
  selected: boolean;
  editing: boolean;
  /** Single click: this note becomes the canvas's note selection. */
  onSelect: () => void;
  /** Double-click / Enter: start editing in place. */
  onEdit: () => void;
  /** Blur / Esc: commit the draft text (an emptied note is removed). */
  onSave: (text: string) => void;
};

/** `#fdf6e4` paper, `#e8cf94` edge, selected `#2f4bd6` — the design's amber
 * sticky, taken off the waiting-status token pair the identity table already
 * owns (no hex literal in a class, so `check:tokens` keeps its teeth). The card
 * IS the drag handle, so it carries no `nodrag`; the textarea does. */
const cardClass = (selected: boolean): string =>
  `block w-full rounded-[10px] border px-[10px] py-[8px] text-left text-[13px] leading-[18px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-accent ${
    selected ? "border-accent" : "border-st-waiting-pale-edge"
  } bg-st-waiting-pale-body`;

export function NoteNode(props: NodeProps<Node<NoteNodeRender>>): ReactElement {
  const { data } = props;
  const { note, readOnly, selected, editing } = data;
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // An uncontrolled textarea: it opens holding the note's saved text and the
  // canvas hears about it only on blur / Esc, so typing never re-renders the
  // graph. A freshly dropped note takes the keyboard straight away — but the
  // frame it mounts in is not the frame it can be focused in: React Flow paints
  // an unmeasured node `visibility: hidden`, and a hidden element refuses
  // focus. So the attempt repeats until the node is visible (or the note stops
  // being the editor), which is the click→type gesture the tool promises.
  useEffect(() => {
    const el = areaRef.current;
    if (!editing || !el) return;
    growNote(el, el.value);
    let stop = false;
    let handle = 0;
    let tries = 0;
    const attempt = () => {
      if (stop) return;
      tries += 1;
      el.focus();
      if (document.activeElement === el) {
        el.setSelectionRange(el.value.length, el.value.length);
        return;
      }
      if (tries < 30) handle = requestAnimationFrame(attempt);
    };
    handle = requestAnimationFrame(attempt);
    return () => {
      stop = true;
      cancelAnimationFrame(handle);
    };
  }, [editing, note.id]);

  const takeText = useCallback(() => {
    const el = areaRef.current;
    if (el) data.onSave(el.value);
  }, [data]);

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (readOnly || editing) return;
    if (event.key === "Enter" || event.key === " ") {
      // Enter while selected edits in place (the other half of double-click).
      event.preventDefault();
      data.onEdit();
    }
  };

  const trimmed = note.text.trim();
  return (
    <div
      data-testid={`canvas-note-${note.id}`}
      data-note-id={note.id}
      data-selected={selected || undefined}
      className={cardClass(selected)}
      style={{ width: note.width, minHeight: NOTE_MIN_HEIGHT }}
      // A note answers only for itself: the click never reaches React Flow's
      // node/pane selection, which is a mechanism for steps.
      onClick={(event) => {
        event.stopPropagation();
        if (!editing && !readOnly) data.onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!readOnly) data.onEdit();
      }}
      onKeyDown={onKey}
      role={readOnly ? "note" : "button"}
      tabIndex={readOnly ? -1 : 0}
      aria-label={
        trimmed.length > 0
          ? `Note: ${trimmed}`
          : `Empty note${readOnly ? "" : " (press Enter to type)"}`
      }
    >
      {/* No <Handle> at all: a note has no connection points, so nothing can be
          wired to or from it (README: notes are not steps). */}
      {editing ? (
        <textarea
          ref={areaRef}
          data-testid={`canvas-note-input-${note.id}`}
          className="nodrag min-h-[40px] w-full resize-none border-none bg-transparent p-0 font-[inherit] text-[13px] leading-[18px] text-ink outline-none"
          defaultValue={note.text}
          rows={1}
          aria-label="Note text"
          // A pointerdown here must not start a node drag or reach the canvas.
          onPointerDown={(event) => event.stopPropagation()}
          onInput={(event) => growNote(event.currentTarget, event.currentTarget.value)}
          // Blur saves; an emptied note is removed by the canvas.
          onBlur={takeText}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Enter writes a newline; Esc leaves the editor — and saves. It must
            // not also reach the canvas's Esc (which clears the selection), so
            // the commit happens here rather than by waiting for the blur
            // (which a detached-in-test editor may never fire).
            event.stopPropagation();
            event.preventDefault();
            const el = event.currentTarget;
            el.blur();
            data.onSave(el.value);
          }}
        />
      ) : (
        <span className="block whitespace-pre-wrap break-words">{note.text}</span>
      )}
    </div>
  );
}

/** The note is as tall as its text: there is no resize handle to trust. */
function growNote(el: HTMLTextAreaElement, value: string): void {
  el.style.height = "auto";
  const lines = Math.max(1, value.split("\n").length);
  el.style.height = `${Math.max(40, lines * 18 + (value.endsWith("\n") ? 18 : 0))}px`;
}
