/**
 * The project page's header tabs (Projects Review design 1b).
 *
 * They replace the 160px `ProjectSectionNav` rail on the project overview: one
 * navigation, drawn as links that sit *on* the header band's bottom border.
 * Items are ROUTES, not fragments, exactly like the workflow page's tabs
 * (`pages/Workflow.tsx`), so a tab change is a navigation and the URL stays the
 * honest answer to "where am I".
 *
 * Two labels are new words over old routes, which the handoff asks for
 * ("Conversations becomes Threads everywhere"; a library workflow is *used* by
 * a project, which is what the assignments page lists):
 *   Threads   → `/p/:id/conversations`  (rebuilt as its own screen by the
 *              Threads Review handoff; the project's list is still the
 *              conversations page)
 *   Workflows → `/p/:id/pipelines`      (the project's assignments)
 *
 * A count trails the label in mono only where the count means something, and
 * the Runs count carries the waiting glyph + color when it is a count of things
 * that ask something of a person (identity rule 06: never color alone).
 */
import { Link } from "react-router";
import { routes } from "../../lib/routes";

export type ProjectTabKey =
  | "overview"
  | "runs"
  | "threads"
  | "workflows"
  | "artifacts"
  | "settings";

/** The tabs, in design order. */
export const PROJECT_TABS: readonly { key: ProjectTabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "runs", label: "Runs" },
  { key: "threads", label: "Threads" },
  { key: "workflows", label: "Workflows" },
  { key: "artifacts", label: "Artifacts" },
  { key: "settings", label: "Settings" },
];

/** The route one tab points at. */
export function projectTabHref(projectId: string, tab: ProjectTabKey): string {
  switch (tab) {
    case "overview":
      return routes.project(projectId);
    case "threads":
      return routes.projectTab(projectId, "conversations");
    case "workflows":
      return routes.projectTab(projectId, "pipelines");
    default:
      return routes.projectTab(projectId, tab);
  }
}

export interface ProjectTabFlags {
  /** Runs that ask something of a person (open gates + stalled runs). Shown as
   * `! n` in the waiting color; null = not known yet, so nothing is printed. */
  needsYou?: number | null;
  /** Project threads; null until the read arrives. */
  threads?: number | null;
  /** Workflows the project uses; null until the read arrives. */
  workflows?: number | null;
}

export interface ProjectTabsProps {
  projectId: string;
  active: ProjectTabKey | null;
  flags?: ProjectTabFlags;
}

/** One tab's mono count. */
function Count({ value, urgent }: { value: number | null | undefined; urgent?: boolean }) {
  if (value === null || value === undefined) return null;
  if (urgent) {
    if (value === 0) return null;
    return (
      <span className="font-mono text-[10.5px] font-semibold text-st-waiting-tag-fg" aria-hidden>
        ! {value}
      </span>
    );
  }
  return <span className="font-mono text-[10.5px]">{value}</span>;
}

export function ProjectTabs({ projectId, active, flags = {} }: ProjectTabsProps) {
  return (
    <nav
      aria-label="Project sections"
      className="-mb-px flex gap-[4px] overflow-x-auto"
      data-testid="project-tabs"
    >
      {PROJECT_TABS.map(({ key, label }) => {
        const isActive = active === key;
        // Only the urgent Runs count changes color, and only when it is
        // non-zero; the plain counts print whatever the read served, zero
        // included (an empty project's "0" is a fact, not a gap).
        const count =
          key === "runs"
            ? { value: flags.needsYou ?? null, urgent: true }
            : key === "threads"
              ? { value: flags.threads ?? null, urgent: false }
              : key === "workflows"
                ? { value: flags.workflows ?? null, urgent: false }
                : null;
        return (
          <Link
            key={key}
            to={projectTabHref(projectId, key)}
            aria-current={isActive ? "page" : undefined}
            className={`flex shrink-0 items-center gap-[6px] whitespace-nowrap rounded-t-[3px] border px-[12px] pt-[6px] pb-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              isActive
                ? "border-ink border-b-paper bg-paper font-semibold text-ink"
                : "border-transparent text-muted"
            }`}
            data-testid={`project-tab-${key}`}
          >
            {label}
            {count ? (
              <>
                <Count {...count} />
                {/* The urgent count's glyph is decorative, so the count is
                    spelled out for anyone not reading the color. */}
                {count.urgent && (count.value ?? 0) > 0 ? (
                  <span className="sr-only">{`${count.value} need you`}</span>
                ) : null}
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
