/**
 * REPOS on the project home (redesign R2, README §2): one quiet row per
 * repository — its name in mono (the checkout's own name, the thing an
 * engineer scans) and, on the right, the short status the repository panel
 * prints today.
 *
 * The status is the panel's honesty rule, not a shorter lie: an open-issue
 * count is only ever read from GitHub, per repository, and only for a remote
 * the route can actually answer for (`isGitHubRepository`) — the same
 * `useRepoIssues` key the repository page uses, so opening that page after this
 * one reuses the cached answer. A remote the route cannot serve, a refusal, or
 * an answer still in flight prints NOTHING; the row never says "clean" because
 * nobody asked. `openIssuesText` (the panel's own helper) words a count, and a
 * repository that did answer with nothing open reads `✓ clean`.
 */
import { Link } from "react-router";
import { isGitHubRepository, useRepoIssues } from "../../api/issues";
import { useRepositories } from "../../api/queries";
import type { Repository } from "../../api/types";
import { routes } from "../../lib/routes";
import { openIssuesText } from "../project/Repositories";
import { ColumnHeading } from "./SectionLabel";

export interface RepoListProps {
  projectId: string;
}

/** The `Add repository` link: Manage's repository section, opened on this
 * project. */
export function addRepositoryHref(projectId: string): string {
  return `${routes.manage("repositories")}?project=${encodeURIComponent(projectId)}`;
}

/** The right-hand status cell's words, or null when nothing may be said. */
export function repoStatusText(githubHosted: boolean, count: number | null): string | null {
  if (!githubHosted || count === null) return null;
  if (count === 0) return "✓ clean";
  return openIssuesText(count);
}

function RepoRow({ projectId, repo }: { projectId: string; repo: Repository }) {
  const githubHosted = isGitHubRepository(repo.git_url);
  const issues = useRepoIssues(projectId, repo.id, "", githubHosted);
  const status = repoStatusText(githubHosted, issues.data ? issues.data.items.length : null);
  return (
    <li
      className="flex min-h-[44px] items-center justify-between gap-[10px] border-b border-line-soft py-[10px] last:border-b-0"
      data-testid={`repo-row-${repo.name}`}
    >
      <Link
        to={routes.repository(projectId, repo.name)}
        className="min-w-0 truncate font-mono text-[12.5px] text-ink hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {repo.name}
      </Link>
      {status === null ? null : (
        <span
          className="shrink-0 text-[12px] text-muted"
          data-testid={`repo-status-${repo.name}`}
          title={githubHosted ? "open issues read from GitHub" : undefined}
        >
          {status}
        </span>
      )}
    </li>
  );
}

export function RepoList({ projectId }: RepoListProps) {
  const repos = useRepositories(projectId);
  const items = repos.data?.items ?? [];

  return (
    <section className="min-w-0" aria-label="Repositories" data-testid="repo-list">
      <ColumnHeading testid="repo-list-label">Repos</ColumnHeading>
      {items.length === 0 ? (
        <p className="m-0 text-[13.5px] text-muted" data-testid="repo-list-empty">
          {repos.isPending
            ? "Reading this project's repositories."
            : "No repositories here yet — without one this project has nothing to run against."}
        </p>
      ) : (
        <ul className="m-0 list-none p-0" data-testid="repo-list-rows">
          {items.map((repo) => (
            <RepoRow key={repo.id} projectId={projectId} repo={repo} />
          ))}
        </ul>
      )}
      <Link
        to={addRepositoryHref(projectId)}
        className="mt-[10px] inline-flex min-h-[44px] items-center text-[13px] text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent min-[560px]:min-h-[20px]"
        data-testid="repo-list-add"
      >
        Add repository
      </Link>
    </section>
  );
}

export default RepoList;
