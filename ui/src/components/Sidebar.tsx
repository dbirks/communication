/**
 * Sidebar — the shell's one left column (handoff 2c/3c, `Sidebar.dc.html`).
 *
 * It has two widths, and which one you get is a saved layout preference
 * (`sidebarCollapsed`, `lib/prefs.ts`), not local state: 220px expanded, or a
 * 52px rail (redesign 3a/4a). The rail is not a second implementation of the
 * content: it carries the same facts — the same badges, the same unseen and
 * waiting counts — in the same reads; the one tile with children (Projects)
 * opens a click-surface `ds/Popover` beside it, and every icon names itself
 * on a dark hover/focus label. Nothing opens by accident while the mouse
 * crosses the rail: hover is a label, only a click opens a menu.
 *
 * Three ways back to the full column (4a): the expand button under the mark,
 * ⌘\ (wired in `Shell`), and dragging the column's right edge past ~120px —
 * the pointer travels a ghost, never a layout, and the column snaps open or
 * shut at the threshold. In the forced-rail zone (768–1023px) `Shell` owns
 * the expand: there the full column shows as an OVERLAY and the saved
 * preference is never touched.
 *
 * Everything the column shows is real: the project tree and its status flags
 * come from the same reads Inbox runs (`useSidebarFlags` projects the
 * `lib/attention.ts` reduction, worst state per project); the library counts
 * are live pipeline/profile reads; the footer is the signed-in identity the
 * old bar carried (`user-badge` + the account menu: Settings, Operations,
 * Sign out). What the backend cannot supply yet is simply absent — no fake
 * folders under Workflows, no count on Steps (there is no template store), no
 * per-repo flags.
 *
 * Finding 09: the project row carries no "⋯" any more. Project settings, Members
 * and Add repository are actions on the PROJECT PAGE (its header band), not on a
 * menu that stayed invisible until you hovered the row — and a hover-only menu is
 * never there on touch or in the rail. The tree does one job: it takes you to a
 * project and opens its repositories.
 *
 * The column has two placements: `panel` (desktop, a sticky screen-height
 * flex item — the one that can collapse to the rail) and `drawer` (phone,
 * off-canvas, always the expanded column; `Shell` owns the backdrop and the
 * focus choreography, the `drawer` variant adds the close control and takes
 * focus in on mount).
 *
 * Anchored surfaces: the rail flyouts are positioned against the column's own
 * non-scrolling host, not the row inside the scroller — the 220px/52px column is
 * `overflow-y-auto`, and a flyout that leaves it sideways would be cut off at the
 * column's edge by the scroll container.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation } from "react-router";
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  Inbox,
  MessageSquare,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import { useAgentProfiles, useMe, useProjects, useRepositories } from "../api/queries";
import { usePipelines } from "../api/pipelines";
import { useCatchUpItems } from "../api/catchup";
import { useLayoutPrefs } from "../lib/prefs";
import { routes } from "../lib/routes";
import type { Flag } from "../lib/sidebarFlags";
import { FLAG_RANK, useSidebarFlags } from "../lib/sidebarFlags";
import { Mark } from "./ds/Mark";
import { Popover, POPOVER_WIDTH_PX } from "./ds/Popover";
import NewConversationDialog from "./NewConversationDialog";
import UserMenu from "./UserMenu";
import { CATCH_UP_PATH, openPalette } from "./CommandPalette";

const FLAG_STYLE: Record<
  Exclude<Flag["kind"], "none">,
  { glyph: string; fg: string; word: string }
> = {
  failed: { glyph: "×", fg: "text-st-failed-tag-fg", word: "failed" },
  waiting: { glyph: "!", fg: "text-st-waiting-tag-fg", word: "waiting" },
  running: { glyph: "●", fg: "text-st-running-tag-fg", word: "running" },
};

/** Glyph + count, never colour alone; `none` (or 0) renders nothing at all. */
export function FlagBadge({ flag }: { flag: Flag }) {
  if (flag.kind === "none" || flag.count === 0) return null;
  const style = FLAG_STYLE[flag.kind];
  return (
    <span
      aria-label={`${flag.count} ${style.word}`}
      className={`ml-auto shrink-0 font-mono text-[10.5px] font-semibold ${style.fg}`}
    >
      {style.glyph} {flag.count}
    </span>
  );
}

/** The 12×12 chevron: down = open, rotated to point right = closed (issue #65:
 * real lucide icons, not a Unicode arrow). */
function Chevron({
  open,
  size = 16,
  className = "",
}: {
  open: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <ChevronDown
      size={size}
      strokeWidth={1.6}
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"} ${className}`}
    />
  );
}

/** The row rhythm: the active row is an ink border on the 4px blueprint grid. */
const ROW =
  "flex items-center gap-[6px] rounded-[3px] border px-[8px] py-[5px] text-[13px] text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";
const ROW_INACTIVE = "border-transparent text-muted hover:text-ink";
const ROW_ACTIVE = "ds-texture-accent border-ink bg-surface font-semibold text-ink";

const SECTION_LABEL = "px-2 pb-1 font-mono text-[10px] tracking-[.06em] text-faint";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/**
 * One repository under a project: indent 14, left rule, mono 11.5. The
 * repository page you are on marks its row the way every other active row in
 * the column is marked (the Workflows row's `ROW_ACTIVE` ink border), and
 * NavLink carries the `aria-current="page"` that marks it for assistive tech.
 */
function RepoRow({ projectHref, name }: { projectHref: string; name: string }) {
  return (
    <NavLink
      to={`${projectHref}/${name}`}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-[3px] border px-2 py-[3px] font-mono text-[11.5px] no-underline ${FOCUS_RING} ${
          isActive ? ROW_ACTIVE : "border-transparent text-ink-2 hover:underline"
        }`
      }
    >
      <span className="min-w-0 truncate">{name}</span>
    </NavLink>
  );
}

/**
 * The project a pathname lives inside: `/p/:projectId/…` and the legacy
 * `/projects/:projectId/…` redirects (the router replaces them onto `/p/…` a
 * render later; matching both keeps the tree from flashing closed in
 * between). Every descendant — the tabs, conversations, members, the
 * `/p/:projectId/:repo` catch-all — names the same project; anything else
 * returns `null`.
 */
export function projectIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if ((segments[0] !== "p" && segments[0] !== "projects") || !segments[1]) return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return segments[1];
  }
}

function RepoList({ projectHref, projectId }: { projectHref: string; projectId: string }) {
  const repos = useRepositories(projectId);
  const items = repos.data?.items ?? [];
  if (repos.isPending) return null;
  if (items.length === 0) return null;
  return (
    <div className="ml-[14px] border-l border-line pl-[10px]">
      {items.map((repo) => (
        <RepoRow key={repo.id} projectHref={projectHref} name={repo.name} />
      ))}
    </div>
  );
}

/**
 * The tree mode (the default): one row per project, a chevron that opens the
 * repository list, and the project's worst-state flag on the right. Finding 09
 * took the "⋯" off the row: a hover-only menu hid the project's actions from
 * touch, from the rail and from anyone who never thought to hover.
 * Expansion is a saved preference
 * (`expanded["project:<id>"]`), not local state, so it survives a reload. The
 * project the current route lives inside opens itself — once per entered
 * project, so a manual collapse is never fought while the route stays put.
 */
function ProjectTree() {
  const { prefs, update, loaded } = useLayoutPrefs();
  const projects = useProjects();
  const flags = useSidebarFlags();
  const items = projects.data?.items ?? [];

  /**
   * The chevron's optimistic bridge. The saved preference is the source of
   * truth (it survives a reload), but the click also lands in this local
   * state so the chevron flips on the same event — it must not wait on the
   * preferences query's external-store notification to catch up. The bridge
   * is dropped whenever the cached preference changes identity (the
   * optimistic write, the PATCH answer, or a failure rollback), from which
   * point the preference value alone drives the DOM.
   */
  const [bridge, setBridge] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setBridge((previous) => (Object.keys(previous).length === 0 ? previous : {}));
  }, [prefs]);

  const setExpanded = (id: string, open: boolean) => {
    setBridge((previous) => ({ ...previous, [`project:${id}`]: open }));
    update({ expanded: { ...prefs.expanded, [`project:${id}`]: open } });
  };

  /**
   * The design opens the project you are in (Projects Review 1b/1e): when the
   * route ENTERS a project its tree node expands, through the same saved
   * preference a chevron click writes — so the repository list reuses the
   * existing lazy `useRepositories` read, no new endpoint. The expansion
   * fires once per entered project, never on every render: a manual collapse
   * sticks for as long as the route stays in that project, and the
   * auto-expand re-arms only when the route moves to a different project
   * (leaving the project pages counts as moving away and coming back).
   */
  const location = useLocation();
  const routeProjectId = projectIdFromPath(location.pathname);
  const autoExpandedFor = useRef<string | null>(null);
  useEffect(() => {
    // The write waits for the read. Auto-expanding before the saved document
    // has arrived would stamp the optimistic write as “newer” than the fetch
    // that is still in flight, and the fetch would then be dropped as stale —
    // losing whatever the user had saved (including the collapsed rail).
    if (!loaded) return;
    if (routeProjectId === autoExpandedFor.current) return;
    autoExpandedFor.current = routeProjectId;
    if (routeProjectId === null) return;
    const key = `project:${routeProjectId}`;
    if (!(bridge[key] ?? prefs.expanded[key] === true)) {
      setExpanded(routeProjectId, true);
    }
  });

  if (projects.isPending) return null;
  if (items.length === 0) {
    return <p className="px-2 font-mono text-[11px] text-faint">no projects yet</p>;
  }
  return (
    <div className="flex flex-col gap-px">
      {items.map((project) => {
        const key = `project:${project.id}`;
        const open = bridge[key] ?? prefs.expanded[key] === true;
        const href = routes.project(project.id);
        return (
          <div key={project.id}>
            {/* issue #68: `py-[6px]` (was `py-1`) — the row pitch must clear
                the shared `.icon-hit` 30px hit box, or the next project's
                chevron clips this row's hit area back below 28px. */}
            <div className="flex items-center gap-1 px-[6px] py-[6px]">
              <button
                type="button"
                data-testid={`sidebar-project-toggle-${project.id}`}
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} ${project.name} repositories`}
                onClick={() => {
                  setExpanded(project.id, !open);
                }}
                className={`icon-hit grid size-4 shrink-0 place-items-center rounded-[3px] p-0 text-ink-2 hover:bg-fill ${FOCUS_RING}`}
              >
                <Chevron open={open} className="text-ink-2" />
              </button>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                <NavLink
                  to={href}
                  className={`no-underline text-ink hover:underline rounded-[3px] ${FOCUS_RING}`}
                >
                  {project.name}
                </NavLink>
              </span>
              <FlagBadge flag={flags.projects[project.id] ?? { kind: "none", count: 0 }} />
            </div>
            {open ? <RepoList projectHref={href} projectId={project.id} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The footer the app bar used to carry: the signed-in user as the menu
 * trigger (`user-badge`) over the account menu (`user-menu-list`: Settings,
 * Operations, Sign out), plus the honest "not signed in" state. The replica
 * name moved to Settings — the honest operations signal the footer used to
 * carry — and the Operations page shows it too.
 */
function Footer({ rail = false }: { rail?: boolean }) {
  const me = useMe();

  return (
    <div
      className={
        rail
          ? // The rail has room for the avatar tile and nothing else. The
            // button is pinned to the tile's own 26px with its own overflow,
            // so the name (which stays in the DOM, and stays the trigger's
            // accessible name) prints no ink past the tile.
            "w-full border-t border-line pt-2 [&>div>button]:mx-auto [&>div>button]:w-[26px] [&>div>button]:gap-0 [&>div>button]:overflow-hidden [&>div>button]:px-0"
          : "mt-auto border-t border-line px-1 pt-2"
      }
    >
      {me.data ? (
        <UserMenu />
      ) : (
        <span className="font-mono text-[11px] text-faint">not signed in</span>
      )}
    </div>
  );
}

/**
 * The row at the top of the column: `New thread` and the `Search ⌘K` field
 * (redesign finding 08: two labelled entries, one shortcut each — the search
 * field opens the jump/command palette, and `Ask` is a floating button over the
 * page with its own ⌘J). The field is drawn like a field (a bordered box, the
 * verb left, the mono chord right) because it is the row people look for; it
 * opens the palette rather than typing here. Signed-in affordance only for
 * `New thread` — "start something" needs a member; search is never gated.
 */
function NewChatRow({ signedIn, onNewChat }: { signedIn: boolean; onNewChat: () => void }) {
  return (
    <div className="flex gap-[6px]">
      {signedIn ? (
        <button
          type="button"
          data-testid="new-chat"
          onClick={onNewChat}
          className={`h-[30px] min-w-0 flex-1 truncate rounded-[4px] border border-fill-edge bg-fill px-2 text-[12.5px] font-semibold text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg ${FOCUS_RING}`}
        >
          New thread
        </button>
      ) : null}
      <button
        type="button"
        data-testid="sidebar-search"
        onClick={openPalette}
        aria-label="Search or jump (⌘K)"
        className={`flex h-[30px] min-w-0 flex-1 items-center gap-[6px] rounded-[4px] border border-line-strong bg-surface px-[8px] text-left text-[12.5px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:border-ink ${FOCUS_RING}`}
      >
        <span className="min-w-0 flex-1 truncate">Search</span>
        <span className="shrink-0 font-mono text-[10.5px] tracking-[.04em] text-faint">⌘K</span>
      </button>
    </div>
  );
}

/* ─────────────────────────────── collapsed rail (3a/4a) ─────────────────────────── */

/**
 * The 3a icon tile: 34×34, 3px radius, a reserved 1px transparent border so
 * hover and active never shift the box. The active treatment is the sidebar
 * row\u2019s own — ink border on the blue grid-paper fill — and hover is
 * `#efede7` fill with the `#cfc9bd` border (`fill`/`fill-edge` tokens).
 */
const RAIL_TILE =
  "relative grid size-[34px] shrink-0 place-items-center rounded-[3px] border text-ink no-underline";
const RAIL_TILE_ACTIVE = "ds-texture-accent border-ink bg-surface font-semibold";
const RAIL_TILE_INACTIVE = "border-transparent hover:border-fill-edge hover:bg-fill";

/** Badge tones: the state tint as background, the state ink as text; Catch up
 * carries the accent pair the handoff names for the unseen count. */
const RAIL_BADGE_TONE: Record<"waiting" | "running" | "failed" | "accent", string> = {
  waiting: "bg-st-waiting-tag text-st-waiting-tag-fg",
  running: "bg-st-running-tag text-st-running-tag-fg",
  failed: "bg-st-failed-tag text-st-failed-tag-fg",
  accent: "bg-accent-tint text-accent-edge",
};

/**
 * The 3a corner badge: a 15×14 box at the tile\u2019s top-right, offset
 * −4/−5px, mono 9px/600 on the state tint with a 1px white outline. The
 * tile\u2019s `aria-label` states the same number in words (`Today · 2
 * waiting`), so the tint is never the only carrier — and the count is the
 * very number the expanded row prints. `glyph` is the state mark the expanded
 * rows print beside their count (`! 2`, `× 1`); the count-only tiles (Today,
 * Catch up, Threads) leave it off.
 */
function RailBadge({
  name,
  count,
  tone,
  glyph,
}: {
  name: string;
  count: number;
  tone: keyof typeof RAIL_BADGE_TONE;
  glyph?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      data-testid={`rail-badge-${name}`}
      className={`absolute -top-[4px] -right-[5px] flex h-[14px] min-w-[15px] items-center justify-center rounded-[3px] border border-surface px-[3px] font-mono text-[9px] font-semibold leading-none ${RAIL_BADGE_TONE[tone]}`}
    >
      {glyph ? `${glyph} ` : ""}
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * The Projects tile's own badge (3a): the worst state any project is in,
 * read off the very flags the expanded project rows print. Running is not
 * attention — the tile only speaks when a project waits for a person or has
 * failed — and two projects in the same state add up rather than fighting
 * over the one corner.
 */
export function projectTileFlag(flags: Record<string, Flag>): Flag {
  let worst: Flag = { kind: "none", count: 0 };
  for (const flag of Object.values(flags)) {
    if (flag.kind === "none" || flag.kind === "running" || flag.count === 0) continue;
    if (worst.kind === "none" || FLAG_RANK[flag.kind] > FLAG_RANK[worst.kind]) {
      worst = flag;
    } else if (flag.kind === worst.kind) {
      worst = { kind: worst.kind, count: worst.count + flag.count };
    }
  }
  return worst;
}

/** The one tooltip element the rail draws; tiles point at it while it shows. */
const RAIL_TOOLTIP_ID = "rail-tooltip";

interface RailTip {
  key: string;
  label: string;
  hint?: string;
  top: number;
}

/** The hover/focus wiring one tile carries (see `Rail`\u2019s `tipProps`). */
interface TipProps {
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  "aria-describedby"?: string;
}

interface RailTileProps {
  testid: string;
  ariaLabel: string;
  icon: ReactNode;
  badge?: ReactNode;
  /** With `to` the tile is a NavLink; without it, a button (popover/command). */
  to?: string;
  end?: boolean;
  /** Extra active mark beyond the route (the Projects tile on any `/p/…`). */
  active?: boolean;
  onClick?: (el: HTMLElement) => void;
  hasPopup?: boolean;
  expanded?: boolean;
  controls?: string;
  tip: TipProps;
}

/** One rail tile \u2014 the 3a icon tile, as a link or a button. */
function RailTile({
  testid,
  ariaLabel,
  icon,
  badge,
  to,
  end,
  active,
  onClick,
  hasPopup,
  expanded,
  controls,
  tip,
}: RailTileProps) {
  const tileClass = (isActive: boolean) =>
    `${RAIL_TILE} ${FOCUS_RING} ${isActive ? RAIL_TILE_ACTIVE : RAIL_TILE_INACTIVE}`;
  if (to) {
    return (
      <NavLink
        to={to}
        end={end}
        data-testid={testid}
        aria-label={ariaLabel}
        className={({ isActive }) => tileClass(isActive || active === true)}
        {...tip}
      >
        {icon}
        {badge}
      </NavLink>
    );
  }
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={ariaLabel}
      onClick={(event) => onClick?.(event.currentTarget)}
      aria-haspopup={hasPopup ? "dialog" : undefined}
      aria-expanded={hasPopup ? Boolean(expanded) : undefined}
      aria-controls={hasPopup ? controls : undefined}
      className={tileClass(active === true)}
      {...tip}
    >
      {icon}
      {badge}
    </button>
  );
}

/**
 * The 4a third way: the column\u2019s right edge is a drag handle — 5px of
 * `#dfe4fa` (`accent-ring`), shown on hover. Dragging past ~120px snaps the
 * sidebar open; dragging back below it snaps it closed. The pointer never
 * resizes the column (no layout thrash): it only ever checks one threshold,
 * and the snap reuses the same expand/collapse path as the buttons and ⌘\.
 * The keyboard alternative is the ⌘\ chord (`Shell`).
 */
export const RAIL_EDGE_SNAP_PX = 120;

function EdgeResizeHandle({
  collapsed,
  onExpand,
  onCollapse,
}: {
  collapsed: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      if (collapsed ? event.clientX > RAIL_EDGE_SNAP_PX : event.clientX < RAIL_EDGE_SNAP_PX) {
        setDragging(false);
        (collapsed ? onExpand : onCollapse)?.();
      }
    };
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, collapsed, onExpand, onCollapse]);
  return (
    <div className="group absolute inset-y-0 -right-[3px] z-30 flex w-[11px] justify-center">
      <button
        type="button"
        data-testid="sidebar-resize-handle"
        aria-label={collapsed ? "Expand sidebar (drag right)" : "Collapse sidebar (drag left)"}
        title="Drag past 120px to toggle the sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        className={`h-full w-[5px] cursor-col-resize border-0 bg-accent-ring p-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 ${
          dragging ? "opacity-100" : ""
        } ${FOCUS_RING}`}
      />
    </div>
  );
}

/**
 * The collapsed rail (redesign 3a + 4a): the 52px white column with its 1px
 * ink right edge — the mark, the expand button, Search, the `+`, and the six
 * nav icons, with the avatar pinned at the bottom. Hover or keyboard focus on
 * a tile prints the dark label 8px to the right (never on a touch tap); a
 * CLICK on the one icon with children (Projects) opens the `ds/Popover`
 * project menu, so nothing opens by accident while the mouse crosses the rail.
 * The badges are the same counts the expanded rows carry: waiting on Today,
 * unseen on Catch up, live threads. No initials any more \u2014 every tile is
 * an icon, and the words live in the label, the `aria-label` and the popover.
 * Every badge is the expanded column's own number: waiting on Today, unseen
 * on Catch up, live threads on Threads, and the projects' worst state (glyph
 * and count, `! 2` / `× 1`) on Projects.
 */
function Rail({
  signedIn,
  unseenCatchUp,
  onNewChat,
  onExpand,
}: {
  signedIn: boolean;
  unseenCatchUp: number;
  onNewChat: () => void;
  onExpand: (source?: HTMLElement) => void;
}) {
  const flags = useSidebarFlags();
  const location = useLocation();
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  const activeProjectId = projectIdFromPath(location.pathname);
  const hostRef = useRef<HTMLDivElement>(null);
  const projectsTrigger = useRef<HTMLElement | null>(null);
  const touchAt = useRef(0);
  const pointerOver = useRef<string | null>(null);
  const [tip, setTip] = useState<RailTip | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  // Navigation delivered the popover\u2019s link; the next click opens it anew.
  useEffect(() => setProjectsOpen(false), [location.pathname]);
  // Leaving the rail entirely takes the label with it (a pointerleave on the
  // last tile can be missed when the pointer jumps elsewhere).
  useEffect(() => {
    const onLeaveRail = () => {
      pointerOver.current = null;
      setTip(null);
    };
    window.addEventListener("blur", onLeaveRail);
    return () => window.removeEventListener("blur", onLeaveRail);
  }, []);

  // Non-mouse pointer activity on the rail stamps `touchAt`; a focus that
  // arrives right after it (the tail of a tap) is not the keyboard, and gets
  // no label. Keyboard-only focus (no tap behind it) keeps the label.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPointerActivity = (event: PointerEvent) => {
      const pointerType = String(event.pointerType);
      if (pointerType !== "mouse" && pointerType !== "pen") touchAt.current = Date.now();
    };
    host.addEventListener("pointerdown", onPointerActivity);
    host.addEventListener("pointerup", onPointerActivity);
    return () => {
      host.removeEventListener("pointerdown", onPointerActivity);
      host.removeEventListener("pointerup", onPointerActivity);
    };
  }, []);

  const showTip = (key: string, label: string, hint: string | undefined, el: HTMLElement) => {
    const host = hostRef.current;
    if (!host) return;

    const r = el.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    setTip({ key, label, hint, top: r.top - b.top + (r.height - 24) / 2 });
  };
  const hideTip = (key: string) => setTip((current) => (current?.key === key ? null : current));
  /**
   * 3a: the label answers hover AND keyboard focus, and a touch tap gets
   * neither \u2014 `pointerType: touch` is ignored outright, and the focus a
   * tap drags in behind it is ignored for a beat after the touch.
   */
  const tipProps = (key: string, label: string, hint?: string): TipProps => ({
    onPointerEnter: (event) => {
      pointerOver.current = key;
      // Only the mouse/pen gets a label; a touch pointer (or a browser that
      // reports no pointer type at all, where touch is the likelier guest)
      // never paints one.
      const pointerType = String(event.pointerType);
      if (pointerType === "" || pointerType === "touch") return;
      showTip(key, label, hint, event.currentTarget);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "touch") return;
      if (pointerOver.current === key) pointerOver.current = null;
      hideTip(key);
    },
    // A tap lands focus after the pointer already left the tile — so ANY
    // recent pointer presence suppresses the focus label for a beat. (This
    // is why the keyboard-only `focusin` in the tests fires no pointer at
    // all: with no pointer on the rail, focus owns the label outright.)
    onFocus: (event) => {
      if (Date.now() - touchAt.current < 700) return;
      showTip(key, label, hint, event.currentTarget);
    },
    onBlur: () => hideTip(key),
    "aria-describedby": tip?.key === key ? RAIL_TOOLTIP_ID : undefined,
  });

  const waiting = flags.inbox.needsYou;
  const live = flags.threads ?? 0;
  // The Projects tile carries the projects' own worst state — the same flags
  // the expanded rows (and the popover) print.
  const projectsFlag = projectTileFlag(flags.projects);
  const projectsWord = projectsFlag.kind === "none" ? "" : FLAG_STYLE[projectsFlag.kind].word;

  const toggleProjects = (el: HTMLElement) => {
    setTip(null);
    pointerOver.current = null;
    if (projectsOpen) {
      setProjectsOpen(false);
      return;
    }
    projectsTrigger.current = el;
    setProjectsOpen(true);
  };

  return (
    <div ref={hostRef} data-testid="sidebar" className="relative flex h-full w-[52px] shrink-0">
      <aside
        data-testid="sidebar-rail"
        aria-label="Primary"
        className="flex h-full w-[52px] flex-col items-center gap-[6px] border-r border-ink bg-surface py-3 text-ink"
      >
        <Link
          to="/"
          aria-label="Communication"
          draggable={false}
          data-testid="brand-home"
          className={`flex h-[26px] shrink-0 select-none items-center justify-center text-ink ${FOCUS_RING}`}
        >
          <Mark size={26} />
        </Link>

        {/* 4a way one: the expand button under the logo. Way two is ⌘\
            (Shell), way three is the edge handle (below). */}
        <RailTile
          testid="sidebar-expand"
          ariaLabel="Expand sidebar (⌘\)"
          icon={<ChevronsRight size={16} strokeWidth={1.6} aria-hidden="true" />}
          onClick={onExpand}
          tip={tipProps("expand", "Expand sidebar", "⌘\\")}
        />

        <RailTile
          testid="rail-item-search"
          ariaLabel="Search (⌘K)"
          icon={<Search size={18} strokeWidth={1.6} aria-hidden="true" />}
          onClick={() => openPalette()}
          tip={tipProps("search", "Search", "⌘K")}
        />

        {/* The rail\u2019s `+`: the same conversation dialog as the expanded
            `New thread`, kept reachable directly under Search. */}
        {signedIn ? (
          <RailTile
            testid="new-chat-rail"
            ariaLabel="New thread"
            icon={<Plus size={17} strokeWidth={1.7} aria-hidden="true" />}
            onClick={() => onNewChat()}
            tip={tipProps("new", "New thread")}
          />
        ) : null}

        <div className="h-px w-[24px] shrink-0 bg-line" aria-hidden="true" />

        <nav aria-label="Sections" className="flex shrink-0 flex-col items-center gap-[6px]">
          <RailTile
            to={routes.home()}
            end
            testid="rail-item-today"
            ariaLabel={waiting > 0 ? `Today · ${waiting} waiting` : "Today"}
            icon={<CalendarDays size={18} strokeWidth={1.6} aria-hidden="true" />}
            badge={<RailBadge name="today" count={waiting} tone="waiting" />}
            tip={tipProps("today", "Today")}
          />
          <RailTile
            to={CATCH_UP_PATH}
            testid="rail-item-catch-up"
            ariaLabel={unseenCatchUp > 0 ? `Catch up · ${unseenCatchUp} unseen` : "Catch up"}
            icon={<Inbox size={18} strokeWidth={1.6} aria-hidden="true" />}
            badge={<RailBadge name="catch-up" count={unseenCatchUp} tone="accent" />}
            tip={tipProps("catch-up", "Catch up")}
          />
          <RailTile
            to={routes.threads()}
            testid="rail-item-threads"
            ariaLabel={live > 0 ? `Threads · ${live} live` : "Threads"}
            icon={<MessageSquare size={18} strokeWidth={1.6} aria-hidden="true" />}
            badge={<RailBadge name="threads" count={live} tone="running" />}
            tip={tipProps("threads", "Threads")}
          />
          {/* The one tile with children: the click-surface (3a) that carries
              the projects, their state counts and the active project\u2019s
              repositories \u2014 what the labels used to say. */}
          <RailTile
            testid="rail-item-projects"
            ariaLabel={
              projectsFlag.count > 0
                ? `Projects · ${projectsFlag.count} ${projectsWord}`
                : "Projects"
            }
            icon={<Folder size={18} strokeWidth={1.6} aria-hidden="true" />}
            active={activeProjectId !== null}
            badge={
              <RailBadge
                name="projects"
                count={projectsFlag.count}
                tone={projectsFlag.kind === "failed" ? "failed" : "waiting"}
                glyph={
                  projectsFlag.kind === "none" ? undefined : FLAG_STYLE[projectsFlag.kind].glyph
                }
              />
            }
            hasPopup
            expanded={projectsOpen}
            controls="rail-projects-panel"
            onClick={toggleProjects}
            tip={tipProps("projects", "Projects")}
          />
          <RailTile
            to={routes.workflows()}
            testid="rail-item-workflows"
            ariaLabel="Workflows"
            icon={<Workflow size={18} strokeWidth={1.6} aria-hidden="true" />}
            tip={tipProps("workflows", "Workflows")}
          />
          <RailTile
            to={routes.profiles()}
            testid="rail-item-agents"
            ariaLabel="Agents"
            icon={<Bot size={18} strokeWidth={1.6} aria-hidden="true" />}
            tip={tipProps("agents", "Agents")}
          />
        </nav>

        <div className="mt-auto flex w-full shrink-0 flex-col items-center">
          <Footer rail />
        </div>
      </aside>

      {/* 3a: the dark label, 8px off the rail\u2019s edge, on hover and on
          keyboard focus \u2014 a `role="tooltip"` the described tile points at,
          with the optional mono chord. */}
      {tip ? (
        <span
          role="tooltip"
          id={RAIL_TOOLTIP_ID}
          data-testid="rail-tooltip"
          style={{ top: tip.top }}
          className="pointer-events-none absolute left-[60px] z-50 flex h-6 items-center gap-[8px] whitespace-nowrap rounded-[3px] bg-ink px-[9px] text-[12px] font-semibold text-surface"
        >
          <span
            aria-hidden="true"
            data-testid="rail-tooltip-arrow"
            className="absolute -left-[4px] top-1/2 h-[8px] w-[8px] -translate-y-1/2 rotate-45 bg-ink"
          />
          {tip.label}
          {tip.hint ? (
            <span className="font-mono text-[10.5px] font-normal text-line-strong">{tip.hint}</span>
          ) : null}
        </span>
      ) : null}

      <Popover
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        triggerRef={projectsTrigger}
        width={POPOVER_WIDTH_PX}
        panelId="rail-projects-panel"
        ariaLabel="Projects"
        data-testid="rail-projects-popover"
      >
        <span className="px-[6px] pb-[4px] pt-[2px] font-mono text-[10px] tracking-[.06em] text-faint">
          PROJECTS
        </span>
        {items.length === 0 && !projects.isPending ? (
          <span className="px-[6px] font-mono text-[11px] text-faint">no projects yet</span>
        ) : null}
        {items.map((project) => {
          const active = project.id === activeProjectId;
          return (
            <div key={project.id}>
              <Link
                to={routes.project(project.id)}
                data-testid={`rail-project-${project.id}`}
                onClick={() => setProjectsOpen(false)}
                className={`flex items-center gap-[6px] rounded-[3px] border px-[6px] py-1 text-[12.5px] font-semibold no-underline ${FOCUS_RING} ${
                  active
                    ? "ds-texture-accent border-ink text-ink"
                    : "border-transparent text-ink hover:bg-fill"
                }`}
              >
                <span className="min-w-0 truncate">{project.name}</span>
                <FlagBadge flag={flags.projects[project.id] ?? { kind: "none", count: 0 }} />
              </Link>
              {active ? (
                <RepoList projectHref={routes.project(project.id)} projectId={project.id} />
              ) : null}
            </div>
          );
        })}
      </Popover>

      <EdgeResizeHandle collapsed onExpand={onExpand} />
    </div>
  );
}

export interface SidebarProps {
  /** `panel` is the desktop column; `drawer` is the phone off-canvas sheet. */
  variant?: "panel" | "drawer";
  /** Drawer only: the close control (backdrop and esc are Shell's job). */
  onClose?: () => void;
  /** Finding 07: rail-only widths (768–1023px) force the collapsed rail.
   * The `sidebarCollapsed` preference is not touched — the expanded column
   * returns on its own as soon as the window is wide again. In that zone the
   * rail's expand (button, edge drag, ⌘\) opens the full column as an
   * OVERLAY, which is `Shell`'s `forceExpanded` mount below. */
  forceCollapsed?: boolean;
  /** Overlay only (4a): show the expanded column regardless of the
   * preference and the forced-rail zone. */
  forceExpanded?: boolean;
  /** The rail's expand affordances (button, edge drag), given the element
   * that started it so an overlay can return the keyboard there: `Shell`
   * opens the overlay in the rail zone; unbound, the `sidebarCollapsed`
   * preference decides (≥1024px). */
  onExpand?: (source?: HTMLElement) => void;
  /** The expanded column's collapse affordances (‹‹ button, edge drag):
   * `Shell` closes the overlay in the rail zone; unbound, the preference. */
  onCollapse?: () => void;
}

/** The expanded column's width, so `Shell` can park the floating Ask box. */
export const SIDEBAR_WIDTH_PX = 220;
/** The collapsed rail's width. */
export const SIDEBAR_RAIL_WIDTH_PX = 52;

/**
 * The column itself, at either placement, in either width. `Shell` decides
 * which placement shows; the width is the `sidebarCollapsed` layout
 * preference (a drawer is always the expanded column — a phone has no rail).
 */
export default function Sidebar({
  variant = "panel",
  onClose,
  forceCollapsed = false,
  forceExpanded = false,
  onExpand,
  onCollapse,
}: SidebarProps) {
  const { prefs, update } = useLayoutPrefs();
  const me = useMe();
  const flags = useSidebarFlags();
  // Finding 02: the Workflows/Agents rows count themselves off the same
  // reads the pages use (see the nav block in the expanded column).
  const pipelines = usePipelines();
  const profiles = useAgentProfiles();
  // Finding 8a: the Catch up row's badge is the reader's own unseen count —
  // one cheap read of the page's own endpoint, on the app's usual refetch and
  // nothing more. A read that has not answered, or failed, prints no number.
  const catchUp = useCatchUpItems();
  const unseenCatchUp = catchUp.data?.total_unseen ?? 0;
  const closeRef = useRef<HTMLButtonElement>(null);
  const [chatOpen, setChatOpen] = useState(false);

  // A drawer opens by intent; the keyboard must land somewhere in it.
  useLayoutEffect(() => {
    if (variant === "drawer") closeRef.current?.focus();
  }, [variant]);

  const collapsed =
    variant === "panel" && !forceExpanded && (forceCollapsed || prefs.sidebarCollapsed);

  // The rail zone hands both directions to `Shell` (overlay in, overlay
  // out); everywhere else they are plain preference writes.
  const expand = (source?: HTMLElement) =>
    onExpand ? onExpand(source) : update({ sidebarCollapsed: false });
  const collapse = () => (onCollapse ? onCollapse() : update({ sidebarCollapsed: true }));

  if (collapsed) {
    return (
      <>
        <Rail
          signedIn={Boolean(me.data)}
          unseenCatchUp={unseenCatchUp}
          onNewChat={() => setChatOpen(true)}
          onExpand={expand}
        />
        <NewConversationDialog open={chatOpen} onClose={() => setChatOpen(false)} />
      </>
    );
  }

  const mainNav: { to: string; label: string; testid: string; end?: boolean; flag: ReactNode }[] = [
    // Today (was Home; the route is still `/`) carries the count of what needs
    // a person — the Inbox the page used to be a separate row for.
    {
      to: routes.home(),
      label: "Today",
      testid: "sidebar-link-home",
      end: true,
      flag:
        flags.inbox.needsYou > 0 ? (
          <span
            aria-label={`${flags.inbox.needsYou} waiting`}
            className="ml-auto shrink-0 font-mono text-[10.5px] font-semibold text-st-waiting-tag-fg"
          >
            ! {flags.inbox.needsYou}
          </span>
        ) : null,
    },
    {
      // Finding 8a: what the agents did that this reader has not seen yet.
      to: CATCH_UP_PATH,
      label: "Catch up",
      testid: "sidebar-link-catch-up",
      flag:
        unseenCatchUp > 0 ? (
          <span className="ml-auto shrink-0 font-mono text-[10.5px] font-semibold text-accent-edge">
            {unseenCatchUp} unseen
          </span>
        ) : null,
    },
    {
      to: routes.threads(),
      label: "Threads",
      testid: "sidebar-link-threads",
      flag:
        flags.threads !== null && flags.threads > 0 ? (
          <span
            aria-label={`${flags.threads} live threads`}
            className="ml-auto shrink-0 font-mono text-[10.5px] font-semibold text-muted"
          >
            {flags.threads}
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <div className="relative flex h-full w-[220px] shrink-0">
        <aside
          data-testid="sidebar"
          aria-label="Primary"
          className="flex h-full w-[220px] flex-col gap-3 overflow-y-auto border-r border-ink bg-surface px-[10px] py-3 text-ink"
        >
          <div className="flex items-center gap-[9px] px-1">
            {/* The brand is a logo, not text: it links home (issue #61) and must
                never highlight or drag. `min-w-0 flex-1` keeps the wordmark's
                truncate (and the drawer's close button) behaving as before. */}
            <Link
              to="/"
              aria-label="Communication"
              draggable={false}
              data-testid="brand-home"
              className={`flex min-w-0 flex-1 select-none items-center gap-[9px] text-ink ${FOCUS_RING}`}
            >
              <Mark size={26} />
              <span className="min-w-0 truncate text-[13.5px] font-semibold">Communication</span>
            </Link>
            {variant === "drawer" ? (
              <button
                ref={closeRef}
                type="button"
                data-testid="sidebar-close"
                aria-label="Close sidebar"
                onClick={onClose}
                className={`icon-hit grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[3px] border border-fill-edge bg-surface text-[13px] text-ink ${FOCUS_RING}`}
              >
                ×
              </button>
            ) : (
              <button
                type="button"
                data-testid="sidebar-collapse"
                aria-label="Collapse sidebar"
                onClick={collapse}
                className={`icon-hit grid size-[22px] shrink-0 place-items-center rounded-[3px] border border-fill-edge bg-surface p-0 text-ink hover:bg-fill ${FOCUS_RING}`}
              >
                <ChevronsLeft size={14} strokeWidth={1.6} aria-hidden="true" />
              </button>
            )}
          </div>

          <NewChatRow signedIn={Boolean(me.data)} onNewChat={() => setChatOpen(true)} />

          <nav aria-label="Cross-project" className="flex flex-col gap-[2px]">
            {mainNav.map((item) => (
              <NavLink
                key={item.testid}
                to={item.to}
                end={item.end}
                data-testid={item.testid}
                className={({ isActive }) => `${ROW} ${isActive ? ROW_ACTIVE : ROW_INACTIVE}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.flag}
              </NavLink>
            ))}
          </nav>

          <div className="h-px bg-line" aria-hidden="true" />

          {/* Finding 10: projects are always the tree — the switcher mode and
              its preference are gone. */}
          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>PROJECTS</span>
            <ProjectTree />
          </div>

          {/* Finding 02: the LIBRARY block is gone. Workflows and Agents are
              top-level rows in the Today/Threads style, after the projects;
              Steps lives on as a tab of the Workflows page
              (`/workflows/steps`), and the workflow folders are off the
              sidebar entirely. The counts are the list reads' own rows — and
              there is no number at all while a read has not answered: a
              failed or in-flight read must not render `0`, which would read
              as "empty" (design 1b review). */}
          <nav aria-label="Workflows and agents" className="flex flex-col gap-[2px]">
            {(
              [
                {
                  to: routes.workflows(),
                  label: "Workflows",
                  testid: "sidebar-link-workflows",
                  count: pipelines.data?.pipelines.length,
                },
                {
                  to: routes.profiles(),
                  label: "Agents",
                  testid: "sidebar-link-profiles",
                  count: profiles.data?.items.length,
                },
              ] as const
            ).map((item) => (
              <NavLink
                key={item.testid}
                to={item.to}
                data-testid={item.testid}
                className={({ isActive }) => `${ROW} ${isActive ? ROW_ACTIVE : ROW_INACTIVE}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== undefined ? (
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] font-semibold text-muted">
                    {item.count}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>

          <Footer />
        </aside>
        {/* 4a way three, expanded side: dragging this edge back below ~120px
            snaps the column closed (the drawer has no rail to snap to). */}
        {variant === "panel" ? (
          <EdgeResizeHandle collapsed={false} onCollapse={collapse} onExpand={expand} />
        ) : null}
      </div>

      <NewConversationDialog open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  );
}
