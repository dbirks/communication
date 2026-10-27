/**
 * Where the overview's Members panel and live event feed went (Projects Review
 * design 1b): "Members, workspaces and the event feed move to Settings and to
 * each run." Neither the Settings page (`pages/ProjectSettings.tsx`, secrets +
 * workspaces) nor the Runs tab is in this brief, so the two panels the overview
 * loses are mounted here — at a real `/p/…` route, reachable from the overview's
 * own footnote — until the screen the handoff names takes them over.
 *
 * The band is the shared page pattern with the project breadcrumb, and the tab
 * row has no current item on purpose: this page is a section of its own, not one
 * of the six tabs.
 */
import { Link, useParams } from "react-router";
import { useProject } from "../../api/queries";
import { routes } from "../../lib/routes";
import ActivityFeed from "../ActivityFeed";
import { ProblemBanner, Spinner } from "../Feedback";
import { ProjectUnavailable, projectAccessRefused } from "../ProjectUnavailable";
import { MembersPanel } from "./MembersPanel";
import { ProjectPageShell, PROJECT_PAGE_PAD } from "./ProjectPageShell";
import { ProjectTabs } from "./ProjectTabs";

export default function ProjectMembersPage() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const project = useProject(projectId);

  // `/p/:projectId/members` is full-bleed like the overview, so the unusable
  // branches — which mount no header band of their own — need the page column
  // that carries the band's padding (`ProjectPageShell`).
  if (project.isPending) {
    return (
      <ProjectPageShell testid="project-members-loading">
        <Spinner label="Loading project" />
      </ProjectPageShell>
    );
  }
  // The same refusal every screen under the project gives: 404/403 is one
  // sentence (`ProjectUnavailable`), never a shell that confirms the project
  // exists; any other failure quotes the server.
  if (project.error) {
    if (projectAccessRefused(project.error)) {
      return (
        <ProjectPageShell testid="project-members-not-found">
          <ProjectUnavailable
            heading="Project"
            headingId="project-members-heading"
            testid="project-not-found"
          />
        </ProjectPageShell>
      );
    }
    return (
      <ProjectPageShell testid="project-members-error">
        <section aria-labelledby="project-members-error-heading">
          <h1 id="project-members-error-heading" className="text-title-l font-bold">
            Members
          </h1>
          <ProblemBanner error={project.error} fallback="The project could not be loaded." />
        </section>
      </ProjectPageShell>
    );
  }
  if (!project.data) {
    return (
      <ProjectPageShell testid="project-members-not-found">
        <ProjectUnavailable
          heading="Project"
          headingId="project-members-heading"
          testid="project-not-found"
        />
      </ProjectPageShell>
    );
  }

  const data = project.data;
  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid="project-members-page">
      <header
        className={`flex flex-col gap-[14px] border-b border-line-strong bg-surface ${PROJECT_PAGE_PAD}`}
      >
        <div className="flex flex-col gap-[4px]">
          <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
            <Link
              to={routes.project(data.id)}
              className="text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {data.name}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Members</span>
          </nav>
          <h1 id="project-members-heading" className="text-[22px] leading-[28px] font-semibold">
            Members &amp; activity
          </h1>
          <p className="max-w-[70ch] text-[13.5px] text-muted">
            Who is in this project, and what its journal is reporting. Workspaces and secrets are
            under{" "}
            <Link to={routes.projectTab(data.id, "settings")} className="underline">
              Settings
            </Link>
            ; a run&apos;s own events are on its page.
          </p>
        </div>
        <ProjectTabs projectId={data.id} active={null} />
      </header>
      <div className="mx-auto w-full max-w-[900px] space-y-[16px] px-[22px] py-[22px] md:px-[28px]">
        <MembersPanel project={data} />
        <ActivityFeed projectId={data.id} />
      </div>
    </div>
  );
}
