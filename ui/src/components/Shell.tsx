import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Mark } from "./ds/Mark";
import { Button } from "./ds/Button";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import Sidebar from "./Sidebar";
import CommandPalette, { CATCH_UP_PATH } from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";
import { openAsk } from "./assistant/askControl";
import { useLayoutPrefs } from "../lib/prefs";

/**
 * The sections the Ask box's context chip names, in the order the sidebar
 * lists them. A nav item wins; anything outside the track is named by its own
 * first segment (`/p/proj-1` is `p`, `/login` is `login`) rather than guessed
 * at.
 *
 * Handoff 2c/3c: the nav is Today (`/`, what the page called Home), Catch up
 * (finding 8a: `/catch-up`, what the agents did) and Threads, plus — since
 * finding 02 — the Workflows and Agents rows that sit under the projects.
 * Board and Inbox are not nav rows any more — the Board's behavior lives in the
 * repository page's Lanes view and the Inbox folds into Today — and (finding
 * 03) `/board` and `/inbox` now redirect to `/` the way `/ops` redirects to
 * Settings.
 */
const NAV_ITEMS = [
  { to: "/", label: "Today", end: true },
  { to: CATCH_UP_PATH, label: "Catch up" },
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
}

/** Finding 07: the phone frame (drawer + top strip) only starts below 768px —
 * a half-split laptop window is a tablet, not a phone. From 768px the sidebar
 * owns the left edge and there is no top bar at all; between 768px and the
 * full column's 1024px the shell forces the collapsed RAIL (below) whatever
 * the saved `sidebarCollapsed` preference says. */
export const PHONE_MAX_WIDTH_PX = 767.98;

/** Above this width the full 220px column may show (honouring the preference);
 * from `PHONE_MAX_WIDTH_PX + 0.02` up to here the rail is forced. */
export const RAIL_MAX_WIDTH_PX = 1023.98;

const NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;
const RAIL_QUERY = `(min-width: ${PHONE_MAX_WIDTH_PX + 0.02}px) and (max-width: ${RAIL_MAX_WIDTH_PX}px)`;

/**
 * Does the viewport match `query`? The answer drives what MOUNTS, not what a
 * stylesheet hides: an app bar that exists at desktop width and is only
 * `display:none`d is still an app bar in the accessibility tree, still steals
 * the Ask box's one safe anchor, and still has to be re-hidden by every
 * descendant rule. `matchMedia` is the same question the CSS media query
 * asks, so one source of truth moves the chrome. Where `matchMedia` is
 * missing (a server render, a jsdom without it) the answer is no — the wider
 * layout is the one the app is designed for.
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

/**
 * Is the event aimed at something that is busy typing? ⌘\ toggles the
 * sidebar from anywhere (4a) — except from inside a text field, where the
 * chord (or the platform's variant of it) may belong to the editor.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/** Phone frame (drawer + top strip)? */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/** Rail-only width (768–1023px): the collapsed rail shows regardless of the
 * saved preference — the preference itself is never overwritten. */
export function useIsRailWidth(): boolean {
  return useMediaQuery(RAIL_QUERY);
}

/**
 * App shell — handoff 2c/3c: one left column and no top bar on desktop. The
 * 220px white column (collapsible to a 52px rail — see `Sidebar.tsx`) carries
 * the mark, New thread + `Search ⌘K` (finding 08), Today, Catch up, Threads,
 * the project tree and the identity footer. Between `PHONE_MAX_WIDTH_PX` and `RAIL_MAX_WIDTH_PX`
 * (768–1023px) the rail is FORCED — a window that narrow cannot also carry
 * 220px of labels, and the rail exists already. Below `PHONE_MAX_WIDTH_PX` the
 * column is an off-canvas drawer opened from a slim top strip (the phone keeps
 * today's hamburger); the content column then owns the full width, and that
 * strip is the only place the palette's `Ask… Ctrl K` box may render (see
 * `CommandPalette.tsx`). `<main>` no longer decides width (finding 07): pages
 * do, through `ds/Page`.
 */
export default function Shell({ children }: ShellProps) {
  const location = useLocation();
  const narrow = useIsNarrow();
  const railWidth = useIsRailWidth();
  const { prefs, update, loaded } = useLayoutPrefs();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // The 4a expand in the forced-rail zone: the full column opens as an
  // OVERLAY over the rail, and the stored `sidebarCollapsed` preference is
  // not touched — a tablet window is too narrow for the column by geometry,
  // not by the user's choice. Esc / a click outside / another ⌘\ close it.
  const [railOverlay, setRailOverlay] = useState(false);
  const overlayReturnFocus = useRef<HTMLElement | null>(null);

  const openRailOverlay = (source?: HTMLElement) => {
    overlayReturnFocus.current = source ?? (document.activeElement as HTMLElement | null);
    setRailOverlay(true);
  };
  const closeRailOverlay = (restoreFocus = true) => {
    setRailOverlay(false);
    if (restoreFocus) overlayReturnFocus.current?.focus();
  };

  // Content changed = the phone drawer has delivered its link, and so has
  // the rail overlay's popover; both stand down on navigation.
  useEffect(() => {
    setDrawerOpen(false);
    setRailOverlay(false);
  }, [location.pathname]);

  // Leaving the phone frame must not strand an open drawer over the desktop
  // column (or keep the body locked), and leaving the rail zone must not
  // strand the overlay the geometry asked for.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (!railWidth) setRailOverlay(false);
  }, [railWidth]);

  // ⌘\ (⌃\ off Apple keyboards) toggles the column from anywhere (4a):
  // the preference at ≥1024px, the overlay inside the forced-rail zone —
  // never from inside a text field, never on the phone (the drawer already
  // is "expanded on demand").
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "\\" || !(event.metaKey || event.ctrlKey)) return;
      if (narrow || isTypingTarget(event.target)) return;
      event.preventDefault();
      if (railWidth) {
        if (railOverlay) closeRailOverlay();
        else openRailOverlay();
        return;
      }
      // The write waits for the read, or a toggle would stamp over a
      // document still in flight (the same race the tree's auto-expand gate
      // guards in `Sidebar.tsx`).
      if (loaded) update({ sidebarCollapsed: !prefs.sidebarCollapsed });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, railWidth, railOverlay, loaded, prefs.sidebarCollapsed, update]);

  // Esc closes the drawer and the keyboard goes back to the button that
  // opened it; the page body is locked while it stands over the content.
  useEffect(() => {
    if (!drawerOpen && !railOverlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A rail popover (or the drawer's) owns Esc while it is open.
      if (event.defaultPrevented) return;
      if (drawerOpen) {
        setDrawerOpen(false);
        menuButton.current?.focus();
      } else {
        closeRailOverlay();
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen, railOverlay]);

  const closeDrawer = () => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  };

  return (
    <div className="flex min-h-screen bg-paper text-ink">
      {/* Desktop column: sticky, screen-height; the column scrolls itself. It
          is the shell's only chrome at this width — the top bar is gone. In
          the rail zone the rail's expand opens the OVERLAY below, and the
          edge drag snaps to the same overlay. */}
      {narrow ? null : (
        <div className="sticky top-0 h-screen shrink-0">
          <Sidebar forceCollapsed={railWidth} onExpand={railWidth ? openRailOverlay : undefined} />
        </div>
      )}

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Phone top strip (below 768px only): the 44px menu button, the mark,
            and the Ask box. The palette's trigger lives *here* and nowhere else:
            the pass-2
            review caught the same box parked on a fixed bottom-right anchor,
            drawing over the run page's gate card and the Workflows tab's YAML.
            At desktop widths this strip does not mount at all, and the
            sidebar's `Search ⌘K` field is the trigger — which is why the panel
            portals to the body. */}
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
             but the palette engine still must: it owns the ⌘K chord (finding
             08) and listens for the sidebar field's `palette-open` event, and
             a shell that never mounts it silently swallows both (lab-e2e:
             `palette-input` never appeared). `hidden` hides the wrapper and the `Ask… Ctrl K` box
             inside it; the open panel is portalled to the body, so it paints
             exactly where the phone one does. */
          <CommandPalette context={sectionOf(location.pathname)} className="hidden" />
        )}

        {/* Finding 07: the shell never caps or pads the content column —
            every page declares its layout through `ds/Page`. */}
        <main className="w-full flex-1">
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

      {/* The 4a rail-zone expand: the full column over the page, NOT the
          preference. Esc, the backdrop, the column\u2019s own ‹‹ button and
          another ⌘\ all close it; the keyboard returns to the control that
          opened it. */}
      {railWidth && railOverlay ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="rail-overlay-backdrop"
            onClick={() => closeRailOverlay()}
            className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
          />
          <div className="absolute inset-y-0 left-0">
            <Sidebar forceExpanded onCollapse={() => closeRailOverlay()} />
          </div>
        </div>
      ) : null}

      {/* The assistant popover's engine (finding 08): the floating `Ask` button
          and the ⌘J chord both open it through `assistant/askControl`, and its
          state lives here so a page change never loses the transcript. */}
      <AssistantPopover />

      {/* Finding 10 option B: Ask is a floating button over the page, on every
          page, in its own corner — never a sidebar row (the sidebar carries the
          `Search ⌘K` field instead). It stands clear of the column that is
          actually showing, and on the phone frame it lifts above the safe
          area. Finding 08: one shortcut, ⌘J, and the button says so. */}
      <Button
        variant="primary"
        data-testid="ask-fab"
        aria-label="Ask the assistant (⌘J)"
        onClick={() => openAsk()}
        style={{ right: 16, bottom: narrow ? "max(16px, env(safe-area-inset-bottom))" : 16 }}
        className="fixed z-30 flex items-center gap-[6px]"
      >
        Ask
        <span className="font-mono text-[10.5px] tracking-[.04em] opacity-80">⌘J</span>
      </Button>
    </div>
  );
}
