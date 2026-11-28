/**
 * GestureHint.tsx — one-line gesture hint on the canvas (editor interactions 1b).
 *
 * A small floating note in the top-left of the canvas listing the primary
 * gestures: drag empty space to select, space + drag to pan, drag a node port
 * to connect, or press N to drop a note (or the touch equivalents). It is
 * dismissible: closing it persists a flag in localStorage so the hint stays
 * gone across sessions.
 */

import { IconX } from "@tabler/icons-react";
import type { JSX } from "react";

export const GESTURE_HINT_KEY = "communication.editor.gestureHintDismissed";

/** True when the user has dismissed the hint (false on any storage error). */
export function gestureHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(GESTURE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the dismissal; storage failures are ignored. */
export function dismissGestureHint(): void {
  try {
    window.localStorage.setItem(GESTURE_HINT_KEY, "1");
  } catch {
    /* storage unavailable — nothing to persist */
  }
}

interface GestureHintProps {
  touch?: boolean;
  onDismiss(): void;
}

/** A bold key/gesture followed by its action; separators are " · ". */
function Gesture({ keys, action }: { keys: string; action: string }) {
  return (
    <>
      <span className="font-semibold text-ink">{keys}</span> <span>{action}</span>
    </>
  );
}

export function GestureHint({ touch = false, onDismiss }: GestureHintProps): JSX.Element {
  return (
    <div
      data-testid="gesture-hint"
      role="note"
      className="absolute left-[16px] top-[16px] z-20 flex items-center gap-[8px] rounded-[8px] border border-line bg-surface px-[8px] py-[4px] font-mono text-[10.5px] text-muted"
    >
      {touch ? (
        <span className="flex items-center gap-[8px]">
          <Gesture keys="long-press" action="select" />
          <span aria-hidden>·</span>
          <Gesture keys="drag" action="move" />
          <span aria-hidden>·</span>
          <Gesture keys="tap a step" action="open" />
        </span>
      ) : (
        <span className="flex items-center gap-[8px]">
          <Gesture keys="drag empty space" action="select" />
          <span aria-hidden>·</span>
          <Gesture keys="space + drag" action="move" />
          <span aria-hidden>·</span>
          <Gesture keys="drag a dot" action="connect" />
          <span aria-hidden>·</span>
          <Gesture keys="N" action="note" />
        </span>
      )}
      <button
        type="button"
        aria-label="Dismiss hint"
        data-testid="gesture-hint-close"
        onClick={() => {
          dismissGestureHint();
          onDismiss();
        }}
        className="inline-flex items-center justify-center text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] max-md:min-w-[44px]"
      >
        <IconX size={12} aria-hidden />
      </button>
    </div>
  );
}
