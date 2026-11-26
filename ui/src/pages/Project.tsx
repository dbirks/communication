/**
 * `/p/:projectId` — the project's home (redesign R2, README §2 "Project home",
 * docs/design/redesign/CONTRACT.md "Routes and scope").
 *
 * One project, at a glance: the prompt box that starts work in it, the three
 * pills that start the specific things this project has, what is happening
 * right now, what happened while the reader was away, and — in the right column
 * — the repositories, the workflows that live here, and the project's default
 * agent (ADR-0086). The old page's tab band is gone: the rail and the pill in
 * the top bar are the navigation now, so this page is not framed by a second
 * copy of it.
 *
 * Layout is the handoff's: max-width 1180, `1fr 300px`, gap 40, padding 28 36 —
 * one column below 900px, and the phone's 20/16 inset below 768 (CONTRACT.md
 * "Phone"). Everything on it comes from a read; what the wire does not serve is
 * said, never drawn (see `WorkflowsHere`, `RepoList`, `HappeningNow`).
 *
 * The unusable branches keep today's behaviour exactly: a `404`/`403` is
 * `ProjectUnavailable`'s one sentence, any other failure quotes the server, and
 * neither prints a half page. The project journal subscription stays too — it is
 * what coalesces a replaying stream into one invalidation, so the counts and
 * cards here refresh without a read storm (see `ProjectRefetch.test.tsx`).
 */
import { useState } from "react";
import { useParams } from "react-router";
import { IconBuildingFactory2 } from "@tabler/icons-react";
import { useProject } from "../api/queries";
import { useProjectEvents } from "../api/events";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";
import { ProblemBanner, Spinner } from "../components/Feedback";
import Page from "../components/ds/Page";
import { PromptChip } from "../components/ds/PromptBox";
import { StartRunDialog } from "../components/home/StartRunDialog";
import { DefaultAgentLine } from "../components/home/DefaultAgentLine";
import { HappeningNow } from "../components/home/HappeningNow";
import { HomePrompt } from "../components/home/HomePrompt";
import { RepoList } from "../components/home/RepoList";
import { SinceYouLeft } from "../components/home/SinceYouLeft";
import { StarterPills } from "../components/home/StarterPills";
import { WorkflowsHere } from "../components/home/WorkflowsHere";
import { routes } from "../lib/routes";

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const project = useProject(id);
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  if (project.isPending) {
    return (
      <Page layout="canvas" testid="project-home-loading">
        <div className="px-[22px] pt-[20px] md:px-[28px]">
          <Spinner label="Loading the project home" />
        </div>
      </Page>
    );
  }

  if (projectAccessRefused(project.error)) {
    return (
      <Page layout="canvas" testid="project-home-refused">
        <div className="px-[22px] pt-[20px] md:px-[28px]">
          <ProjectUnavailable
            heading="Project"
            headingId="project-home-heading"
            testid="project-not-found"
            missing="Project"
            hint="Check the link, or go back to Projects and open one you belong to — a project you cannot open reads exactly like one that is not there."
            back={{
              to: routes.projects(),
              label: "Projects",
              testid: "project-home-back-to-projects",
            }}
            backButton={{ label: "← Projects", testid: "project-home-back-to-projects-action" }}
          />
        </div>
      </Page>
    );
  }

  if (project.error || !project.data) {
    return (
      <Page layout="canvas" testid="project-home-error">
        <div className="max-w-[70ch] px-[22px] pt-[20px] md:px-[28px]">
          <ProblemBanner
            error={project.error}
            fallback="The project home could not be loaded."
            subject="the project home"
            hint="The project could not be loaded, so this page has nothing to show yet."
            retry={{
              onClick: () => void project.refetch(),
              pending: project.isFetching,
              testid: "project-home-retry",
            }}
          />
        </div>
      </Page>
    );
  }

  const data = project.data;
  return (
    <div className="min-h-full bg-surface" data-testid="project-home">
      {/* The journal subscription: what keeps these cards honest without a
          poll. It renders nothing. */}
      <ProjectJournal projectId={data.id} />
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-[40px] px-[36px] pt-[28px] pb-[48px] max-md:px-[16px] max-md:pt-[20px] min-[900px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[24px]">
          <div className="flex flex-col gap-[10px]">
            <HomePrompt
              projectId={data.id}
              placeholder={`What should we do in ${data.name}?`}
              extraChips={
                <PromptChip
                  testid="home-prompt-run"
                  icon={<IconBuildingFactory2 size={14} stroke={1.5} aria-hidden />}
                  title="Start a run of one of this project's workflows"
                  onClick={() => setRunDialogOpen(true)}
                >
                  or run a workflow
                </PromptChip>
              }
            />
            <StarterPills projectId={data.id} />
          </div>
          <HappeningNow projectId={data.id} />
          <SinceYouLeft projectId={data.id} />
        </div>

        <div className="flex min-w-0 flex-col gap-[28px]">
          <RepoList projectId={data.id} />
          <WorkflowsHere projectId={data.id} />
          {/* CONTRACT "Agents & models" 3: the project's default agent, one
              line under the workflows that live here. */}
          <DefaultAgentLine project={data} />
        </div>
      </div>

      {runDialogOpen ? <StartRunDialog onClose={() => setRunDialogOpen(false)} /> : null}
    </div>
  );
}

/**
 * The live subscription, in a component of its own so the hook stays a hook:
 * it mounts only once the project read has answered, and returns nothing.
 */
function ProjectJournal({ projectId }: { projectId: string }) {
  useProjectEvents(projectId);
  return null;
}
