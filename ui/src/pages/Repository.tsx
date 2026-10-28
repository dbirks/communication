/**
 * `/p/:projectId/:repo` — the repository page (Projects Review design 1e).
 *
 * Header (breadcrumb · H1 · mono `remote · branch` · `New thread here` /
 * `Start run`), then two columns — `minmax(0,1fr) 320px`, stacking below
 * 1024px. Left: WORKFLOWS ON THIS REPO (the 2e triggers panel, kept intact)
 * and OPEN ISSUES (GitHub remotes only): "Start a workflow with an issue as
 * its goal" — each row expands inline into the RUN strip. Right: WORK IN THIS
 * REPO (the workspaces touching this repository, in words) and RECENT RUNS.
 *
 * Honest data only:
 * - the GitHub access line says what the repository row says: no credential is
 *   `public · no credential`, a credential is named by the secret's own slug
 *   (ADR-0061), and an id the project does not list says so;
 * - RECENT RUNS are attributed by the run's own `repository_id` (ADR-0064/
 *   ADR-0060) when the server serves one, else through `assignment_id` → the
 *   assignment's repository. When neither read answers the section says
 *   plainly that it is showing the project's runs instead of this repo's;
 * - an issue "already has a run" when a run carries `trigger.kind =
 *   issue` and `trigger.ref = owner/repo#<number>` — the ref an issue-trigger
 *   start records and, since ADR-0064, the ref a hand start from this very
 *   row records too (`RunCreate.issue`); a manual or thread start carries
 *   neither and is never counted;
 * - the issue list is GitHub's, read anonymously; a refused or spent read
 *   renders the upstream's own answer, never an invented list;
 * - a WORK IN THIS REPO row says what the worker's recorded view can support:
 *   the path manifest, else the dirty flag, else the commits (`committed
 *   <short head>` when the head moved past the base). It never says "no
 *   changes yet" over a commit, and with no head served it says only that
 *   there are no *uncommitted* changes.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  useProject,
  useRepositories,
  useWorkspaces,
  useWorkspaceRepoStatus,
  useConversation,
} from "../api/queries";
import { useProjectRuns, useRun } from "../api/runs";
import { useAssignments, usePipelines } from "../api/pipelines";
import {
  isGitHubRepository,
  isNotGitHubRepository,
  useRepoIssues,
  type GitHubIssue,
} from "../api/issues";
import type {
  Assignment,
  Repository,
  RunSummary,
  Workspace,
  WorkspaceRepoStatus,
} from "../api/types";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Spinner, ProblemBanner } from "../components/Feedback";
import { RUN_STATE, SHORT_WORD, STATES, WORKSPACE_STATE } from "../components/ds/states";
import { formatAge, shortCommit, shortId, testidOf } from "../lib/format";
import { routes } from "../lib/routes";
import { elapsed } from "./ProjectRuns";
import { NewRunForm } from "../components/m4/NewRunForm";
import NewConversationDialog from "../components/NewConversationDialog";
import {
  GitHubAccess,
  hasCredential,
  type GitHubAccessHandle,
} from "../components/repo/GitHubAccess";
import { IssueLabels, IssueRunExpansion } from "../components/repo/IssueRunExpansion";
import { RepoWorkflows } from "../components/workflows/RepoWorkflows";

/** The statuses after which a run is no longer "in progress" (the terminal
 * arms of `RunStatus`; `interrupted` stopped with the outcome unknown). */
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);

/** The one-line answer for a spent anonymous GitHub budget: the upstream
 * refused the read (`502 github_rate_limited`). Say so, and stop there. */
function githubRateLimited(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 502) return false;
  const body = error.body as { code?: unknown } | null;
  const code = body && typeof body === "object" && typeof body.code === "string" ? body.code : "";
  return code === "github_rate_limited" || error.type.endsWith("/github_rate_limited");
}

/** Pipeline id → the workflow's own name (display name, else slug) — the only
 * names the wire gives a run or an assignment select. */
function useNameMap(): ReadonlyMap<string, string> {
  const pipelines = usePipelines();
  return useMemo(
    () =>
      new Map(
        (pipelines.data?.pipelines ?? []).map((pipeline) => [
          pipeline.id,
          pipeline.display_name || pipeline.slug,
        ]),
      ),
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
  const names = useNameMap();
  const assignments = useAssignments(id);
  const runs = useProjectRuns(id);

  const repository = useMemo(
    () => findRepository(repos.data?.items ?? [], name),
    [repos.data, name],
  );

  // The GitHub-ness of this repository's remote is decided from the `git_url`
  // the payload already carries: a local/file remote never asks the issues
  // route (which would only answer `422 not_a_github_repository`).
  const githubHosted = repository ? isGitHubRepository(repository.git_url) : false;
  const issues = useRepoIssues(id, repository?.id ?? "", "", githubHosted);
  // ADR-0061 § 6: the ISSUES refusal line opens the GitHub-access picker
  // rendered up in the header — one dialog, opened from where the refusal is.
  const ghAccess = useRef<GitHubAccessHandle | null>(null);
  // The OPEN ISSUES row that is expanded inline (design 1e) — one at a time.
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  // The header's two ways in (design 1e): the shared new-thread dialog with
  // this project fixed, and the same new-run form the page has always used.
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
  // The repositories read failing is not the page disappearing: the header the
  // design draws (the project's breadcrumb, the page's own H1) stays and the
  // panel quotes the server — the rule every other server-error screen follows
  // (design-landmark check `repo-failed-heading`, issue #24). The repository's
  // name is NOT said here: the read that would answer it is the one that failed,
  // so the H1 is the page's own word, `Repository`.
  if (repos.error) {
    return (
      <div className="min-w-0 space-y-4" data-testid="repo-error-page">
        <header className="min-w-0 space-y-1" data-testid="repo-error-header">
          <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
            <Link to={routes.project(id)} data-testid="repo-breadcrumb">
              {projectData.name}
            </Link>
            <span aria-hidden="true" className="px-1.5">
              /
            </span>
          </nav>
          <h1 id="repo-load-error-heading" className="text-[22px] leading-[28px] font-semibold">
            Repository
          </h1>
        </header>
        <section aria-labelledby="repo-load-error-heading" className="min-w-0 space-y-3">
          <div className="max-w-[70ch]">
            <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />
          </div>
          <Button
            variant="secondary"
            compact
            className="h-[30px]"
            onClick={() => void repos.refetch()}
            disabled={repos.isFetching}
            data-testid="repo-load-retry"
          >
            {repos.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </section>
      </div>
    );
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

  // ADR-0060: the assignments that cover this repository — this repo's own
  // pins plus the whole-project ones (`repository_id` null). They decide both
  // which workflows are startable from an issue and which runs are "this
  // repository's runs". Computed plain (no hook): the early returns above
  // would otherwise split the hook list between renders.
  const usableAssignments = (assignments.data?.assignments ?? []).filter(
    (assignment) =>
      assignment.repository_id === repository.id ||
      assignment.repository_id == null ||
      assignment.repository_id === undefined,
  );

  return (
    <div className="min-w-0 space-y-4" data-testid="repo-page">
      <header
        className="flex flex-col gap-2 min-[640px]:flex-row min-[640px]:flex-wrap min-[640px]:items-end min-[640px]:gap-x-4"
        data-testid="repo-header"
      >
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
          <GitHubAccess ref={ghAccess} project={projectData} repository={repositoryData} />
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

      {/* The design's two columns: workflows + issues left, work + runs right;
          they stack below 1024px so a 390px viewport never scrolls sideways. */}
      <div className="grid grid-cols-1 items-start gap-5 min-[1024px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <RepoWorkflows projectId={id} project={projectData} repository={repositoryData} />
          <RepoIssues
            repository={repositoryData}
            projectId={id}
            issues={issues}
            githubHosted={githubHosted}
            assignments={usableAssignments}
            names={names}
            activeRunsByIssue={activeIssueRuns(runs.data, issues.data)}
            expandedIssue={expandedIssue}
            onExpand={setExpandedIssue}
            canManageGitHub={projectData.my_role === "maintainer"}
            onAddGitHubAccess={() => ghAccess.current?.open()}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <RepoWork repository={repositoryData} projectId={id} />
          <RepoRuns
            projectId={id}
            repository={repositoryData}
            names={names}
            runs={runs}
            assignments={assignments}
            usableAssignments={usableAssignments}
          />
        </div>
      </div>

      <NewConversationDialog
        open={threadOpen}
        onClose={() => setThreadOpen(false)}
        projectId={id}
        project={projectData}
      />
    </div>
  );
}

/** Issue number → the newest run that was started FROM that issue and has not
 * finished. The proof is the ADR-0056 pair the runs list really carries:
 * `trigger.kind = issue` plus `trigger.ref = owner/repo#<number>`, matched
 * against the `owner/repo` the issue list itself echoed. Both hands that
 * start an issue run record it: the trigger fire, and — since ADR-0064 — the
 * inline start from this page (`RunCreate.issue`). A run that claims no
 * issue (`manual`, `schedule`, `thread`) never counts, whatever else it ran
 * with. */
function activeIssueRuns(
  runsData: { runs: RunSummary[] } | undefined,
  issuesData: { repository: string } | undefined,
): ReadonlyMap<number, RunSummary> {
  const map = new Map<number, RunSummary>();
  if (!runsData || !issuesData) return map;
  const prefix = `${issuesData.repository}#`;
  for (const run of runsData.runs) {
    const trigger = run.trigger;
    if (!trigger || trigger.kind !== "issue" || !trigger.ref) continue;
    if (!trigger.ref.startsWith(prefix)) continue;
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const number = Number(trigger.ref.slice(prefix.length));
    if (!Number.isInteger(number) || number <= 0) continue;
    // The project list is newest-first: the first match is the newest run.
    if (!map.has(number)) map.set(number, run);
  }
  return map;
}

/** OPEN ISSUES (design 1e) — the open GitHub issues of this repository, each
 * one click from starting a workflow with the issue as its goal. */
function RepoIssues({
  repository,
  projectId,
  issues,
  githubHosted,
  assignments,
  names,
  activeRunsByIssue,
  expandedIssue,
  onExpand,
  canManageGitHub,
  onAddGitHubAccess,
}: {
  repository: Repository;
  projectId: string;
  issues: ReturnType<typeof useRepoIssues>;
  /** The `git_url` mirror of the server's parse: false means the request was
   * never made and the refusal line is shown up front. */
  githubHosted: boolean;
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  activeRunsByIssue: ReadonlyMap<number, RunSummary>;
  expandedIssue: number | null;
  onExpand: (number: number | null) => void;
  /** ADR-0061 § 6: a Maintainer may open the GitHub-access picker from the
   * refusal line; others are pointed at a maintainer instead. */
  canManageGitHub: boolean;
  onAddGitHubAccess: () => void;
}) {
  const list = issues.data;
  const notGitHub = !githubHosted || isNotGitHubRepository(issues.error);
  const title = list ? `OPEN ISSUES · ${list.items.length}` : "OPEN ISSUES";
  return (
    <Panel
      id="repo-issues"
      title={title}
      headingId="repo-issues-heading"
      headingLevel={2}
      meta={
        notGitHub ? undefined : (
          <span className="font-mono text-[10.5px] font-normal text-faint">from GitHub</span>
        )
      }
    >
      <div data-testid="repo-issues">
        {!notGitHub && (list?.items.length ?? 0) > 0 ? (
          <p
            className="px-3 pb-1 pt-[10px] text-[12.5px] text-muted"
            data-testid="repo-issues-intro"
          >
            Start a workflow with an issue as its goal. The run links back to the issue.
          </p>
        ) : null}
        <div className="pb-[6px]">
          {issues.isPending && !notGitHub ? (
            <div className="px-3 py-[10px]">
              <Spinner label="Reading GitHub" />
            </div>
          ) : null}
          {notGitHub ? (
            <p
              className="px-3 py-[10px] text-[12.5px] text-muted"
              data-testid="repo-issues-not-github"
            >
              Issue triggers need a GitHub repository — {repository.name}'s remote is not one, so
              there is no issue to start a run from.
            </p>
          ) : issues.error ? (
            githubRateLimited(issues.error) ? (
              <p
                className="px-3 py-[10px] font-mono text-[11px] text-st-failed-tag-fg"
                role="alert"
                data-testid="repo-issues-rate-limited"
              >
                GitHub is rate-limiting anonymous requests — try again later.
              </p>
            ) : !hasCredential(repository) && privateRepoRefusal(issues.error) ? (
              <p
                className="px-3 py-[10px] text-[12.5px] text-muted"
                data-testid="repo-issues-private"
              >
                {canManageGitHub ? (
                  // ADR-0061 § 6: the 404-without-credential answer is the
                  // private-repo hint, one click into the access picker — not
                  // the generic not-found.
                  <button
                    type="button"
                    onClick={onAddGitHubAccess}
                    className="text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    data-testid="repo-issues-add-github-access"
                  >
                    private repo? add GitHub access
                  </button>
                ) : (
                  <span data-testid="repo-issues-private-maintainer">
                    private repo — a project maintainer can add GitHub access.
                  </span>
                )}
              </p>
            ) : (
              <div className="px-3 py-[10px]">
                <ProblemBanner error={issues.error} fallback="GitHub issues could not be read." />
              </div>
            )
          ) : null}
          {list && list.items.length === 0 ? (
            <p className="px-3 py-[10px] text-[12.5px] text-muted" data-testid="repo-issues-empty">
              GitHub answered {list.repository} with no open issues.
            </p>
          ) : null}
          {list && !issues.isPending && !issues.isError && list.items.length > 0 ? (
            <ul data-testid="repo-issues-list">
              {list.items.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  projectId={projectId}
                  assignments={assignments}
                  names={names}
                  activeRun={activeRunsByIssue.get(issue.number) ?? null}
                  expanded={expandedIssue === issue.number}
                  onExpand={() => onExpand(expandedIssue === issue.number ? null : issue.number)}
                  onClose={() => onExpand(null)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

/** GitHub refused the read the way a hidden repository answers: GitHub hides
 * private repos from anonymous callers as a 404 (`502
 * github_repository_not_found` through the proxy), and an upstream that
 * challenges the anonymous request says unauthorized. With no credential on
 * the row this is the private-repo case ADR-0061 § 6 names — with a
 * credential it is something else, and the generic banner's server words
 * stay on screen. */
function privateRepoRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = (error.body as { code?: unknown } | null)?.code;
  if (code === "github_repository_not_found") return true;
  return error.status === 404 || error.status === 401;
}

interface IssueRowProps {
  issue: GitHubIssue;
  projectId: string;
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  /** A run started from this issue that has not finished (trigger-proven). */
  activeRun: RunSummary | null;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
}

function IssueRow({
  issue,
  projectId,
  assignments,
  names,
  activeRun,
  expanded,
  onExpand,
  onClose,
}: IssueRowProps) {
  if (expanded) {
    return (
      <li data-testid={`repo-issue-${issue.number}`}>
        <IssueRunExpansion
          projectId={projectId}
          issue={issue}
          assignments={assignments}
          nameFor={(pipelineId) => names.get(pipelineId) ?? shortId(pipelineId)}
          onClose={onClose}
        />
      </li>
    );
  }
  const state = activeRun ? (RUN_STATE[activeRun.status] ?? "queued") : null;
  return (
    <li
      className="flex items-center gap-3 border-t border-line-soft px-3 py-[10px] first:border-t-0"
      data-testid={`repo-issue-${issue.number}`}
    >
      <span className="min-w-0 flex-1">
        <a
          href={issue.html_url}
          target="_blank"
          rel="noreferrer"
          data-testid={`repo-issue-title-${issue.number}`}
          className="block text-[13px] font-semibold text-ink hover:underline"
        >
          #{issue.number} {issue.title}
        </a>
        <IssueLabels issue={issue} />
      </span>
      {activeRun && state ? (
        // The issue already has a run that has not finished — the design's
        // `● run #a7f3 in progress`, spelled with the run's own short word.
        <Link
          to={routes.run(activeRun.id)}
          className={`shrink-0 font-mono text-[10.5px] ${STATES[state].tagFg} hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
          data-testid={`repo-issue-active-run-${issue.number}`}
        >
          <span aria-hidden="true">{STATES[state].glyph} </span>
          run #{shortId(activeRun.id)} {SHORT_WORD[state]}
        </Link>
      ) : (
        <Button
          variant="secondary"
          compact
          data-testid={`repo-issue-run-${issue.number}`}
          onClick={onExpand}
        >
          Start a run…
        </Button>
      )}
    </li>
  );
}

/** WORK IN THIS REPO — the workspaces touching this repository, in words: what
 * the work IS (the workflow or thread behind it), what the worker last saw,
 * and the branch ref. No worker ids, no volume ids, no bare uuids. */
function RepoWork({ repository, projectId }: { repository: Repository; projectId: string }) {
  const workspaces = useWorkspaces(projectId);
  const touching = useMemo(
    () =>
      (workspaces.data?.workspaces ?? []).filter((workspace) =>
        workspace.repos.some((repo) => repo.repository_id === repository.id),
      ),
    [workspaces.data, repository.id],
  );

  return (
    <Panel id="repo-work" title="WORK IN THIS REPO" headingId="repo-work-heading" headingLevel={2}>
      <div data-testid="repo-workspaces">
        {workspaces.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading workspaces" />
          </div>
        ) : null}
        {workspaces.error ? (
          <div className="p-[10px]">
            <ProblemBanner error={workspaces.error} fallback="Workspaces could not be loaded." />
          </div>
        ) : null}
        {workspaces.data && touching.length === 0 ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="repo-workspaces-empty">
            Nothing is happening in this repository right now — no workspace has touched it.
          </p>
        ) : null}
        {touching.map((workspace) => (
          <RepoWorkRow key={workspace.id} workspace={workspace} repository={repository} />
        ))}
      </div>
    </Panel>
  );
}

function RepoWorkRow({ workspace, repository }: { workspace: Workspace; repository: Repository }) {
  const status = useWorkspaceRepoStatus(workspace.id, repository.id);
  const workspaceState = WORKSPACE_STATE[workspace.state];

  const entry =
    workspace.repos.find((repo) => repo.repository_id === repository.id) ?? workspace.repos[0];
  const branch = entry?.run_ref ?? "";

  // What the workspace belongs to: a run it was created for, or the thread it
  // was opened in. The owning id stays a `title` attribute only — the row
  // names the workflow run or the thread, never the bare uuid.
  const runId = workspace.scope_kind === "run" ? (workspace.run_id ?? null) : null;
  const conversationId =
    workspace.scope_kind === "conversation" ? (workspace.conversation_id ?? null) : null;
  const conversation = useConversation(conversationId ?? "");
  const run = useRunSummary(runId);

  // The row's state: the run's own status when it is run work, the workspace
  // state otherwise (the workspace's health is all a thread row can speak to).
  const state = run ? (RUN_STATE[run.status] ?? workspaceState) : workspaceState;
  const spec = STATES[state];

  // What the checkout holds, in the order the evidence gets weaker (design
  // 1e): the worker's manifest of paths, then its dirty flag, then the
  // commits. A run that committed and pushed is NOT "no changes yet" — the
  // head moved, and `committed <sha>` is the true sentence (ADR-0064's
  // honesty rule: never a count nobody served, never a denial of a commit).
  // A status with no `head_commit` at all may only say there is nothing
  // *uncommitted*, because whether it committed is not served either.
  const changes = repoChangeWords(status.data, status.isPending);

  const owner = runId
    ? `Run #${shortId(runId)}${run ? ` · ${SHORT_WORD[RUN_STATE[run.status] ?? "queued"]}` : ""}`
    : conversationId
      ? "Thread"
      : "Workspace";
  // The run's own banner first (ADR-0064's served `title`), the workflow name
  // only when the run was never named.
  const title = runId
    ? (run?.title ?? run?.name ?? `Run #${shortId(runId)}`)
    : conversationId
      ? (conversation.data?.title ?? "Thread")
      : "Workspace";

  // The branch ref, with the honest age of the worker's last recorded view.
  const refText = status.data
    ? `${branch} · seen ${formatAge(status.data.recorded_at)} ago`
    : branch;

  return (
    <div
      className="flex flex-col gap-[3px] border-t border-line-soft p-[10px] first:border-t-0"
      data-testid={`repo-workspace-${workspace.id}`}
    >
      <span className="flex items-center gap-[6px] text-[12.5px] font-semibold text-ink">
        <span aria-hidden="true" className={`font-mono ${spec.tagFg}`}>
          {spec.glyph}
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </span>
      <span className="text-[12px] text-ink-2" data-testid={`repo-workspace-state-${workspace.id}`}>
        <span className="sr-only">{`${spec.word}: `}</span>
        {owner} · {changes}
        {workspace.state === "lost" ? " · prior edits lost, rerun required" : ""}
      </span>
      {branch ? (
        runId ? (
          <Link
            to={routes.run(runId)}
            title={workspace.id}
            className={WORKSPACE_REF_CLASS}
            data-testid={`repo-workspace-run-${workspace.id}`}
          >
            {refText}
          </Link>
        ) : conversationId ? (
          <Link
            to={routes.thread(conversationId)}
            title={workspace.id}
            className={WORKSPACE_REF_CLASS}
            data-testid={`repo-workspace-thread-${workspace.id}`}
          >
            {refText}
          </Link>
        ) : (
          <Link
            to={routes.project(workspace.project_id)}
            title={workspace.id}
            className={WORKSPACE_REF_CLASS}
            data-testid={`repo-workspace-branch-${workspace.id}`}
          >
            {refText}
          </Link>
        )
      ) : null}
    </div>
  );
}

/**
 * What one checkout's last recorded view is worth saying (design 1e). The
 * worker's manifest outranks its dirty flag, and either outranks the commits:
 * `head != base` is a commit the run made, so the row names it; a clean
 * checkout whose head never moved says `no changes yet`; a status that does
 * not serve a head may only claim there is nothing *uncommitted* — whether the
 * agent committed is a question that read cannot answer.
 */
function repoChangeWords(status: WorkspaceRepoStatus | undefined, pending: boolean): string {
  if (!status) return pending ? "checking…" : "changes unknown";
  const paths = status.modified_paths.length;
  const files =
    paths > 0
      ? `${paths} ${paths === 1 ? "file" : "files"} changed`
      : status.dirty
        ? "changes recorded, paths not listed"
        : null;
  const base = status.base_commit ?? "";
  const head = status.head_commit ?? "";
  const committed = head !== "" && head !== base ? `committed ${shortCommit(head)}` : null;
  if (committed && files) return `${files} · ${committed}`;
  if (committed) return committed;
  if (files) return files;
  return head !== "" ? "no changes yet" : "no uncommitted changes";
}

/** The mono ref link styling, shared by the three owner branches above (each
 * keeps its own literal `data-testid` — the test-id guard reads literals). */
const WORKSPACE_REF_CLASS =
  "break-all font-mono text-[10.5px] text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** The run behind a workspace: its status, its own banner when it has one
 * (ADR-0064's served `title`), and the workflow name it falls back to. Null
 * while the run read is open or there is no run. */
function useRunSummary(
  runId: string | null,
): { status: string; title: string | null; name: string | null } | null {
  const run = useRun(runId ?? "");
  const pipelines = usePipelines();
  if (!runId || !run.data) return null;
  const slug = (pipelines.data?.pipelines ?? []).find(
    (pipeline) => pipeline.id === run.data.pipeline_id,
  );
  return {
    status: run.data.status,
    title: run.data.title ?? null,
    name: slug ? slug.display_name || slug.slug : null,
  };
}

/** RECENT RUNS — the runs of THIS repository, attributed through
 * `run.assignment_id` → the assignment's repository (ADR-0060's pins, whole-
 * project pins included). When the assignments read fails the section says so
 * and shows the project's runs instead — never an unclaimed "this repo". */
function RepoRuns({
  projectId,
  repository,
  names,
  runs,
  assignments,
  usableAssignments,
}: {
  projectId: string;
  repository: Repository;
  names: ReadonlyMap<string, string>;
  runs: ReturnType<typeof useProjectRuns>;
  assignments: ReturnType<typeof useAssignments>;
  usableAssignments: readonly Assignment[];
}) {
  const attributable = !assignments.isError && !!assignments.data;
  const assignmentIds = useMemo(
    () => new Set(usableAssignments.map((assignment) => assignment.id)),
    [usableAssignments],
  );
  const rows = useMemo(() => {
    const all = (runs.data?.runs ?? [])
      .filter((run) => run.depth === 0)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    // ADR-0064: a run that names its own repository answers for itself, even
    // on a server whose assignments read failed; the assignment attribution
    // stays the fallback for rows the server never named (pre-ADR-0060 runs).
    const named = all.filter((run) => run.repository_id === repository.id);
    const rest = all.filter((run) => run.repository_id == null || run.repository_id === "");
    const viaAssignment = attributable
      ? rest.filter((run) => run.assignment_id && assignmentIds.has(run.assignment_id))
      : // The assignments read failed: unnamed rows stay shown (with the
        // note below), only repository-named ones are claimed for this repo.
        rest;
    return named
      .concat(viaAssignment)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5);
  }, [runs.data, attributable, assignmentIds, repository.id]);

  return (
    <Panel
      id="repo-runs"
      title="RECENT RUNS"
      headingId="repo-runs-heading"
      headingLevel={2}
      meta={
        <Link
          to={routes.projectTab(projectId, "runs")}
          className="font-mono text-[10.5px] font-normal normal-case"
          data-testid="repo-runs-all"
        >
          all ›
        </Link>
      }
    >
      <div data-testid="repo-runs">
        {runs.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading runs" />
          </div>
        ) : null}
        {runs.error ? (
          <div className="p-[10px]">
            <ProblemBanner error={runs.error} fallback="Runs could not be loaded." />
          </div>
        ) : null}
        {runs.data && rows.length === 0 ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="repo-runs-empty">
            {attributable
              ? "No runs through this repository's workflows yet."
              : "No runs yet in this project."}
          </p>
        ) : null}
        {rows.map((run) => (
          <RunRow key={run.id} run={run} name={names.get(run.pipeline_id) ?? null} />
        ))}
        {runs.data && rows.length > 0 && !attributable ? (
          <p
            className="border-t border-line-soft px-3 py-[8px] font-mono text-[10.5px] text-st-waiting-tag-fg"
            data-testid="repo-runs-project-note"
          >
            these are the project's runs — this repository's own runs could not be told apart
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/** One RECENT RUNS row (design 1e): state glyph, the run's own title when the
 * server carries one (ADR-0064) else the workflow name, age. The word is
 * there for screen readers (never color alone) without becoming a chip. */
function RunRow({ run, name }: { run: RunSummary; name: string | null }) {
  const state = RUN_STATE[run.status] ?? "queued";
  const spec = STATES[state];
  return (
    <Link
      to={routes.run(run.id)}
      title={run.id}
      className="flex items-center gap-2 border-t border-line-soft px-3 py-[8px] first:border-t-0 hover:bg-paper"
      data-testid={`repo-run-${testidOf(run.id)}`}
    >
      <span aria-hidden="true" className={`font-mono text-[11px] ${spec.tagFg}`}>
        {spec.glyph}
      </span>
      <span className="sr-only" data-testid={`repo-run-status-${testidOf(run.id)}`}>
        {SHORT_WORD[state]}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
        {run.title ?? name ?? `run #${shortId(run.id)}`}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] text-faint">{elapsed(run)}</span>
    </Link>
  );
}
