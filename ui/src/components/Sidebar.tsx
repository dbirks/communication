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
 * Per DECISIONS.md, Project settings / Members / Add repository / Workflows in
 * use are NOT tree rows: they live behind the "⋯" that the project row shows on
 * hover or focus, and each one links to the route that already owns it.
 *
 * The column has two placements: `panel` (desktop, a sticky screen-height
 * flex item — the one that can collapse to the rail) and `drawer` (phone,
 * off-canvas, always the expanded column; `Shell` owns the backdrop and the
 * focus choreography, the `drawer` variant adds the close control and takes
 * focus in on mount).
 *
 * Anchored surfaces: the "⋯" menu and the rail flyouts are positioned against
 * the column's own non-scrolling host, not the row inside the scroller — the
 * 220px/52px column is `overflow-y-auto`, and a flyout that leaves it sideways
 * would be cut off at the column's edge by the scroll container.
 */
import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { ChevronDown, ChevronsLeft, ChevronsRight, Ellipsis, Plus } from "lucide-react";
import { useAgentProfiles, useMe, useProjects, useRepositories } from "../api/queries";
import type { Project } from "../api/types";
import { UNFILED_FOLDER, usePipelines } from "../api/pipelines";
import { useLayoutPrefs } from "../lib/prefs";
import { routes } from "../lib/routes";
import type { Flag } from "../lib/sidebarFlags";
import { useSidebarFlags } from "../lib/sidebarFlags";
import { Mark } from "./ds/Mark";
import { Menu, Popover, type MenuEntry } from "./ds/Menu";
import NewConversationDialog from "./NewConversationDialog";
import UserMenu from "./UserMenu";

/**
 * The command palette owns its open state and its global ⌘K listener; the
 * Ask buttons in the shell have no other handle, so they press ⌘K.
 */
export function openAsk(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

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

function InitialsTile({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid place-items-center rounded-[3px] border border-ink bg-surface font-mono text-ink ${className}`}
    >
      {initialsOf(name) || "?"}
    </span>
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
 * The four actions the "⋯" holds (DECISIONS: they left the tree). Each is a
 * route that already exists — and the fourth says what the project's Workflows
 * tab is: the library workflows this project puts in use.
 */
export function projectMenuEntries(project: Project, navigate: (to: string) => void): MenuEntry[] {
  const href = routes.project(project.id);
  return [
    {
      id: "settings",
      label: "Project settings",
      testId: "project-menu-settings",
      onSelect: () => navigate(routes.projectTab(project.id, "settings")),
    },
    {
      id: "members",
      label: "Members",
      testId: "project-menu-members",
      onSelect: () => navigate(`${href}/members`),
    },
    // There is no route of its own for adding a repository: the form is the
    // project overview's `+ add`, which opens `AddRepositoryDialog`. The menu
    // item goes to the page that owns that door rather than inventing a URL.
    {
      id: "add-repository",
      label: "Add repository",
      testId: "project-menu-add-repository",
      onSelect: () => navigate(href),
    },
    { separator: true },
    {
      id: "workflows",
      label: "Workflows in use",
      testId: "project-menu-workflows",
      onSelect: () => navigate(routes.projectTab(project.id, "pipelines")),
    },
  ];
}

/**
 * The tree mode (the default): one row per project, a chevron that opens the
 * repository list, the project's worst-state flag on the right, and the "⋯"
 * that appears on hover/focus. Expansion is a saved preference
 * (`expanded["project:<id>"]`), not local state, so it survives a reload. The
 * project the current route lives inside opens itself — once per entered
 * project, so a manual collapse is never fought while the route stays put.
 */
function ProjectTree({
  openMenuId,
  onOpenMenu,
  onCloseMenu,
}: {
  openMenuId: string | null;
  onOpenMenu: (project: Project, trigger: HTMLElement) => void;
  onCloseMenu: () => void;
}) {
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
        const menuOpen = openMenuId === project.id;
        return (
          <div key={project.id} className="group">
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
              {/* The "⋯" is painted only when the row is hovered or holds
                  focus (and while its menu is open): day-to-day the column
                  shows what you can act on, not what you configure. */}
              <button
                type="button"
                data-testid={`sidebar-project-menu-${project.id}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`${project.name} project menu`}
                onClick={(event) =>
                  menuOpen ? onCloseMenu() : onOpenMenu(project, event.currentTarget)
                }
                className={`icon-hit grid size-[22px] shrink-0 place-items-center rounded-[3px] border bg-surface p-0 text-ink opacity-0 hover:bg-fill group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 ${
                  menuOpen ? "border-ink opacity-100" : "border-fill-edge"
                } ${FOCUS_RING}`}
              >
                <Ellipsis size={14} strokeWidth={1.6} aria-hidden="true" />
              </button>
            </div>
            {open ? <RepoList projectHref={href} projectId={project.id} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The switcher mode (a saved preference): a 36px button for the current
 * project and a listbox of the rest, ending in "All projects". The
 * selection lives in this render — the preference store carries layout
 * settings, not a "current project" cursor.
 */
function ProjectSwitcher() {
  const navigate = useNavigate();
  const projects = useProjects();
  const flags = useSidebarFlags();
  const items = projects.data?.items ?? [];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const selected = items.find((project) => project.id === selectedId) ?? items[0] ?? null;

  const choose = (index: number) => {
    const project = items[index];
    setOpen(false);
    trigger.current?.focus();
    if (!project) {
      navigate(routes.projects());
      return;
    }
    setSelectedId(project.id);
    navigate(routes.project(project.id));
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActive(0);
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + items.length) % items.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  if (projects.isPending) return null;
  if (items.length === 0) {
    return <p className="px-2 font-mono text-[11px] text-faint">no projects yet</p>;
  }

  return (
    <div className="relative flex flex-col gap-1">
      <button
        ref={trigger}
        type="button"
        data-testid="project-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `Switch project — current: ${selected.name}` : "Switch project"}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (open) {
            setOpen(false);
            trigger.current?.focus();
          } else {
            setActive(0);
            setOpen(true);
          }
        }}
        className={`flex h-9 w-full items-center gap-2 rounded-[4px] border border-fill-edge bg-fill px-2 text-[13px] font-semibold text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg ${FOCUS_RING}`}
      >
        {selected ? (
          <>
            <InitialsTile name={selected.name} className="h-[22px] w-[22px] text-[9.5px]" />
            <span className="min-w-0 flex-1 truncate text-left">{selected.name}</span>
            <FlagBadge flag={flags.projects[selected.id] ?? { kind: "none", count: 0 }} />
            <Chevron open={open} size={14} className="text-ink" />
          </>
        ) : null}
      </button>
      {open ? (
        <div
          ref={list}
          role="listbox"
          aria-label="Projects"
          data-testid="project-switcher-list"
          tabIndex={-1}
          className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-64 w-full overflow-y-auto rounded-[4px] border border-ink bg-surface p-1 shadow-raised"
        >
          {items.map((project, index) => (
            <button
              key={project.id}
              type="button"
              role="option"
              aria-selected={project.id === selected?.id}
              onClick={() => choose(index)}
              onMouseEnter={() => setActive(index)}
              className={`flex w-full items-center gap-2 rounded-[3px] px-2 py-1 text-left text-[12.5px] text-ink ${
                index === active ? "bg-fill" : ""
              } ${FOCUS_RING}`}
            >
              <InitialsTile
                name={project.name}
                className="h-[18px] w-[18px] text-[8.5px] border-fill-edge"
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <FlagBadge flag={flags.projects[project.id] ?? { kind: "none", count: 0 }} />
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={false}
            data-testid="project-switcher-all"
            onClick={() => choose(items.length)}
            onMouseEnter={() => setActive(items.length)}
            className={`flex w-full items-center rounded-[3px] px-2 py-1 text-left text-[12.5px] text-ink ${
              active === items.length ? "bg-fill" : ""
            } ${FOCUS_RING}`}
          >
            All projects
          </button>
        </div>
      ) : null}
      {selected ? (
        <RepoList projectHref={routes.project(selected.id)} projectId={selected.id} />
      ) : null}
    </div>
  );
}

/**
 * The LIBRARY block. Workflows and Agent profiles carry real counts (the
 * pipeline and profile reads); Steps carries none — there is no node-template
 * store behind a number yet, and an invented one is exactly what the column
 * must not do. Workflows expands to its folders (ADR-0049 § 8) when the
 * `showWorkflowFolders` preference allows: the folders are the wire's own
 * `folder` values with the list read's own counts (Unfiled last), the chevron
 * state is the saved `expanded["library:workflows"]` preference, and each
 * folder links the index filtered on it. With the preference off the row is a
 * plain link again.
 */
function LibrarySection() {
  const pipelines = usePipelines();
  const profiles = useAgentProfiles();
  const { prefs, update } = useLayoutPrefs();
  const items = pipelines.data?.pipelines ?? [];
  // The count is the list read's own rows — and there is no number at all
  // while that read has not answered: a failed or in-flight read must not
  // render `0`, which would read as "the library is empty" (design 1b review).
  const workflows = pipelines.data?.pipelines.length;
  const profileCount = profiles.data?.items.length;

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const name = item.folder && item.folder.length > 0 ? item.folder : UNFILED_FOLDER;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      if (a[0] === UNFILED_FOLDER) return 1;
      if (b[0] === UNFILED_FOLDER) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [items]);

  const showFolders = prefs.showWorkflowFolders;
  const workflowsOpen = showFolders && prefs.expanded["library:workflows"] === true;

  const row = (to: string, label: string, testid: string, count: number | undefined) => (
    <NavLink
      to={to}
      data-testid={testid}
      className={({ isActive }) => `${ROW} ${isActive ? ROW_ACTIVE : ROW_INACTIVE}`}
    >
      <span className="w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="shrink-0 font-mono text-[10.5px] text-muted">{count}</span>
      ) : null}
    </NavLink>
  );

  return (
    <div className="flex min-h-0 flex-col gap-px">
      <span className={SECTION_LABEL}>LIBRARY</span>
      <div className="flex items-center gap-1">
        {showFolders ? (
          <button
            type="button"
            data-testid="sidebar-workflows-toggle"
            aria-expanded={workflowsOpen}
            aria-label={`${workflowsOpen ? "Hide" : "Show"} workflow folders`}
            onClick={() =>
              update({
                expanded: {
                  ...prefs.expanded,
                  "library:workflows": !workflowsOpen,
                },
              })
            }
            className={`icon-hit grid size-4 shrink-0 place-items-center rounded-[3px] p-0 text-ink-2 hover:bg-fill ${FOCUS_RING}`}
          >
            <Chevron open={workflowsOpen} size={14} />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden="true" />
        )}
        <NavLink
          to={routes.workflows()}
          data-testid="sidebar-link-workflows"
          className={({ isActive }) =>
            `flex min-w-0 flex-1 items-center gap-2 rounded-[3px] border px-2 py-[4px] text-[12.5px] no-underline ${FOCUS_RING} ${
              isActive ? ROW_ACTIVE : ROW_INACTIVE
            }`
          }
        >
          <span className="min-w-0 flex-1 truncate">Workflows</span>
          {workflows !== undefined ? (
            <span className="shrink-0 font-mono text-[10.5px] text-muted">{workflows}</span>
          ) : null}
        </NavLink>
      </div>
      {workflowsOpen && folderCounts.length > 0 ? (
        <div className="ml-[14px] flex flex-col gap-px border-l border-line pl-[10px]">
          {folderCounts.map(([name, count]) => {
            const slug =
              name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "folder";
            return (
              <NavLink
                key={name}
                to={`${routes.workflows()}?folder=${encodeURIComponent(name)}`}
                data-testid={`sidebar-workflow-folder-${slug}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-[3px] px-2 py-[3px] font-mono text-[11.5px] no-underline ${FOCUS_RING} ${
                    isActive ? "text-ink" : "text-ink-2 hover:underline"
                  }`
                }
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 text-[10.5px] text-muted">{count}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
      {row(routes.steps(), "Steps", "sidebar-link-steps", undefined)}
      {row(routes.profiles(), "Agent profiles", "sidebar-link-profiles", profileCount)}
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

/** The `New chat` row: one chat-starting button (the shared conversation
 * dialog, with its project picker) and the `⌘K` box the Ask preference puts
 * beside it. Signed-in affordance only — "start something" needs a member. */
function NewChatRow({
  signedIn,
  onNewChat,
  askInSidebar,
}: {
  signedIn: boolean;
  onNewChat: () => void;
  askInSidebar: boolean;
}) {
  return (
    <div className="flex gap-[6px]">
      {signedIn ? (
        <button
          type="button"
          data-testid="new-chat"
          onClick={onNewChat}
          className={`h-[30px] min-w-0 flex-1 truncate rounded-[4px] border border-fill-edge bg-fill px-2 text-[12.5px] font-semibold text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg ${FOCUS_RING}`}
        >
          New chat
        </button>
      ) : null}
      {askInSidebar ? (
        <button
          type="button"
          data-testid="ask-sidebar"
          onClick={openAsk}
          aria-label="Ask the assistant (⌘K)"
          className={`h-[30px] shrink-0 rounded-[4px] border border-fill-edge bg-surface px-[9px] font-mono text-[11px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill ${FOCUS_RING}`}
        >
          ⌘K
        </button>
      ) : null}
    </div>
  );
}

/** The rail's `+`: the same conversation dialog as the expanded `New chat`. */
function RailNewChat({ signedIn, onNewChat }: { signedIn: boolean; onNewChat: () => void }) {
  if (!signedIn) return null;
  return (
    <button
      type="button"
      data-testid="new-chat-rail"
      aria-label="New chat"
      onClick={onNewChat}
      className={`grid size-[28px] shrink-0 place-items-center rounded-[4px] border border-fill-edge bg-fill text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-disabled-bg ${FOCUS_RING}`}
    >
      <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

/** The rail's label-under-a-tile type (mono 9.5). */
const RAIL_LABEL =
  "block font-mono text-[9.5px] leading-[1.2] no-underline text-muted hover:text-ink";

/**
 * The collapsed column: a 52px rail (handoff 3c). The mark, `+`, Today, one
 * initials tile per project, Library, the expand control and the avatar.
 * A tile's flyout is the honest replacement for the labels: it names the
 * project, states its worst flag and links its repositories.
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

        <NavLink
          to={routes.home()}
          end
          data-testid="sidebar-link-home"
          className={({ isActive }) =>
            `${RAIL_LABEL} ${
              // Today keeps its word even at 52px; amber is the waiting flag the
              // expanded row carries, and it is colour-plus-word everywhere else.
              isActive
                ? "font-semibold text-ink"
                : flags.inbox.needsYou > 0
                  ? "text-st-waiting-tag-fg"
                  : ""
            }`
          }
        >
          Today
        </NavLink>

        <div className="h-px w-[28px] shrink-0 bg-line" aria-hidden="true" />

        {/* The tiles keep their natural height (2c draws Library directly
            under them) and only scroll when there is not enough of it: a
            growing `flex-1` would push Library down to the bottom group. */}
        <div className="flex w-full min-h-0 shrink flex-col items-center gap-[8px] overflow-y-auto">
          {items.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <NavLink
                key={project.id}
                to={routes.project(project.id)}
                data-testid={`sidebar-rail-project-${project.id}`}
                aria-label={project.name}
                onMouseEnter={(event) => openFlyoutFor(event.currentTarget, project.id)}
                onMouseLeave={scheduleClose}
                onFocus={(event) => openFlyoutFor(event.currentTarget, project.id)}
                onBlur={scheduleClose}
                className={`grid size-[30px] shrink-0 place-items-center rounded-[3px] border font-mono text-[10px] no-underline ${FOCUS_RING} ${
                  active
                    ? "border-ink bg-accent-tint text-ink"
                    : "border-fill-edge bg-surface text-muted hover:bg-fill hover:text-ink"
                }`}
              >
                {initialsOf(project.name) || "?"}
              </NavLink>
            );
          })}
        </div>

        <div className="h-px w-[28px] shrink-0 bg-line" aria-hidden="true" />

        <NavLink
          to={routes.workflows()}
          data-testid="sidebar-rail-library"
          className={({ isActive }) => `${RAIL_LABEL} ${isActive ? "font-semibold text-ink" : ""}`}
        >
          Library
        </NavLink>

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
        width={212}
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
                className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink no-underline hover:underline"
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
export default function Sidebar({ variant = "panel", onClose }: SidebarProps) {
  const { prefs, update } = useLayoutPrefs();
  const me = useMe();
  const navigate = useNavigate();
  const flags = useSidebarFlags();
  const projectsQuery = useProjects();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [chatOpen, setChatOpen] = useState(false);

  // The project whose "⋯" menu stands open, and the button that opened it.
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);

  // A drawer opens by intent; the keyboard must land somewhere in it.
  useLayoutEffect(() => {
    if (variant === "drawer") closeRef.current?.focus();
  }, [variant]);

  const collapsed = variant === "panel" && prefs.sidebarCollapsed;

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
      to: routes.threads(),
      label: "My chats",
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

  const openProjectMenu = (project: Project, trigger: HTMLElement) => {
    menuTrigger.current = trigger;
    setMenuProjectId(project.id);
  };
  const closeProjectMenu = () => setMenuProjectId(null);
  const openMenuProject =
    (projectsQuery.data?.items ?? []).find((project) => project.id === menuProjectId) ?? null;

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

          <NewChatRow
            signedIn={Boolean(me.data)}
            onNewChat={() => setChatOpen(true)}
            askInSidebar={prefs.askPlacement === "sidebar"}
          />

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

          <div className="flex flex-col gap-1">
            <span className={SECTION_LABEL}>
              {prefs.projectsMode === "switcher" ? "PROJECT" : "PROJECTS"}
            </span>
            {prefs.projectsMode === "switcher" ? (
              <ProjectSwitcher />
            ) : (
              <ProjectTree
                openMenuId={menuProjectId}
                onOpenMenu={openProjectMenu}
                onCloseMenu={closeProjectMenu}
              />
            )}
          </div>

          <LibrarySection />

          <Footer />
        </aside>

        {/* The "⋯" menu is anchored to its row but mounted outside the
            scrolling column, so the 220px scroller never cuts it. */}
        <Menu
          open={openMenuProject !== null}
          onClose={closeProjectMenu}
          triggerRef={menuTrigger}
          side="bottom"
          align="end"
          width={190}
          height={160}
          ariaLabel={
            openMenuProject ? `${openMenuProject.name} project actions` : "Project actions"
          }
          data-testid="sidebar-project-menu"
          items={openMenuProject ? projectMenuEntries(openMenuProject, navigate) : []}
        />
      </div>

      <NewConversationDialog open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  );
}
