/**
 * `/p/:projectId/pipelines` — the project's Workflows tab (design 1b).
 *
 * The route keeps its path (`pipelines` is what the API calls them) and the
 * tab keeps the product's word. The pass review of `project-1b-workflows`
 * caught the reason: this page had become a dumping ground for legacy panels
 * — a full LIBRARY list, a YAML dump of the pinned revision, a definition
 * graph, a Validate-YAML admin note, and raw digest/uuid strings everywhere.
 * The redesign gives every one of those a surface built to hold it, and the
 * tab keeps the one thing the handoff says is its own:
 *
 *   "Triggers are created and edited on the repo page (and LISTED ON THE
 *    PROJECT'S WORKFLOWS TAB across all its repos)."
 *
 * So the tab is now ONE panel — `ProjectWorkflowsPanel`: a row per workflow
 * the project uses, in the repository page's 2e row shape (chevron, name,
 * `✓ rN` chip, trigger summary, step chain, repo scope), each opening on the
 * same `STARTS WHEN` box and the same switch, `Edit`-target and 2c dialog the
 * repo page uses. No raw digest or uuid survives here: the revision is `r1`,
 * the workflow links to its own page, and a run is named elsewhere.
 *
 * Where the removed panels live now (nothing became unreachable):
 * - the library list: the `/workflows` index (and the panel's own
 *   `+ use a library workflow` opens a workflow into this project);
 * - the pinned revision's YAML and its definition graph: the workflow's own
 *   page — every row name here links to it (its YAML tab and Studio carry
 *   the pinned document; the graph is the Studio canvas);
 * - the schedules the old `WHEN TO RUN` block listed and authored: the
 *   STARTS WHEN box, with the 2c dialog — the same control the repo page
 *   already used, now across every repository of the project;
 * - the org-admin VALIDATE YAML panel (contract § 7.2 W8): the WORKFLOW'S OWN
 *   PAGE — the row's words are "the YAML viewer's 'Validate' panel", and the
 *   YAML tab (`/workflows/:id/yaml`, `pages/Workflow.tsx`) mounts it under its
 *   YAML block behind one collapsed `Validate a YAML document` disclosure,
 *   pinned to that workflow and shown only to someone with the library role
 *   (`components/m4/ValidatePanel.tsx`). Nothing else on this page repeated it,
 *   and every row name here links to the page that now carries it.
 *
 * Editing, publishing and channel rollout stay out of scope: no draft form
 * here, and no channel claim — `AssignmentCreate` has no channel member
 * (channels are M6 rollout vocabulary).
 */
import { useParams } from "react-router";
import { ProjectFrame } from "../components/project/ProjectFrame";
import { ProjectWorkflowsPanel } from "../components/project/workflows/ProjectWorkflowsPanel";

/**
 * The Workflows tab: the frame, and under it the ONE panel this project owns.
 *
 * The panel is a component rather than markup in the route so its reads mount
 * in the SAME commit as the header band's own: the tab count and the rows
 * below then share one `GET .../assignments` instead of asking twice.
 */
export default function ProjectPipelines() {
  const { projectId = "" } = useParams();
  return (
    <ProjectFrame
      projectId={projectId}
      active="workflows"
      testid="project-pipelines"
      heading="Workflows"
    >
      {(project) => <ProjectWorkflowsPanel projectId={projectId} project={project} />}
    </ProjectFrame>
  );
}
