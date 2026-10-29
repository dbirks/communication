/**
 * The page greeting shared by `/` (Home) and `/inbox` (Inbox). It used to
 * live in `pages/Inbox.tsx`, which dragged Inbox's whole route chunk into
 * Home's download; the helper is small and has no page dependencies, so it
 * lives here and both pages import it.
 */

/** "Good morning|afternoon|evening, <first name>" — the wall clock's, not the
 * server's (the wire carries no greeting). */
export function greeting(now: Date, displayName: string | undefined | null): string {
  const hour = now.getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = displayName?.trim().split(/\s+/)[0];
  return `Good ${part}, ${first || "there"}`;
}
