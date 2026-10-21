/**
 * Sidebar v3 — the permanent 240px column that replaces the top app bar
 * (handoff 5a, `SidebarV3.dc.html`).
 *
 * Everything the column shows is real: the project tree and its status flags
 * come from the same reads Inbox runs (`useSidebarFlags` projects the
 * `lib/attention.ts` reduction, worst state per project); the library counts
 * are live pipeline/profile reads; the footer is the signed-in identity the
 * old bar carried (`user-badge`, `sign-out`, `replica-badge` move here). What
 * the backend cannot supply yet is simply absent — no fake folders under
 * Workflows, no count on Steps (there is no template store), no per-repo
 * flags.
 *
 * The column has two placements: `panel` (desktop, a sticky screen-height
 * flex item) and `drawer` (phone, off-canvas; `Shell` owns the backdrop and
 * the focus choreography, the `drawer` variant adds the close control and
 * takes focus in on mount).
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
import { Link, NavLink, useNavigate } from "react-router";
import { problemOf } from "../api/client";
import { useAgentProfiles, useLogout, useMe, useProjects, useRepositories } from "../api/queries";
import { UNFILED_FOLDER, usePipelines } from "../api/pipelines";
import { useReplicaName } from "../api/replica";
import { useLayoutPrefs } from "../lib/prefs";
import { routes } from "../lib/routes";
import type { Flag } from "../lib/sidebarFlags";
import { useSidebarFlags } from "../lib/sidebarFlags";
import { Button } from "./ds/Button";
import { Mark } from "./ds/Mark";
import NewMenu from "./NewMenu";

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

/** The 12×12 chevron the design names by path; down = open, right = closed. */
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
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"} ${className}`}
    >
      <path
        d="M3 4.5l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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

/** One repository under a project: indent 14, left rule, mono 11.5. */
function RepoRow({ projectHref, name }: { projectHref: string; name: string }) {
  return (
    <NavLink
      to={`${projectHref}/${name}`}
      className={`flex items-center gap-2 px-2 py-[3px] font-mono text-[11.5px] text-ink-2 no-underline hover:underline ${FOCUS_RING} rounded-[3px]`}
    >
      <span className="min-w-0 truncate">{name}</span>
    </NavLink>
  );
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
 * repository list, the project's worst-state flag on the right. Expansion is
 * a saved preference (`expanded["project:<id>"]`), not local state, so it
 * survives a reload.
 */
function ProjectTree() {
  const { prefs, update } = useLayoutPrefs();
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
            <div className="flex items-center gap-1 px-[6px] py-1">
              <button
                type="button"
                data-testid={`sidebar-project-toggle-${project.id}`}
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} ${project.name} repositories`}
                onClick={() => {
                  setExpanded(project.id, !open);
                }}
                className={`grid size-4 shrink-0 place-items-center rounded-[3px] p-0 text-ink-2 hover:bg-fill ${FOCUS_RING}`}
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
              <InitialsTile name={project.name} className="h-[18px] w-[18px] text-[8.5px]" />
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
 * `folder` values with the list read's own counts (Unfiled last), the
 * chevron state is the saved `expanded["library:workflows"]` preference, and
 * each folder links the index filtered on it. With the preference off the
 * row is a plain link again.
 */
function LibrarySection() {
  const pipelines = usePipelines();
  const profiles = useAgentProfiles();
  const { prefs, update } = useLayoutPrefs();
  const items = pipelines.data?.pipelines ?? [];
  const workflows = items.length;
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
            className={`grid size-4 shrink-0 place-items-center rounded-[3px] p-0 text-ink-2 hover:bg-fill ${FOCUS_RING}`}
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
 * The footer the app bar used to carry: identity tile + name (`user-badge`),
 * the Settings link, sign out (`sign-out`) and the `replica-badge` line —
 * the last honest operations signal the shell carries.
 */
function Footer() {
  const me = useMe();
  const logout = useLogout();
  const replica = useReplicaName();
  const navigate = useNavigate();

  const onSignOut = () => {
    logout.mutate(undefined, {
      onSuccess: () => navigate("/login"),
      onError: () => navigate("/login"),
    });
  };
  const error = logout.error ? problemOf(logout.error).detail || "Sign out failed." : null;

  return (
    <div className="mt-auto border-t border-line px-1 pt-2">
      {me.data ? (
        <div className="flex items-center gap-2">
          <InitialsTile name={me.data.display_name} className="h-[26px] w-[26px] text-[10px]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
            <strong data-testid="user-badge" className="font-semibold text-ink">
              {me.data.display_name}
            </strong>
          </span>
          <Link
            to={routes.settings("layout")}
            className={`shrink-0 rounded-[3px] text-[12px] text-muted no-underline hover:text-ink ${FOCUS_RING}`}
          >
            Settings
          </Link>
        </div>
      ) : (
        <span className="font-mono text-[11px] text-faint">not signed in</span>
      )}
      <div className="mt-1 flex items-center gap-2">
        <Button
          variant="secondaryPlain"
          data-testid="sign-out"
          onClick={onSignOut}
          className="h-[22px] px-2 text-[11px]"
        >
          Sign out
        </Button>
        {error ? (
          <span
            role="alert"
            className="min-w-0 truncate font-mono text-[11px] text-st-failed-tag-fg"
          >
            × {error}
          </span>
        ) : null}
        <span
          data-testid="replica-badge"
          className="ml-auto shrink-0 font-mono text-[10.5px] text-faint"
        >
          replica: {replica}
        </span>
      </div>
    </div>
  );
}

export interface SidebarProps {
  /** `panel` is the desktop column; `drawer` is the phone off-canvas sheet. */
  variant?: "panel" | "drawer";
  /** Drawer only: the close control (backdrop and esc are Shell's job). */
  onClose?: () => void;
}

/** The column itself, at either placement. `Shell` decides which one shows. */
export default function Sidebar({ variant = "panel", onClose }: SidebarProps) {
  const { prefs } = useLayoutPrefs();
  const flags = useSidebarFlags();
  const me = useMe();
  const closeRef = useRef<HTMLButtonElement>(null);

  // A drawer opens by intent; the keyboard must land somewhere in it.
  useLayoutEffect(() => {
    if (variant === "drawer") closeRef.current?.focus();
  }, [variant]);

  const mainNav: { to: string; label: string; testid: string; end?: boolean; flag: ReactNode }[] = [
    { to: routes.home(), label: "Home", testid: "sidebar-link-home", end: true, flag: null },
    {
      to: routes.inbox(),
      label: "Inbox",
      testid: "sidebar-link-inbox",
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
      to: routes.board(),
      label: "Board",
      testid: "sidebar-link-board",
      flag:
        flags.board.running > 0 ? (
          <FlagBadge flag={{ kind: "running", count: flags.board.running }} />
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
    <aside
      data-testid="sidebar"
      aria-label="Primary"
      className="flex h-full w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-ink bg-surface px-[10px] py-3 text-ink"
    >
      <div className="flex items-center gap-[9px] px-1">
        <Mark size={26} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">Communication</span>
        {variant === "drawer" ? (
          <button
            ref={closeRef}
            type="button"
            data-testid="sidebar-close"
            aria-label="Close sidebar"
            onClick={onClose}
            className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[3px] border border-fill-edge bg-surface font-mono text-[13px] text-ink ${FOCUS_RING}`}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="flex gap-[6px]">
        {/* "New" starts things, so it is a signed-in affordance only. */}
        <div
          className={
            me.data
              ? "min-w-0 flex-1 [&>div]:w-full [&>div>button]:h-[30px] [&>div>button]:w-full [&>div>button]:justify-center"
              : "hidden"
          }
        >
          {me.data ? <NewMenu /> : null}
        </div>
        {prefs.askPlacement === "sidebar" ? (
          <button
            type="button"
            data-testid="ask-sidebar"
            onClick={openAsk}
            className={`h-[30px] shrink-0 rounded-[4px] border border-fill-edge bg-surface px-[9px] font-mono text-[11px] text-ink shadow-[2px_2px_0_var(--color-fill-edge)] hover:bg-fill ${FOCUS_RING}`}
          >
            Ask ⌘K
          </button>
        ) : null}
      </div>

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
        {prefs.projectsMode === "switcher" ? <ProjectSwitcher /> : <ProjectTree />}
      </div>

      <LibrarySection />

      <Footer />
    </aside>
  );
}
