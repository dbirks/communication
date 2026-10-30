/**
 * `/p/:projectId/conversations` — the project's Threads tab.
 *
 * The route keeps its path (`conversations` is the API's noun, and the
 * assistant's route table, breadcrumbs and permalinks name it) while the
 * screen speaks the product's word: **Threads**. The tab IS the 1g view — the
 * same 320px list pane and open-thread column the `/threads` page draws
 * (`components/threads/ThreadListPane`, `ThreadsDetailColumn`), filtered to
 * this project and sitting under the project's 1b header band and tab row.
 * There is no second card list: an earlier pass drew a `THREADS` panel of the
 * project's own rows beside the band, which the review named as exactly the
 * divergence to stop — one thread list, one row shape, everywhere.
 *
 * What "filtered to the project" means on the wire: the pane reads
 * `GET /projects/{id}/conversations`, and the search and the `from runs` chip
 * travel to that route as `q` and `origin` (ADR-0043) — the same server query
 * the pane uses and the same one the old tab had. The chips themselves are
 * 1g's: `all` / `mine` / `from runs`.
 *
 * The frame's body column is the pane here, so the 1g panes keep their own
 * edge-to-edge chrome (white list, `border-r`, paper detail) inside the
 * full-bleed route; the page inset is the panes' own, not `22px 28px`.
 */
import { useParams } from "react-router";
import { useConversations } from "../api/queries";
import type { Project } from "../api/types";
import { ProjectFrame } from "../components/project/ProjectFrame";
import { ThreadListPane } from "../components/threads/ThreadListPane";
import { ThreadsDetailColumn } from "./Threads";
import { ProjectUnavailable, projectAccessRefused } from "../components/ProjectUnavailable";

export default function ProjectConversations() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return (
    <ProjectFrame
      projectId={projectId}
      active="threads"
      testid="project-conversations"
      heading="Threads"
      bodyClassName="flex min-h-0 flex-1 flex-col lg:flex-row"
    >
      {(project) => <ThreadsTabBody project={project} />}
    </ProjectFrame>
  );
}

/**
 * The 1g view inside the frame: list pane + detail column, one project wide.
 *
 * It is a component so its read mounts in the SAME commit as the header band's
 * own (a page-level read would fire one commit earlier and the tab count would
 * then re-fetch the same list), and so the refusal is decided where the read
 * is: the list route answers the same 404/403 the project read does, and a
 * pane saying "no threads yet" would confirm more than the API chose to say.
 *
 * The pane is the `projectId`-filtered one, so on a failed list read it owns
 * the single loud banner and the detail column says nothing (the same split
 * `/threads` makes — see `ThreadListPane`'s `ownsError`).
 */
export function ThreadsTabBody({ project }: { project: Project }) {
  // The unfiltered read — the same key the tab count and (until a filter is
  // picked) the pane itself use, so one round trip serves all three. The pane
  // adds its own filtered keys only while a search or `from runs` is active.
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
    <>
      <div className="flex min-h-0 w-full flex-col border-b border-line-strong bg-surface lg:w-[320px] lg:flex-none lg:border-b-0 lg:border-r">
        <ThreadListPane projectId={project.id} ownsError={list.isError} />
      </div>
      {list.isError ? null : <ThreadsDetailColumn />}
    </>
  );
}
