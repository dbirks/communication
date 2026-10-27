/**
 * REPOSITORIES (Projects Review design 1b), the right column's first panel: one
 * block per repository — name (to the repository page), what is live in it, the
 * remote and default branch, and how many workflows run here.
 *
 * `+ add` opens the project's existing add-repository form in a dialog (the
 * same three fields, the same `POST /projects/{id}/repos`, the same `409`/`422`
 * refusals shown inline) so the list stays a list.
 *
 * Honesty rules:
 * - The live flag counts this repository's *live* workspaces (`preparing` /
 *   `ready`), which is the only per-repository liveness any read serves.
 * - The workflow count is the assignments that run in this repository — a
 *   project-wide pin (ADR-0060's null `repository_id`) covers every repository
 *   of the project, so it counts here too.
 * - **Open issues are counted from GitHub, per row, only where that is
 *   honest** (ADR-0065): a GitHub-hosted remote (`isGitHubRepository`, so no
 *   request is ever made that could only answer `422`) reads the repository
 *   page's own issues route — the same query key, so the two screens share one
 *   cache entry. The route returns at most 50 rows with no total, so a full
 *   page reads `50+ open issues`, none reads `no open issues`, and a refusal
 *   or a non-GitHub remote prints nothing at all.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useRepositories } from "../../api/queries";
import { useAssignments } from "../../api/pipelines";
import { isGitHubRepository, useRepoIssues } from "../../api/issues";
import type { Project, Repository } from "../../api/types";
import { Button } from "../ds/Button";
import { Panel } from "../ds/Panel";
import { ProblemBanner, Spinner } from "../Feedback";
import { routes } from "../../lib/routes";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { gitRemote } from "./gitRemote";
import { useProjectRepoIndex } from "./useProjectRepoIndex";

export interface RepositoriesProps {
  project: Project;
}

/** The issues route's page cap (`per_page=50`, api/openapi.yaml
 * GitHubIssueList): a full page is “at least this many”, never a total. */
const GITHUB_ISSUES_PAGE_CAP = 50;

/** The row's count in words: `no open issues` at 0, `50+ open issues` when
 * the route answered its 50-row cap, `N open issues` otherwise. */
export function openIssuesText(count: number): string {
  if (count === 0) return "no open issues";
  if (count >= GITHUB_ISSUES_PAGE_CAP) return `${GITHUB_ISSUES_PAGE_CAP}+ open issues`;
  return `${count} open issues`;
}

/** One repository row's open-issue count (ADR-0065 UI half): the repository
 * page's own `useRepoIssues` read, same query key, so opening the repository
 * page after this one reuses the cached answer instead of spending the
 * anonymous GitHub budget twice. Non-GitHub remotes never ask (the read is
 * disabled); a refusal or an answer still in flight prints nothing. */
function RepoIssueCount({ projectId, repo }: { projectId: string; repo: Repository }) {
  const githubHosted = isGitHubRepository(repo.git_url);
  const issues = useRepoIssues(projectId, repo.id, "", githubHosted);
  const list = issues.data;
  if (!githubHosted || issues.error || !list) return null;
  return (
    <>
      {" · "}
      <span
        title="open issues read from GitHub — the route answers at most 50, newest first"
        data-testid={`repo-issues-${repo.name}`}
      >
        {openIssuesText(list.items.length)}
      </span>
    </>
  );
}

export function Repositories({ project }: RepositoriesProps) {
  const repos = useRepositories(project.id);
  const assignments = useAssignments(project.id);
  const workspaces = useProjectRepoIndex(project.id);
  const [adding, setAdding] = useState(false);
  const isMaintainer = project.my_role === "maintainer";
  const items = repos.data?.items ?? [];
  const assigned = assignments.data?.assignments ?? [];

  return (
    <Panel
      id="repos"
      title={repos.data ? `REPOSITORIES · ${items.length}` : "REPOSITORIES"}
      headingId="repos-heading"
      headingLevel={2}
      meta={
        isMaintainer ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="font-mono text-[10.5px] normal-case text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="repo-add-toggle"
          >
            + add
          </button>
        ) : undefined
      }
    >
      <div className="bg-surface">
        {repos.isPending ? (
          <div className="p-[10px]">
            <Spinner label="Loading repositories" />
          </div>
        ) : null}
        {repos.error ? (
          <div className="p-[10px]">
            <ProblemBanner error={repos.error} fallback="Repositories could not be loaded." />
          </div>
        ) : null}
        {repos.data ? (
          items.length === 0 ? (
            <div className="space-y-[6px] p-[10px]">
              <p className="text-[12.5px] text-muted" data-testid="repo-list-empty">
                No repositories yet — without one this project has nothing to run against.
              </p>
              {isMaintainer ? (
                <Button
                  variant="secondary"
                  compact
                  onClick={() => setAdding(true)}
                  data-testid="repo-add-empty"
                >
                  Add a repository
                </Button>
              ) : (
                <p className="text-[12.5px] text-muted">
                  Only project maintainers can add repositories.
                </p>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-line-soft" data-testid="repo-list">
              {items.map((repo) => {
                const live = workspaces.liveCountByRepository.get(repo.id) ?? 0;
                const workflows = assigned.filter(
                  (pin) => pin.repository_id === repo.id || pin.repository_id == null,
                ).length;
                return (
                  <li key={repo.id} data-testid={`repo-row-${repo.name}`}>
                    <div className="space-y-[3px] px-[12px] py-[10px]">
                      <div className="flex items-baseline gap-[8px]">
                        <Link
                          to={routes.repository(project.id, repo.name)}
                          className="min-w-0 truncate text-[13px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                        >
                          {repo.name}
                        </Link>
                        {workspaces.pending ? null : live > 0 ? (
                          <span
                            className="ml-auto shrink-0 font-mono text-[10.5px] font-semibold text-st-running-tag-fg"
                            title={`${live} live workspace${live === 1 ? "" : "s"} in this repository`}
                            data-testid={`repo-live-${repo.name}`}
                          >
                            <span aria-hidden="true">● </span>
                            {live}
                            <span className="sr-only"> live workspace{live === 1 ? "" : "s"}</span>
                          </span>
                        ) : (
                          <span
                            className="ml-auto shrink-0 font-mono text-[10.5px] text-faint"
                            data-testid={`repo-live-${repo.name}`}
                          >
                            idle
                          </span>
                        )}
                      </div>
                      <p className="break-all font-mono text-[10.5px] text-muted">
                        {/* The visible line is the remote a person recognises;
                            the whole URL stays in the accessible text, which is
                            what an operator comparing checkouts needs. */}
                        <span aria-hidden="true">
                          {gitRemote(repo.git_url)} · {repo.default_branch}
                        </span>
                        <span className="sr-only">{`remote ${repo.git_url} · ${repo.default_branch}`}</span>
                      </p>
                      <p className="text-[12px] text-ink-2">
                        {assignments.data
                          ? `${workflows} workflow${workflows === 1 ? "" : "s"}`
                          : "reading workflows…"}
                        <RepoIssueCount projectId={project.id} repo={repo} />
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>
      <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} projectId={project.id} />
    </Panel>
  );
}
