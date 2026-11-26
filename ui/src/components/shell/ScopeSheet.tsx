/**
 * ScopeSheet — the phone's stand-in for the project rail (CONTRACT "Phone").
 *
 * The rail's contents as full rows: All projects, one row per project (tile +
 * name + the amber "!" the tile carries), Add project, then Manage and the
 * account. Rows are links to the same section in the new scope (`tileHref`),
 * exactly like the tiles above them.
 *
 * Three ways out and all of them hand the keyboard back to the `scope-open`
 * button the sheet came from: Escape, the backdrop, and choosing a row (which
 * also navigates). The body is scroll-locked while it stands over the page, so
 * a flick on the backdrop cannot scroll the page behind it.
 */
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { useProjects } from "../../api/queries";
import { routes } from "../../lib/routes";
import { sectionFromPath, useScope } from "../../lib/scope";
import { useSidebarFlags } from "../../lib/sidebarFlags";
import UserMenu from "../UserMenu";
import { NeedsYouBadge, needsYouBadge, projectInitials, tileHref } from "./ProjectRail";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring";

/** One 48px row: the tile, then the words. */
const ROW = "flex h-12 w-full items-center gap-3 border-line px-3 text-left hover:bg-disabled-bg";

export interface ScopeSheetProps {
  onClose: () => void;
}

export default function ScopeSheet({ onClose }: ScopeSheetProps) {
  const location = useLocation();
  const scope = useScope();
  const projects = useProjects();
  const flags = useSidebarFlags();
  const sheetRef = useRef<HTMLDivElement>(null);
  const section = sectionFromPath(location.pathname);
  const items = projects.data?.items ?? [];

  const closeAndReturn = () => {
    onClose();
    // The bar is still mounted underneath: the keyboard goes back to the
    // button that opened the sheet, wherever the row navigated to.
    document.querySelector<HTMLElement>('[data-testid="scope-open"]')?.focus();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndReturn();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const row = (
    key: string,
    to: string,
    testid: string,
    code: string,
    label: string,
    opts: { selected?: boolean; waiting?: boolean; add?: boolean; icon?: "settings" } = {},
  ) => (
    <Link
      key={key}
      to={to}
      data-testid={testid}
      aria-current={opts.selected ? "true" : undefined}
      onClick={closeAndReturn}
      className={`${ROW} ${FOCUS_RING}`}
    >
      <span
        aria-hidden="true"
        className={`relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] border font-mono font-semibold ${
          code === "All" ? "text-[10.5px]" : "text-[12px]"
        } ${
          opts.selected
            ? "border-ink bg-ink text-surface"
            : opts.add
              ? "border-dashed border-line-strong text-[17px] text-muted"
              : "border-line bg-surface text-ink"
        }`}
      >
        {opts.add ? (
          <IconPlus size={17} />
        ) : opts.icon === "settings" ? (
          <IconSettings size={19} />
        ) : (
          code
        )}
        {opts.waiting ? <NeedsYouBadge /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{label}</span>
    </Link>
  );

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="scope-backdrop"
        onClick={closeAndReturn}
        className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        data-testid="scope-sheet"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[300px] max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-surface py-2 outline-none"
      >
        {row("all", tileHref(section, null), "scope-row-all", "All", "All projects", {
          selected: scope === null,
        })}
        <span aria-hidden="true" className="mx-3 my-1 h-px shrink-0 bg-line" />
        {items.map((project) =>
          row(
            project.id,
            tileHref(section, project.id),
            `scope-row-${project.id}`,
            projectInitials(project.name),
            project.name,
            {
              selected: scope === project.id,
              waiting: needsYouBadge(flags.projects[project.id]),
            },
          ),
        )}
        {row("add", `${routes.manage("projects")}?new=1`, "scope-row-add", "", "Add project", {
          add: true,
        })}
        <span aria-hidden="true" className="mx-3 my-1 h-px shrink-0 bg-line" />
        {row("manage", routes.manage(), "scope-row-manage", "", "Manage", {
          icon: "settings",
        })}
        {/* The account row is the existing menu, unchanged, in a row-height
            wrapper — the same trigger the rail carries at desktop width. */}
        <div data-testid="scope-account" className="border-t border-line px-1 pt-2">
          <UserMenu />
        </div>
      </div>
    </div>
  );
}
