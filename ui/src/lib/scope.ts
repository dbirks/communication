/**
 * Scope — which project the rail has selected (handoff README §1 "Scope
 * rules"). The scope lives in the URL as the `/p/:projectId` prefix; "All
 * projects" is the absence of the prefix. Manage is global.
 *
 * Pages that are not scoped by their own URL (`/runs/:id`, `/approvals/:id`,
 * `/manage/...`) remember the last scope so the rail keeps its selection and
 * the pill's links go back where the person was.
 */
import { useEffect } from "react";
import { useLocation } from "react-router";
import type { Section } from "./routes";

const LAST_SCOPE_KEY = "communication.scope";

/** `/p/<id>/...` → `<id>`; anything else → null. */
export function scopeFromPath(pathname: string): string | null {
  const match = /^\/p\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Does this path carry its own scope (true), or is it a global page that
 * should keep showing the remembered one (false)? Home, Chats and Factory
 * are scoped by URL; `/` , `/chats`, `/factory` mean All. */
export function pathDecidesScope(pathname: string): boolean {
  if (pathname.startsWith("/p/")) return true;
  return (
    pathname === "/" ||
    pathname === "/chats" ||
    pathname.startsWith("/chats/") ||
    pathname === "/factory" ||
    pathname.startsWith("/factory/")
  );
}

/** Which pill item is active for a path; null on pages outside all four
 * (a run, an approval, the account page). */
export function sectionFromPath(pathname: string): Section | null {
  const rest = pathname.replace(/^\/p\/[^/]+/, "");
  if (pathname.startsWith("/manage")) return "manage";
  if (rest === "" || rest === "/") return "home";
  if (rest === "/chats" || rest.startsWith("/chats/")) return "chats";
  if (rest === "/factory" || rest.startsWith("/factory/")) return "factory";
  if (pathname.startsWith("/catch-up")) return "home";
  if (pathname.startsWith("/runs/")) return "factory";
  return null;
}

function readLastScope(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_SCOPE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * The current scope: a project id, or null for All projects.
 */
export function useScope(): string | null {
  const { pathname } = useLocation();
  const decides = pathDecidesScope(pathname);
  const fromPath = scopeFromPath(pathname);
  useEffect(() => {
    if (!decides) return;
    try {
      if (fromPath) window.sessionStorage.setItem(LAST_SCOPE_KEY, fromPath);
      else window.sessionStorage.removeItem(LAST_SCOPE_KEY);
    } catch {
      /* storage may be blocked; the URL still carries the scope */
    }
  }, [decides, fromPath]);
  return decides ? fromPath : readLastScope();
}
