/**
 * One project's configuration page (`/manage/projects/:projectId`, redesign R7).
 *
 * It is where the project Settings section went: the blocks below are the
 * panels `pages/ProjectSettings.tsx` and `pages/ProjectMembersPage.tsx` mount
 * today — the same components, the same props, unchanged bodies — re-stacked
 * under the redesign's section labels. Nothing is dropped on the way:
 *
 *   old                                                                 new home
 *   `ProjectSettingsTabs` "Settings" ─ panel list          →  DETAILS · REPOSITORIES ·
 *                                                               AGENT MAIL · WORKSPACES
 *   `ProjectSettingsTabs` "Members" (`/p/:id/members`)     →  PEOPLE · ACTIVITY
 *   the Settings tab's three secret panels                  →  Manage → Secrets
 *                                                               (they need the project's
 *                                                               selected secret, which is
 *                                                               that section's job)
 *
 * DETAILS holds the project's own facts, which are read-only — `PATCH
 * /api/v1/projects/{id}` moves two settings (`default_agent_profile_id`,
 * ADR-0086, and `agent_mail_enabled`, ADR-0072) and no name or description, so
 * a text field here would be a form that cannot save. The default agent is the
 * project home's own `DefaultAgentLine`, mounted in this block.
 */
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { useProject, useRepositories } from "../../api/queries";
import type { Project } from "../../api/types";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { AgentMailPanel } from "../ProjectSettings";
import { DefaultAgentLine } from "../../components/home/DefaultAgentLine";
import { AddRepositoryDialog } from "../../components/project/AddRepositoryDialog";
import { MembersPanel } from "../../components/project/MembersPanel";
import ActivityFeed from "../../components/ActivityFeed";
import { WorkspacesPanel } from "../../components/Workspaces";
import { routes } from "../../lib/routes";
import { SectionLabel, SECTION_ACTION_CLASS } from "./ManageTable";

export interface ProjectDetailProps {
  projectId?: string;
}

export default function ProjectDetail({ projectId }: ProjectDetailProps) {
  const params = useParams<{ itemId: string }>();
  const id = projectId ?? params.itemId ?? "";
  const project = useProject(id);

  if (project.isPending) return <Spinner label="Loading project" />;
  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <p
        className="text-[13.5px] text-st-failed-tag-fg"
        role="alert"
        data-testid="detail-not-found"
      >
        <span aria-hidden="true">× </span>
        Project not found or you do not have access
      </p>
    );
  }
  if (project.error || !project.data) {
    return (
      <ProblemBanner
        error={project.error}
        fallback="The project could not be loaded."
        subject="this project"
        retry={{ onClick: () => void project.refetch(), pending: project.isFetching }}
      />
    );
  }

  const data = project.data;

  return (
    <div className="flex flex-col gap-[20px]" data-testid="manage-project-detail">
      <div className="flex flex-col gap-[4px]">
        <Link
          to={routes.manage("projects")}
          className="text-[13px] text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid="detail-back"
        >
          ← Projects
        </Link>
        <h2 className="text-[20px] font-bold leading-[1.25]" data-testid="detail-name">
          {data.name}
        </h2>
      </div>

      <Block label="Details" testid="detail-label-details">
        <Details project={data} />
        {/* ADR-0086: the project's default agent is the same line the project
            home prints, mounted under the project's own facts. */}
        <div className="pt-[10px]">
          <DefaultAgentLine project={data} />
        </div>
      </Block>

      <Block label="Repositories" testid="detail-label-repositories">
        <ProjectRepos project={data} />
      </Block>

      <Block label="People" testid="detail-label-people">
        <MembersPanel project={data} />
      </Block>

      <Block label="Agent mail" testid="detail-label-agent-mail">
        <AgentMailPanel project={data} />
      </Block>

      <Block label="Workspaces" testid="detail-label-workspaces">
        <WorkspacesPanel projectId={data.id} />
      </Block>

      <Block label="Activity" testid="detail-label-activity">
        <ActivityFeed projectId={data.id} />
      </Block>

      <p className="text-[12.5px] text-muted" data-testid="detail-secrets-hint">
        This project&#39;s secrets are under{" "}
        <Link to={routes.manage("secrets")} className="text-accent-text hover:text-ink">
          Secrets
        </Link>{" "}
        — pick this project there.
      </p>
    </div>
  );
}

/** One labelled block: the design's mono label, then the existing panel. */
function Block({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <SectionLabel testid={testid}>{label}</SectionLabel>
      {children}
    </section>
  );
}

/** The project's own facts, and the honest note about which of them the API
 * will let you move. */
export function Details({ project }: { project: Project }) {
  const rows: { label: string; value: string; testid: string }[] = [
    { label: "Name", value: project.name, testid: "detail-name-value" },
    { label: "Slug", value: project.slug, testid: "detail-slug" },
    {
      label: "Description",
      value: project.description.trim() === "" ? "none" : project.description,
      testid: "detail-description",
    },
    { label: "Your role", value: project.my_role, testid: "detail-role" },
    { label: "Created", value: project.created_at, testid: "detail-created" },
  ];
  return (
    <dl
      className="flex flex-col gap-[6px] rounded-[10px] border border-line bg-surface p-[14px]"
      data-testid="detail-details"
    >
      {rows.map((row) => (
        <div key={row.testid} className="flex flex-wrap items-baseline gap-[10px]">
          <dt className="w-[110px] shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-faint">
            {row.label}
          </dt>
          <dd className="min-w-0 text-[13.5px]" data-testid={row.testid}>
            {row.value}
          </dd>
        </div>
      ))}
      <p className="pt-[4px] text-[12.5px] text-muted" data-testid="detail-edit-note">
        The name, slug and description come from the project&#39;s create and are not editable here.
        The settings this page does move are the project&#39;s default agent just below and its
        agent-mail switch under AGENT MAIL.
      </p>
    </dl>
  );
}

/** The project's repositories, with the existing add dialog behind one button. */
export function ProjectRepos({ project }: { project: Project }) {
  const repos = useRepositories(project.id);
  const [adding, setAdding] = useState(false);
  const items = repos.data?.items ?? [];
  const isMaintainer = project.my_role === "maintainer";

  return (
    <div className="rounded-[10px] border border-line bg-surface" data-testid="detail-repositories">
      {repos.isPending ? (
        <div className="p-[14px]">
          <Spinner label="Loading repositories" />
        </div>
      ) : null}
      {repos.error ? (
        <div className="p-[14px]">
          <ProblemBanner
            error={repos.error}
            fallback="Repositories could not be loaded."
            subject="this project's repositories"
            retry={{
              onClick: () => void repos.refetch(),
              pending: repos.isFetching,
              testid: "detail-repos-retry",
            }}
          />
        </div>
      ) : null}
      {repos.data ? (
        items.length === 0 ? (
          <div className="space-y-[8px] p-[14px]">
            <p className="text-[13.5px] text-muted" data-testid="detail-repos-empty">
              No repositories yet — without one this project has nothing to run against.
            </p>
            {isMaintainer ? (
              <button
                type="button"
                className={SECTION_ACTION_CLASS}
                data-testid="detail-add-repository"
                onClick={() => setAdding(true)}
              >
                Add repository
              </button>
            ) : (
              <p className="text-[12.5px] text-muted">
                Only project maintainers can add repositories.
              </p>
            )}
          </div>
        ) : (
          <div className="p-[14px]">
            <ul className="flex flex-col divide-y divide-line-soft" data-testid="detail-repo-list">
              {items.map((repo) => (
                <li key={repo.id} className="flex flex-wrap items-baseline gap-[10px] py-[8px]">
                  <Link
                    to={routes.repository(project.id, repo.name)}
                    className="font-mono text-[13px] font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid={`detail-repo-${repo.name}`}
                  >
                    {repo.name}
                  </Link>
                  <span className="font-mono text-[11.5px] text-muted">{repo.default_branch}</span>
                </li>
              ))}
            </ul>
            {isMaintainer ? (
              <button
                type="button"
                className={`${SECTION_ACTION_CLASS} mt-[10px]`}
                data-testid="detail-add-repository"
                onClick={() => setAdding(true)}
              >
                Add repository
              </button>
            ) : null}
          </div>
        )
      ) : null}
      <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} projectId={project.id} />
    </div>
  );
}
