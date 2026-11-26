/**
 * Hold ⌘K (Ctrl+K off-Mac) to talk (redesign R6).
 *
 * - keydown of K with Meta (or Ctrl), not repeated: starts a 500ms timer.
 * - keyup of K or the modifier before 500ms: normal tap → opens the palette.
 * - 500ms timer fires while still held: does NOT open the palette; opens Quick
 *   chat and starts dictation.
 * - Release (keyup of K or modifier) after hold started: stops dictation and
 *   sends the transcript.
 * - Auto-repeat keydowns are ignored.
 * - Window `blur` while pending or holding cancels without sending.
 * - Plain "k" without the modifier never fires (including inside text fields).
 * - If speech is unavailable, falls back immediately to `onTap()` on keydown.
 */
import { useEffect, useRef } from "react";

export const HOLD_TO_TALK_MS = 500;

export interface UseHoldToTalkOptions {
  /** Whether speech input is available (server speech or enabled browser fallback). */
  speechAvailable: boolean;
  /** Called on a short tap (< 500ms) or immediately when speech is unavailable. */
  onTap: () => void;
  /** Called once the key has been held for 500ms. */
  onHoldStart: () => void;
  /** Called when K or the modifier is released after `onHoldStart`. */
  onHoldEnd: () => void;
  /** Called when the window blurs while holding. */
  onHoldCancel: () => void;
}

type HoldPhase =
  | { kind: "idle" }
  | { kind: "pending"; modifier: "meta" | "ctrl"; timerId: number }
  | { kind: "holding"; modifier: "meta" | "ctrl" };

function isReleaseKey(event: KeyboardEvent, modifier: "meta" | "ctrl"): boolean {
  if (event.key.toLowerCase() === "k") return true;
  if (modifier === "meta" && event.key === "Meta") return true;
  if (modifier === "ctrl" && event.key === "Control") return true;
  return false;
}

export function useHoldToTalk({
  speechAvailable,
  onTap,
  onHoldStart,
  onHoldEnd,
  onHoldCancel,
}: UseHoldToTalkOptions): void {
  const callbacksRef = useRef({ onTap, onHoldStart, onHoldEnd, onHoldCancel });
  callbacksRef.current = { onTap, onHoldStart, onHoldEnd, onHoldCancel };
  const speechAvailableRef = useRef(speechAvailable);
  speechAvailableRef.current = speechAvailable;

  useEffect(() => {
    let state: HoldPhase = { kind: "idle" };

    const clearPendingTimer = () => {
      if (state.kind === "pending") {
        window.clearTimeout(state.timerId);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      event.preventDefault();

      if (!speechAvailableRef.current) {
        callbacksRef.current.onTap();
        return;
      }

      if (state.kind !== "idle") return;

      const modifier: "meta" | "ctrl" = event.metaKey ? "meta" : "ctrl";
      const timerId = window.setTimeout(() => {
        if (state.kind !== "pending") return;
        state = { kind: "holding", modifier };
        callbacksRef.current.onHoldStart();
      }, HOLD_TO_TALK_MS);
      state = { kind: "pending", modifier, timerId };
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (state.kind === "idle") return;
      if (!isReleaseKey(event, state.modifier)) return;

      if (state.kind === "pending") {
        clearPendingTimer();
        state = { kind: "idle" };
        callbacksRef.current.onTap();
        return;
      }

      state = { kind: "idle" };
      callbacksRef.current.onHoldEnd();
    };

    const onBlur = () => {
      if (state.kind === "idle") return;
      if (state.kind === "pending") {
        clearPendingTimer();
        state = { kind: "idle" };
        return;
      }
      state = { kind: "idle" };
      callbacksRef.current.onHoldCancel();
    };

    // Capture phase so order-invariant with page handlers (e.g. Studio).
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearPendingTimer();
      state = { kind: "idle" };
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
