/**
 * The one navigation for one project at every screen under `/p/:id` that has not
 * been rebuilt with the header tabs (Projects Review design 1b moved the tabs
 * into the project page's own header band; the sibling pages — runs, threads,
 * workflows, artifacts, settings, the run inspector — still mount this rail
 * until each is rebuilt to the same pattern).
 *
 * It used to be that the overview carried its own left menu of in-page fragments
 * while the run and pipeline screens carried this rail — two answers to "where am
 * I in this project" on adjacent pages. The overview now has header tabs, and the
 * rail's job is only to keep the remaining screens navigable.
 *
 * Every href is built by `lib/routes.ts`, so the rail links the canonical `/p/…`
 * paths and never a legacy `/projects/…` URL (those survive only as
 * `<Navigate replace>` redirects in `App.tsx`). Labels follow the page's copy:
 * "Conversations" is **Threads**, and the assignments page is **Workflows**.
 * Items are routes, not fragments.
 */
import { useNavigate } from "react-router";
import { routes } from "../lib/routes";
import { SubNav } from "./ds/SubNav";

export type ProjectSection =
  | "overview"
  | "runs"
  | "conversations"
  | "pipelines"
  | "artifacts"
  | "settings";

export interface ProjectSectionNavProps {
  projectId: string;
  active: ProjectSection;
  className?: string;
}

/** The href of one section, in the order the rail shows them. */
export function projectSectionHref(projectId: string, section: ProjectSection): string {
  if (section === "overview") return routes.project(projectId);
  return routes.projectTab(projectId, section);
}

export const PROJECT_SECTIONS: readonly {
  section: ProjectSection;
  label: string;
}[] = [
  { section: "overview", label: "Overview" },
  { section: "runs", label: "Runs" },
  { section: "conversations", label: "Threads" },
  { section: "pipelines", label: "Workflows" },
  { section: "artifacts", label: "Artifacts" },
  { section: "settings", label: "Settings" },
];

export function ProjectSectionNav({
  projectId,
  active,
  className = "md:sticky md:top-0",
}: ProjectSectionNavProps) {
  const navigate = useNavigate();
  return (
    <SubNav
      label="Project sections"
      className={className}
      active={projectSectionHref(projectId, active)}
      onNavigate={(target) => navigate(target)}
      items={PROJECT_SECTIONS.map(({ section, label }) => ({
        href: projectSectionHref(projectId, section),
        label,
      }))}
    />
  );
}

export default ProjectSectionNav;
