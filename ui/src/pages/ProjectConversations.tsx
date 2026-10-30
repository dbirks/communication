/**
 * `/p/:projectId/conversations` — the project's Threads tab (design 1b).
 *
 * The route keeps its path (`conversations` is the API's noun, and the
 * assistant's route table, breadcrumbs and permalinks name it) while the screen
 * speaks the product's word: **Threads**. Until the 1b rebuild it was the old
 * page — the left `ProjectSectionNav` rail, a breadcrumb, a "Threads — {project}"
 * H1 of its own, and the `Conversations` panel, whose rows said `CONVERSATION`
 * and `New conversation`, printed `profile:` and `controller:` beside an ISO
 * timestamp, and clipped to `run 01…` at 390. Now it mounts `ProjectFrame`: the
 * same header band and tab row the overview draws, with **Threads** marked as
 * the tab you are on, and under it the project's thread list drawn in the rows
 * the Threads page uses.
 */
import { useParams } from "react-router";
import { useConversations } from "../api/queries";
import type { Project } from "../api/types";
import { ProjectFrame } from "../components/project/ProjectFrame";
import { ProjectThreadList } from "../components/project/ProjectThreadList";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";

export default function ProjectConversations() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return (
    <ProjectFrame
      projectId={projectId}
      active="threads"
      testid="project-conversations"
      heading="Threads"
    >
      {(project, openNewThread) => <ThreadsTabBody project={project} onNewThread={openNewThread} />}
    </ProjectFrame>
  );
}

/**
 * The list in the frame's body column, as a component so its read mounts in the
 * SAME commit as the header band's own (a page-level read would fire one commit
 * earlier and the tab count would then re-fetch the same list), and so the
 * refusal is decided where the read is: the list route answers the same
 * 404/403 the project read does, and a panel saying "no threads yet" would
 * confirm more than the API chose to say.
 */
export function ThreadsTabBody({
  project,
  onNewThread,
}: {
  project: Project;
  onNewThread: () => void;
}) {
  // The unfiltered read — the same key the tab count and (until a filter is
  // picked) the list itself use, so one round trip serves all three.
  const list = useConversations(project.id);

  if (projectAccessRefused(list.error)) {
    return (
      <ProjectUnavailable
        heading="Threads"
        headingId="project-conversations-heading"
        testid="project-conversations-not-found"
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[56rem]">
      <ProjectThreadList
        project={project}
        canStartThread={project.my_role === "maintainer" || project.my_role === "contributor"}
        onNewThread={onNewThread}
      />
    </div>
  );
}
