/**
 * The project page's header band (Projects Review design 1b) — the shared page
 * pattern's white band: H1 22/28, a 13.5px muted subtitle, the actions on the
 * right at 30px, and the section tabs sitting on the band's bottom border.
 *
 * The two verbs are the two ways into a project's work: `New thread` opens the
 * shared thread dialog with the project fixed (the same dialog the Threads page
 * and the shell's New menu open), and `Start run` goes to the Runs tab, where
 * the run form reads its fields off the pinned revision. Both live only for a
 * contributor or maintainer — a viewer cannot start either.
 */
import { Link } from "react-router";
import { useAttentionForProject } from "../../lib/attention";
import { useConversations } from "../../api/queries";
import { useAssignments } from "../../api/pipelines";
import type { Project } from "../../api/types";
import { routes } from "../../lib/routes";
import { Button, VARIANT_CLASS } from "../ds/Button";
import { ProjectTabs, type ProjectTabFlags, type ProjectTabKey } from "./ProjectTabs";

export interface ProjectHeaderProps {
  project: Project;
  active: ProjectTabKey | null;
  /** Opens the shared "New thread" dialog (its state lives in the page). */
  onNewThread: () => void;
}

export function ProjectHeader({ project, active, onNewThread }: ProjectHeaderProps) {
  const canStartWork = project.my_role === "maintainer" || project.my_role === "contributor";
  // The tab counts are three reads the page already makes: the attention fan
  // (approvals + runs + conversations), the thread list and the assignments.
  // Reading them here — in the component that mounts beside the panels, after
  // the project itself has arrived — is what keeps them ONE request each:
  // TanStack dedupes the shared keys within a commit, and every number in the
  // tab row is then the same number the section below prints.
  const attention = useAttentionForProject(project);
  const conversations = useConversations(project.id);
  const assignments = useAssignments(project.id);
  const flags: ProjectTabFlags = {
    needsYou: attention.pending ? null : attention.decisions.length + attention.stalled.length,
    threads: conversations.data ? conversations.data.items.length : null,
    workflows: assignments.data ? assignments.data.assignments.length : null,
  };
  return (
    <header
      className="flex flex-col gap-[14px] border-b border-line-strong bg-surface px-[22px] pt-[20px] md:px-[28px]"
      data-testid="project-header"
    >
      <div className="flex flex-col gap-[12px] md:flex-row md:items-start md:gap-[16px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <h1
            id="project-heading"
            data-testid="project-name"
            className="text-[22px] leading-[28px] font-semibold"
          >
            {project.name}
          </h1>
          {project.description ? (
            <p className="max-w-[70ch] text-[13.5px] text-muted">{project.description}</p>
          ) : (
            <p
              className="max-w-[70ch] text-[13.5px] text-faint"
              data-testid="project-no-description"
            >
              No description.
            </p>
          )}
        </div>
        {canStartWork ? (
          <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
            <Button
              variant="secondary"
              onClick={onNewThread}
              data-testid="project-new-conversation"
            >
              New thread
            </Button>
            {/* The run form lives on the Runs tab (`NewRunForm`), so this is the
                same navigation the old header link performed. */}
            <Link
              to={routes.projectTab(project.id, "runs")}
              className={`ds-btn ${VARIANT_CLASS.primary} inline-flex h-[30px] items-center rounded-[4px] px-[13px]`}
              data-testid="project-start-run"
            >
              Start run
            </Link>
          </div>
        ) : (
          <p
            className="shrink-0 font-mono text-[10.5px] text-faint"
            data-testid="project-role-hint"
          >
            role: {project.my_role} — read-only
          </p>
        )}
      </div>
      <ProjectTabs projectId={project.id} active={active} flags={flags} />
    </header>
  );
}
