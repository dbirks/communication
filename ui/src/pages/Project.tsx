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
import { Link, useParams } from "react-router";
import { useProjectEvents } from "../api/events";
import { ProjectFrame } from "../components/project/ProjectFrame";
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
  return (
    <ProjectFrame
      projectId={id}
      active="overview"
      testid="project-page"
      heading="Project"
      headingId="project-heading"
      notFoundTestid="project-not-found"
      bodyClassName="grid flex-1 items-start gap-[20px] px-[22px] py-[22px] lg:grid-cols-[minmax(0,1fr)_300px] md:px-[28px]"
    >
      {(project, openNewThread) => {
        const canStartWork = project.my_role === "maintainer" || project.my_role === "contributor";
        return (
          <>
            {/* The project journal subscription stays on this page even though
                the visible event feed moved off it: `useProjectEvents` is what
                coalesces frames into one invalidation per window, so a gate
                decided in another tab (or a run that just broke) refreshes the
                counts and callouts here instead of sitting stale until a
                reload. The feed's list is what left; the subscription did not. */}
            <ProjectJournal projectId={project.id} />
            {/* ------------------------------------------------- what asks things */}
            <div className="min-w-0 space-y-[16px]">
              <NeedsYou project={project} />
              <RunningNow project={project} />
              <RecentThreads
                project={project}
                canStartThread={canStartWork}
                onNewThread={openNewThread}
              />
            </div>

            {/* --------------------------------------------------- inventory */}
            <div className="min-w-0 space-y-[16px]">
              <Repositories project={project} />
              <WorkflowsPanel project={project} />
              <p
                className="font-mono text-[10.5px] leading-[16px] text-faint"
                data-testid="project-moved-off-note"
              >
                Members, workspaces and the event feed moved off this page:{" "}
                <Link to={`${routes.project(project.id)}/members`} className="underline">
                  members &amp; activity
                </Link>{" "}
                ·{" "}
                <Link to={routes.projectTab(project.id, "settings")} className="underline">
                  workspaces &amp; secrets
                </Link>
                .
              </p>
            </div>
          </>
        );
      }}
    </ProjectFrame>
  );
}

/**
 * The overview's live subscription, in a component of its own so the hook
 * stays a hook: `useProjectEvents` is called from a real component that mounts
 * only once the project read has answered, and returns nothing.
 */
function ProjectJournal({ projectId }: { projectId: string }) {
  useProjectEvents(projectId);
  return null;
}
