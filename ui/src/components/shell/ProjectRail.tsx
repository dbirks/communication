/**
 * ProjectRail — the 64px project rail (redesign R1, README §1 "Project rail"
 * + CONTRACT "Shell"). It replaces the 220px column and the 52px collapsed
 * rail: one tile per project is the scope switch, and the tile you are on is
 * printed ink.
 *
 * Tiles are links, not buttons: picking a tile means "this project, the same
 * place I already am", so the href keeps the section (`tileHref`) and the
 * browser keeps open-in-a-new-tab. A tile is never a menu — the project's own
 * page carries its actions.
 *
 * The column is `h-dvh`'d by the shell, so the tile list is the one part that
 * scrolls when projects overflow; the Manage + account group at the bottom is
 * pinned and stays reachable.
 */
import { Link, useLocation } from "react-router";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { useProjects } from "../../api/queries";
import { routes, type Section } from "../../lib/routes";
import { sectionFromPath, useScope } from "../../lib/scope";
import { useSidebarFlags, type Flag } from "../../lib/sidebarFlags";
import { Mark } from "../ds/Mark";
import UserMenu from "../UserMenu";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/** One tile: 38×38, radius 11, a hairline border, Red Hat Mono 12/600. The
 * border is always 1px (dashed for "+", ink for the selected one) so a tile
 * never shifts when its state changes. */
const TILE_CLASS =
  "relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] border font-mono font-semibold";

/**
 * The tile's two letters: the first letter of the first two words, and for a
 * one-word name the first two letters of that word ("Project One" → `PO`,
 * "atlasweb" → `AT`). `UserAvatar`'s rule (one letter per word) is about a
 * person's name; a project is usually one word, and one letter would make
 * every tile in the rail read as a different width.
 */
export function projectInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
}

/**
 * The waiting flag is the one the badge means: `useSidebarFlags()` already
 * ranks the states per project (failed > waiting > running), and the amber
 * "!" is specifically "a gate is open on you" — a failed run is red news for
 * the project page, not an ask.
 */
export function needsYouBadge(flag: Flag | undefined): boolean {
  return flag?.kind === "waiting";
}

/** The tile's target: the same section in the new scope. From Manage, a run
 * page or anywhere outside the three pill sections, a tile goes to that
 * project's home (`routes.scopeHome`). */
export function tileHref(
  section: Section | null,
  scope: string | null,
  openChatId: string | null = null,
): string {
  // The open chat belongs to every wider scope: switching to All keeps it
  // open, as the prototype does (review-4 F5).
  if (section === "chats" && scope === null && openChatId) return routes.chat(openChatId, null);
  if (section === "chats") return routes.chats(scope);
  if (section === "factory") return routes.factory(scope);
  return routes.scopeHome(scope);
}

/** The amber "!" (15px, top −5 / right −6, a 2px rail-coloured ring) plus the
 * words it stands for for anyone reading the rail with a screen reader. */
export function NeedsYouBadge() {
  return (
    <>
      <span
        aria-hidden="true"
        className="absolute -top-[5px] -right-[6px] grid h-[15px] min-w-[15px] place-items-center rounded-full border-2 border-rail bg-st-waiting-strong text-[9px] font-bold text-st-waiting-strong-fg"
      >
        !
      </span>
      <span className="sr-only">needs you</span>
    </>
  );
}

/** Selected: ink on white inverted to white on ink, border and fill together
 * so the tile reads as pressed into the rail. */
function tileState(selected: boolean): string {
  return selected ? "border-ink bg-ink text-surface" : "border-line bg-surface text-ink";
}

export interface ProjectRailProps {
  /** Test handle override; the shell draws exactly one rail. */
  testid?: string;
}

export default function ProjectRail({ testid = "project-rail" }: ProjectRailProps) {
  const location = useLocation();
  const scope = useScope();
  const projects = useProjects();
  const flags = useSidebarFlags();
  const section = sectionFromPath(location.pathname);
  const openChat = /\/chats\/([^/]+)\/?$/.exec(location.pathname)?.[1];
  const openChatId = openChat && openChat !== "new" ? decodeURIComponent(openChat) : null;
  const onManage = location.pathname.startsWith("/manage");
  const items = projects.data?.items ?? [];
  // On /manage/* Manage is the only selected thing on the rail (review
  // 15-1280-1): no project scope is in the URL there, and the remembered one
  // must not print a selected tile beside the ink gear.
  const tileSelected = (selected: boolean) => !onManage && selected;

  return (
    <nav
      aria-label="Projects"
      data-testid={testid}
      className="flex w-16 shrink-0 flex-col items-center gap-[10px] border-r border-line bg-rail py-[14px]"
    >
      <Link
        to="/"
        aria-label="Communication"
        draggable={false}
        data-testid="brand-home"
        className={`mb-[6px] flex shrink-0 select-none items-center text-ink ${FOCUS_RING} rounded-[8px]`}
      >
        <Mark size={26} />
      </Link>

      {/* The scrolling group: All, a divider, one tile per project in the
          API's order, then "+". The scrollbar is hidden — the rail is 64px and
          a 15px gutter inside it would move the tiles. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-[10px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Link
          to={tileHref(section, null, openChatId)}
          title="All projects"
          aria-label="All projects"
          aria-current={tileSelected(scope === null) ? "true" : undefined}
          data-testid="rail-tile-all"
          className={`grid place-items-center text-[10.5px] ${TILE_CLASS} ${tileState(
            tileSelected(scope === null),
          )} ${FOCUS_RING}`}
        >
          All
        </Link>
        <span aria-hidden="true" className="h-px w-6 shrink-0 bg-line" />
        {items.map((project) => {
          const selected = tileSelected(scope === project.id);
          return (
            <Link
              key={project.id}
              to={tileHref(section, project.id)}
              title={project.name}
              aria-label={project.name}
              aria-current={selected ? "true" : undefined}
              data-testid={`rail-tile-${project.id}`}
              className={`text-[12px] ${TILE_CLASS} ${tileState(selected)} ${FOCUS_RING}`}
            >
              {projectInitials(project.name)}
              {needsYouBadge(flags.projects[project.id]) ? <NeedsYouBadge /> : null}
            </Link>
          );
        })}
        <Link
          to={`${routes.manage("projects")}?new=1`}
          title="Add project"
          aria-label="Add project"
          data-testid="rail-add-project"
          className={`border-dashed border-line-strong text-[17px] text-muted ${TILE_CLASS} ${FOCUS_RING}`}
        >
          <IconPlus size={17} aria-hidden />
        </Link>
      </div>

      {/* Pinned bottom group: Manage, then the account menu. */}
      <div className="mt-auto flex shrink-0 flex-col items-center gap-[10px]">
        {/* Manage (README §1): 38×38 hit area, a bare `ti-settings` on the
            rail at rest — no border, no fill (review SH-2) — and the filled
            ink tile only while selected. */}
        <Link
          to={routes.manage()}
          title="Manage"
          aria-label="Manage"
          aria-current={onManage ? "page" : undefined}
          data-testid="rail-manage"
          className={`relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] text-ink ${
            onManage ? "bg-ink text-surface" : ""
          } ${FOCUS_RING}`}
        >
          <IconSettings size={19} aria-hidden />
        </Link>
        {/* The account menu is the existing `UserMenu` (it carries
            `user-badge`, which the lab e2e reads). Its trigger is a
            full-width row — avatar + name — so the 30px circle narrows it
            to the avatar alone: the name stays in the DOM (it is the
            trigger's accessible name) and prints no ink past the circle. */}
        <div
          data-testid="rail-account"
          className="w-[38px] shrink-0 overflow-visible [&>div>button]:mx-auto [&>div>button]:h-[30px] [&>div>button]:w-[30px] [&>div>button]:gap-0 [&>div>button]:overflow-hidden [&>div>button]:rounded-full [&>div>button]:px-0"
        >
          <UserMenu railAvatar />
        </div>
      </div>
    </nav>
  );
}
