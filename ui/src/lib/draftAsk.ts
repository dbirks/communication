/**
 * draftAsk — the one bridge from ⌘K (Quick chat) to the open workflow draft
 * (editor interactions 1d: "One entry point: ⌘K").
 *
 * The editor registers a handler while a draft it may change is open; Quick
 * chat reads it and, when the person chooses "Change this workflow", hands the
 * request to the editor instead of the chat. The editor then asks the
 * assistant for a proposal and shows it as ghost steps.
 */
import { useSyncExternalStore } from "react";

export type DraftAskHandler = (request: string) => void;

let handler: DraftAskHandler | null = null;
const listeners = new Set<() => void>();

export function setDraftAskHandler(next: DraftAskHandler | null): void {
  handler = next;
  for (const listener of listeners) listener();
}

/** The current handler (tests and non-React callers). */
export function getDraftAskHandler(): DraftAskHandler | null {
  return handler;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current handler, or null when no editor draft is open for changes. */
export function useDraftAskHandler(): DraftAskHandler | null {
  return useSyncExternalStore(
    subscribe,
    () => handler,
    () => null,
  );
}
