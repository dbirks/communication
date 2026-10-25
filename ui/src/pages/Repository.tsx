/**
 * `/p/:projectId/:repo` — the repository page.
 *
 * The design's repository page (Six Directions, sidebar tree → repo): a header
 * naming the repository, its default branch and its git URL, then the sections
 * the owner asked for — STATUS (the workspaces touching this repository),
 * ISSUES (the open GitHub issues, each with a run-from-issue action) and
 * RECENT RUNS.
 *
 * Honest data only:
 * - the run list is project-scoped and the `RunSummary` row carries no
 *   repository, so the recent-runs section shows this project's runs and says
 *   so — it never claims a run belongs to this repository;
 * - the issue list is GitHub's, read anonymously; a refused or spent read
 *   renders the upstream's own answer, never an invented list.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  useProject,
  useRepositories,
  useWorkspaces,
  useWorkspaceRepoStatus,
  useConversation,
} from "../api/queries";
import { useProjectRuns } from "../api/runs";
import { usePipelines } from "../api/pipelines";
import { isNotGitHubRepository, useRepoIssues, type GitHubIssue } from "../api/issues";
import type { Repository, Workspace } from "../api/types";
import { StatusChip, Row } from "../components/ds/Row";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Spinner, ProblemBanner } from "../components/Feedback";
import { WORKSPACE_STATE } from "../components/ds/states";
import { shortCommit, shortId, testidOf } from "../lib/format";
import { routes } from "../lib/routes";
import { elapsed, RunStatusChip } from "./ProjectRuns";
import { NewRunForm } from "../components/m4/NewRunForm";
import NewConversationDialog from "../components/NewConversationDialog";
import { RepoWorkflows } from "../components/workflows/RepoWorkflows";

/** The honest one-line answer for a spent anonymous GitHub budget: the upstream
 * refused the read (`502 github_rate_limited`). Say so, and stop there. */
function githubRateLimited(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 502) return false;
  const body = error.body as { code?: unknown } | null;
  const code = body && typeof body === "object" && typeof body.code === "string" ? body.code : "";
  return code === "github_rate_limited" || error.type.endsWith("/github_rate_limited");
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

/** The one repository this page reads: the `:repo` segment names it by id or by
 * the repository's own name (the human identifier the sidebar and the project
 * page use), so both resolve. */
function findRepository(items: readonly Repository[], repoParam: string): Repository | null {
  const needle = repoParam.trim().toLowerCase();
  if (!needle) return null;
  return (
    items.find((item) => item.id === repoParam) ??
    items.find((item) => item.name.toLowerCase() === needle) ??
    null
  );
}

export default function Repository() {
  const { projectId = "", repo = "" } = useParams<{ projectId: string; repo: string }>();
  const id = projectId ?? "";
  const name = repo ?? "";

  const project = useProject(id);
  const repos = useRepositories(id);
  const slugs = useSlugMap();

  const repository = useMemo(
    () => findRepository(repos.data?.items ?? [], name),
    [repos.data, name],
  );

  const issues = useRepoIssues(id, repository?.id ?? "", "");
  const [issueRunOpen, setIssueRunOpen] = useState(false);
  // The header's two ways in (design 1e): the shared new-thread dialog with
  // this project fixed, and the same new-run form the issue section opens.
  const [threadOpen, setThreadOpen] = useState(false);
  const [startRunOpen, setStartRunOpen] = useState(false);

  if (project.isPending) return <Spinner label="Loading project" />;
  if (project.error || !project.data) {
    return (
      <section aria-labelledby="repo-error-heading">
        <h1 id="repo-error-heading" className="text-title-l font-bold">
          Repository
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }
  const projectData = project.data;

  if (repos.isPending) return <Spinner label="Loading repositories" />;
  if (repos.error) {
    return <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />;
  }

  if (!repository) {
    return (
      <section aria-labelledby="repo-not-found-heading" data-testid="repo-page">
        <h1 id="repo-not-found-heading" className="text-title-l font-bold">
          Repository
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="repo-not-found">Repository not found or you do not have access</span>
        </p>
      </section>
    );
  }

  const repositoryData = repository;

  return (
    <div className="min-w-0 space-y-4" data-testid="repo-page">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2" data-testid="repo-header">
        <div className="min-w-0 flex-1 space-y-1">
          <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
            <Link to={routes.project(id)} data-testid="repo-breadcrumb">
              {projectData.name}
            </Link>
            <span aria-hidden="true" className="px-1.5">
              /
            </span>
            <span data-testid="repo-breadcrumb-repo">{repositoryData.name}</span>
          </nav>
          <h1 data-testid="repo-name" className="text-[22px] leading-[28px] font-semibold">
            {repositoryData.name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted">
            {/^https?:\/\//i.test(repositoryData.git_url.trim()) ? (
              <a
                href={repositoryData.git_url}
                target="_blank"
                rel="noreferrer"
                data-testid="repo-git-url"
                className="break-all underline"
              >
                {repositoryData.git_url}
              </a>
            ) : (
              <span className="break-all">{repositoryData.git_url}</span>
            )}
            <span aria-hidden="true">·</span>
            <span data-testid="repo-default-branch">{repositoryData.default_branch}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setThreadOpen(true)}
            data-testid="repo-new-thread"
          >
            New thread here
          </Button>
          <Button
            variant="primary"
            onClick={() => setStartRunOpen(true)}
            data-testid="repo-start-run"
          >
            Start run
          </Button>
        </div>
      </header>

      {startRunOpen ? (
        <Panel
          id="repo-start-run"
          title="START A RUN"
          headingId="repo-start-run-heading"
          headingLevel={2}
          className="max-w-[900px]"
        >
          <div className="p-[10px]">
            <NewRunForm projectId={id} onCancel={() => setStartRunOpen(false)} />
          </div>
        </Panel>
      ) : null}

      <RepoWorkflows projectId={id} project={projectData} repository={repositoryData} />

      <NewConversationDialog
        open={threadOpen}
        onClose={() => setThreadOpen(false)}
        projectId={id}
        project={projectData}
      />

      <div className="max-w-[900px] space-y-4">
        <RepoStatus repository={repositoryData} projectId={id} />
        <RepoIssues
          repository={repositoryData}
          projectId={id}
          issues={issues}
          issueRunOpen={issueRunOpen}
          onRun={() => setIssueRunOpen(true)}
          onClose={() => setIssueRunOpen(false)}
        />
        <RepoRuns projectId={id} slugs={slugs} />
      </div>
    </div>
  );
}

/** STATUS — the workspaces that touch this repository, from the project
 * workspace list filtered by repository id (the status route is per
 * workspace + repository, so each touching workspace reads its own row). */
function RepoStatus({ repository, projectId }: { repository: Repository; projectId: string }) {
  const workspaces = useWorkspaces(projectId);
  const touching = useMemo(
    () =>
      (workspaces.data?.workspaces ?? []).filter((workspace) =>
        workspace.repos.some((repo) => repo.repository_id === repository.id),
      ),
    [workspaces.data, repository.id],
  );

  return (
    <Panel id="repo-workspaces" title="STATUS" headingId="repo-workspaces-heading" headingLevel={2}>
      <div data-testid="repo-workspaces" className="space-y-[6px] p-[10px]">
        {workspaces.isPending ? <Spinner label="Loading workspaces" /> : null}
        {workspaces.error ? (
          <ProblemBanner error={workspaces.error} fallback="Workspaces could not be loaded." />
        ) : null}
        {workspaces.data && touching.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="repo-workspaces-empty">
            No workspaces have touched this repository yet.
          </p>
        ) : null}
        {touching.map((workspace) => (
          <RepoWorkspaceRow key={workspace.id} workspace={workspace} repository={repository} />
        ))}
      </div>
    </Panel>
  );
}

function RepoWorkspaceRow({
  workspace,
  repository,
}: {
  workspace: Workspace;
  repository: Repository;
}) {
  const status = useWorkspaceRepoStatus(workspace.id, repository.id);
  const state = WORKSPACE_STATE[workspace.state];

  const entry =
    workspace.repos.find((repo) => repo.repository_id === repository.id) ?? workspace.repos[0];
  const branch = entry?.run_ref ?? "";
  const dirty = status.data?.dirty ?? false;

  // What the workspace belongs to: a run it was created for, or the thread it
  // was opened in. The owning id stays a `title` attribute only — the row
  // names the run or the thread, never the bare uuid.
  const runId = workspace.scope_kind === "run" ? (workspace.run_id ?? null) : null;
  const conversationId =
    workspace.scope_kind === "conversation" ? (workspace.conversation_id ?? null) : null;
  const conversation = useConversation(conversationId ?? "");
  const threadTitle = conversation.data?.title ?? null;

  return (
    <Row data-testid={`repo-workspace-${workspace.id}`}>
      <StatusChip state={state} label={workspace.state} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-ink-2" title={branch}>
          {branch || "—"}
        </span>
        <span className="block font-mono text-[10.5px] text-muted">
          {status.isPending ? (
            <span>checking…</span>
          ) : (
            <>
              {dirty ? "dirty" : "clean"}
              {status.data?.head_commit ? ` · head ${shortCommit(status.data.head_commit)}` : ""}
            </>
          )}
        </span>
      </span>
      {runId ? (
        <Link
          to={routes.run(runId)}
          title={workspace.id}
          className="font-mono text-[11px] text-accent underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid={`repo-workspace-run-${workspace.id}`}
        >
          run #{shortId(runId)}
        </Link>
      ) : conversationId ? (
        <Link
          to={routes.thread(conversationId)}
          title={workspace.id}
          className="font-mono text-[11px] text-accent underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid={`repo-workspace-thread-${workspace.id}`}
        >
          thread {threadTitle ?? shortId(conversationId)}
        </Link>
      ) : null}
    </Row>
  );
}

/** ISSUES — the open GitHub issues of this repository, read through the
 * anonymous upstream proxy. */
function RepoIssues({
  repository,
  projectId,
  issues,
  issueRunOpen,
  onRun,
  onClose,
}: {
  repository: Repository;
  projectId: string;
  issues: ReturnType<typeof useRepoIssues>;
  issueRunOpen: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  const list = issues.data;
  return (
    <Panel id="repo-issues" title="ISSUES" headingId="repo-issues-heading" headingLevel={2}>
      <div data-testid="repo-issues" className="space-y-[6px] p-[10px]">
        {issues.isPending ? <Spinner label="Reading GitHub" /> : null}
        {issues.error ? (
          isNotGitHubRepository(issues.error) ? (
            <p className="text-[12.5px] text-muted" data-testid="repo-issues-not-github">
              {repository.name} is not a GitHub remote, so there is no issue to start a run from.
            </p>
          ) : githubRateLimited(issues.error) ? (
            <p
              className="font-mono text-[11px] text-st-failed-tag-fg"
              role="alert"
              data-testid="repo-issues-rate-limited"
            >
              GitHub is rate-limiting anonymous requests — try again later.
            </p>
          ) : (
            <ProblemBanner error={issues.error} fallback="GitHub issues could not be read." />
          )
        ) : null}
        {list && list.items.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="repo-issues-empty">
            GitHub answered {list.repository} with no open issues.
          </p>
        ) : null}
        {list && !issues.isPending && !issues.isError && list.items.length > 0 ? (
          <ul className="space-y-[6px]" data-testid="repo-issues-list">
            {list.items.map((issue) => (
              <IssueRow key={issue.number} issue={issue} onRun={onRun} />
            ))}
          </ul>
        ) : null}
        {issueRunOpen ? (
          <Panel title="NEW RUN" headingId="repo-issue-run-heading" headingLevel={3}>
            <div className="p-[10px]">
              <NewRunForm projectId={projectId} onCancel={onClose} />
            </div>
          </Panel>
        ) : null}
      </div>
    </Panel>
  );
}

function IssueRow({ issue, onRun }: { issue: GitHubIssue; onRun: () => void }) {
  return (
    <li data-testid={`repo-issue-${issue.number}`}>
      <Row>
        <span className="min-w-0 flex-1">
          <a
            href={issue.html_url}
            target="_blank"
            rel="noreferrer"
            data-testid={`repo-issue-title-${issue.number}`}
            className="block truncate text-[12.5px] font-semibold text-ink hover:underline"
          >
            #{issue.number} {issue.title}
          </a>
          <span className="block font-mono text-[10.5px] text-muted truncate">
            {issue.labels.length > 0 ? issue.labels.join(", ") : "no labels"}
          </span>
        </span>
        <Button
          variant="secondary"
          compact
          data-testid={`repo-issue-run-${issue.number}`}
          onClick={onRun}
        >
          Run from issue
        </Button>
      </Row>
    </li>
  );
}

/** RECENT RUNS — the project's newest runs; the run rows carry no repository,
 * so the section never claims a run here belongs to this one. */
function RepoRuns({ projectId, slugs }: { projectId: string; slugs: ReadonlyMap<string, string> }) {
  const runs = useProjectRuns(projectId);
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
      id="repo-runs"
      title="RECENT RUNS"
      headingId="repo-runs-heading"
      headingLevel={2}
      meta={
        <Link
          to={routes.projectTab(projectId, "runs")}
          className="font-mono text-[10.5px] normal-case"
          data-testid="repo-runs-all"
        >
          all runs →
        </Link>
      }
    >
      <div className="space-y-[6px] p-[10px]" data-testid="repo-runs">
        {runs.isPending ? <Spinner label="Loading runs" /> : null}
        {runs.error ? (
          <ProblemBanner error={runs.error} fallback="Runs could not be loaded." />
        ) : null}
        {runs.data && rows.length === 0 ? (
          <p className="text-[12.5px] text-muted" data-testid="repo-runs-empty">
            No runs yet in this project.
          </p>
        ) : null}
        {rows.map((run) => (
          <Row key={run.id} to={routes.run(run.id)} data-testid={`repo-run-${testidOf(run.id)}`}>
            <RunStatusChip status={run.status} testid={`repo-run-status-${testidOf(run.id)}`} />
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
