/**
 * The unsaved-changes guard behind the draft editor's "unsaved changes" chip.
 *
 * Why this is hand-rolled: react-router's `useBlocker` only exists on a *data*
 * router, and this app is declarative (`main.tsx` mounts `BrowserRouter`,
 * `App.tsx` renders `<Routes>`), so `useBlocker` throws
 * `useBlocker must be used within a data router` the moment it mounts. Moving
 * the router is a topology decision bigger than one page, so the guard is the
 * two mechanisms a declarative router does offer:
 *
 * - `beforeunload` covers what the browser owns — reload, close, typing a new
 *   address. The browser shows its own prompt; no app text is involved.
 * - a capture-phase `click` listener covers in-app `<Link>`s: the click is
 *   stopped before react-router ever sees it, the editor asks in its own words,
 *   and only a confirmed answer calls `navigate`.
 *
 * What it cannot do without a data router: stop `popstate` (back/forward) or a
 * `navigate()` fired by something outside the DOM (the command palette). Those
 * leave with the edit, and the editor says so rather than pretending otherwise.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

/** The slice of the location the guard compares a link against. */
export interface CurrentPath {
  pathname: string;
  search: string;
}

/**
 * The in-app target a click asked to navigate to, or null when the guard must
 * let the click alone. Left-click on the same page, a modified click (new tab),
 * a download, and a cross-origin link are all excluded: the last one is a real
 * navigation, which `beforeunload` already covers with the browser's own prompt.
 */
export function exitTargetOf(event: MouseEvent, here: CurrentPath): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target !== "" && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface UnsavedGuard {
  /** The href a click was stopped for, or null when nothing is pending. */
  pending: string | null;
  /** Leave for real. The caller must drop its unsaved state first. */
  proceed: () => void;
  /** Stay, and keep the text. */
  cancel: () => void;
}

/**
 * Block in-app navigation and browser unloads while `active`. Mounting this is
 * only honest while the editor also *shows* that it is unsaved.
 */
export function useUnsavedGuard(active: boolean): UnsavedGuard {
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  const hold = useCallback((to: string | null) => {
    pendingRef.current = to;
    setPending(to);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      const to = exitTargetOf(event, window.location);
      if (to === null) return;
      // Capture, so react-router's own link handler never runs.
      event.preventDefault();
      event.stopPropagation();
      hold(to);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines still look at `returnValue` rather than `preventDefault`.
      event.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active, hold]);

  const proceed = useCallback(() => {
    const to = pendingRef.current;
    hold(null);
    if (to !== null) navigate(to);
  }, [hold, navigate]);

  return { pending, proceed, cancel: useCallback(() => hold(null), [hold]) };
}
