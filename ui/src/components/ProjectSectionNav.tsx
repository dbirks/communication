/**
 * The one navigation for one project: Overview · Runs · Conversations ·
 * Pipelines · Artifacts · Settings, at every screen under `/projects/:id`.
 *
 * It used to be that the overview carried its own left menu of in-page
 * fragments while the run and pipeline screens carried this rail — two answers
 * to "where am I in this project" on adjacent pages. The rail is now the only
 * navigation, so it lives in `components/` and every project page mounts it.
 *
 * Items are routes, not fragments, so the rail behaves the same wherever it is
 * mounted — Conversations included: `/projects/:id/conversations` is a page of
 * its own (`pages/ProjectConversations.tsx`), which is the canonical form every
 * in-app link to the list uses. The overview keeps its copy of the section
 * under `#conversations`, so a bookmarked fragment still lands on a list.
 */
import { useNavigate } from "react-router";
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
  const base = `/projects/${projectId}`;
  switch (section) {
    case "overview":
      return base;
    default:
      return `${base}/${section}`;
  }
}

export const PROJECT_SECTIONS: readonly {
  section: ProjectSection;
  label: string;
}[] = [
  { section: "overview", label: "Overview" },
  { section: "runs", label: "Runs" },
  { section: "conversations", label: "Conversations" },
  { section: "pipelines", label: "Pipelines" },
  { section: "artifacts", label: "Artifacts" },
  { section: "settings", label: "Settings" },
];

export function ProjectSectionNav({
  projectId,
  active,
  className = "md:sticky md:top-[64px]",
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
