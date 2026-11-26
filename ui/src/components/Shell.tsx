/**
 * App shell — redesign R1. The frame is now three things and nothing else:
 *
 * ```
 * ┌────────┬──────────────────────────────────────────────────┐
 * │ rail   │ top bar  (scope name · Home/Chats/Factory · ⌘K)  │
 * │ 64px   ├──────────────────────────────────────────────────┤
 * │      … │ main (each page scrolls itself)                  │
 * └────────┴──────────────────────────────────────────────────┘
 * ```
 *
 * `h-dvh overflow-hidden` on the root with `min-h-0 flex-1 overflow-auto` on
 * `<main>` is the whole scrolling contract: the rail and the bar never move,
 * and the page owns its own scroll position — which is what a person
 * supervising agents wants (the bar's scope and pill stay put while the
 * transcript runs).
 *
 * Below 768px (`useIsNarrow`) the rail does not mount at all: the bar's phone
 * variant carries the scope as a 36px tile button and the scope arrives in
 * `ScopeSheet`. Which frame mounts is a `matchMedia` question, not a
 * stylesheet one — an app bar that exists at desktop width and is only
 * `display:none`d is still an app bar in the accessibility tree.
 *
 * Gone with this rewrite (all of it in CONTRACT "What happens to the old
 * app"): the 220px `Sidebar` column and its drawer, the forced-rail overlay,
 * the ⌘\ expand chord, and the floating `Ask` button — Ask keeps its ⌘J
 * (the popover's engine stays mounted below) and the rail/top bar carry
 * search (⌘K, the palette engine unchanged).
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import CommandPalette from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";
import ProjectRail from "./shell/ProjectRail";
import TopBar from "./shell/TopBar";
import ScopeSheet from "./shell/ScopeSheet";
import { sectionFromPath } from "../lib/scope";

/**
 * What the assistant's context chip calls this page. The three pill sections
 * answer with their own name (`home`, `chats`, `factory`, `manage` — see
 * `sectionFromPath`); everything outside them — a run, an approval, `/login`
 * — is named by its own first segment rather than guessed at, so the chip
 * never claims a page is somewhere it is not.
 */
export function sectionOf(pathname: string): string {
  return sectionFromPath(pathname) ?? pathname.split("/")[1] ?? "home";
}

/**
 * The assistant's full-page route (`pages/AssistantPage.tsx`). It lives here,
 * next to the shell's own frame rules, because the SHELL has to key on it and
 * the assistant engine (`assistant/AssistantPopover.tsx`) already imports this
 * module — a constant the other way round would close the cycle.
 */
export const ASSISTANT_PAGE_PATH = "/assistant";

/** Is this path the assistant full page (`/assistant`, `/assistant/…`)? */
export function isAssistantPagePath(pathname: string): boolean {
  return pathname === ASSISTANT_PAGE_PATH || pathname.startsWith(`${ASSISTANT_PAGE_PATH}/`);
}

export interface ShellProps {
  children: ReactNode;
}

/** The phone frame starts below 768px; a half-split laptop window is a
 * tablet, not a phone, and keeps the rail. */
export const PHONE_MAX_WIDTH_PX = 767.98;

/** The redesign has no 220px column any more, so the rail band that used to
 * run from here up to desktop width is a single point: everything at or above
 * it shows the rail. Kept because other modules read the constant. */
export const RAIL_MAX_WIDTH_PX = 1023.98;

const NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;
const RAIL_QUERY = `(min-width: ${PHONE_MAX_WIDTH_PX + 0.02}px) and (max-width: ${RAIL_MAX_WIDTH_PX}px)`;

/**
 * Does the viewport match `query`? The answer drives what MOUNTS, not what a
 * stylesheet hides. Where `matchMedia` is missing (a server render, a jsdom
 * without it) the answer is no — the wider layout is the one the app is
 * designed for.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Phone frame (scope sheet + compact bar)? */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/** The band the rail still appears in at a tablet window's width. Nothing
 * changes at that boundary any more — the rail is the frame from 768px up —
 * but the question is still asked by callers that size their own content. */
export function useIsRailWidth(): boolean {
  return useMediaQuery(RAIL_QUERY);
}

/**
 * The shell: rail, top bar, and one scrolling content region. The palette
 * engine (`CommandPalette`) stays mounted and invisible — it owns ⌘K and
 * listens for the `palette-open` event the top bar's field fires — and so
 * does the Ask popover, which owns ⌘J and holds the transcript across page
 * changes. Both are replaced by the wave-1 quick-chat/search surface.
 */
export default function Shell({ children }: ShellProps) {
  const location = useLocation();
  const narrow = useIsNarrow();
  const [scopeSheetOpen, setScopeSheetOpen] = useState(false);

  // A row in the sheet navigated: its job is done. Growing back to desktop
  // width likewise cannot leave the sheet standing over the rail.
  useEffect(() => {
    setScopeSheetOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!narrow) setScopeSheetOpen(false);
  }, [narrow]);

  return (
    <div className="flex h-dvh overflow-hidden bg-surface text-ink">
      {narrow ? null : <ProjectRail />}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          phone={narrow}
          scopeOpen={scopeSheetOpen}
          onScopeOpen={() => setScopeSheetOpen(true)}
        />
        <main className="min-h-0 flex-1 overflow-auto">
          {/* gh-69: navigation clears a caught render error through `resetKey`
              instead of a `key={location.pathname}` remount — keying the
              subtree threw away every already-painted page merely to reset one
              error flag. */}
          <RouteErrorBoundary resetKey={location.pathname}>{children}</RouteErrorBoundary>
        </main>
      </div>

      {narrow && scopeSheetOpen ? <ScopeSheet onClose={() => setScopeSheetOpen(false)} /> : null}

      {/* ⌘K: the field in the bar is the trigger, the engine lives here (a
          shell that never mounts it silently swallows the chord). */}
      <CommandPalette context={sectionOf(location.pathname)} className="hidden" />

      {/* ⌘J and the Ask transcript, shell-scoped so a page change never loses
          the conversation. */}
      <AssistantPopover />
    </div>
  );
}
