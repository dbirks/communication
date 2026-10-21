import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useLayoutPrefs } from "../lib/prefs";
import { Mark } from "./ds/Mark";
import { Button } from "./ds/Button";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import Sidebar, { openAsk } from "./Sidebar";
import CommandPalette from "./CommandPalette";
import AssistantPopover from "./assistant/AssistantPopover";

/**
 * The sections the Ask box's context chip names, in the order the sidebar
 * lists them. A nav item wins; anything outside the track is named by its own
 * first segment (`/p/proj-1` is `p`, `/login` is `login`) rather than guessed
 * at.
 */
const NAV_ITEMS = [
  { to: "/", label: "Home", end: true },
  { to: "/inbox", label: "Inbox" },
  { to: "/board", label: "Board" },
  { to: "/threads", label: "Threads" },
  { to: "/ops", label: "Operations" },
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

/**
 * App shell — Sidebar v3. A 240px white column on every page (no top app bar
 * anywhere): mark, New/Ask, cross-project nav, the project tree or switcher
 * (a saved preference), the library, and the identity footer. Below `md`
 * (768px) the column is an off-canvas drawer opened from a slim top strip;
 * the content column then owns the full width.
 */
export default function Shell({ children, fullBleed = false }: ShellProps) {
  const { prefs } = useLayoutPrefs();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // Content changed = the phone drawer has delivered its link.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

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
      {/* Desktop column: sticky, screen-height; the column scrolls itself. */}
      <div className="sticky top-0 hidden h-screen shrink-0 md:block">
        <Sidebar />
      </div>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Phone top strip: the 44px menu button and the mark. */}
        <header className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-ink bg-surface px-2 md:hidden">
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
          <Mark size={22} />
          <span className="min-w-0 truncate text-[13px] font-semibold">Communication</span>
        </header>

        <main className={fullBleed ? "w-full flex-1" : "mx-auto w-full max-w-5xl flex-1 px-4 py-6"}>
          {/* Keyed by the path: navigating clears a caught render error instead
              of leaving the crash banner on every later page. */}
          <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>
        </main>
      </div>

      {/* The phone drawer: backdrop + off-canvas column. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
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

      {/* The command palette's engine, anchored at the content's bottom-right
          (the assistant popover's design position): its trigger box is hidden
          — the sidebar's `Ask ⌘K` row (or the floating button) opens it — but
          the global ⌘K listener and the panel stay mounted here. */}
      <div className="fixed bottom-0 right-[248px] z-30 h-px w-px [&>button]:hidden">
        <CommandPalette context={sectionOf(location.pathname)} />
      </div>

      {/* The assistant popover's engine (ADR-0050): it owns ⌘K, the sidebar's
          `Ask ⌘K` row and the floating button all press it, and its state
          lives here so a page change never loses the transcript. */}
      <AssistantPopover />

      {/* Ask placement: a saved preference. `floating` parks the button at
          the content's bottom-right, above the palette engine. */}
      {prefs.askPlacement === "floating" ? (
        <Button
          variant="secondary"
          data-testid="ask-float"
          onClick={openAsk}
          className="fixed bottom-4 right-4 z-30 font-mono text-[11px] md:right-[256px]"
        >
          Ask ⌘K
        </Button>
      ) : null}
    </div>
  );
}
