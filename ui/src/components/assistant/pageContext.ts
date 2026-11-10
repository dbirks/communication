/**
 * Page context (handoff §3, CONTRACT §2).
 *
 * What the person is looking at rides INSIDE the user turn as data — never in
 * the system prompt — so the model can resolve "this", "here", "it". The
 * composer shows it only as a small icon button; clicking it says what is
 * attached and offers to stop sending it, per tab.
 *
 * The label comes from the route alone (no extra fetch): the app's own section
 * names, a run's short id, a project's slug. `status` is optional — a caller
 * that already knows it passes it in — and the payload leaves blank values out
 * (CONTRACT §2: "Lines whose value is empty are left out").
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { assistantContextOf } from "../../api/assistant";
import { shortId } from "../../lib/format";
import type { AssistantMessageContext } from "./types";

/** The one tab-scoped key: the choice dies with the tab (handoff §3). */
export const PAGE_CONTEXT_SESSION_KEY = "communication.assistant.ctx";

/** What is on screen, in the shape the composer and the POST body both need. */
export interface PageContext {
  label: string;
  route: string;
  status?: string;
  project?: string;
  entity?: { kind: string; id: string };
}

/** The attached-page block of `context` (CONTRACT §2's `page` member). */
export interface PageContextAttached {
  label: string;
  status?: string;
  project?: string;
}

/** The nav sections keyed by first route segment, in the design's wording. */
const SECTION_LABELS: Record<string, string> = {
  "": "Today",
  catchup: "Catch up",
  threads: "Threads",
  workflows: "Workflows",
  profiles: "Agents",
  projects: "Projects",
  settings: "Settings",
  library: "Workflows",
  approvals: "Approvals",
  artifacts: "Artifacts",
};

/** "run 9c1e" → "Run 9c1e": a route-derived label still reads as a label. */
function titleize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * The page label for a route (the wording the composer chip carried, in the
 * handoff's capitalisation): Today, Catch up, `Run 9c1e`, `Draft 01K1`, the
 * project slug on a project page, else the section name.
 */
export function pageLabelOf(pathname: string): string {
  const run = /^\/runs\/([^/?#]+)/.exec(pathname);
  if (run) return `Run ${shortId(decodeURIComponent(run[1]))}`;
  const draft = /^\/workflows\/[^/?#]+\/drafts\/([^/?#]+)/.exec(pathname);
  if (draft) return `Draft ${shortId(decodeURIComponent(draft[1]))}`;
  const step = /^\/workflows\/steps\/([^/?#]+)/.exec(pathname);
  if (step) return `Step ${shortId(decodeURIComponent(step[1]))}`;
  const workflow = /^\/workflows\/([^/?#]+)/.exec(pathname);
  if (workflow) return `Workflow ${decodeURIComponent(workflow[1])}`;
  const project = /^\/p\/([^/?#]+)/.exec(pathname);
  if (project) return decodeURIComponent(project[1]) || "Projects";
  const profile = /^\/profiles\/([^/?#]+)/.exec(pathname);
  if (profile) return `Agent ${shortId(decodeURIComponent(profile[1]))}`;
  if (pathname.startsWith("/catch-up")) return "Catch up";
  const first = pathname.split("/")[1] ?? "";
  return titleize(SECTION_LABELS[first] ?? first ?? "");
}

/** Everything the composer can say about the page at `pathname`. */
export function pageContextFor(pathname: string, status?: string): PageContext {
  const context = assistantContextOf(pathname);
  const page: PageContext = { label: pageLabelOf(pathname), route: context.route };
  if (status) page.status = status;
  if (context.project_id) page.project = context.project_id;
  if (context.entity) page.entity = { kind: context.entity.kind, id: context.entity.id };
  return page;
}

/**
 * The current location without needing a `<Router>`: `window.location` is the
 * same value react-router pushes through `history`, and the surface re-renders
 * on every navigation anyway (its route-derived props change). The
 * `popstate`/`hashchange` subscription covers back/forward.
 */
function subscribeLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

function getPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/** `usePageContext()` — the page context for the current location. */
export function usePageContext(): PageContext {
  const pathname = useSyncExternalStore(subscribeLocation, getPathname, () => "/");
  return useMemo(() => pageContextFor(pathname), [pathname]);
}

/**
 * `pageContextPayload(ctx, on)` — the POST body's `context` (CONTRACT §2), or
 * `undefined` when the person unchecked "Send with my messages": the client
 * then omits `context` ENTIRELY.
 */
export function pageContextPayload(
  page: PageContext | null | undefined,
  on: boolean,
): AssistantMessageContext | undefined {
  if (!on || !page) return undefined;
  const context: AssistantMessageContext = { route: page.route };
  if (page.project) context.project_id = page.project;
  if (page.entity) {
    const kind = page.entity.kind as NonNullable<AssistantMessageContext["entity"]>["kind"];
    context.entity = { kind, id: page.entity.id };
  }
  const attached: PageContextAttached = { label: page.label };
  if (page.status) attached.status = page.status;
  if (page.project) attached.project = page.project;
  context.page = attached;
  return context;
}

/** The stored choice; absent means ON (handoff §3: sent with every message). */
export function readPageContextOn(): boolean {
  try {
    const raw = window.sessionStorage.getItem(PAGE_CONTEXT_SESSION_KEY);
    if (raw === null) return true;
    const parsed = JSON.parse(raw) as { on?: unknown };
    return parsed.on !== false;
  } catch {
    return true;
  }
}

function writePageContextOn(on: boolean): void {
  try {
    window.sessionStorage.setItem(PAGE_CONTEXT_SESSION_KEY, JSON.stringify({ on }));
  } catch {
    // storage unavailable (private mode): the choice lives for this session only.
  }
}

/** `[on, setOn]` — the checkbox's state, persisted per tab. */
export function usePageContextOn(): [boolean, (next: boolean) => void] {
  // Read once: the key is tab-scoped, and a second panel mount re-reads it.
  const [on, setOn] = useState(readPageContextOn);
  const update = useCallback((next: boolean) => {
    writePageContextOn(next);
    setOn(next);
  }, []);
  return [on, update];
}
