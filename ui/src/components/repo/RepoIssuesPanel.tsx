/**
 * OPEN ISSUES · n — the repo page's side-panel issue list (design 3a).
 *
 * The GitHub issues of this repository, each one click from a run: `Hand
 * off` expands the row inline into today's issue-run form (`IssueRunExpansion`
 * — the workflow select and the honest issue→input mapping), and a row whose
 * issue already has a live run says so with the run's own state word. The
 * bar's `all ›` walks to GitHub's own issue list.
 *
 * The panel lists at most `MAX_PANEL_ISSUES` of them (the bar still counts
 * them all): a busy tracker is 18-plus rows deep and turns the page into a
 * scroll — the rest belong to GitHub, one click behind `all ›`.
 *
 * Honesty rules carried over from design 1e: the list is GitHub's read
 * answer (rate-limit, private-repo and not-a-GitHub refusals each say their
 * own sentence); a run only counts as "from this issue" when the ADR-0056
 * pair on the run (`trigger.kind = issue` + `trigger.ref = owner/repo#n`)
 * says so.
 */
import type { Assignment, Repository, RunSummary } from "../../api/types";
import type { GitHubIssue } from "../../api/issues";
import { isNotGitHubRepository, useRepoIssues } from "../../api/issues";
import { ApiError } from "../../api/client";
import { Panel } from "../ds/Panel";
import { Button } from "../ds/Button";
import { ProblemBanner, Spinner } from "../Feedback";
import { RUN_STATE, SHORT_WORD, STATES } from "../ds/states";
import { shortId } from "../../lib/format";
import { routes } from "../../lib/routes";
import { Link } from "react-router";
import { IssueLabels, IssueRunExpansion } from "./IssueRunExpansion";
import { hasCredential } from "./GitHubAccess";

export interface RepoIssuesPanelProps {
  repository: Repository;
  projectId: string;
  issues: ReturnType<typeof useRepoIssues>;
  /** The `git_url` mirror of the server's parse: false means the request was
   * never made and the refusal line is shown up front. */
  githubHosted: boolean;
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  /** Issue number → the newest live run started FROM that issue. */
  activeRunsByIssue: ReadonlyMap<number, RunSummary>;
  expandedIssue: number | null;
  onExpand: (number: number | null) => void;
  canManageGitHub: boolean;
  onAddGitHubAccess: () => void;
}

/** What the statuses after which a run is no longer live — same arms the
 * activity feed uses; kept local so the panel never claims "in progress"
 * for a closed run. */
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);

/** How many open issues the side panel lists before `all ›` takes the rest
 * to GitHub (the design's meta link). */
const MAX_PANEL_ISSUES = 8;

export function RepoIssuesPanel({
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
}: RepoIssuesPanelProps) {
  const list = issues.data;
  const notGitHub = !githubHosted || isNotGitHubRepository(issues.error);
  const title = list ? `OPEN ISSUES\u00A0\u00B7\u00A0${list.items.length}` : "OPEN ISSUES";
  return (
    <Panel
      id="repo-issues"
      title={title}
      headingId="repo-issues-heading"
      headingLevel={2}
      className="min-w-0"
      meta={
        notGitHub ? undefined : (
          <Link
            to={githubIssuesUrl(list?.repository, projectId)}
            className="font-mono text-[10.5px] font-normal normal-case text-accent-text hover:underline"
            data-testid="repo-issues-all"
          >
            all ›
          </Link>
        )
      }
    >
      <div data-testid="repo-issues">
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
              Issue hand-offs need a GitHub repository — {repository.name}'s remote is not one, so
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
              {list.items.slice(0, MAX_PANEL_ISSUES).map((issue) => (
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

/** GitHub's own list for `owner/repo`; without the read's answer there is no
 * honest URL, so the link degrades to the project rather than a guess. */
function githubIssuesUrl(repository: string | undefined, projectId: string): string {
  if (!repository) return routes.project(projectId);
  return `https://github.com/${repository}/issues`;
}

/** The one-line answer for a spent anonymous GitHub budget: the upstream
 * refused the read (`502 github_rate_limited`). Say so, and stop there. */
function githubRateLimited(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 502) return false;
  const body = error.body as { code?: unknown } | null;
  const code = body && typeof body === "object" && typeof body.code === "string" ? body.code : "";
  return code === "github_rate_limited" || error.type.endsWith("/github_rate_limited");
}

/** GitHub refused the read the way a hidden repository answers (404/401 or
 * the proxy's `github_repository_not_found`). */
function privateRepoRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const code = (error.body as { code?: unknown } | null)?.code;
  if (code === "github_repository_not_found") return true;
  return error.status === 404 || error.status === 401;
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
}: {
  issue: GitHubIssue;
  projectId: string;
  assignments: readonly Assignment[];
  names: ReadonlyMap<string, string>;
  activeRun: RunSummary | null;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
}) {
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
  const state =
    activeRun && !TERMINAL_RUN_STATUSES.has(activeRun.status)
      ? (RUN_STATE[activeRun.status] ?? "queued")
      : null;
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
          className="block wrap-anywhere text-[13px] font-semibold text-ink hover:underline"
        >
          #{issue.number} {issue.title}
        </a>
        <IssueLabels issue={issue} />
      </span>
      {activeRun && state ? (
        <Link
          to={routes.run(activeRun.id)}
          className={`flex-none whitespace-nowrap font-mono text-[10.5px] ${STATES[state].tagFg} hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
          data-testid={`repo-issue-active-run-${issue.number}`}
        >
          <span aria-hidden="true">{STATES[state].glyph} </span>
          run #{shortId(activeRun.id)} {SHORT_WORD[state]}
        </Link>
      ) : (
        <Button
          variant="secondary"
          compact
          className="flex-none"
          data-testid={`repo-issue-run-${issue.number}`}
          onClick={onExpand}
        >
          Hand off
        </Button>
      )}
    </li>
  );
}
