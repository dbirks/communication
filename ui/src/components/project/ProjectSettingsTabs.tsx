/**
 * The project Settings section's own tabs (redesign finding 09).
 *
 * The finding's complaint was that the project's configure actions — settings,
 * members, add a repository — lived behind a "⋯" on the sidebar row that stayed
 * at `opacity-0` until you hovered it, so on a touch screen, and in the 52px
 * rail, they simply did not exist. "Add repository" did not even open the form:
 * it navigated to the overview and asked you to find the `+ add` link.
 *
 * Two of those three actions are answers to "configure this project", and the
 * handoff's home for them is the Settings page. Members was already its own
 * route (`/p/:id/members`, Projects Review design 1b), so the honest shape is
 * one section with two tabs, not a merge that strands a live URL: the strip
 * below marks which half of Settings you are reading, and each tab is a route.
 *
 * The strip is the same link-on-the-band pattern the Workflows page's tabs use
 * (`pages/Workflows.tsx`): an item sits on the rule, the current one is inked
 * and bold. Its nav label is "Settings sections" so it never collides with the
 * project's own tab row (labelled "Project sections") that the framed pages
 * draw.
 */
import { Link } from "react-router";
import { routes } from "../../lib/routes";

export type ProjectSettingsTabKey = "settings" | "members";

const TABS: readonly { key: ProjectSettingsTabKey; label: string }[] = [
  { key: "settings", label: "Settings" },
  { key: "members", label: "Members" },
];

/** The route one settings tab points at. */
export function projectSettingsTabHref(projectId: string, tab: ProjectSettingsTabKey): string {
  return tab === "settings"
    ? routes.projectTab(projectId, "settings")
    : routes.projectMembers(projectId);
}

export interface ProjectSettingsTabsProps {
  projectId: string;
  active: ProjectSettingsTabKey;
}

export function ProjectSettingsTabs({ projectId, active }: ProjectSettingsTabsProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="-mb-px flex gap-[4px] border-b border-line"
      data-testid="project-settings-tabs"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          to={projectSettingsTabHref(projectId, tab.key)}
          aria-current={active === tab.key ? "page" : undefined}
          data-testid={`project-settings-tab-${tab.key}`}
          className={`shrink-0 whitespace-nowrap rounded-t-[3px] border px-[12px] pt-[6px] pb-[7px] text-[13px] no-underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            active === tab.key
              ? "border-ink border-b-paper bg-paper font-semibold text-ink"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
