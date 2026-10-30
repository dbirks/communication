/**
 * The 1b frame every project tab renders (Projects Review design 1b).
 *
 * Before this component existed, only `/p/:id` (the overview) and
 * `/p/:id/members` drew the header band; the Runs, Threads and Workflows routes
 * kept the 160px `ProjectSectionNav` rail and their own old page furniture, so
 * one click on a tab changed the whole navigation. Design 1b has ONE navigation
 * per project, and the pass-2 review named the three pages that still broke it.
 *
 * So the band, the tab row, the thread dialog the header opens and the three
 * unusable branches live here, and a tab page supplies only its own body.
 * `ProjectHeader` — through it `ProjectTabs` — is literally the component the
 * overview mounts, so a tab page cannot drift into a different header, and the
 * counts in the tab row are the same reads the section below prints.
 *
 * The unusable branches are the ones every screen under `/p/:id` already gives:
 * a refusal is `ProjectUnavailable`'s one sentence, and any other failure
 * quotes the server. A caller who cannot open the project gets no band, no tabs
 * and no counts — the shell itself would confirm more than the API chose to say
 * (the list routes answer the same 404/403 as the project read, hence `refused`).
 */
import { useState, type ReactNode } from "react";
import { useProject } from "../../api/queries";
import type { Project } from "../../api/types";
import NewConversationDialog from "../NewConversationDialog";
import { ProblemBanner, Spinner } from "../Feedback";
import { ProjectUnavailable, projectAccessRefused } from "../ProjectUnavailable";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectPageShell } from "./ProjectPageShell";
import type { ProjectTabKey } from "./ProjectTabs";

/** The body column under the band: the handoff's page inset (`22px`, `28px` at
 *  `md`), the same inset the band itself carries. */
export const PROJECT_FRAME_BODY = "flex-1 px-[22px] py-[22px] md:px-[28px]";

export interface ProjectFrameProps {
  /** The `:projectId` from the route. */
  projectId: string;
  /** Which tab this page is: it is what marks the tab row. */
  active: ProjectTabKey;
  /** Root test handle (`project-runs`), so the suites still anchor on it. */
  testid: string;
  /** The section's own word, for the headings the unusable branches print. */
  heading: string;
  /** Test handle of the refusal's `ProjectUnavailable` line. */
  notFoundTestid?: string;
  /** The refusal/error heading's id; defaults to `{testid}-heading`. */
  headingId?: string;
  /** Classes for the body column; defaults to the page inset. */
  bodyClassName?: string;
  /**
   * The page's own content, once the project has arrived. `openNewThread` is
   * the verb the header's `New thread` button presses, handed down so an empty
   * state can offer it without mounting a second dialog.
   */
  children: (project: Project, openNewThread: () => void) => ReactNode;
}

/** The band's tabs, the band's project — and nothing else on the page. */
export function ProjectFrame({
  projectId,
  active,
  testid,
  heading,
  notFoundTestid,
  headingId,
  bodyClassName = PROJECT_FRAME_BODY,
  children,
}: ProjectFrameProps) {
  const project = useProject(projectId);
  const [threadDialogOpen, setThreadDialogOpen] = useState(false);
  const openThread = () => setThreadDialogOpen(true);

  // Every framed route is in `App.tsx`'s full-bleed list, so the shell gives
  // the page the bare content column and a branch that mounts no band needs
  // the band's own padding from `ProjectPageShell`.
  const branch = (shellTestId: string, node: ReactNode) => (
    <ProjectPageShell testid={shellTestId}>{node}</ProjectPageShell>
  );

  if (project.isPending) {
    return branch(`${testid}-loading`, <Spinner label={`Loading ${heading.toLowerCase()}`} />);
  }

  if (projectAccessRefused(project.error)) {
    const refusalTestid = notFoundTestid ?? `${testid}-not-found`;
    return branch(
      refusalTestid === `${testid}-not-found` ? `${testid}-refused` : `${testid}-not-found`,
      <ProjectUnavailable
        heading={heading}
        headingId={headingId ?? `${testid}-heading`}
        testid={refusalTestid}
      />,
    );
  }

  // Any other failure quotes the server — and so does a read that answered
  // nothing at all, which is a broken read rather than a refusal.
  if (project.error || !project.data) {
    return branch(
      `${testid}-error`,
      <section aria-labelledby={`${testid}-error-heading`}>
        <h1 id={`${testid}-error-heading`} className="text-title-l font-bold">
          {heading}
        </h1>
        <ProblemBanner error={project.error} fallback={`${heading} could not be loaded.`} />
      </section>,
    );
  }

  const data = project.data;
  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid={testid}>
      <ProjectHeader project={data} active={active} onNewThread={openThread} />
      <div className={bodyClassName}>{children(data, openThread)}</div>
      <NewConversationDialog
        open={threadDialogOpen}
        onClose={() => setThreadDialogOpen(false)}
        projectId={data.id}
        project={data}
      />
    </div>
  );
}
