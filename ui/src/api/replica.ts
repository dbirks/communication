import { useSyncExternalStore } from "react";

/**
 * Tiny external store for the last `X-Communication-Replica` response header
 * seen by the client. The M1 acceptance check is "the same state is visible
 * behind two replicas", so the UI surfaces which replica answered last.
 */
const UNKNOWN = "unknown";

let current = UNKNOWN;
const listeners = new Set<() => void>();

/** Record the replica name from a response header (null/empty ignored). */
export function setReplicaName(name: string | null): void {
  if (!name || name === current) return;
  current = name;
  for (const listener of listeners) listener();
}

/** Test helper: forget the last seen replica. */
export function resetReplicaName(): void {
  if (current === UNKNOWN) return;
  current = UNKNOWN;
  for (const listener of listeners) listener();
}

export function getReplicaName(): string {
  return current;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): string {
  return current;
}

/** Subscribe a component to the last seen replica name. */
export function useReplicaName(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
