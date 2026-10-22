/**
 * `/projects/:projectId` — the project overview, read as a dashboard.
 *
 * The design's project section tabs (`ProjectSectionNav`) are the only
 * navigation here: the page used to carry a second left menu of in-page
 * fragments on top of header links, so one project had two navigations. Below
 * the header it is two columns — the work that asks something of you on the
 * left, the project's inventory on the right.
 *
 * The attention read is the inbox's (`../lib/attention.ts`), narrowed to this
 * project, so a stalled run never reads as fine here and urgent there. Run rows
 * obey the run pages' honesty rule: no invented title, only the pipeline slug,
 * the short id and the state the wire serves.
 */
import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  useAddRepository,
  useArtifacts,
  useMembers,
  useProject,
  usePutMember,
  useRepositories,
  useUsers,
} from "../api/queries";
import { usePipelines } from "../api/pipelines";
import { useProjectRuns } from "../api/runs";
import type { MemberRole, Project } from "../api/types";
import ActivityFeed from "../components/ActivityFeed";
import { ArtifactsPanel } from "../components/Artifacts";
import Conversations from "../components/Conversations";
import ProjectSectionNav, { projectSectionHref } from "../components/ProjectSectionNav";
import NewConversationDialog from "../components/NewConversationDialog";
import { WorkspacesPanel } from "../components/Workspaces";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Button, VARIANT_CLASS } from "../components/ds/Button";
import { Field, Input, Select } from "../components/ds/Field";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { useAttentionForProject, attentionTitle, ATTENTION_TITLE_CLAMP } from "../lib/attention";
import { formatAge, testidOf } from "../lib/format";
import { routes } from "../lib/routes";
import { RunStatusChip, elapsed, shortId } from "./ProjectRuns";

const MEMBER_ROLES: readonly MemberRole[] = ["maintainer", "contributor", "viewer"];

/**
 * The remote a person recognises — `github.com/example/app` — from whatever
 * shape the git URL arrives in (https, ssh, or scp-style `git@host:path`). The
 * full URL stays in the row's text and `title`; only the visible line is
 * shortened, because the right column is 320px and a whole URL is unreadable
 * there.
 */
export function gitRemote(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const scp = /^[^@/\s]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "");
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return withoutScheme.replace(/\.git$/, "");
}

/** Pipeline id → slug, the only name the wire gives a run. */
function useSlugMap(): ReadonlyMap<string, string> {
  const pipelines = usePipelines();
  return useMemo(
    () =>
      new Map((pipelines.data?.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline.slug])),
    [pipelines.data],
  );
}

/**
 * Pending approvals plus failed/paused/waiting runs *of this project* — the
 * inbox's aggregation read for one project, with the same dedupe: a
 * `waiting_human` run whose gate is still open is a decision, not a stall.
 */
function NeedsAttention({ project }: { project: Project }) {
  const attention = useAttentionForProject(project);
  const slugs = useSlugMap();
  const total = attention.decisions.length + attention.stalled.length;

  return (
    <Panel
      id="attention"
      title={`NEEDS ATTENTION IN THIS PROJECT · ${total}`}
      headingId="attention-heading"
      headingLevel={2}
      state={total > 0 ? "waiting" : undefined}
    >
      <div className="space-y-[6px] p-[10px]" data-testid="project-attention">
        {attention.pending ? <Spinner label="Loading what needs attention" /> : null}
        {attention.unread.map(({ title }) => (
          <p
            key={title}
            className="font-mono text-[10.5px] text-st-failed-tag-fg"
            role="alert"
            data-testid="project-attention-unread"
          >
            × {title}
          </p>
        ))}
        {!attention.pending && total === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="project-attention-empty">
            Nothing needs attention in this project.
          </p>
        ) : null}
        {attention.decisions.map(({ approval }) => (
          <div
            key={approval.id}
            data-testid={`project-attention-decision-${testidOf(approval.id)}`}
          >
            <Row to={routes.run(approval.run_id)}>
              <StatusChip
                state="waiting"
                label="approval"
                labelProps={{
                  "data-testid": `project-attention-decision-status-${testidOf(approval.id)}`,
                }}
              />
              <span
                className={`min-w-0 flex-1 text-[12.5px] font-semibold ${ATTENTION_TITLE_CLAMP}`}
                title={approval.summary}
              >
                {attentionTitle(approval.summary)}
              </span>
              <span className="font-mono text-[10.5px] text-faint">
                {formatAge(approval.created_at)}
              </span>
            </Row>
            <p className="truncate font-mono text-[10.5px] text-muted">
              run {shortId(approval.run_id)} · {approval.node_instance_key}
            </p>
          </div>
        ))}
        {attention.stalled.map(({ run }) => (
          <Row
            key={run.id}
            to={routes.run(run.id)}
            data-testid={`project-attention-run-${testidOf(run.id)}`}
          >
            <RunStatusChip
              status={run.status}
              testid={`project-attention-run-status-${testidOf(run.id)}`}
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
              #{shortId(run.id)} {slugs.get(run.pipeline_id) ?? run.pipeline_id}
              {run.failed_cause ? ` — ${run.failed_cause}` : ""}
            </span>
            <span className="font-mono text-[10.5px] text-faint">{formatAge(run.created_at)}</span>
          </Row>
        ))}
      </div>
    </Panel>
  );
}

/**
 * The five newest top-level runs. Children are excluded for the same reason the
 * run list excludes them (`pages/ProjectRuns.tsx`): they belong to their
 * parent's tree, and a dashboard that mixed them would read as independent
 * work. "All runs" is the one route that owns the rest.
 */
function RecentRuns({ project }: { project: Project }) {
  const runs = useProjectRuns(project.id);
  const slugs = useSlugMap();

  const rows = useMemo(
    () =>
      (runs.data?.runs ?? [])
        .filter((run) => run.depth === 0)
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5),
    [runs.data],
  );

  return (
    <Panel
      id="recent-runs"
      title="RECENT RUNS"
      headingId="recent-runs-heading"
      headingLevel={2}
      meta={
        <Link
          to={routes.projectTab(project.id, "runs")}
          className="font-mono text-[10.5px] normal-case"
          data-testid="recent-runs-all"
        >
          all runs →
        </Link>
      }
    >
      <div className="space-y-[6px] p-[10px]">
        {runs.isPending ? <Spinner label="Loading runs" /> : null}
        {runs.isError ? (
          <ProblemBanner error={runs.error} fallback="Runs could not be loaded." />
        ) : null}
        {runs.data && rows.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="recent-runs-empty">
            No runs yet — this project has never started a pipeline.
          </p>
        ) : null}
        {rows.map((run) => (
          <Row key={run.id} to={routes.run(run.id)} data-testid={`recent-run-${testidOf(run.id)}`}>
            <RunStatusChip status={run.status} testid={`recent-run-status-${testidOf(run.id)}`} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
              #{shortId(run.id)} {slugs.get(run.pipeline_id) ?? run.pipeline_id}
            </span>
            <span className="font-mono text-[10.5px] text-faint">{elapsed(run)}</span>
          </Row>
        ))}
      </div>
    </Panel>
  );
}

/**
 * The project's repositories in the right column's narrow space: one line each,
 * the remote shortened to what a person recognises. The add form is the old one,
 * collapsed behind a button so the list stays a list.
 */
function Repositories({ project }: { project: Project }) {
  const repos = useRepositories(project.id);
  const add = useAddRepository(project.id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const isMaintainer = project.my_role === "maintainer";
  const items = repos.data?.items ?? [];
  // A project with no repository has nothing to scan, so the form is simply
  // open — the first checkout is the one moment adding one is the whole point.
  const showForm = isMaintainer && (adding || items.length === 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = gitUrl.trim();
    if (!trimmedName || !trimmedUrl) return;
    add.mutate(
      {
        name: trimmedName,
        git_url: trimmedUrl,
        default_branch: defaultBranch.trim() || "main",
      },
      {
        onSuccess: () => {
          setName("");
          setGitUrl("");
          setDefaultBranch("");
          setAdding(false);
        },
      },
    );
  };

  return (
    <Panel
      id="repos"
      title="REPOSITORIES"
      headingId="repos-heading"
      headingLevel={2}
      meta={
        isMaintainer ? (
          <Button
            variant="secondary"
            compact
            aria-expanded={showForm}
            aria-controls="add-repo-form"
            data-testid="repo-add-toggle"
            onClick={() => setAdding((current) => !current)}
          >
            {showForm ? "Close" : "Add repository"}
          </Button>
        ) : repos.data ? (
          `${items.length} total`
        ) : undefined
      }
    >
      <div className="space-y-3 p-[10px]">
        {repos.isPending ? <Spinner label="Loading repositories" /> : null}
        {repos.error ? (
          <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />
        ) : null}
        {repos.data ? (
          items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="repo-list-empty">
              No repositories yet.
            </p>
          ) : (
            <ul className="space-y-[4px]" data-testid="repo-list">
              {items.map((repo) => (
                <li key={repo.id} data-testid={`repo-row-${repo.name}`}>
                  <Row to={routes.repository(project.id, repo.name)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold">
                        {repo.name}
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-muted">
                        <span aria-hidden="true">{gitRemote(repo.git_url)}</span>
                        <span className="sr-only">{repo.git_url}</span>
                      </span>
                    </span>
                    <span className="font-mono text-[10.5px] text-faint">
                      {repo.default_branch}
                    </span>
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {!isMaintainer ? (
          <p className="text-[12.5px] text-muted">Only project maintainers can add repositories.</p>
        ) : null}

        {showForm ? (
          <form
            id="add-repo-form"
            onSubmit={onSubmit}
            aria-labelledby="add-repo-heading"
            className="space-y-3"
          >
            <h3
              id="add-repo-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add a repository
            </h3>
            <div className="grid gap-3">
              <Field id="repo-name" label="Name">
                <Input
                  id="repo-name"
                  data-testid="repo-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </Field>
              <Field id="repo-git-url" label="Git URL">
                <Input
                  id="repo-git-url"
                  data-testid="repo-git-url"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/example/app.git"
                  required
                />
              </Field>
              <Field id="repo-default-branch" label="Default branch">
                <Input
                  id="repo-default-branch"
                  data-testid="repo-default-branch"
                  placeholder="main"
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="repo-submit"
              disabled={add.isPending || !name.trim() || !gitUrl.trim()}
            >
              {add.isPending ? "Adding…" : "Add repository"}
            </Button>
            {add.error instanceof ApiError && add.error.status === 409 ? (
              <p className="text-[12.5px] text-muted">
                That repository name is already used in this project.
              </p>
            ) : null}
            <FormError error={add.error} />
          </form>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Members in the same narrow shape: a name and the role the server reports. The
 * add-or-update form (a PUT, so one control covers both) sits behind a button.
 */
function Members({ project }: { project: Project }) {
  const members = useMembers(project.id);
  const users = useUsers();
  const put = usePutMember(project.id);
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<MemberRole>("contributor");
  const isMaintainer = project.my_role === "maintainer";
  const items = members.data?.items ?? [];
  const showForm = isMaintainer && (adding || items.length === 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!userId) return;
    put.mutate(
      { userId, role },
      {
        onSuccess: () => setAdding(false),
      },
    );
  };

  return (
    <Panel
      id="members"
      title="MEMBERS"
      headingId="members-heading"
      headingLevel={2}
      meta={
        isMaintainer ? (
          <Button
            variant="secondary"
            compact
            aria-expanded={showForm}
            aria-controls="add-member-form"
            data-testid="member-add-toggle"
            onClick={() => setAdding((current) => !current)}
          >
            {showForm ? "Close" : "Add member"}
          </Button>
        ) : members.data ? (
          `${items.length} total`
        ) : undefined
      }
    >
      <div className="space-y-3 p-[10px]">
        {members.isPending ? <Spinner label="Loading members" /> : null}
        {members.error ? (
          <ProblemBanner error={members.error} fallback="Members could not be loaded." />
        ) : null}
        {members.data ? (
          items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="member-list-empty">
              No members yet.
            </p>
          ) : (
            <ul className="space-y-[4px]" data-testid="member-list">
              {items.map((member) => (
                <li key={member.user_id} data-testid={`member-row-${member.display_name}`}>
                  <Row>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                      {member.display_name}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted">role: {member.role}</span>
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {!isMaintainer ? (
          <p className="text-[12.5px] text-muted">Only project maintainers can change members.</p>
        ) : null}

        {showForm ? (
          <form
            id="add-member-form"
            onSubmit={onSubmit}
            aria-labelledby="add-member-heading"
            className="space-y-3"
          >
            <h3
              id="add-member-heading"
              className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
            >
              Add or update a member
            </h3>
            <div className="grid gap-3">
              <Field
                id="member-user"
                label="User"
                hint={
                  <>
                    {users.isPending ? <Spinner label="Loading users" /> : null}
                    {users.error ? (
                      <ProblemBanner error={users.error} fallback="User directory unavailable." />
                    ) : null}
                  </>
                }
              >
                <Select
                  id="member-user"
                  data-testid="member-user"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  required
                >
                  <option value="">Select a user…</option>
                  {users.data
                    ? users.data.items.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.display_name}
                          {user.email ? ` (${user.email})` : ""}
                        </option>
                      ))
                    : null}
                </Select>
              </Field>
              <Field id="member-role" label="Role">
                <Select
                  id="member-role"
                  data-testid="member-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as MemberRole)}
                >
                  {MEMBER_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              data-testid="member-submit"
              disabled={put.isPending || !userId}
            >
              {put.isPending ? "Saving…" : "Save member"}
            </Button>
            <FormError error={put.error} />
          </form>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * The newest five artifacts, as a pointer into the Artifacts section: the index
 * itself (with the sensitivity caveat) is `/projects/:id/artifacts`.
 */
function RecentArtifacts({ project }: { project: Project }) {
  const artifacts = useArtifacts(project.id);
  if (artifacts.isPending) return <Spinner label="Loading artifacts" />;
  if (artifacts.error)
    return <ProblemBanner error={artifacts.error} fallback="Artifacts could not be loaded." />;
  return (
    <ArtifactsPanel
      title="RECENT ARTIFACTS"
      headingId="artifacts-heading"
      artifacts={(artifacts.data?.artifacts ?? []).slice(0, 5)}
    />
  );
}

export default function Project() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = projectId ?? "";
  const project = useProject(id);
  const [conversationDialogOpen, setConversationDialogOpen] = useState(false);

  if (project.isPending) return <Spinner label="Loading project" />;

  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <section aria-labelledby="project-missing-heading">
        <h1 id="project-missing-heading" className="text-title-l font-bold">
          Project
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="project-not-found">Project not found or you do not have access</span>
        </p>
      </section>
    );
  }

  if (project.error || !project.data) {
    return (
      <section aria-labelledby="project-error-heading">
        <h1 id="project-error-heading" className="text-title-l font-bold">
          Project
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const projectData = project.data;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
      <ProjectSectionNav projectId={projectData.id} active="overview" />
      <div className="min-w-0 space-y-4">
        <header className="space-y-1">
          <h1 data-testid="project-name" className="text-title-l font-bold">
            {projectData.name}
          </h1>
          <p className="font-mono text-[11px] text-muted">
            <span>role: {projectData.my_role}</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span>slug: {projectData.slug}</span>
          </p>
          {projectData.description ? (
            <p className="max-w-[60ch] text-[12.5px] text-muted">{projectData.description}</p>
          ) : null}
          {projectData.my_role === "maintainer" || projectData.my_role === "contributor" ? (
            // The two ways into the project's work: a one-off conversation
            // (shared dialog, project fixed) and a run (started from the
            // project's Runs page, where NewRunForm opens).
            <div className="flex items-center gap-2 pt-1">
              <Button
                data-testid="project-new-conversation"
                onClick={() => setConversationDialogOpen(true)}
              >
                New conversation
              </Button>
              <Link
                to={projectSectionHref(projectData.id, "runs")}
                className={`ds-btn ${VARIANT_CLASS["secondary"]}`}
                data-testid="project-start-run"
              >
                Start run
              </Link>
            </div>
          ) : null}
        </header>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            <NeedsAttention project={projectData} />
            <RecentRuns project={projectData} />
            <Conversations project={projectData} />
          </div>
          <div className="min-w-0 space-y-4">
            <Repositories project={projectData} />
            <Members project={projectData} />
            <WorkspacesPanel projectId={projectData.id} />
            <RecentArtifacts project={projectData} />
          </div>
        </div>
        <ActivityFeed projectId={projectData.id} />
      </div>
      <NewConversationDialog
        open={conversationDialogOpen}
        onClose={() => setConversationDialogOpen(false)}
        projectId={projectData.id}
        project={projectData}
      />
    </div>
  );
}
