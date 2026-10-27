/**
 * `/p/:projectId` — the project overview (Projects Review design 1b).
 *
 * One navigation, in the page header: the section tabs are ROUTES
 * (Overview · Runs · Threads · Workflows · Artifacts · Settings), which replaced
 * the 160px `ProjectSectionNav` rail this page used to mount beside its own
 * panels. Below the band it is the handoff's shared two-column body — the work
 * that asks something of you on the left, the project's inventory on the right,
 * `minmax(0,1fr) 300px` down to 1024px and stacked below it.
 *
 * The attention read is the inbox's (`../lib/attention.ts`) narrowed to this
 * project, so a stalled run never reads as fine here and urgent there. Run rows
 * obey the run pages' honesty rule: no invented title, only what the wire
 * serves. What the design shows that the API does not serve — a repository on a
 * run, an issue count per repository, a subject line on a thread — is said
 * rather than drawn: see the notes in `RunningNow`, `Repositories` and
 * `RecentThreads`.
 */
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useProject } from "../api/queries";
import { useProjectEvents } from "../api/events";
import NewConversationDialog from "../components/NewConversationDialog";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";
import { ProjectHeader } from "../components/project/ProjectHeader";
import { ProjectPageShell } from "../components/project/ProjectPageShell";
import { NeedsYou } from "../components/project/NeedsYou";
import { RecentThreads } from "../components/project/RecentThreads";
import { Repositories } from "../components/project/Repositories";
import { RunningNow } from "../components/project/RunningNow";
import { WorkflowsPanel } from "../components/project/WorkflowsPanel";
import { routes } from "../lib/routes";

/**
 * The remote a person recognises — `github.com/example/app` — from https, ssh or
 * scp-style `git@host:path` URLs. Re-exported from
 * `../components/project/gitRemote` (where it now lives, because the repositories
 * panel and the repository page print the same line).
 */
export { gitRemote } from "../components/project/gitRemote";

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const project = useProject(id);
  const [threadDialogOpen, setThreadDialogOpen] = useState(false);
  // The project journal subscription stays on this page even though the visible
  // event feed moved off it: `useProjectEvents` is what coalesces frames into one
  // invalidation per window, so a gate decided in another tab (or a run that just
  // broke) refreshes the counts and callouts here instead of sitting stale until
  // a reload. The feed's list is what left; the subscription did not.
  useProjectEvents(project.data?.id ?? "");

  // The three unusable branches carry no header band, so each is wrapped in the
  // page column that gives them the band's padding (`ProjectPageShell`): on this
  // full-bleed route an unwrapped line sits flush against the sidebar.
  if (project.isPending) {
    return (
      <ProjectPageShell testid="project-page-loading">
        <Spinner label="Loading project" />
      </ProjectPageShell>
    );
  }

  // A project the reader cannot open is not a page that renders its name:
  // `GET /projects/{id}` answers 404 to hide existence (ADR-0014 § 3), and every
  // screen under it gives the same one sentence (`ProjectUnavailable`).
  if (projectAccessRefused(project.error) || !project.data) {
    if (project.error && !projectAccessRefused(project.error)) {
      return (
        <ProjectPageShell testid="project-page-error">
          <section aria-labelledby="project-error-heading">
            <h1 id="project-error-heading" className="text-title-l font-bold">
              Project
            </h1>
            <ProblemBanner error={project.error} fallback="The project could not be loaded." />
          </section>
        </ProjectPageShell>
      );
    }
    return (
      <ProjectPageShell testid="project-page-not-found">
        <ProjectUnavailable
          heading="Project"
          headingId="project-heading"
          testid="project-not-found"
        />
      </ProjectPageShell>
    );
  }

  const projectData = project.data;
  const canStartWork =
    projectData.my_role === "maintainer" || projectData.my_role === "contributor";

  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid="project-page">
      <ProjectHeader
        project={projectData}
        active="overview"
        onNewThread={() => setThreadDialogOpen(true)}
      />

      <div className="grid flex-1 items-start gap-[20px] px-[22px] py-[22px] lg:grid-cols-[minmax(0,1fr)_300px] md:px-[28px]">
        {/* ------------------------------------------------- what asks things */}
        <div className="min-w-0 space-y-[16px]">
          <NeedsYou project={projectData} />
          <RunningNow project={projectData} />
          <RecentThreads
            project={projectData}
            canStartThread={canStartWork}
            onNewThread={() => setThreadDialogOpen(true)}
          />
        </div>

        {/* --------------------------------------------------- inventory */}
        <div className="min-w-0 space-y-[16px]">
          <Repositories project={projectData} />
          <WorkflowsPanel project={projectData} />
          <p
            className="font-mono text-[10.5px] leading-[16px] text-faint"
            data-testid="project-moved-off-note"
          >
            Members, workspaces and the event feed moved off this page:{" "}
            <Link to={`${routes.project(projectData.id)}/members`} className="underline">
              members &amp; activity
            </Link>{" "}
            ·{" "}
            <Link to={routes.projectTab(projectData.id, "settings")} className="underline">
              workspaces &amp; secrets
            </Link>
            .
          </p>
        </div>
      </div>

      <NewConversationDialog
        open={threadDialogOpen}
        onClose={() => setThreadDialogOpen(false)}
        projectId={projectData.id}
        project={projectData}
      />
    </div>
  );
}
