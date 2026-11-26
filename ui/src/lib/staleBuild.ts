/**
 * A deploy replaces every hashed chunk. A tab that was open across the deploy
 * still holds the OLD index and asks for chunk names that no longer exist, so
 * the first lazy route it opens fails with "error loading dynamically imported
 * module". Vite reports that as a `vite:preloadError` event on `window`.
 *
 * The honest recovery is to load the new build: reload once. The guard keeps a
 * genuinely missing chunk (a bad deploy, a blocked network) from becoming a
 * reload loop — within the window the second failure is left to the route's
 * own error boundary, which says what failed.
 */
const RELOADED_AT_KEY = "communication.stale-build-reload";
export const STALE_RELOAD_WINDOW_MS = 30_000;

/** True when this failure should be answered with a reload (and records it). */
export function shouldReloadForStaleBuild(
  storage: Pick<Storage, "getItem" | "setItem">,
  now: number,
): boolean {
  let last = 0;
  try {
    last = Number(storage.getItem(RELOADED_AT_KEY) ?? 0);
  } catch {
    return false; // no storage, no loop guard: leave it to the error boundary
  }
  if (Number.isFinite(last) && now - last < STALE_RELOAD_WINDOW_MS) return false;
  try {
    storage.setItem(RELOADED_AT_KEY, String(now));
  } catch {
    return false;
  }
  return true;
}

/** Install the listener once, at startup. */
export function installStaleBuildReload(target: Window = window): void {
  target.addEventListener("vite:preloadError", (event) => {
    if (!shouldReloadForStaleBuild(target.sessionStorage, Date.now())) return;
    // The reload replaces the failed import; without this the error would
    // also reach the route's boundary for one frame.
    event.preventDefault();
    target.location.reload();
  });
}
