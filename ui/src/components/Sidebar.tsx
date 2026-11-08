/**
 * Sidebar — the shell's one left column (handoff 2c/3c, `Sidebar.dc.html`).
 *
 * It has two widths, and which one you get is a saved layout preference
 * (`sidebarCollapsed`, `lib/prefs.ts`), not local state: 220px expanded, or a
 * 52px rail of tiles. The rail is not a second implementation of the content:
 * it carries the same facts — the same projects, the same worst-state flags —
 * in the same reads, and every tile that hides a list (a project) opens a
 * `ds/Popover` flyout beside it so nothing becomes unreachable when the labels
 * go away.
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
import { useEffect, useMemo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Plus,
} from "lucide-react";
import { useAgentProfiles, useMe, useProjects, useRepositories } from "../api/queries";
import { usePipelines } from "../api/pipelines";
import { useCatchUpItems } from "../api/catchup";
import { useLayoutPrefs } from "../lib/prefs";
import { routes } from "../lib/routes";
import type { Flag } from "../lib/sidebarFlags";
import { useSidebarFlags } from "../lib/sidebarFlags";
import { Mark } from "./ds/Mark";
import { Popover } from "./ds/Menu";
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

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Characterwise longest shared prefix of a group of names. */
function commonPrefix(names: readonly string[]): string {
  let prefix = names[0] ?? "";
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * The rail tiles' initials — unique within the rail wherever the names
 * allow, and a pure function of the list (so a reload never re-shuffles
 * them). Pass 1 is the plain two-word initials. Where those collide the
 * tile keeps the first letter and takes the shortest head (1–2 characters,
 * so at most 3 on the tile) of what the colliding names have after the
 * part they share — the distinguishing token starts there, turning three
 * “Emu rcn rcn-labA-…/-devA-…/rcnA-…” projects into `EL`/`ED`/`EA`.
 * Names too alike for that fall back to 2–3 characters of the whole name;
 * truly identical names cannot be told apart by ink alone, so they keep
 * the same tile and the flyout's full name carries the difference.
 */
export function railInitials(names: readonly string[]): string[] {
  const out = names.map((name) => initialsOf(name) || "?");
  const groups = new Map<string, number[]>();
  out.forEach((initials, index) => {
    const group = groups.get(initials);
    if (group) group.push(index);
    else groups.set(initials, [index]);
  });
  const assignable = (candidates: readonly string[], indexes: readonly number[]): boolean =>
    new Set(candidates).size === candidates.length &&
    candidates.every(
      (candidate) => !out.some((value, i) => !indexes.includes(i) && value === candidate),
    );
  for (const [initials, indexes] of groups) {
    if (indexes.length < 2) continue;
    const memberNames = indexes.map((index) => names[index]);
    const shared = commonPrefix(memberNames);
    const letter = (initials[0] ?? "?").toUpperCase();
    const tails = memberNames.map((name) =>
      name
        .slice(shared.length)
        .replace(/^[^A-Za-z0-9]+/, "")
        .toUpperCase(),
    );
    let resolved = false;
    for (let take = 1; take <= 2 && !resolved; take += 1) {
      const candidates = tails.map((tail) => letter + (tail.slice(0, take) || "?"));
      if (assignable(candidates, indexes)) {
        candidates.forEach((candidate, i) => {
          out[indexes[i]] = candidate;
        });
        resolved = true;
      }
    }
    for (let take = 2; take <= 3 && !resolved; take += 1) {
      const candidates = memberNames.map((name) => name.trim().slice(0, take).toUpperCase());
      if (assignable(candidates, indexes)) {
        candidates.forEach((candidate, i) => {
          out[indexes[i]] = candidate;
        });
        resolved = true;
      }
    }
    // Still unresolved (identical, or case-only differences): the members
    // keep the shared base initials; the flyout names each one in full.
  }
  return out;
}

/** The row rhythm: the active row is an ink border on the 4px blueprint grid. */
const ROW =
  "flex items-center gap-[6px] rounded-[3px] border px-[8px] py-[5px] text-[13px] text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";
const ROW_INACTIVE = "border-transparent text-muted hover:text-ink";
const ROW_ACTIVE = "ds-texture-accent border-ink bg-surface font-semibold text-ink";

const SECTION_LABEL = "px-2 pb-1 font-mono text-[10px] tracking-[.06em] text-faint";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/** The rail's hover flyout stays open long enough to cross the 4px gap. */
const FLYOUT_CLOSE_MS = 150;

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

/** The rail's `+`: the same conversation dialog as the expanded `New thread`. */
function RailNewChat({ signedIn, onNewChat }: { signedIn: boolean; onNewChat: () => void }) {
  if (!signedIn) return null;
  return (
    <button
      type="button"
      data-testid="new-chat-rail"
      aria-label="New thread"
      title="New thread"
      onClick={onNewChat}
      className={`grid size-[28px] shrink-0 place-items-center rounded-[4px] border border-fill-edge bg-fill text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg ${FOCUS_RING}`}
    >
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

/**
 * A rail item: the 30px icon tile the design draws for every labelled start
 * (Today, Library) — a lucide icon, never bare text under another control's
 * button (review 3c: the text `Today` sat under the `+` and read as its
 * caption). The word survives as the tooltip and the aria-label, so the
 * meaning is never icon alone.
 */
function RailItem({
  to,
  label,
  testid,
  icon,
  end = false,
  className = "",
}: {
  to: string;
  label: string;
  testid: string;
  icon: ReactNode;
  end?: boolean;
  className?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      data-testid={testid}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        `grid size-[30px] shrink-0 place-items-center rounded-[3px] border no-underline ${FOCUS_RING} ${
          isActive
            ? "border-ink bg-accent-tint text-ink"
            : `border-fill-edge bg-surface text-muted hover:bg-fill hover:text-ink ${className}`
        }`
      }
    >
      {icon}
    </NavLink>
  );
}

/**
 * The collapsed column: a 52px rail (handoff 3c). The mark, `+`, Today, one
 * initials tile per project, Library, the expand control and the avatar.
 * A tile's flyout is the honest replacement for the labels: it names the
 * project, states its worst flag and links its repositories.
 * Tiles carry the project's worst-state flag (design 3c) as a corner
 * badge — glyph + count from the very data the expanded rows read
 * (`useSidebarFlags`), never colour alone — and their initials are made
 * unique within the rail (`railInitials`), so three “Emu rcn …” projects
 * are three distinguishable tiles.
 */
function Rail({
  signedIn,
  onNewChat,
  onExpand,
}: {
  signedIn: boolean;
  onNewChat: () => void;
  onExpand: () => void;
}) {
  const projects = useProjects();
  const flags = useSidebarFlags();
  const location = useLocation();
  const items = projects.data?.items ?? [];
  const activeProjectId = projectIdFromPath(location.pathname);
  // One pass over the whole list: a tile's letters depend on its
  // neighbours', so they are computed together, deterministically.
  const tiles = useMemo(() => railInitials(items.map((project) => project.name)), [items]);

  // One flyout at a time, anchored to whichever tile opened it. The popover
  // is a child of the column's host (outside the scrolling list), so the
  // scroll container cannot cut it at 52px.
  const triggerRef = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [flyoutId, setFlyoutId] = useState<string | null>(null);
  const flyoutProject = items.find((project) => project.id === flyoutId) ?? null;

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeNow = () => {
    cancelClose();
    setFlyoutId(null);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(closeNow, FLYOUT_CLOSE_MS);
  };
  const openFlyoutFor = (trigger: HTMLElement, id: string) => {
    cancelClose();
    triggerRef.current = trigger;
    setFlyoutId(id);
  };

  useEffect(() => cancelClose, []);
  // Navigation delivered the flyout's link; the next hover opens the next one.
  useEffect(() => setFlyoutId(null), [location.pathname]);

  return (
    <div className="relative flex h-full w-[52px] shrink-0">
      <aside
        data-testid="sidebar"
        aria-label="Primary"
        className="flex h-full w-[52px] flex-col items-center gap-[10px] border-r border-ink bg-surface py-3 text-ink"
      >
        <Link
          to="/"
          aria-label="Communication"
          draggable={false}
          data-testid="brand-home"
          className={`flex select-none items-center justify-center text-ink ${FOCUS_RING}`}
        >
          <Mark size={24} />
        </Link>

        <RailNewChat signedIn={signedIn} onNewChat={onNewChat} />

        {/* Today: an icon tile like every other rail item. Amber is the
            waiting flag the expanded row carries, and the tooltip names the
            count, so the state is never colour alone. */}
        <RailItem
          to={routes.home()}
          label={flags.inbox.needsYou > 0 ? `Today · ${flags.inbox.needsYou} waiting` : "Today"}
          testid="sidebar-link-home"
          end
          className={flags.inbox.needsYou > 0 ? "text-st-waiting-tag-fg" : ""}
          icon={<CalendarDays size={15} strokeWidth={1.6} aria-hidden="true" />}
        />

        <div className="h-px w-[28px] shrink-0 bg-line" aria-hidden="true" />

        {/* The tiles keep their natural height (2c draws Library directly
            under them) and only scroll when there is not enough of it: a
            growing `flex-1` would push Library down to the bottom group. */}
        <div className="flex w-full min-h-0 shrink flex-col items-center gap-[8px] overflow-y-auto">
          {items.map((project, index) => {
            const active = project.id === activeProjectId;
            const flag = flags.projects[project.id] ?? { kind: "none", count: 0 };
            const style = flag.kind === "none" || flag.count === 0 ? null : FLAG_STYLE[flag.kind];
            return (
              <NavLink
                key={project.id}
                to={routes.project(project.id)}
                data-testid={`sidebar-rail-project-${project.id}`}
                aria-label={style ? `${project.name} · ${flag.count} ${style.word}` : project.name}
                onMouseEnter={(event) => openFlyoutFor(event.currentTarget, project.id)}
                onMouseLeave={scheduleClose}
                onFocus={(event) => openFlyoutFor(event.currentTarget, project.id)}
                onBlur={scheduleClose}
                className={`relative grid size-[30px] shrink-0 place-items-center rounded-[3px] border font-mono text-[10px] no-underline ${FOCUS_RING} ${
                  active
                    ? "border-ink bg-accent-tint text-ink"
                    : "border-fill-edge bg-surface text-muted hover:bg-fill hover:text-ink"
                }`}
              >
                {tiles[index] || "?"}
                {/* The worst-state flag, design 3c's corner badge: the same
                    data the expanded row prints (one `FlagBadge`'s worth),
                    glyph + count at rail size. */}
                {style ? (
                  <span
                    aria-hidden="true"
                    data-testid={`sidebar-rail-flag-${project.id}`}
                    className={`absolute -bottom-[5px] -right-[5px] rounded-[3px] border border-line-strong bg-surface px-[2px] font-mono text-[8.5px] font-semibold leading-[11px] ${style.fg}`}
                  >
                    {style.glyph}
                    {flag.count}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
        </div>

        <div className="h-px w-[28px] shrink-0 bg-line" aria-hidden="true" />

        <RailItem
          to={routes.workflows()}
          label="Workflows"
          testid="sidebar-rail-library"
          icon={<BookOpen size={15} strokeWidth={1.6} aria-hidden="true" />}
        />

        <div className="mt-auto flex w-full flex-col items-center gap-[10px]">
          <button
            type="button"
            data-testid="sidebar-expand"
            aria-label="Expand sidebar"
            onClick={onExpand}
            className={`icon-hit grid size-[22px] shrink-0 place-items-center rounded-[3px] border border-fill-edge bg-surface p-0 text-ink hover:bg-fill ${FOCUS_RING}`}
          >
            <ChevronsRight size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <Footer rail />
        </div>
      </aside>

      <Popover
        open={flyoutProject !== null}
        onClose={closeNow}
        triggerRef={triggerRef}
        side="right"
        // 260, not 212: the flyout's project name is its whole content, and
        // review 3c watched it cut to `Emu rcn rcn-rev3-1793644…`. The name
        // wraps onto as many lines as it needs inside this width.
        width={260}
        height={160}
        ariaLabel={flyoutProject ? `${flyoutProject.name} repositories` : "Project"}
        data-testid={flyoutProject ? `sidebar-rail-flyout-${flyoutProject.id}` : undefined}
      >
        {flyoutProject ? (
          <div
            onMouseEnter={cancelClose}
            onMouseLeave={closeNow}
            onFocus={cancelClose}
            onBlur={scheduleClose}
            data-testid={`sidebar-rail-flyout-content-${flyoutProject.id}`}
          >
            <div className="flex items-center gap-2 px-[6px] pb-[4px] pt-[2px]">
              <Link
                to={routes.project(flyoutProject.id)}
                className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-[17px] text-ink no-underline hover:underline"
              >
                {flyoutProject.name}
              </Link>
              <FlagBadge flag={flags.projects[flyoutProject.id] ?? { kind: "none", count: 0 }} />
            </div>
            <RepoList projectHref={routes.project(flyoutProject.id)} projectId={flyoutProject.id} />
          </div>
        ) : null}
      </Popover>
    </div>
  );
}

export interface SidebarProps {
  /** `panel` is the desktop column; `drawer` is the phone off-canvas sheet. */
  variant?: "panel" | "drawer";
  /** Drawer only: the close control (backdrop and esc are Shell's job). */
  onClose?: () => void;
  /** Panel only (finding 07): rail-only widths (768–1023px) force the
   * collapsed rail. The `sidebarCollapsed` preference is not touched — the
   * expanded column returns on its own as soon as the window is wide again. */
  forceCollapsed?: boolean;
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

  const collapsed = variant === "panel" && (forceCollapsed || prefs.sidebarCollapsed);

  if (collapsed) {
    return (
      <>
        <Rail
          signedIn={Boolean(me.data)}
          onNewChat={() => setChatOpen(true)}
          onExpand={() => update({ sidebarCollapsed: false })}
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
                onClick={() => update({ sidebarCollapsed: true })}
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
      </div>

      <NewConversationDialog open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  );
}
