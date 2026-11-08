import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { useLayoutPrefs } from "../lib/prefs";
import { Mark } from "./ds/Mark";
import { Button } from "./ds/Button";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import Sidebar, { SIDEBAR_RAIL_WIDTH_PX, SIDEBAR_WIDTH_PX, openAsk } from "./Sidebar";
import CommandPalette from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";

/**
 * The sections the Ask box's context chip names, in the order the sidebar
 * lists them. A nav item wins; anything outside the track is named by its own
 * first segment (`/p/proj-1` is `p`, `/login` is `login`) rather than guessed
 * at.
 *
 * Handoff 2c/3c: the nav is Today (`/`, what the page called Home) and My
 * chats, plus — since finding 02 — the Workflows and Agents rows that sit
 * under the projects. Board and Inbox are not nav rows any more — the Board's
 * behavior lives in the repository page's Lanes view and the Inbox folds into
 * Today — and (finding 03) `/board` and `/inbox` now redirect to `/` the way
 * `/ops` redirects to Settings.
 */
const NAV_ITEMS = [
  { to: "/", label: "Today", end: true },
  { to: "/threads", label: "Threads" },
  { to: "/workflows", label: "Workflows" },
  { to: "/profiles", label: "Agents" },
];

export function sectionOf(pathname: string): string {
  const hit = NAV_ITEMS.find((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  const first = pathname.split("/")[1] ?? "";
  return (hit?.label ?? (first || "projects")).toLowerCase();
}

export interface ShellProps {
  children: ReactNode;
  /** Routes that own the whole viewport (the Run Workbench) drop the
   * content column's width cap and padding; they pad themselves. */
  fullBleed?: boolean;
}

/** Handoff 2c/3c: below this width the shell is the phone frame (drawer +
 * top strip); at or above it the sidebar owns the left edge and there is no
 * top bar at all. The same cut the design's own reflow notes use (1024px). */
export const PHONE_MAX_WIDTH_PX = 1023.98;

const NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

/**
 * Does the viewport ask for the phone frame? The answer drives what MOUNTS,
 * not what a stylesheet hides: an app bar that exists at desktop width and is
 * only `display:none`d is still an app bar in the accessibility tree, still
 * steals the Ask box's one safe anchor, and still has to be re-hidden by every
 * descendant rule. `matchMedia` is the same question the CSS media query asks,
 * so one source of truth moves the chrome. Where `matchMedia` is missing (a
 * server render, a jsdom without it) the shell is the desktop one — the wider
 * layout is the one the app is designed for.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * App shell — handoff 2c/3c: one left column and no top bar on desktop. The
 * 220px white column (collapsible to a 52px rail — see `Sidebar.tsx`) carries
 * the mark, New thread + `⌘K`, Today/Threads, the project tree, the library and
 * the identity footer. Below `PHONE_MAX_WIDTH_PX` the column is an off-canvas
 * drawer opened from a slim top strip (the phone keeps today's hamburger); the
 * content column then owns the full width, and that strip is the only place
 * the palette's `Ask… Ctrl K` box may render (see `CommandPalette.tsx`).
 */
export default function Shell({ children, fullBleed = false }: ShellProps) {
  const { prefs } = useLayoutPrefs();
  const location = useLocation();
  const narrow = useIsNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // The column's width is a saved preference: the floating Ask box parks
  // beside whichever one is showing.
  const columnWidth = prefs.sidebarCollapsed ? SIDEBAR_RAIL_WIDTH_PX : SIDEBAR_WIDTH_PX;

  // Content changed = the phone drawer has delivered its link.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Leaving the phone frame must not strand an open drawer over the desktop
  // column (or keep the body locked).
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  // Esc closes the drawer and the keyboard goes back to the button that
  // opened it; the page body is locked while it stands over the content.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  };

  return (
    <div className="flex min-h-screen bg-paper text-ink">
      {/* Desktop column: sticky, screen-height; the column scrolls itself. It
          is the shell's only chrome at this width — the top bar is gone. */}
      {narrow ? null : (
        <div className="sticky top-0 h-screen shrink-0">
          <Sidebar />
        </div>
      )}

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Phone top strip (below 1024px only): the 44px menu button, the mark,
            and the Ask box. The palette's trigger lives *here* and nowhere else:
            the pass-2
            review caught the same box parked on a fixed bottom-right anchor,
            drawing over the run page's gate card and the Workflows tab's YAML.
            At desktop widths this strip does not mount at all, and the
            sidebar's `⌘K` row is the trigger — which is why the panel portals
            to the body. */}
        {narrow ? (
          <header
            data-testid="phone-top-strip"
            className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-ink bg-surface px-2"
          >
            <button
              ref={menuButton}
              type="button"
              data-testid="sidebar-open"
              aria-label="Open sidebar"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[4px] border border-fill-edge bg-surface text-ink hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path
                  d="M2 5h14M2 9h14M2 13h14"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {/* The brand is a logo, not text (issue #61): a home link that
              never highlights or drags; the C mark's box and the wordmark's
              box share a vertical centre (items-center). */}
            <Link
              to="/"
              aria-label="Communication"
              draggable={false}
              data-testid="brand-home"
              className="flex min-w-0 select-none items-center gap-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
            >
              <Mark size={22} />
              <span className="min-w-0 truncate text-[13px] font-semibold">Communication</span>
            </Link>
            <CommandPalette context={sectionOf(location.pathname)} className="ml-auto shrink-0" />
          </header>
        ) : (
          /* Desktop: the strip — the box's only DRAWN home — does not mount,
             but the palette engine still must: the assistant popover hands
             the second ⌘K to the jump palette (ADR-0050) through a window
             event this component listens for, and a shell that never mounts
             it silently swallows the chord (lab-e2e: `palette-input` never
             appeared). `hidden` hides the wrapper and the `Ask… Ctrl K` box
             inside it; the open panel is portalled to the body, so it paints
             exactly where the phone one does. */
          <CommandPalette context={sectionOf(location.pathname)} className="hidden" />
        )}

        <main className={fullBleed ? "w-full flex-1" : "mx-auto w-full max-w-5xl flex-1 px-4 py-6"}>
          {/* gh-69: navigation clears a caught render error through `resetKey`
              instead of a `key={location.pathname}` remount — keying the
              subtree threw away every already-painted page (skeleton flash on
              the first click of a thread/run, and state loss on every param
              change) merely to reset one error flag. */}
          <RouteErrorBoundary resetKey={location.pathname}>{children}</RouteErrorBoundary>
        </main>
      </div>

      {/* The phone drawer: backdrop + the EXPANDED column off-canvas. The
          collapsed rail is a desktop affordance; a 390px drawer shows the
          sidebar the design drew, labels and all. */}
      {narrow && drawerOpen ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="sidebar-backdrop"
            onClick={closeDrawer}
            className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
          />
          <div className="absolute inset-y-0 left-0">
            <Sidebar variant="drawer" onClose={closeDrawer} />
          </div>
        </div>
      ) : null}

      {/* The assistant popover's engine (ADR-0050): it owns ⌘K, the sidebar's
          `Ask ⌘K` row and the floating button all press it, and its state
          lives here so a page change never loses the transcript. */}
      <AssistantPopover />

      {/* Ask placement: a saved preference. `floating` parks the button at
          the content's bottom-right, above the palette engine — clear of
          whichever column width the sidebar is saving. */}
      {prefs.askPlacement === "floating" ? (
        <Button
          variant="secondary"
          data-testid="ask-float"
          onClick={openAsk}
          style={{ right: (narrow ? 0 : columnWidth) + 16 }}
          className="fixed bottom-4 z-30 font-mono text-[11px]"
        >
          Ask ⌘K
        </Button>
      ) : null}
    </div>
  );
}
